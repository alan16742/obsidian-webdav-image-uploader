import { MarkdownView, Notice, type Editor, type MarkdownFileInfo, type Menu, type TFile } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";
import { createLink, type Link } from "../link";
import { PdfLink } from "../link/pdf";
import { matchLinks, formatLinkReplacement, replaceLinkTarget, type LinkInfo } from "./noteLinks";
import { EditorNoteUpdate, type NoteEdit } from "./noteEditing";
import { AttachmentCleanup, fileVersion } from "../attachment/attachmentCleanup";
import { TransferSession } from "../transfer/transferSession";
import { findUploadRule } from "../attachment/uploadRules";
import { getFileType } from "../attachment/fileTypes";
import { ensureVaultParentFolder } from "../attachment/obsidianPaths";
import { getRenamePath } from "../../view/modals/renameModal";
import { noticeError } from "../../utils";

type Action = "upload" | "download" | "rename" | "delete";

export class EditorActions {
	private disposed = false;
	constructor(private readonly plugin: WebDavImageUploaderPlugin) { }
	destroy() { this.disposed = true; }

	private getSource(editor: Editor, info?: MarkdownFileInfo): MarkdownFileInfo | undefined {
		if (info != null) return info;
		return this.plugin.app.workspace.getLeavesOfType("markdown")
			.map(leaf => leaf.view)
			.find((view): view is MarkdownView => view instanceof MarkdownView && view.editor === editor);
	}

	async pasteOrDrop(event: ClipboardEvent | DragEvent, editor: Editor, info?: MarkdownFileInfo) {
		if (this.disposed || !this.plugin.settings.enableUpload || event.defaultPrevented) return;
		const files = Array.from(event.type === "paste"
			? (event as ClipboardEvent).clipboardData?.files ?? []
			: (event as DragEvent).dataTransfer?.files ?? []);
		const source = this.getSource(editor, info);
		if (source?.file == null || files.length === 0) return;
		const session = new TransferSession(this.plugin);
		if (!files.some(file => findUploadRule(session.settings.uploadRules, file.name, false) != null)) return;
		const update = new EditorNoteUpdate(editor, source.file, () => source.file);
		session.captureNote(source.file);
		event.preventDefault();
		const notice = new Notice("Uploading attachments...", 0);
		const links: string[] = [];
		try {
			for (const [index, file] of files.entries()) {
				if (this.disposed) throw new Error("Plugin was unloaded.");
				notice.setMessage(`Processing '${file.name}' (${index + 1}/${files.length})`);
				try {
					if (findUploadRule(session.settings.uploadRules, file.name, false) == null) {
						links.push(await this.saveLocal(file, update.note));
					} else {
						links.push((await createLink(this.plugin, file, update.path, session).upload(update.note)).markdownLink);
					}
				} catch (error) {
					// Once paste is intercepted, keep its bytes accessible even if upload fails.
					try { links.push(await this.saveLocal(file, update.note)); }
					catch (localError) { noticeError(`Could not save '${file.name}' locally: ${localError}`); }
					noticeError(`Upload skipped or failed for '${file.name}': ${error}`);
				}
			}
			if (this.disposed) throw new Error("Plugin was unloaded.");
			if (links.length > 0) update.insert(links.join("\n"));
		} catch (error) {
			noticeError(`${error}\nAvailable attachment links:\n${links.join("\n")}`);
		} finally { notice.hide(); }
	}

	private async saveLocal(file: File, note: TFile): Promise<string> {
		const path = await this.plugin.app.fileManager.getAvailablePathForAttachment(file.name, note.path);
		await ensureVaultParentFolder(this.plugin.app, path);
		const local = await this.plugin.app.vault.createBinary(path, await file.arrayBuffer());
		const link = this.plugin.app.fileManager.generateMarkdownLink(local, note.path);
		return getFileType(file.name, false) === "image" && !link.startsWith("!") ? "!" + link : link;
	}

	addMenu(menu: Menu, editor: Editor, info?: MarkdownFileInfo) {
		const source = this.getSource(editor, info);
		if (source?.file == null || this.disposed) return;
		const update = new EditorNoteUpdate(editor, source.file, () => source.file);
		const offset = editor.posToOffset(editor.getCursor());
		const selected = matchLinks(update.snapshot).find(link => link.start <= offset && offset < link.end);
		if (selected == null) return;
		const link = createLink(this.plugin, selected, update.path);
		const add = (action: Action, title: string, icon: string) => menu.addItem(item => item
			.setTitle(title).setIcon(icon).onClick(() => { void this.run(action, link, selected, update, source, editor); }));
		if (link.downloadable()) {
			add("download", "Download file from WebDAV", "arrow-down-from-line");
			add("delete", "Delete file from WebDAV", "trash");
			add("rename", "Rename file from WebDAV", "pencil-line");
		}
		if (link.uploadable()) add("upload", "Upload file to WebDAV", "arrow-up-from-line");
	}

	private async run(action: Action, link: Link<LinkInfo>, selected: LinkInfo, update: EditorNoteUpdate, source: MarkdownFileInfo, editor: Editor) {
		const notice = new Notice(`Processing '${selected.path}'...`, 0);
		let recovery = "";
		try {
			update.assertUnchanged();
			await link.init();
			let replacement = "";
			let cleanupFile: TFile | undefined;
			let version;
			if (action === "upload") {
				cleanupFile = link.getTFile();
				version = fileVersion(cleanupFile);
				const result = await link.upload(update.note);
				recovery = result.markdownLink;
				replacement = formatLinkReplacement(selected, result.markdownLink);
			} else if (action === "download") {
				const result = await link.download(update.note);
				recovery = result.markdownLink;
				replacement = formatLinkReplacement(selected, result.markdownLink);
			} else if (action === "rename") {
				const path = await getRenamePath(this.plugin.app, link.session.client.getPath(link.getRemoteUrl()));
				if (path == null) return;
				update.assertUnchanged();
				if (this.disposed) throw new Error("Plugin was unloaded.");
				const url = await link.rename(update.note, path);
				recovery = "Remote file moved to " + url;
				replacement = link instanceof PdfLink && link.dummyFile != null ? selected.raw : replaceLinkTarget(selected, url);
			} else {
				update.assertUnchanged();
				if (this.disposed) throw new Error("Plugin was unloaded.");
				if (link instanceof PdfLink && link.dummyFile != null) {
					cleanupFile = link.dummyFile;
					version = fileVersion(cleanupFile);
				}
				await link.delete(update.note);
				recovery = "Remote file was deleted.";
			}
			if (this.disposed) throw new Error("Plugin was unloaded.");
			update.replace(selected, replacement);
			const committed = editor.getValue();
			if (source instanceof MarkdownView) await source.save();
			if (cleanupFile != null && version != null) {
				if (await this.plugin.app.vault.read(update.note) !== committed) {
					new Notice("Local attachment retained until the note is saved.");
					return;
				}
				const cleanup = new AttachmentCleanup(this.plugin.app, action === "delete" ? "default" : link.session.settings.uploadedFileOperation);
				cleanup.add(cleanupFile, version);
				const edits: NoteEdit[] = [{ link: selected, replacement }];
				cleanup.markCommitted(update.note, committed, edits);
				for (const result of await cleanup.run()) {
					if (result.status !== "deleted") new Notice(`Retained '${result.file.path}': ${result.message}`);
				}
			}
		} catch (error) {
			noticeError(`Could not complete ${action}: ${error}${recovery === "" ? "" : "\n" + recovery}`);
		} finally { notice.hide(); }
	}
}
