import {
	MarkdownView,
	Notice,
	moment,
	type App,
	type Editor,
} from "obsidian";
export { getFileType } from "../lib/attachment/fileTypes";
export type { FileType } from "../lib/attachment/fileTypes";
import { hasUrlScheme, safeDecodeURIComponent } from "../lib/attachment/attachmentPaths";
import { matchLinks, type LinkInfo } from "../lib/note/noteLinks";
export { matchLinks } from "../lib/note/noteLinks";
export type { LinkInfo } from "../lib/note/noteLinks";

export async function reportTask(task: () => void | Promise<void>): Promise<void> {
	try { await task(); } catch (error) { noticeError(String(error)); }
}
export interface NoteInfo {
	basename: string;
	stat: {
		ctime: number;
		mtime: number;
	};
}

export function getFormatVariables(
	file: File,
	note: NoteInfo,
	attachmentFolder = "",
) {
	const dotIndex = file.name.lastIndexOf(".");
	const fileName = dotIndex > 0 ? file.name.substring(0, dotIndex) : file.name;
	const fileExtension =
		dotIndex > 0 && dotIndex < file.name.length - 1
			? file.name.substring(dotIndex + 1)
			: "";
	return {
		attachment: { type: "string" as const, value: attachmentFolder },
		name: { type: "string" as const, value: fileName },
		ext: { type: "string" as const, value: fileExtension },
		nameext: { type: "string" as const, value: file.name },
		mtime: {
			type: "date" as const,
			value: moment(new Date(file.lastModified)),
		},
		now: { type: "date" as const, value: moment() },
		notename: { type: "string" as const, value: note.basename },
		notectime: {
			type: "date" as const,
			value: moment(new Date(note.stat.ctime)),
		},
		notemtime: {
			type: "date" as const,
			value: moment(new Date(note.stat.mtime)),
		},
	};
}

export function replaceLink(
	editor: Editor,
	lineNumber: number,
	link: LinkInfo,
	newLink?: string,
) {
	const line = editor.getLine(lineNumber);
	if (line.slice(link.start, link.end) !== link.raw) {
		throw new Error("The note changed. The original link was not replaced.");
	}
	const newLine =
		line.substring(0, link.start) +
		(newLink ?? "") +
		line.substring(link.end);
	editor.setLine(lineNumber, newLine);
}

export function getFileByPath(app: App, path: string, sourcePath: string, encoded = true) {
	path = path.split("#", 1)[0];
	if (encoded) path = safeDecodeURIComponent(path);
	// https://forum.obsidian.md/t/how-to-get-full-paths-from-link-text
	return app.metadataCache.getFirstLinkpathDest(path, sourcePath);
}

// get link currently selected
export function getSelectedLink(editor: Editor) {
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);
	const links = matchLinks(line);
	return links.find(
		(link) => link.start <= cursor.ch && link.end >= cursor.ch,
	);
}

export function isLocalPath(path: string) {
	return !hasUrlScheme(path) && !path.startsWith("//");
}

export function noticeError(message: string, ...args: unknown[]) {
	console.error(message, ...args);
	new Notice(message, 5000);
}

export function getCurrentEditor(app: App) {
	return app.workspace.getActiveViewOfType(MarkdownView)?.editor;
}
