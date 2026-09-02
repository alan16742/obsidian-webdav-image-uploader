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
	// A link with an explicit `./` or `../` resolves against the note's folder;
	// a bare path resolves against the WebDAV root so it maps onto the uploaded
	// remote path unchanged.
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

/**
 * Normalize a vault-absolute path without adding a leading slash.
 *
 * Template paths and WebDAV paths use this canonical representation. Local
 * link prefixes such as `../` and `/` are added only when a note link is
 * formatted, so they can never leak into the remote path.
 */
export function normalizeVaultPath(source: string): string {
	const segments: string[] = [];
	for (const segment of source.replace(/\\/g, "/").split("/")) {
		const decodedSegment = safeDecodeURIComponent(segment);
		if (decodedSegment === "" || decodedSegment === ".") continue;
		if (decodedSegment === "..") {
			if (segments.length === 0) {
				throw new Error("Path cannot escape the vault root.");
			}
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/");
}

export function isBareAttachmentPath(source: string): boolean {
	const path = source
		.split("#", 1)[0]
		.split("?", 1)[0]
		.replace(/\\/g, "/");
	return path !== "" && !path.includes("/");
}

export function stripFragment(source: string): string {
	const fragmentIndex = source.indexOf("#");
	return fragmentIndex === -1 ? source : source.substring(0, fragmentIndex);
}

export function getFragment(source: string): string {
	const fragmentIndex = source.indexOf("#");
	return fragmentIndex === -1 ? "" : source.substring(fragmentIndex);
}

export function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
