/** Source offsets are immutable and always refer to the text that was parsed. */
export interface LinkInfo {
	start: number;
	end: number;
	name: string;
	path: string;
	raw: string;
	targetStart?: number;
	targetEnd?: number;
	syntax?: "markdown" | "wiki" | "definition";
}

function escaped(text: string, index: number): boolean {
	let slashes = 0;
	while (index > 0 && text[--index] === "\\") slashes++;
	return slashes % 2 === 1;
}

function destination(text: string, start: number) {
	let end = start;
	if (text[start] === "<") {
		start++;
		end = start;
		while (end < text.length && text[end] !== "\n") {
			if (text[end] === ">" && !escaped(text, end)) {
				return { start, end, next: end + 1 };
			}
			end++;
		}
		return null;
	}
	let depth = 0;
	for (; end < text.length; end++) {
		if (escaped(text, end)) continue;
		const char = text[end];
		if (/\s/.test(char)) break;
		if (char === "(") depth++;
		if (char === ")") {
			if (depth === 0) break;
			depth--;
		}
	}
	return depth === 0 && end > start ? { start, end, next: end } : null;
}

function scanLink(text: string, open: number): LinkInfo | null {
	const start = open > 0 && text[open - 1] === "!" && !escaped(text, open - 1)
		? open - 1 : open;
	let close: number;
	let pathStart: number;
	let pathEnd: number;
	let name: string;
	let syntax: LinkInfo["syntax"];
	if (text[open + 1] === "[") {
		close = text.indexOf("]]", open + 2);
		if (close < 0 || text.slice(open, close).includes("\n")) return null;
		const alias = text.indexOf("|", open + 2);
		pathStart = open + 2;
		pathEnd = alias >= 0 && alias < close ? alias : close;
		name = pathEnd === close ? "" : text.slice(pathEnd + 1, close);
		close += 2;
		syntax = "wiki";
	} else {
		let depth = 1;
		let labelEnd = open + 1;
		for (; labelEnd < text.length; labelEnd++) {
			if (escaped(text, labelEnd)) continue;
			if (text[labelEnd] === "[") depth++;
			if (text[labelEnd] === "]" && --depth === 0) break;
		}
		if (depth !== 0) return null;
		name = text.slice(open + 1, labelEnd);
		const definition = text[labelEnd + 1] === ":" &&
			/^ {0,3}$/.test(text.slice(text.lastIndexOf("\n", open - 1) + 1, open));
		if (!definition && text[labelEnd + 1] !== "(") return null;
		let cursor = labelEnd + 2;
		while (/[ \t]/.test(text[cursor] ?? "\n")) cursor++;
		const target = destination(text, cursor);
		if (target == null) return null;
		pathStart = target.start;
		pathEnd = target.end;
		cursor = target.next;
		while (/[ \t]/.test(text[cursor] ?? "\n")) cursor++;
		if (cursor > target.next && ['"', "'", "("].includes(text[cursor])) {
			const closing = text[cursor] === "(" ? ")" : text[cursor];
			cursor++;
			while (cursor < text.length && (text[cursor] !== closing || escaped(text, cursor))) cursor++;
			if (cursor === text.length) return null;
			cursor++;
			while (/[ \t]/.test(text[cursor] ?? "\n")) cursor++;
		}
		if (definition) {
			if (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "\r") return null;
			close = cursor;
			syntax = "definition";
		} else {
			if (text[cursor] !== ")") return null;
			close = cursor + 1;
			syntax = "markdown";
		}
	}
	if (pathEnd === pathStart) return null;
	return {
		start, end: close, name, syntax,
		path: text.slice(pathStart, pathEnd).replace(/\\([\\()[\]<> ])/g, "$1"),
		raw: text.slice(start, close),
		targetStart: pathStart - start,
		targetEnd: pathEnd - start,
	};
}

/** Scan editable links, excluding fenced/indented code, inline code and comments. */
export function matchLinks(content: string): LinkInfo[] {
	const links: LinkInfo[] = [];
	let fence: { char: string; length: number } | undefined;
	for (let i = 0; i < content.length; i++) {
		if (i === 0 || content[i - 1] === "\n") {
			const end = content.indexOf("\n", i);
			const lineEnd = end < 0 ? content.length : end;
			const line = content.slice(i, lineEnd);
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence != null) {
				if (marker != null && marker[1][0] === fence.char &&
					marker[1].length >= fence.length && marker[2].trim() === "") fence = undefined;
				i = lineEnd;
				continue;
			}
			if (marker != null) {
				fence = { char: marker[1][0], length: marker[1].length };
				i = lineEnd;
				continue;
			}
			if (/^(?: {4}|\t)/.test(line)) {
				i = lineEnd;
				continue;
			}
		}
		if (content.startsWith("<!--", i)) {
			const end = content.indexOf("-->", i + 4);
			i = end < 0 ? content.length : end + 2;
			continue;
		}
		if (escaped(content, i)) continue;
		if (content[i] === "`") {
			let length = 1;
			while (content[i + length] === "`") length++;
			let end = i + length;
			while ((end = content.indexOf("`".repeat(length), end)) >= 0) {
				if (content[end - 1] !== "`" && content[end + length] !== "`") break;
				end += length;
			}
			i = end < 0 ? i + length - 1 : end + length - 1;
			continue;
		}
		if (content[i] !== "[") continue;
		const link = scanLink(content, i);
		if (link == null) continue;
		links.push(link);
		i = link.end - 1;
	}
	return links.reverse();
}

export function replaceLinkTarget(link: LinkInfo, target: string): string {
	if (link.targetStart == null || link.targetEnd == null) {
		throw new Error("Link has no verified target range.");
	}
	return link.raw.slice(0, link.targetStart) + target + link.raw.slice(link.targetEnd);
}

/** Preserve aliases, image sizes, titles and reference definitions where possible. */
export function formatLinkReplacement(original: LinkInfo, generated: string): string {
	const replacement = matchLinks(generated)[0];
	if (replacement == null) throw new Error("Generated link is invalid.");
	let target = replacement.raw.slice(replacement.targetStart, replacement.targetEnd);
	const fragmentIndex = original.path.indexOf("#");
	if (fragmentIndex >= 0 && !target.includes("#")) target += original.path.slice(fragmentIndex);
	if (original.syntax === "definition" || original.syntax === replacement.syntax) {
		return replaceLinkTarget(original, target);
	}
	const updated = replaceLinkTarget(replacement, target);
	return original.raw.startsWith("!")
		? (updated.startsWith("!") ? updated : "!" + updated)
		: updated.replace(/^!/, "");
}
