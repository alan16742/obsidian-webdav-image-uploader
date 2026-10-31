import {
	TransferSkippedError,
	type TransferSession,
} from "../transfer/transferSession";
import type { TFile } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";
import { getFileByPath, getFormatVariables, isLocalPath } from "../../utils";
import {
	findUploadRule,
	formatUploadLink,
	getLocalLinkTarget,
	resolveUploadTarget,
	type AttachmentMapping,
	type UploadTarget,
} from "../attachment/uploadRules";
import {
	ensureVaultParentFolder,
	getAttachmentFolderPath,
	getNewLinkFormat,
	getUseMarkdownLinks,
} from "../attachment/obsidianPaths";
import type { Link, LinkData, LinkContext } from "./types";

export class AttachmentLink<T extends LinkData> implements Link<T> {
	readonly data: T;
	readonly session: TransferSession;
	protected sourcePath: string;
	protected mapping?: AttachmentMapping;
	protected previewUrl?: string;
	linkType: "local" | "external";
	tFile: TFile | null = null;

	constructor(
		readonly plugin: WebDavImageUploaderPlugin,
		data: T,
		context: LinkContext,
	) {
		this.data = data instanceof File ? data : { ...data };
		this.session = context.session;
		this.sourcePath = context.sourcePath;
		this.linkType =
			data instanceof File || isLocalPath(data.path)
				? "local"
				: "external";
	}

	/** Only used for dummy PDF pointers and display; never for DAV requests. */
	getPreviewUrl(): string {
		if (this.previewUrl != null) return this.previewUrl;
		if (this.mapping != null) return this.mapping.previewUrl;
		if (this.data instanceof File || this.linkType === "local")
			throw new Error("Attachment has no resolved preview URL.");
		return this.data.path;
	}

	async getMapping(): Promise<AttachmentMapping> {
		if (this.mapping != null) return this.mapping;
		if (this.data instanceof File)
			throw new Error("Attachment has not been uploaded.");
		const mapping = await this.session.paths.resolve(
			this.previewUrl ?? this.data.path,
			this.sourcePath,
			this.data.syntax !== "wiki",
		);
		if (mapping == null)
			throw new Error(`No upload rule maps '${this.data.path}'.`);
		this.mapping = mapping;
		return mapping;
	}

	async init(): Promise<void> {
		if (!(this.data instanceof File))
			this.mapping =
				(await this.session.paths.resolve(
					this.data.path,
					this.sourcePath,
					this.data.syntax !== "wiki",
				)) ?? undefined;
	}

	uploadable(): boolean {
		if (this.linkType === "external") return false;
		if (this.data instanceof File)
			return (
				findUploadRule(
					this.session.settings.uploadRules,
					this.data.name,
					false,
				) != null
			);
		if (!this.session.settings.useLogicalLinks) return false;
		const file = this.getLocalFile();
		return (
			file != null &&
			findUploadRule(
				this.session.settings.uploadRules,
				file.name,
				false,
			) != null
		);
	}

	downloadable(): boolean {
		if (this.data instanceof File) return false;
		if (this.mapping != null) return true;
		if (this.linkType === "external")
			return this.plugin.isWebdavUrl(this.getPreviewUrl());
		const local = this.getLocalFile();
		return local == null
			? this.session.paths.hasRecordedLink(
					this.data.path,
					this.sourcePath,
					this.data.syntax !== "wiki",
				) ||
					findUploadRule(
						this.session.settings.uploadRules,
						this.data.path,
					) != null
			: this.session.paths.findLogical(local.path) != null;
	}

	getTFile(): TFile {
		if (this.tFile != null) return this.tFile;
		if (this.data instanceof File)
			throw new Error("Cannot get TFile from pasted File data.");
		this.tFile = this.getLocalFile();
		if (this.tFile == null)
			throw new Error(`File not found: '${this.data.path}'.`);
		return this.tFile;
	}

	protected getLocalFile(): TFile | null {
		if (this.data instanceof File) return null;
		return (
			this.tFile ??
			getFileByPath(
				this.plugin.app,
				this.data.path,
				this.sourcePath,
				this.data.syntax !== "wiki",
			)
		);
	}

	async upload(note: TFile) {
		if (!this.uploadable())
			throw new TransferSkippedError(
				"No local attachment or matching upload rule.",
			);
		let file: File;
		let source: TFile | undefined;
		if (this.data instanceof File) file = this.data;
		else {
			source = this.getTFile();
			const mtime = source.stat.mtime;
			const buffer = await this.plugin.app.vault.readBinary(source);
			if (source.stat.mtime !== mtime)
				throw new Error("Attachment changed while being read.");
			file = new File([buffer], source.name, { lastModified: mtime });
		}
		const folder = await getAttachmentFolderPath(
			this.plugin.app,
			this.sourcePath,
			file.name,
		);
		const vars = getFormatVariables(
			file,
			this.session.getNoteInfo(this.sourcePath) ?? note,
			folder,
		);
		const selected = resolveUploadTarget(
			this.session.settings.uploadRules,
			file.name,
			this.session.settings.url,
			vars,
			source?.path,
		);
		if (selected == null)
			throw new TransferSkippedError(
				`No upload rule matched '${file.name}'.`,
			);
		const recorded =
			source == null
				? undefined
				: this.session.paths.findLogical(source.path);
		const target: UploadTarget =
			recorded == null
				? selected
				: {
						...selected,
						...(await this.session.paths.currentPreview(
							recorded,
							this.sourcePath,
						)),
					};
		const result = await this.session.upload(file, target, source);
		this.mapping = result;
		return {
			...result,
			markdownLink: this.formatManagedLink(note, result, file.name),
		};
	}

	protected formatManagedLink(
		note: TFile,
		mapping: AttachmentMapping,
		fileName: string,
	): string {
		return this.session.settings.useLogicalLinks
			? this.formatLocalLink(note, mapping.logicalPath, fileName)
			: formatUploadLink(
					{ linkType: "external", linkTarget: mapping.previewUrl },
					fileName,
					true,
				);
	}

	formatLocalLink(
		_note: TFile,
		logicalPath: string,
		fileName: string,
	): string {
		const markdown = getUseMarkdownLinks(this.plugin.app);
		const linkTarget = markdown
			? getLocalLinkTarget(
					logicalPath,
					this.sourcePath,
					getNewLinkFormat(this.plugin.app),
				)
			: logicalPath;
		return formatUploadLink({ linkTarget }, fileName, markdown);
	}

	async download(note: TFile) {
		if (!this.downloadable()) throw new Error("File is not downloadable.");
		const mapping = await this.getMapping();
		this.tFile = await this.session.client.downloadFile(mapping);
		await this.session.paths.remember(mapping);
		return {
			tFile: this.tFile,
			markdownLink: this.formatLocalLink(
				note,
				mapping.logicalPath,
				this.tFile.name,
			),
		};
	}

	async rename(note: TFile, newPath: string): Promise<string> {
		if (!this.downloadable()) throw new Error("File cannot be renamed.");
		const old = await this.getMapping();
		const target = await this.session.paths.renameTarget(
			old,
			newPath,
			this.sourcePath,
		);
		this.session.paths.assertAvailable(target, old.logicalPath);
		if (
			target.logicalPath === old.logicalPath &&
			target.remotePath === old.remotePath
		)
			throw new Error("Attachment path is not modified.");
		if (
			target.logicalPath !== old.logicalPath &&
			this.plugin.app.vault.getAbstractFileByPath(target.logicalPath) !=
				null
		) {
			throw new Error(
				`Local destination already exists: '${target.logicalPath}'.`,
			);
		}
		const local = this.plugin.app.vault.getFileByPath(old.logicalPath);
		if (old.remotePath !== target.remotePath)
			await this.session.client.renameFile(
				old.remotePath,
				target.remotePath,
			);
		this.plugin.mediaLoader?.blobStore.invalidate(old.remotePath);
		this.plugin.mediaLoader?.blobStore.invalidate(target.remotePath);
		await this.session.paths.remember(target, old.logicalPath);
		this.mapping = target;
		this.previewUrl = target.previewUrl;
		if (local != null && target.logicalPath !== old.logicalPath) {
			try {
				await ensureVaultParentFolder(
					this.plugin.app,
					target.logicalPath,
				);
				await this.plugin.app.vault.rename(local, target.logicalPath);
			} catch (error) {
				throw new Error(
					`Remote attachment moved to '${target.remotePath}', but local rename failed: ${error}`,
				);
			}
		}
		return this.formatManagedLink(
			note,
			target,
			target.logicalPath.split("/").pop() ?? "",
		);
	}

	async delete(_note: TFile) {
		if (!this.downloadable()) throw new Error("File is not deletable.");
		const mapping = await this.getMapping();
		await this.session.client.deleteFile(mapping.remotePath);
		this.plugin.mediaLoader?.blobStore.invalidate(mapping.remotePath);
		await this.session.paths.forget(mapping.logicalPath);
	}
}
