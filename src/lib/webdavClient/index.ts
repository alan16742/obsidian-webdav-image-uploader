import type { WebDavImageUploaderSettings } from "../../settings";
import { TransferSkippedError } from "../transfer/transferErrors";
import type WebDavImageUploaderPlugin from "../../main";
import { buildManagedUrl, extractRemotePath } from "../attachment/uploadRules";
import {
	ensureVaultParentFolder,
	getAvailableVaultPath,
} from "../attachment/obsidianPaths";
import {
	WebDavClientInner,
	type WebDavResource,
} from "./webdavClientInner";

export type { WebDavResource } from "./webdavClientInner";

export class WebDavClient {
	plugin: WebDavImageUploaderPlugin;
	client!: WebDavClientInner;
	private settings!: WebDavImageUploaderSettings;

	constructor(plugin: WebDavImageUploaderPlugin, settings = plugin.settings) {
		this.plugin = plugin;
		this.initClient(settings);
	}

	initClient(settings = this.plugin.settings) {
		this.settings = { ...settings, uploadRules: settings.uploadRules.map(rule => ({ ...rule, extensions: [...rule.extensions] })) };
		this.client = new WebDavClientInner(settings);
	}

	async downloadFile(url: string) {
		const path = this.getPath(url);

		const resp = await this.getFileContents(url);

		const filePath = getAvailableVaultPath(this.plugin.app, path);
		await ensureVaultParentFolder(this.plugin.app, filePath);
		return await this.plugin.app.vault.createBinary(filePath, resp);
	}

	async uploadFile(file: File, path: string, urlPrefix: string): Promise<FileInfo> {
		const buffer = await file.arrayBuffer();

		// Try the configured remote path exactly once. putFileContents uses
		// If-None-Match so an existing remote file is never overwritten; callers
		// can then retain/save the local file instead of inventing another path.
		if (!await this.client.putFileContents(path, buffer)) {
			throw new TransferSkippedError(`Remote file already exists: '${path}'. Local file retained.`);
		}

		return { fileName: file.name, remotePath: path, url: buildManagedUrl(urlPrefix, path) };
	}

	async getFileContents(url: string) {
		return await this.client.getFileContents(this.getPath(url));
	}

	async getResource(url: string): Promise<WebDavResource> {
		return await this.client.getResource(this.getPath(url));
	}

	async renameFile(oldPath: string, newPath: string) {
		await this.client.moveFile(oldPath, newPath, false);
	}

	async testConnection() {
		try {
			const resp = await this.client.customRequest("/", {
				method: "PROPFIND",
				headers: { Depth: "0" },
			});

			// WebDAV servers may return 207 (Multi-Status) for a successful PROPFIND request
			if (resp.status === 207) {
				return null;
			}

			return `Check connection failed: ${resp.status}`;
		} catch (e) {
			return `${e}`;
		}
	}

	async deleteFile(url: string) {
		const path = this.getPath(url);
		await this.client.deleteFile(path);
	}

	getPath(url: string) {
		return extractRemotePath(
			url,
			this.settings.url,
			this.settings.uploadRules,
		);
	}
}

export interface FileInfo {
	remotePath: string;
	fileName: string;
	url: string;
}
