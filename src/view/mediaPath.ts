export function hasUrlScheme(source: string): boolean {
	return /^[a-z][a-z\d+.-]*:/i.test(source.trim());
}

export function normalizeAttachmentPath(
	source: string,
	notePath: string,
): string {
	const path = source
		.split("#", 1)[0]
		.split("?", 1)[0]
		.replace(/\\/g, "/");
	const isExplicitlyRelative = /^\.{1,2}(?:\/|$)/.test(path);
	const segments = isExplicitlyRelative
		? notePath
			.replace(/\\/g, "/")
			.split("/")
			.slice(0, -1)
			.filter(Boolean)
		: [];
	for (const segment of path.split("/")) {
		const decodedSegment = safeDecodeURIComponent(segment);
		if (decodedSegment === "" || decodedSegment === ".") continue;
		if (decodedSegment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return "/" + segments.join("/");
}

export function getFragment(source: string): string {
	const fragmentIndex = source.indexOf("#");
	return fragmentIndex === -1 ? "" : source.substring(fragmentIndex);
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
