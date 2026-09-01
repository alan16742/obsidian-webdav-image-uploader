const DIRECT_MEDIA_EMBED_CLASS = "webdav-direct-media-embed";
const STANDALONE_MEDIA_LINE_CLASS = "webdav-standalone-media-line";

export class EditorMediaLayout {
	private readonly measuredElements = new WeakSet<Element>();
	private readonly markedEmbeds = new Set<HTMLElement>();

	constructor(private readonly requestEditorMeasure?: () => void) {}

	mark(element: Element): boolean {
		const embed = element.closest<HTMLElement>(
			".image-embed, .media-embed",
		);
		const line = embed == null ? null : getContainingEditorLine(embed);
		if (embed == null || line == null) return false;

		// Layout follows the rendered editor role, not WebDAV ownership. Public
		// direct links do not need proxying, but Obsidian still renders them as
		// inline CodeMirror widgets and they need the same line normalization as
		// authenticated links that are replaced with blob URLs.
		embed.classList.add(DIRECT_MEDIA_EMBED_CLASS);
		this.markedEmbeds.add(embed);
		refreshMediaLine(line);
		return true;
	}

	observeSize(element: Element) {
		if (
			this.requestEditorMeasure == null ||
			this.measuredElements.has(element)
		) {
			return;
		}

		const eventName = element.tagName === "IMG"
			? "load"
			: element.tagName === "VIDEO" || element.tagName === "AUDIO"
				? "loadedmetadata"
				: undefined;
		if (eventName == null) return;

		this.measuredElements.add(element);
		element.addEventListener(
			eventName,
			() => this.requestEditorMeasure?.(),
			{ once: true },
		);
		this.requestEditorMeasure();
	}

	addAffectedLine(node: Node, lines: Set<HTMLElement>) {
		const line = getContainingEditorLine(node);
		if (line != null) lines.add(line);
	}

	refreshLines(lines: Iterable<HTMLElement>) {
		for (const line of lines) refreshMediaLine(line);
	}

	releaseTree(root: Element) {
		const embeds = root.matches(`.${DIRECT_MEDIA_EMBED_CLASS}`)
			? [root]
			: Array.from(
				root.querySelectorAll(`.${DIRECT_MEDIA_EMBED_CLASS}`),
			);
		for (const embed of embeds) {
			this.markedEmbeds.delete(embed as HTMLElement);
		}
	}

	restoreEmbed(embed: HTMLElement) {
		this.markedEmbeds.delete(embed);
		const line = getContainingEditorLine(embed);
		if (line != null) refreshMediaLine(line);
		this.requestEditorMeasure?.();
	}

	requestMeasure() {
		this.requestEditorMeasure?.();
	}

	dispose() {
		for (const embed of this.markedEmbeds) {
			const line = getContainingEditorLine(embed);
			embed.classList.remove(DIRECT_MEDIA_EMBED_CLASS);
			if (line != null) refreshMediaLine(line);
		}
		this.markedEmbeds.clear();
	}
}

function getContainingEditorLine(node: Node): HTMLElement | null {
	const element = isElement(node) ? node : node.parentElement;
	const line = element?.closest<HTMLElement>(".cm-line") ?? null;
	return line?.parentElement?.classList.contains("cm-content") ? line : null;
}

function refreshMediaLine(line: HTMLElement) {
	const directEmbeds = Array.from(line.children).filter((child) =>
		child.classList.contains(DIRECT_MEDIA_EMBED_CLASS),
	);
	const isStandalone = directEmbeds.length === 1 &&
		Array.from(line.childNodes).every((node) => {
			if (node.nodeType === 3) return node.textContent?.trim() === "";
			return isElement(node) && (
				node.classList.contains("cm-widgetBuffer") ||
				node.classList.contains(DIRECT_MEDIA_EMBED_CLASS)
			);
		});
	line.classList.toggle(STANDALONE_MEDIA_LINE_CLASS, isStandalone);
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}
