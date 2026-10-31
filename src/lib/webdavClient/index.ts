import type { WebDavImageUploaderSettings } from "../../settings";
import { TransferSkippedError } from "../transfer/transferErrors";
import type WebDavImageUploaderPlugin from "../../main";
import {
	normalizeFilePath,
	type AttachmentMapping,
} from "../attachment/uploadRules";
import { ensureVaultParentFolder } from "../attachment/obsidianPaths";
import { WebDavClientInner, type WebDavResource } from "./webdavClientInner";

export type { WebDavResource } from "./webdavClientInner";
export type FileInfo = AttachmentMapping & { fileName: string };

/** DAV methods accept remote paths explicitly. Preview URLs never enter here. */
export class WebDavClient {
	client!: WebDavClientInner;
	private connection = "";
	private connectionVersion = 0;

	constructor(
		readonly plugin: WebDavImageUploaderPlugin,
		settings: WebDavImageUploaderSettings = plugin.settings,
	) {
		this.initClient(settings);
	}

	initClient(settings: WebDavImageUploaderSettings = this.plugin.settings) {
		const connection = JSON.stringify([
			settings.url,
			settings.username,
			settings.password,
		]);
		if (connection !== this.connection) {
			this.connection = connection;
			this.connectionVersion++;
		}
		this.client = new WebDavClientInner(settings);
	}

	cacheKey(remotePath: string): string {
		return JSON.stringify([
			this.connectionVersion,
			normalizeFilePath(remotePath),
		]);
	}

	async downloadFile(mapping: AttachmentMapping) {
		const logicalPath = normalizeFilePath(mapping.logicalPath);
		const existing = this.plugin.app.vault.getFileByPath(logicalPath);
		if (existing != null) return existing;
		if (this.plugin.app.vault.getAbstractFileByPath(logicalPath) != null)
			throw new Error(`Logical path is occupied: '${logicalPath}'.`);
		const data = await this.getFileContents(mapping.remotePath);
		await ensureVaultParentFolder(this.plugin.app, logicalPath);
		return await this.plugin.app.vault.createBinary(logicalPath, data);
	}

	async uploadFile(
		file: File,
		mapping: AttachmentMapping,
	): Promise<FileInfo> {
		const remotePath = normalizeFilePath(mapping.remotePath);
		if (
			!(await this.client.putFileContents(
				remotePath,
				await file.arrayBuffer(),
			))
		) {
			throw new TransferSkippedError(
				`Remote file already exists: '${remotePath}'. Local file retained.`,
			);
		}
		return {
			logicalPath: mapping.logicalPath,
			remotePath,
			previewUrl: mapping.previewUrl,
			fileName: file.name,
		};
	}

	async getFileContents(remotePath: string) {
		return await this.client.getFileContents(normalizeFilePath(remotePath));
	}
	async getResource(remotePath: string): Promise<WebDavResource> {
		return await this.client.getResource(normalizeFilePath(remotePath));
	}
	async exists(remotePath: string): Promise<boolean> {
		return await this.client.exists(normalizeFilePath(remotePath));
	}
	async propfind(remotePath: string) {
		return await this.client.customRequest(normalizeFilePath(remotePath), {
			method: "PROPFIND",
			headers: { Depth: "0" },
		});
	}
	async renameFile(oldRemotePath: string, newRemotePath: string) {
		await this.client.moveFile(
			normalizeFilePath(oldRemotePath),
			normalizeFilePath(newRemotePath),
			false,
		);
	}
	async deleteFile(remotePath: string) {
		await this.client.deleteFile(normalizeFilePath(remotePath));
	}

	async testConnection() {
		try {
			const response = await this.client.customRequest("/", {
				method: "PROPFIND",
				headers: { Depth: "0" },
			});
			return response.status === 207
				? null
				: `Check connection failed: ${response.status}`;
		} catch (error) {
			return String(error);
		}
	}
}
