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

	async uploadFile(file: File, path: string, urlPrefix: string, localSourcePath?: string): Promise<FileInfo> {
		const buffer = await file.arrayBuffer();
		const slash = path.lastIndexOf("/");
		const directory = path.slice(0, slash + 1);
		const name = path.slice(slash + 1);
		const dot = name.lastIndexOf(".");
		const extension = dot > 0 ? name.slice(dot) : "";
		const candidates = [path, directory + Math.trunc(file.lastModified) + extension];
		for (let index = 0; index < 3; index++) {
			if (index === 2) {
				const digest = await crypto.subtle.digest("SHA-256", buffer);
				const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
				candidates.push(directory + hash + extension);
			}
			const candidate = candidates[index];
			if (candidates.indexOf(candidate) !== index) continue;
			if (localSourcePath != null) {
				const local = this.plugin.app.vault.getAbstractFileByPath(candidate.substring(1));
				if (local != null && local.path !== localSourcePath) continue;
			}
			if (await this.client.exists(candidate)) continue;
			if (!await this.client.putFileContents(candidate, buffer)) continue;
			return { fileName: file.name, remotePath: candidate, url: buildManagedUrl(urlPrefix, candidate) };
		}
		throw new TransferSkippedError("All upload names already exist (original, mtime and SHA-256): '" + path + "'. Local file retained.");
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
