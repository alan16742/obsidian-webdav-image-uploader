import type { WebDavClient } from "./webdavClient";

const REVOKE_DELAY_MS = 30_000;

interface BlobEntry {
	objectUrl?: string;
	pending?: Promise<string>;
	refCount: number;
	revokeTimer?: number;
}

export interface BlobHandle {
	src: string;
	release(): void;
}

/**
 * Owns object URLs created for authenticated WebDAV resources.
 * Entries are shared across views and released shortly after their final user
 * disappears so CodeMirror virtualization does not cause repeated downloads.
 */
export class WebDavBlobStore {
	private readonly entries = new Map<string, BlobEntry>();
	private destroyed = false;

	constructor(private readonly client: WebDavClient) {}

	async acquire(sourceUrl: string): Promise<BlobHandle> {
		if (this.destroyed) {
			throw new Error("WebDAV blob store has been destroyed");
		}

		const key = stripFragment(sourceUrl);
		let entry = this.entries.get(key);
		if (entry == null) {
			entry = { refCount: 0 };
			this.entries.set(key, entry);
		}

		entry.refCount += 1;
		this.cancelRevoke(entry);

		try {
			const objectUrl =
				entry.objectUrl ??
				(await this.getOrCreateObjectUrl(key, sourceUrl, entry));
			let released = false;

			return {
				src: objectUrl + getFragment(sourceUrl),
				release: () => {
					if (released) return;
					released = true;
					this.releaseEntry(key, entry!);
				},
			};
		} catch (error) {
			this.releaseEntry(key, entry);
			throw error;
		}
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;

		for (const entry of this.entries.values()) {
			this.cancelRevoke(entry);
			if (entry.objectUrl != null) {
				URL.revokeObjectURL(entry.objectUrl);
			}
		}
		this.entries.clear();
	}

	private async getOrCreateObjectUrl(
		key: string,
		sourceUrl: string,
		entry: BlobEntry,
	): Promise<string> {
		if (entry.pending != null) {
			return await entry.pending;
		}

		const pending = (async () => {
			const resource = await this.client.getResource(sourceUrl);
			if (this.destroyed || this.entries.get(key) !== entry) {
				throw new Error("WebDAV blob request was cancelled");
			}

			const type = normalizeMimeType(resource.contentType) ??
				inferMimeType(sourceUrl);
			const blob = new Blob(
				[resource.data],
				type == null ? undefined : { type },
			);
			const objectUrl = URL.createObjectURL(blob);

			if (this.destroyed || this.entries.get(key) !== entry) {
				URL.revokeObjectURL(objectUrl);
				throw new Error("WebDAV blob request was cancelled");
			}

			entry.objectUrl = objectUrl;
			return objectUrl;
		})();

		entry.pending = pending;
		try {
			return await pending;
		} finally {
			if (entry.pending === pending) {
				entry.pending = undefined;
			}
			if (entry.refCount === 0 && entry.objectUrl != null) {
				this.scheduleRevoke(key, entry);
			}
		}
	}

	private releaseEntry(key: string, entry: BlobEntry) {
		entry.refCount = Math.max(0, entry.refCount - 1);
		if (entry.refCount !== 0) return;

		if (entry.objectUrl != null) {
			this.scheduleRevoke(key, entry);
		} else if (entry.pending == null && this.entries.get(key) === entry) {
			this.entries.delete(key);
		}
	}

	private scheduleRevoke(key: string, entry: BlobEntry) {
		if (entry.revokeTimer != null || this.destroyed) return;

		entry.revokeTimer = window.setTimeout(() => {
			entry.revokeTimer = undefined;
			if (
				entry.refCount !== 0 ||
				this.entries.get(key) !== entry ||
				entry.objectUrl == null
			) {
				return;
			}

			URL.revokeObjectURL(entry.objectUrl);
			this.entries.delete(key);
		}, REVOKE_DELAY_MS);
	}

	private cancelRevoke(entry: BlobEntry) {
		if (entry.revokeTimer == null) return;
		window.clearTimeout(entry.revokeTimer);
		entry.revokeTimer = undefined;
	}
}

function stripFragment(url: string): string {
	const index = url.indexOf("#");
	return index === -1 ? url : url.substring(0, index);
}

function getFragment(url: string): string {
	const index = url.indexOf("#");
	return index === -1 ? "" : url.substring(index);
}

function normalizeMimeType(contentType?: string): string | undefined {
	const normalized = contentType?.split(";", 1)[0].trim().toLowerCase();
	return normalized === "" ? undefined : normalized;
}

function inferMimeType(url: string): string | undefined {
	const cleanUrl = stripFragment(url).split("?", 1)[0].toLowerCase();
	const extension = cleanUrl.substring(cleanUrl.lastIndexOf(".") + 1);
	const mimeTypes: Record<string, string> = {
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		png: "image/png",
		gif: "image/gif",
		bmp: "image/bmp",
		svg: "image/svg+xml",
		webp: "image/webp",
		ico: "image/x-icon",
		mp4: "video/mp4",
		webm: "video/webm",
		mov: "video/quicktime",
		avi: "video/x-msvideo",
		mkv: "video/x-matroska",
		mp3: "audio/mpeg",
		wav: "audio/wav",
		m4a: "audio/mp4",
		flac: "audio/flac",
		ogg: "application/ogg",
	};
	return mimeTypes[extension];
}
