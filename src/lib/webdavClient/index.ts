import WebDavImageUploaderPlugin from "../../main";
import { extractRemotePath } from "../uploadRules";
import {
	WebDavClientInner,
	type WebDavResource,
} from "./webdavClientInner";

export type { WebDavResource } from "./webdavClientInner";

export class WebDavClient {
	plugin: WebDavImageUploaderPlugin;
	client!: WebDavClientInner;

	constructor(plugin: WebDavImageUploaderPlugin) {
		this.plugin = plugin;
		this.initClient();
	}

	initClient() {
		const settings = this.plugin.settings;
		this.client = new WebDavClientInner(settings);
	}

	async downloadFile(url: string, sourcePath?: string) {
		const path = this.getPath(url);
		const fileName = path.split("/").pop()!;

		const resp = await this.getFileContents(url);

		const filePath =
			await this.plugin.app.fileManager.getAvailablePathForAttachment(
				fileName,
				sourcePath,
			);
		return await this.plugin.app.vault.createBinary(filePath, resp);
	}

	async uploadFile(file: File, path: string, url: string): Promise<FileInfo> {
		const buffer = await file.arrayBuffer();

		const success = await this.client.putFileContents(path, buffer);

		if (!success) {
			throw new Error(`Failed to upload file: '${file.name}'`);
		}

		return { fileName: file.name, url };
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
			this.plugin.settings.url,
			this.plugin.settings.uploadRules,
		);
	}
}

export interface FileInfo {
	fileName: string;
	url: string;
}
