import {
	App,
	Editor,
	MarkdownView,
	Notice,
	moment,
} from "obsidian";

export interface NoteInfo {
	basename: string;
	stat: {
		ctime: number;
		mtime: number;
	};
}

export function getFormatVariables(file: File, note: NoteInfo) {
	const dotIndex = file.name.lastIndexOf(".");
	const fileName = dotIndex > 0 ? file.name.substring(0, dotIndex) : file.name;
	const fileExtension =
		dotIndex > 0 && dotIndex < file.name.length - 1
			? file.name.substring(dotIndex + 1)
			: "";
	return {
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
	const newLine =
		line.substring(0, link.start) +
		(newLink ?? "") +
		line.substring(link.end);
	editor.setLine(lineNumber, newLine);
}

export function getFileByPath(app: App, path: string) {
	path = decodeURI(path);
	// https://forum.obsidian.md/t/how-to-get-full-paths-from-link-text
	return app.metadataCache.getFirstLinkpathDest(path, "");
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

// get all links in line
export function matchLinks(content: string): LinkInfo[] {
	// !?[$1]($2)|!?[[$3|$4]] - markdown or wikilink
	const regex =
		/(?:!?\[(.*?)\]\((.*?)\))|(?:!?\[\[([^|\]]+?)(?:\|(.*?))?\]\])/g;
	const matches = content.matchAll(regex);
	return (
		Array.from(matches)
			.map((match) => {
				let name: string;
				let path: string;

				if (match[3] != null) {
					path = match[3];
					name = match[4] ?? "";
				} else {
					name = match[1] ?? "";
					path = match[2];
				}

				return {
					start: match.index ?? 0,
					end: (match.index ?? 0) + match[0].length,
					raw: match[0],
					name: name,
					path: path,
				};
			})
			// reverse the order as replacing links from back to front is more convenient
			.reverse()
	);
}

export interface LinkInfo {
	start: number;
	end: number;
	name: string;
	path: string;
	raw: string;
}

export function isLocalPath(path: string) {
	return !path.startsWith("http://") && !path.startsWith("https://");
}

export function noticeError(message: string, ...args: unknown[]) {
	console.error(message, ...args);
	new Notice(message, 5000);
}

export function getCurrentEditor(app: App) {
	return app.workspace.getActiveViewOfType(MarkdownView)?.editor;
}

export function getFileType(fileName: string) {
	const index = fileName.lastIndexOf(".");
	if (index === -1) {
		return "attachment";
	}

	const fileExtension = fileName.substring(index + 1).toLowerCase();
	if (fileExtension === "md") {
		return "md";
	}

	if (fileExtension === "pdf") {
		return "pdf";
	}

	const imageExtensions = [
		"jpg",
		"jpeg",
		"png",
		"gif",
		"svg",
		"webp",
		"bmp",
		"ico",
	];
	if (imageExtensions.includes(fileExtension)) {
		return "image";
	}

	return "attachment";
}

export type FileType = ReturnType<typeof getFileType>;
