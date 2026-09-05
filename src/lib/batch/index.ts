import { Notice, TFile, TFolder, type TAbstractFile } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";
import { getFileByPath, isLocalPath, noticeError } from "../../utils";
import { getFileType } from "../attachment/fileTypes";
import { createLink } from "../link";
import { matchLinks, formatLinkReplacement } from "../note/noteLinks";
import { commitNoteEdits, type NoteEdit } from "../note/noteEditing";
import { AttachmentCleanup, fileVersion, type CleanupResult, type FileVersion } from "../attachment/attachmentCleanup";
import { TransferSession, TransferSkippedError } from "../transfer/transferSession";
import { isManagedUrl } from "../attachment/uploadRules";
import { createBatchLog, type BatchProcessFileResult } from "./batchLog";
export { createBatchLog, type BatchProcessFileResult } from "./batchLog";

const activeBatches = new WeakSet<WebDavImageUploaderPlugin>();

class BatchProcessor {
	readonly session: TransferSession;
	readonly cleanup: AttachmentCleanup;
	readonly result: BatchProcessFileResult[] = [];
	readonly cleanupResults: CleanupResult[] = [];

	constructor(readonly plugin: WebDavImageUploaderPlugin) {
		this.session = new TransferSession(plugin);
		this.cleanup = new AttachmentCleanup(plugin.app, this.session.settings.uploadedFileOperation);
	}

	async createLog() {
		if (this.session.settings.createBatchLog) {
			await createBatchLog(this.plugin.app, this.result, this.cleanupResults);
		}
	}

	protected async run(notes: TFile[], upload: boolean, clean = true, attachments?: Set<TAbstractFile>) {
		if (activeBatches.has(this.plugin)) throw new Error("Another batch operation is already running.");
		activeBatches.add(this.plugin);
		const notice = new Notice("Starting batch transfer...", 0);
		try {
			for (const [index, note] of notes.entries()) {
				notice.setMessage("Processing '" + note.path + "' (" + (index + 1) + "/" + notes.length + ")");
				try {
					await this.processNote(note, upload, attachments);
				} catch (error) {
					this.result.push({ note, status: "failed", message: String(error) });
					noticeError("Failed to process '" + note.path + "': " + error);
				}
			}
			if (upload && clean) await this.deleteUploadedFiles();
			const count = (status: BatchProcessFileResult["status"]) => this.result.filter(item => item.status === status).length;
			new Notice("Batch finished: " + count("success") + " succeeded, " + count("skipped") + " skipped, " + count("failed") + " failed.");
		} finally {
			notice.hide();
			activeBatches.delete(this.plugin);
		}
	}

	private async processNote(note: TFile, upload: boolean, attachments?: Set<TAbstractFile>) {
		const path = note.path;
		this.session.captureNote(note);
		const snapshot = await this.plugin.app.vault.read(note);
		const links = matchLinks(snapshot).filter(link => upload
			? isLocalPath(link.path)
			: isManagedUrl(link.path, this.session.settings.url, this.session.settings.uploadRules) ||
			(this.session.settings.enableDummyPdf && isLocalPath(link.path) && getFileType(link.path) === "pdf"));
		const pending: { edit: NoteEdit; result: BatchProcessFileResult; file?: TFile; version?: FileVersion }[] = [];
		for (const linkInfo of links) {
			let source: TFile | undefined;
			try {
				if (upload) {
					source = getFileByPath(this.plugin.app, linkInfo.path, path, linkInfo.syntax !== "wiki") ?? undefined;
					if (source == null) throw new Error("Attachment was not found in the source note's context.");
					if (attachments != null && !attachments.has(source)) continue;
				}
				const version = source == null ? undefined : fileVersion(source);
				const link = createLink(this.plugin, linkInfo, path, this.session);
				await link.init();
				if (upload && !link.uploadable()) throw new TransferSkippedError("No upload rule matched, or this is already a dummy PDF.");
				if (!upload && !link.downloadable()) throw new TransferSkippedError("Link does not point to a downloadable WebDAV file.");
				const transfer = upload ? await link.upload(note) : await link.download(note);
				const replacement = formatLinkReplacement(linkInfo, transfer.markdownLink);
				pending.push({
					edit: { link: linkInfo, replacement },
					result: { note, link: linkInfo, status: "success", newLink: "url" in transfer ? transfer.url : transfer.tFile.path },
					file: source, version,
				});
			} catch (error) {
				if (source != null && !(error instanceof TransferSkippedError)) this.cleanup.block(source);
				this.result.push({
					note, link: linkInfo,
					status: error instanceof TransferSkippedError ? "skipped" : "failed",
					message: String(error),
				});
			}
		}
		if (pending.length === 0) return;
		const edits = pending.map(item => item.edit);
		try {
			const committed = await commitNoteEdits(this.plugin.app, note, path, snapshot, edits);
			this.cleanup.markCommitted(note, committed, edits);
			for (const item of pending) {
				this.result.push(item.result);
				if (item.file != null && item.version != null) this.cleanup.add(item.file, item.version);
			}
		} catch (error) {
			for (const item of pending) {
				if (item.file != null) this.cleanup.block(item.file);
				this.result.push({ ...item.result, status: "failed", message: "Transfer completed but note was not updated: " + error });
			}
		}
	}

	async deleteUploadedFiles() {
		const results = await this.cleanup.run();
		this.cleanupResults.push(...results);
		const retained = results.filter(item => item.status !== "deleted");
		if (retained.length > 0) new Notice("Retained " + retained.length + " local attachments. " + retained.map(item => item.file.path + ": " + item.message).join("\n"));
	}
}

export class BatchUploader extends BatchProcessor {
	async uploadVaultFiles() { await this.uploadFolderFiles(); }

	async uploadFolderFiles(folder?: TFolder) {
		await this.run(folder == null ? this.plugin.app.vault.getMarkdownFiles() : getMarkdownFilesInFolder(folder), true);
	}

	async uploadAttachments(folder: TFolder) {
		const attachments = new Set(folder.children.filter(file => file instanceof TFile));
		await this.run(this.plugin.app.vault.getMarkdownFiles(), true, true, attachments);
	}

	async uploadNoteFiles(note: TFile, deleteAfterUpload: boolean, attachments?: Set<TAbstractFile>) {
		await this.run([note], true, deleteAfterUpload, attachments);
	}
}

export class BatchDownloader extends BatchProcessor {
	async downloadVaultFiles() { await this.downloadFolderFiles(); }

	async downloadFolderFiles(folder?: TFolder) {
		await this.run(folder == null ? this.plugin.app.vault.getMarkdownFiles() : getMarkdownFilesInFolder(folder), false);
	}

	async downloadNoteFiles(note: TFile) { await this.run([note], false); }
}

function getMarkdownFilesInFolder(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") files.push(child);
		else if (child instanceof TFolder) files.push(...getMarkdownFilesInFolder(child));
	}
	return files;
}
