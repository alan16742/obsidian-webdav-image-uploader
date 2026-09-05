import { MarkdownView, type App, type Editor, type TFile } from "obsidian";
import type { LinkInfo } from "./noteLinks";

export interface NoteEdit { link: LinkInfo; replacement: string }

export function applyNoteEdits(content: string, edits: NoteEdit[]): string {
	let result = content;
	let boundary = content.length;
	for (const { link, replacement } of [...edits].sort((a, b) => b.link.start - a.link.start)) {
		if (link.end > boundary || content.slice(link.start, link.end) !== link.raw) {
			throw new Error("Link text changed or replacement ranges overlap.");
		}
		result = result.slice(0, link.start) + replacement + result.slice(link.end);
		boundary = link.start;
	}
	return result;
}

export async function commitNoteEdits(app: App, note: TFile, path: string, snapshot: string, edits: NoteEdit[]) {
	const replacement = applyNoteEdits(snapshot, edits);
	return await app.vault.process(note, (current) => {
		const unsavedChange = app.workspace.getLeavesOfType("markdown").some(({ view }) =>
			view instanceof MarkdownView && view.file?.path === path && view.editor.getValue() !== snapshot,
		);
		if (note.path !== path || current !== snapshot || unsavedChange) {
			throw new Error("Note changed during transfer; current text and local attachments were retained.");
		}
		return replacement;
	});
}

/** Selection positions belong to the original document, never to the latest cursor. */
export class EditorNoteUpdate {
	readonly snapshot: string;
	readonly path: string;
	private readonly from;
	private readonly to;

	constructor(
		private readonly editor: Editor,
		readonly note: TFile,
		private readonly getCurrentFile: () => TFile | null,
	) {
		this.snapshot = editor.getValue();
		this.path = note.path;
		this.from = editor.getCursor("from");
		this.to = editor.getCursor("to");
	}

	assertUnchanged() {
		if (this.note.path !== this.path || this.getCurrentFile()?.path !== this.path ||
			this.editor.getValue() !== this.snapshot) {
			throw new Error("The note changed during transfer; its text was retained.");
		}
	}

	insert(text: string) {
		this.assertUnchanged();
		this.editor.replaceRange(text, this.from, this.to);
	}

	replace(link: LinkInfo, replacement: string) {
		this.assertUnchanged();
		applyNoteEdits(this.snapshot, [{ link, replacement }]);
		this.editor.replaceRange(replacement, this.editor.offsetToPos(link.start), this.editor.offsetToPos(link.end));
	}
}
