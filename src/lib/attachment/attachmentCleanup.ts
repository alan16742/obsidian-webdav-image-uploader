import { MarkdownView, type App, type TFile } from "obsidian";
import type { WebDavImageUploaderSettings } from "../../settings";
import { getFileByPath, isLocalPath } from "../../utils";
import { matchLinks } from "../note/noteLinks";
import type { NoteEdit } from "../note/noteEditing";

export interface FileVersion { mtime: number; size: number; path: string }
export function fileVersion(file: TFile): FileVersion {
	return { mtime: file.stat.mtime, size: file.stat.size, path: file.path };
}
export interface CleanupResult {
	file: TFile;
	status: "deleted" | "retained" | "failed";
	message: string;
}

/** Cleanup is authorized only by committed note edits and unchanged source files. */
export class AttachmentCleanup {
	private readonly candidates = new Map<TFile, FileVersion>();
	private readonly blocked = new Set<TFile>();
	private readonly committed = new Map<string, { content: string; ranges: Set<string> }>();

	constructor(private readonly app: App, private readonly operation: WebDavImageUploaderSettings["uploadedFileOperation"]) { }

	add(file: TFile, version: FileVersion) { this.candidates.set(file, version); }
	block(file: TFile) { this.blocked.add(file); }

	markCommitted(note: TFile, content: string, edits: NoteEdit[]) {
		let shift = 0;
		const ranges = new Set<string>();
		for (const { link, replacement } of [...edits].sort((a, b) => a.link.start - b.link.start)) {
			const start = link.start + shift;
			ranges.add(`${start}:${start + replacement.length}`);
			shift += replacement.length - (link.end - link.start);
		}
		this.committed.set(note.path, { content, ranges });
	}

	async run(): Promise<CleanupResult[]> {
		if (this.operation === "none" || this.candidates.size === 0) return [];
		const results: CleanupResult[] = [];
		const referenced = new Set<string>();
		const versions = new Map<TFile, FileVersion>();
		const editors = new Map<MarkdownView, string>();
		let checkError: unknown;
		try {
			const openNotes = new Map<string, string[]>();
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				if (!(leaf.view instanceof MarkdownView) || leaf.view.file == null) continue;
				const text = leaf.view.editor.getValue();
				editors.set(leaf.view, text);
				const texts = openNotes.get(leaf.view.file.path) ?? [];
				texts.push(text);
				openNotes.set(leaf.view.file.path, texts);
			}
			for (const note of this.app.vault.getMarkdownFiles()) {
				versions.set(note, fileVersion(note));
				const contents = [await this.app.vault.read(note), ...(openNotes.get(note.path) ?? [])];
				for (const content of contents) {
					const committed = this.committed.get(note.path);
					const links = matchLinks(content);
					// Obsidian may recognize additional syntax (for example nested list embeds).
					const cache = this.app.metadataCache.getFileCache(note);
					for (const ref of [...cache?.links ?? [], ...cache?.embeds ?? []]) {
						const start = ref.position.start.offset;
						const end = ref.position.end.offset;
						if (content.slice(start, end) === ref.original && !links.some(link => link.start === start && link.end === end)) {
							links.push({ start, end, path: ref.link, raw: ref.original, name: "", syntax: ref.original.includes("[[") ? "wiki" : "markdown" });
						}
					}
					for (const link of links) {
						if (!isLocalPath(link.path)) continue;
						if (committed?.content === content && committed.ranges.has(`${link.start}:${link.end}`)) continue;
						const file = getFileByPath(this.app, link.path, note.path, link.syntax !== "wiki");
						if (file != null) referenced.add(file.path);
					}
				}
			}
		} catch (error) { checkError = error; }

		for (const [file, version] of this.candidates) {
			let message = "";
			if (checkError != null) message = `Reference check failed: ${checkError}`;
			else if (this.blocked.has(file)) message = "A note update failed.";
			else if (this.app.vault.getFileByPath(file.path) !== file || !sameVersion(file, version)) message = "Attachment changed during transfer.";
			else if (referenced.has(file.path)) message = "Still referenced by another link or note.";
			else if (this.app.vault.getMarkdownFiles().length !== versions.size ||
				this.app.vault.getMarkdownFiles().some(note => !versions.has(note)) ||
				[...versions].some(([note, saved]) => !sameVersion(note, saved)) ||
				[...editors].some(([view, text]) => view.editor.getValue() !== text)) message = "Notes changed during reference checking.";
			if (message !== "") {
				results.push({ file, status: "retained", message });
				continue;
			}
			try {
				if (this.operation === "default") await this.app.fileManager.trashFile(file);
				else await this.app.vault.delete(file);
				results.push({ file, status: "deleted", message: "" });
			} catch (error) {
				results.push({ file, status: "failed", message: String(error) });
			}
		}
		this.candidates.clear();
		return results;
	}
}

function sameVersion(file: TFile, version: FileVersion): boolean {
	return file.path === version.path && file.stat.mtime === version.mtime && file.stat.size === version.size;
}
