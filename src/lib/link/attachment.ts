import { TransferSkippedError, type TransferSession } from "../transfer/transferSession";
import { getFragment } from "../attachment/attachmentPaths";
import type { TFile } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";
import {
	getFileByPath,
	getFormatVariables,
	isLocalPath,
} from "../../utils";
import {
	buildManagedUrl,
	findUploadRule,
	formatUploadLink,
	getLocalLinkTarget,
	getManagedUrlPrefix,
	normalizeRemotePath,
	resolveUploadTarget,
} from "../attachment/uploadRules";
import {
	getAttachmentFolderPath,
	getNewLinkFormat,
	getUseMarkdownLinks,
} from "../attachment/obsidianPaths";
import type { Link, LinkData, LinkContext } from "./types";

export class AttachmentLink<T extends LinkData> implements Link<T> {
	plugin: WebDavImageUploaderPlugin;

	readonly data: T;
	readonly session: TransferSession;
	protected sourcePath: string;
	protected remoteUrl?: string;

	linkType: "local" | "external";

	tFile: TFile | null = null;

	constructor(plugin: WebDavImageUploaderPlugin, data: T, context: LinkContext) {
		this.plugin = plugin;
		this.data = data instanceof File ? data : { ...data };
		this.session = context.session;
		this.sourcePath = context.sourcePath;

		if (data instanceof File) {
			this.linkType = "local";
		} else {
			this.linkType = isLocalPath(data.path) ? "local" : "external";
		}
	}

	getRemoteUrl(): string {
		if (this.remoteUrl != null) return this.remoteUrl;
		if (this.data instanceof File) throw new Error("File has no remote URL.");
		return this.data.path;
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
					this.session.settings.uploadRules,
					this.data.name,
					false,
				) != null
			);
		}

		const file = getFileByPath(this.plugin.app, this.data.path, this.sourcePath, this.data.syntax !== "wiki");
		return findUploadRule(this.session.settings.uploadRules,
			file?.name ?? this.data.path, file == null && this.data.syntax !== "wiki") != null;
	}

	downloadable(): boolean {
		if (this.linkType === "local") {
			return false;
		}

		if (this.data instanceof File) {
			return false;
		}

		try { this.session.client.getPath(this.getRemoteUrl()); return true; } catch { return false; }
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

		this.tFile = getFileByPath(this.plugin.app, this.data.path, this.sourcePath, this.data.syntax !== "wiki");
		if (this.tFile == null) {
			throw new Error(`File not found: '${this.data.path}'`);
		}

		return this.tFile;
	}

	async upload(note: TFile) {
		if (!this.uploadable()) {
			const fileName =
				this.data instanceof File ? this.data.name : this.data.path;
			if (
				this.linkType === "local" &&
				findUploadRule(this.session.settings.uploadRules, fileName) ==
				null
			) {
				throw new TransferSkippedError(`No upload rule matched '${fileName}'.`);
			}
			throw new Error(`Cannot upload '${fileName}'`);
		}

		let file;
		let source: TFile | undefined;
		if (this.data instanceof File) {
			file = this.data;
		} else {
			const tFile = this.getTFile();
			source = tFile;
			const mtime = tFile.stat.mtime;
			const buffer = await this.plugin.app.vault.readBinary(tFile);
			if (tFile.stat.mtime !== mtime) throw new Error("Attachment changed while being read.");
			file = new File([buffer], tFile.name, {
				lastModified: tFile.stat.mtime,
			});
		}

		const attachmentFolder = await getAttachmentFolderPath(
			this.plugin.app,
			this.sourcePath,
			file.name,
		);
		const vars = getFormatVariables(file, this.session.getNoteInfo(this.sourcePath) ?? note, attachmentFolder);
		const target = resolveUploadTarget(
			this.session.settings.uploadRules,
			file.name,
			this.session.settings.url,
			vars,
		);
		if (target == null) {
			throw new TransferSkippedError(`No upload rule matched '${file.name}'.`);
		}

		const fileInfo = await this.session.upload(file, target, source);

		return {
			...fileInfo,
			localPath: target.linkType === "local" ? fileInfo.remotePath.substring(1) : undefined,
			markdownLink: target.linkType === "external"
				? formatUploadLink(
					{
						linkType: "external",
						linkTarget: fileInfo.url,
					},
					file.name,
					true,
				)
				: this.formatLocalLink(note, fileInfo.remotePath.substring(1), file.name),
		};
	}

	formatLocalLink(_note: TFile, vaultPath: string, fileName: string): string {
		const localFile = this.plugin.app.vault.getFileByPath(vaultPath.replace(/^\//, ""));
		if (localFile != null) return this.plugin.app.fileManager.generateMarkdownLink(localFile, this.sourcePath);
		const linkTarget = getLocalLinkTarget(
			vaultPath,
			this.sourcePath,
			getNewLinkFormat(this.plugin.app),
		);
		return formatUploadLink(
			{ linkType: "local", linkTarget },
			fileName,
			getUseMarkdownLinks(this.plugin.app),
		);
	}

	async download(note: TFile) {
		if (!this.downloadable()) {
			throw new Error("File is not downloadable");
		}

		this.tFile = await this.session.client.downloadFile(
			this.getRemoteUrl(),
		);

		const markdownLink = this.formatLocalLink(
			note,
			this.tFile.path,
			this.tFile.name,
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

		const oldUrl = this.getRemoteUrl();
		const oldPath = this.session.client.getPath(oldUrl);
		const urlPrefix = getManagedUrlPrefix(
			oldUrl,
			this.session.settings.url,
			this.session.settings.uploadRules,
		);
		if (urlPrefix == null) {
			throw new Error(`No upload rule recognizes '${oldUrl}'.`);
		}

		const normalizedNewPath = normalizeRemotePath(newPath);
		await this.session.client.renameFile(oldPath, normalizedNewPath);

		this.remoteUrl = buildManagedUrl(urlPrefix, normalizedNewPath) + getFragment(oldUrl);
		return this.remoteUrl;
	}

	async delete(_note: TFile) {
		if (!this.downloadable()) {
			throw new Error("File is not deletable");
		}
		await this.session.client.deleteFile(this.getRemoteUrl());
	}
}
