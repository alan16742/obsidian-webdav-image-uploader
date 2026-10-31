import type { TFile } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";
import type { WebDavImageUploaderSettings } from "../../settings";
import { WebDavClient, type FileInfo } from "../webdavClient";
import type { UploadTarget } from "../attachment/uploadRules";
import type { NoteInfo } from "../../utils";
import { AttachmentPathResolver } from "../attachment/pathResolver";

export { TransferSkippedError } from "./transferErrors";

export function snapshotSettings(
	settings: WebDavImageUploaderSettings,
): WebDavImageUploaderSettings {
	return {
		...settings,
		uploadRules: settings.uploadRules.map((rule) => ({
			...rule,
			extensions: [...rule.extensions],
		})),
		pathMappings: settings.pathMappings.map((mapping) => ({ ...mapping })),
	};
}

/** One operation owns its settings, client and reusable transfer artifacts. */
export class TransferSession {
	readonly settings: WebDavImageUploaderSettings;
	readonly client: WebDavClient;
	readonly paths: AttachmentPathResolver;
	readonly dummyFiles = new Map<string, TFile>();
	private readonly uploads = new Map<string, Promise<FileInfo>>();
	private readonly notes = new Map<string, NoteInfo>();

	constructor(private readonly plugin: WebDavImageUploaderPlugin) {
		this.settings = snapshotSettings(plugin.settings);
		this.client = new WebDavClient(plugin, this.settings);
		this.paths = new AttachmentPathResolver(plugin, this.settings);
	}

	captureNote(note: TFile) {
		if (!this.notes.has(note.path)) {
			this.notes.set(note.path, {
				basename: note.basename,
				stat: { ctime: note.stat.ctime, mtime: note.stat.mtime },
			});
		}
	}

	getNoteInfo(path: string): NoteInfo | undefined {
		return this.notes.get(path);
	}

	upload(
		file: File,
		target: UploadTarget,
		source?: TFile,
	): Promise<FileInfo> {
		const key =
			source == null
				? undefined
				: JSON.stringify([
						source.path,
						file.lastModified,
						file.size,
						target.logicalPath,
						target.remotePath,
					]);
		const existing = key == null ? undefined : this.uploads.get(key);
		if (existing != null) return existing;
		this.paths.assertAvailable(target);
		const upload = (async () => {
			const result = await this.client.uploadFile(file, target);
			this.plugin.mediaLoader?.blobStore.invalidate(result.remotePath);
			await this.paths.remember(result);
			return result;
		})();
		if (key != null) {
			this.uploads.set(key, upload);
			void upload.catch(() => this.uploads.delete(key));
		}
		return upload;
	}
}
