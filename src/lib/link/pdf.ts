import type { TFile } from "obsidian";
import { AttachmentLink } from "./attachment";
import type { LinkData, LinkFactory } from "./types";
import { ensureVaultParentFolder, getAvailableVaultPath } from "../attachment/obsidianPaths";

const factory: LinkFactory = {
	create(plugin, type, data, context) {
		return type === "pdf" ? new PdfLink(plugin, data, context) : null;
	},
};
export default factory;

/** The note target and the URL stored inside a dummy PDF are distinct values. */
export class PdfLink<T extends LinkData> extends AttachmentLink<T> {
	dummyFile: TFile | null = null;
	isDummyPdf?: boolean;
	private initialization?: Promise<void>;
	private dummyContent = "";

	uploadable(): boolean {
		return this.isDummyPdf !== true && super.uploadable();
	}

	downloadable(): boolean {
		if (this.linkType === "external") return super.downloadable();
		return this.session.settings.enableDummyPdf === true &&
			!(this.data instanceof File) && this.isDummyPdf == null;
	}

	async init(): Promise<void> {
		if (this.isDummyPdf != null) return;
		if (this.initialization == null) this.initialization = this.inspect();
		try {
			await this.initialization;
		} finally {
			this.initialization = undefined;
		}
	}

	private async inspect() {
		if (!this.session.settings.enableDummyPdf || this.linkType === "external" || this.data instanceof File) {
			this.isDummyPdf = false;
			return;
		}
		const file = this.getTFile();
		const content = await this.plugin.app.vault.cachedRead(file);
		const url = content.trim();
		if (!/^https?:\/\/\S+$/.test(url)) {
			this.isDummyPdf = false;
			return;
		}
		this.dummyFile = file;
		this.dummyContent = content;
		this.remoteUrl = url;
		this.linkType = "external";
		this.isDummyPdf = true;
	}

	async upload(note: TFile) {
		await this.init();
		const result = await super.upload(note);
		if (!this.session.settings.enableDummyPdf) return result;
		let file = this.session.dummyFiles.get(result.url);
		if (file == null) {
			const path = getAvailableVaultPath(this.plugin.app, result.remotePath);
			await ensureVaultParentFolder(this.plugin.app, path);
			file = await this.plugin.app.vault.create(path, result.url);
			this.session.dummyFiles.set(result.url, file);
		}
		const markdownLink = this.formatLocalLink(note, file.path, file.name);
		return { ...result, localPath: file.path, markdownLink: embed(markdownLink) };
	}

	async download(note: TFile) {
		await this.init();
		if (!this.downloadable()) throw new Error("File is not downloadable.");
		if (this.dummyFile == null) {
			const result = await super.download(note);
			return { ...result, markdownLink: embed(result.markdownLink) };
		}
		const data = await this.session.client.getFileContents(this.getRemoteUrl());
		const current = await this.plugin.app.vault.read(this.dummyFile);
		if (current !== this.dummyContent) throw new Error("Dummy PDF changed during download; local file retained.");
		await this.plugin.app.vault.modifyBinary(this.dummyFile, data);
		this.tFile = this.dummyFile;
		return {
			tFile: this.dummyFile,
			markdownLink: embed(this.formatLocalLink(note, this.dummyFile.path, this.dummyFile.name)),
		};
	}

	async rename(note: TFile, newPath: string) {
		await this.init();
		const url = await super.rename(note, newPath);
		if (this.dummyFile != null) {
			await this.plugin.app.vault.process(this.dummyFile, (content) => {
				if (content !== this.dummyContent) throw new Error("Dummy PDF changed. Remote file was moved to '" + url + "'; update the pointer manually.");
				return url;
			});
			this.dummyContent = url;
		}
		return url;
	}

	async delete(note: TFile) {
		await this.init();
		await super.delete(note);
		// Local cleanup belongs to the caller, after the note update commits.
	}
}

function embed(link: string): string {
	return link.startsWith("!") ? link : "!" + link;
}
