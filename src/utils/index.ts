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
	const links: LinkInfo[] = [];

	for (let i = 0; i < content.length; i++) {
		if (content[i] !== "[") {
			continue;
		}

		// The opening bracket may be prefixed with "!" for an embed (e.g.
		// "![[file]]" or "![file](url)"). Include the "!" in the matched range so
		// replacing the link preserves the embed marker.
		const isEmbed = i > 0 && content[i - 1] === "!";
		const start = isEmbed ? i - 1 : i;

		const matched =
			content[i + 1] === "["
				? scanWikilink(content, i)
				: scanMarkdownLink(content, i);
		if (matched == null) {
			continue;
		}

		links.push({
			start,
			end: matched.end,
			raw: content.slice(start, matched.end),
			name: matched.name,
			path: matched.path,
		});
		i = matched.end - 1;
	}

	// Reverse so callers can replace links from back to front without
	// invalidating the offsets of the remaining links.
	return links.reverse();
}

// Matches "[[target]]" and "[[target|alias]]".
function scanWikilink(
	content: string,
	openIndex: number,
): { end: number; path: string; name: string } | null {
	// Find the closing "]]", allowing an optional "|alias" before it.
	let i = openIndex + 2;
	let pathEnd = -1;
	while (i < content.length) {
		if (content[i] === "|") {
			pathEnd = i;
			break;
		}
		if (content[i] === "]" && content[i + 1] === "]") {
			pathEnd = i;
			break;
		}
		i++;
	}
	if (pathEnd === -1) {
		return null;
	}

	const path = content.slice(openIndex + 2, pathEnd);
	// A target can't be empty (mirrors the original `[^|\]]+`).
	if (path === "") {
		return null;
	}

	// No alias: "[[target]]".
	if (content[pathEnd] === "]") {
		return { end: pathEnd + 2, path, name: "" };
	}

	// Alias: "[[target|alias]]".
	const aliasEnd = content.indexOf("]]", pathEnd + 1);
	if (aliasEnd === -1) {
		return null;
	}
	return {
		end: aliasEnd + 2,
		path,
		name: content.slice(pathEnd + 1, aliasEnd),
	};
}

// Matches "[text](url)". URLs may contain balanced parentheses (e.g.
// Wikipedia-style links), which the previous regex truncated at the first ")".
function scanMarkdownLink(
	content: string,
	openIndex: number,
): { end: number; path: string; name: string } | null {
	// Find the "]" that is immediately followed by "(" (the start of the URL).
	let i = openIndex + 1;
	while (
		i < content.length &&
		!(content[i] === "]" && content[i + 1] === "(")
	) {
		i++;
	}
	if (i >= content.length) {
		return null;
	}

	const name = content.slice(openIndex + 1, i);

	// Scan the URL, balancing parentheses so an inner ")" doesn't end the link
	// early.
	let depth = 1;
	let j = i + 2;
	while (j < content.length && depth > 0) {
		if (content[j] === "(") {
			depth++;
		} else if (content[j] === ")") {
			depth--;
		}
		j++;
	}
	if (depth !== 0) {
		return null;
	}

	return {
		end: j,
		path: content.slice(i + 2, j - 1),
		name,
	};
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
