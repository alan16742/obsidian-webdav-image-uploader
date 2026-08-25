import { TFile } from "obsidian";
import WebDavImageUploaderPlugin from "../main";
import {
	getFileByPath,
	getFormatVariables,
	isLocalPath,
	LinkInfo,
} from "../utils";
import {
	buildManagedUrl,
	findUploadRule,
	getManagedUrlPrefix,
	resolveUploadTarget,
} from "../uploadRules";
import { Link, LinkData } from "./types";

export class AttachmentLink<T extends LinkData> implements Link<T> {
	plugin: WebDavImageUploaderPlugin;

	data: T;

	linkType: "local" | "external";

	tFile: TFile | null = null;

	constructor(plugin: WebDavImageUploaderPlugin, data: T) {
		this.plugin = plugin;
		this.data = data;

		if (data instanceof File) {
			this.linkType = "local";
		} else {
			this.linkType = isLocalPath(data.path) ? "local" : "external";
		}
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	uploadable(): boolean {
		if (this.linkType === "external") {
			return false;
		}

		if (this.data instanceof File) {
			return (
				findUploadRule(
					this.plugin.settings.uploadRules,
					this.data.name,
				) != null
			);
		}

		return (
			findUploadRule(
				this.plugin.settings.uploadRules,
				this.data.path,
			) != null
		);
	}

	downloadable(): boolean {
		if (this.linkType === "local") {
			return false;
		}

		if (this.data instanceof File) {
			return false;
		}

		return this.plugin.isWebdavUrl(this.data.path);
	}

	getTFile() {
		if (this.tFile != null) {
			return this.tFile;
		}

		if (this.data instanceof File) {
			throw new Error("Cannot get TFile from File data");
		}

		if (this.data.path == null) {
			throw new Error(
				`Path is undefined for link with name '${this.data.name}'`,
			);
		}

		this.tFile = getFileByPath(this.plugin.app, this.data.path);
		if (this.tFile == null) {
			throw new Error(`File not found: '${this.data.path}'`);
		}

		return this.tFile;
	}

	async upload(note: TFile) {
		if (!this.uploadable()) {
			if (this.linkType === "local") {
				const fileName =
					this.data instanceof File ? this.data.name : this.data.path;
				if (
					findUploadRule(
						this.plugin.settings.uploadRules,
						fileName,
					) == null
				) {
					throw new Error(`No upload rule matched '${fileName}'.`);
				}
			}
			throw new Error(
				`Cannot upload '${
					this.data instanceof File ? this.data.name : this.data.path
				}'`,
			);
		}

		let file;
		if (this.data instanceof File) {
			file = this.data;
		} else {
			const tFile = this.getTFile();
			const buffer = await this.plugin.app.vault.readBinary(tFile);
			file = new File([buffer], tFile.name, {
				lastModified: tFile.stat.mtime,
			});
		}

		const vars = getFormatVariables(file, note);
		const target = resolveUploadTarget(
			this.plugin.settings.uploadRules,
			file.name,
			this.plugin.settings.url,
			vars,
		);
		if (target == null) {
			throw new Error(`No upload rule matched '${file.name}'.`);
		}
		const fileInfo = await this.plugin.client.uploadFile(
			file,
			target.remotePath,
			target.url,
		);

		return {
			fileName: file.name,
			url: fileInfo.url,
			markdownLink: `[${file.name}](${fileInfo.url})`,
		};
	}

	async download(note: TFile) {
		if (!this.downloadable()) {
			throw new Error("File is not downloadable");
		}

		this.tFile = await this.plugin.client.downloadFile(
			(this.data as LinkInfo).path,
			note.path,
		);

		const markdownLink = this.plugin.app.fileManager.generateMarkdownLink(
			this.tFile,
			this.tFile.path,
		);

		return {
			tFile: this.tFile,
			markdownLink: markdownLink,
		};
	}

	async rename(_note: TFile, newPath: string): Promise<string> {
		if (!this.downloadable()) {
			throw new Error("File can not be renamed.");
		}

		const oldUrl = (this.data as LinkInfo).path;
		const oldPath = this.plugin.client.getPath(oldUrl);
		const urlPrefix = getManagedUrlPrefix(
			oldUrl,
			this.plugin.settings.url,
			this.plugin.settings.uploadRules,
		);
		if (urlPrefix == null) {
			throw new Error(`No upload rule recognizes '${oldUrl}'.`);
		}

		await this.plugin.client.renameFile(oldPath, newPath);

		return buildManagedUrl(urlPrefix, newPath);
	}

	async delete(_note: TFile) {
		if (!this.downloadable()) {
			throw new Error("File is not deletable");
		}
		await this.plugin.client.deleteFile((this.data as LinkInfo).path);
	}
}
