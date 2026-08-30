import {
	EditorView,
	PluginValue,
	ViewPlugin,
} from "@codemirror/view";
import { MarkdownRenderChild } from "obsidian";
import type WebDavImageUploaderPlugin from "../main";
import { WebDavBlobStore, type BlobHandle } from "../lib/webDavBlobStore";
import {
	buildManagedUrl,
	findUploadRule,
	getEffectiveUrlPrefix,
	getFileNameParts,
} from "../lib/uploadRules";

export type MediaType = "image" | "video" | "audio";

const MISSING_ATTACHMENT_SELECTOR =
	".internal-embed.mod-empty-attachment[src]";

const MEDIA_EXTENSIONS: Record<MediaType, Set<string>> = {
	image: new Set([
		"avif",
		"bmp",
		"gif",
		"ico",
		"jpeg",
		"jpg",
		"png",
		"svg",
		"webp",
	]),
	video: new Set([
		"avi",
		"m4v",
		"mkv",
		"mov",
		"mp4",
		"ogv",
		"webm",
	]),
	audio: new Set([
		"aac",
		"flac",
		"m4a",
		"mp3",
		"oga",
		"ogg",
		"opus",
		"wav",
	]),
};

export interface MediaAdapter {
	selector: string;
	matches(element: Element): boolean;
	getSource(element: Element): string;
	setLoading(element: Element): void;
	setSource(element: Element, source: string): void;
	restoreSource(element: Element, source: string): void;
	setError(element: Element, error: unknown): void;
	clearState(element: Element): void;
}

interface ElementBinding {
	adapter: MediaAdapter;
	originalUrl: string;
	displayedUrl: string;
	handle?: BlobHandle;
	phase: "loading" | "loaded" | "error";
}

class MediaDomBinding {
	private readonly bindings = new Map<Element, ElementBinding>();
	private readonly transforms = new Map<Element, () => void>();
	private readonly observer?: MutationObserver;
	private disposed = false;

	constructor(
		container: HTMLElement,
		private readonly loader: WebDavMediaLoader,
		observe: boolean,
	) {
		if (observe) {
			const MutationObserverClass =
				container.ownerDocument.defaultView?.MutationObserver ??
				MutationObserver;
			this.observer = new MutationObserverClass((mutations) => {
				this.handleMutations(mutations);
			});
			this.observer.observe(container, {
				attributes: true,
				attributeFilter: ["class", "src"],
				childList: true,
				subtree: true,
			});
		}

		this.scan(container);
	}

	dispose(restoreSources = false) {
		if (this.disposed) return;
		this.disposed = true;
		this.observer?.disconnect();

		for (const [element, binding] of this.bindings) {
			this.releaseBinding(element, binding, restoreSources);
		}
		this.bindings.clear();

		if (restoreSources) {
			for (const restore of this.transforms.values()) {
				restore();
			}
		}
		this.transforms.clear();
		this.loader.removeMount(this);
	}

	private handleMutations(mutations: MutationRecord[]) {
		if (this.disposed) return;

		// Release removed trees first. If CodeMirror moves a node, scan() below
		// sees its restored original URL and acquires the shared blob again.
		for (const mutation of mutations) {
			if (mutation.type !== "childList") continue;
			mutation.removedNodes.forEach((node) => {
				if (isElement(node)) {
					this.releaseTree(node, true);
				}
			});
		}

		for (const mutation of mutations) {
			if (mutation.type === "attributes") {
				if (isElement(mutation.target)) {
					void this.processElement(mutation.target);
				}
				continue;
			}

			mutation.addedNodes.forEach((node) => {
				if (isElement(node)) {
					this.scan(node);
				}
			});
		}
	}

	private scan(root: Element) {
		const selector = this.loader.selector;
		if (root.matches(selector)) {
			void this.processElement(root);
		}
		root.querySelectorAll(selector).forEach((element) => {
			void this.processElement(element);
		});
	}

	private async processElement(element: Element) {
		if (this.disposed) return;

		const preparedElement = this.prepareElement(element);
		if (preparedElement == null) return;
		element = preparedElement;

		const adapter = this.loader.getAdapter(element);
		if (adapter == null) return;

		const currentUrl = adapter.getSource(element);
		const existing = this.bindings.get(element);
		if (existing != null) {
			if (currentUrl === existing.displayedUrl) return;

			// The renderer reused this DOM node for another link.
			this.releaseBinding(element, existing, false);
			this.bindings.delete(element);
		}

		if (!this.loader.shouldProxy(currentUrl)) return;

		const binding: ElementBinding = {
			adapter,
			originalUrl: currentUrl,
			displayedUrl: currentUrl,
			phase: "loading",
		};
		this.bindings.set(element, binding);

		adapter.setLoading(element);
		binding.displayedUrl = adapter.getSource(element);

		try {
			const handle = await this.loader.blobStore.acquire(currentUrl);
			if (
				this.disposed ||
				this.bindings.get(element) !== binding
			) {
				handle.release();
				return;
			}

			binding.handle = handle;
			binding.phase = "loaded";
			binding.displayedUrl = handle.src;
			adapter.setSource(element, handle.src);
			binding.displayedUrl = adapter.getSource(element);
		} catch (error) {
			if (this.bindings.get(element) !== binding) return;

			binding.phase = "error";
			binding.displayedUrl = binding.originalUrl;
			adapter.restoreSource(element, binding.originalUrl);
			adapter.setError(element, error);
			binding.displayedUrl = adapter.getSource(element);
			console.error(
				`Failed to load WebDAV media: '${binding.originalUrl}'`,
				error,
			);
		}
	}

	private prepareElement(element: Element): Element | undefined {
		if (element.matches(MISSING_ATTACHMENT_SELECTOR)) {
			return this.prepareMissingAttachment(element as HTMLElement);
		}

		const adapter = this.loader.getAdapter(element);
		if (adapter == null) return;

		const sourceUrl = adapter.getSource(element);
		const mediaType = getMediaType(sourceUrl);
		if (
			element.tagName !== "IMG" ||
			mediaType == null ||
			mediaType === "image"
		) {
			return element;
		}

		return this.replaceImageWithMedia(
			element as HTMLImageElement,
			mediaType,
			sourceUrl,
		);
	}

	private prepareMissingAttachment(
		container: HTMLElement,
	): Element | undefined {
		const sourcePath = container.getAttribute("src")?.trim();
		if (sourcePath == null || sourcePath === "") return;

		const mediaType = getMediaType(sourcePath);
		if (mediaType == null) return;

		const sourceUrl = this.loader.resolveMissingAttachment(sourcePath);
		if (sourceUrl == null) return;

		const originalChildren = Array.from(container.childNodes);
		const originalClassName = container.className;
		const media = createMediaElement(
			container.ownerDocument,
			mediaType,
			sourceUrl,
		);
		media.setAttribute("aria-label", getFileNameParts(sourcePath).nameext);

		setMediaEmbedClasses(container, mediaType);
		container.replaceChildren(media);

		this.transforms.set(media, () => {
			if (media.parentElement !== container) return;
			container.replaceChildren(...originalChildren);
			container.className = originalClassName;
		});
		return media;
	}

	private replaceImageWithMedia(
		image: HTMLImageElement,
		mediaType: Exclude<MediaType, "image">,
		sourceUrl: string,
	): Element {
		const media = createMediaElement(
			image.ownerDocument,
			mediaType,
			sourceUrl,
		);
		copyMediaPresentation(image, media);

		const wrapper = image.parentElement;
		const embed = wrapper?.closest<HTMLElement>(".image-embed");
		if (embed != null && wrapper?.parentElement === embed) {
			const originalChildren = Array.from(embed.childNodes);
			const originalClassName = embed.className;
			setMediaEmbedClasses(embed, mediaType);
			embed.replaceChildren(media);

			this.transforms.set(media, () => {
				if (media.parentElement !== embed) return;
				embed.replaceChildren(...originalChildren);
				embed.className = originalClassName;
			});
			return media;
		}

		wrapper?.classList.add("webdav-media-wrapper");
		image.replaceWith(media);

		this.transforms.set(media, () => {
			if (media.parentNode == null) return;
			media.replaceWith(image);
			wrapper?.classList.remove("webdav-media-wrapper");
		});
		return media;
	}

	private releaseTree(root: Element, restoreSource: boolean) {
		const binding = this.bindings.get(root);
		if (binding != null) {
			this.releaseBinding(root, binding, restoreSource);
			this.bindings.delete(root);
		}

		root.querySelectorAll(this.loader.selector).forEach((element) => {
			const childBinding = this.bindings.get(element);
			if (childBinding == null) return;
			this.releaseBinding(element, childBinding, restoreSource);
			this.bindings.delete(element);
		});

		for (const [element, restore] of Array.from(this.transforms)) {
			if (element !== root && !root.contains(element)) continue;
			if (restoreSource) restore();
			this.transforms.delete(element);
		}
	}

	private releaseBinding(
		element: Element,
		binding: ElementBinding,
		restoreSource: boolean,
	) {
		if (restoreSource && binding.phase !== "error") {
			binding.adapter.restoreSource(element, binding.originalUrl);
		}
		binding.adapter.clearState(element);
		binding.handle?.release();
	}
}

export class WebDavMediaLoader {
	readonly blobStore: WebDavBlobStore;
	readonly selector: string;
	private readonly mounts = new Set<MediaDomBinding>();
	private destroyed = false;

	constructor(
		private readonly plugin: WebDavImageUploaderPlugin,
		private readonly adapters: MediaAdapter[],
	) {
		this.blobStore = new WebDavBlobStore(plugin.client);
		this.selector = [
			...adapters.map((adapter) => adapter.selector),
			MISSING_ATTACHMENT_SELECTOR,
		].join(",");
	}

	mount(container: HTMLElement, observe: boolean): () => void {
		if (this.destroyed) return () => undefined;
		const mount = new MediaDomBinding(container, this, observe);
		this.mounts.add(mount);
		return () => mount.dispose();
	}

	mountMarkdown(container: HTMLElement): MarkdownRenderChild {
		return new WebDavMediaRenderChild(container, this);
	}

	getAdapter(element: Element): MediaAdapter | undefined {
		return this.adapters.find((adapter) => adapter.matches(element));
	}

	resolveMissingAttachment(sourcePath: string): string | undefined {
		if (hasUrlScheme(sourcePath)) return;

		const rule = findUploadRule(this.plugin.settings.uploadRules, sourcePath);
		if (rule == null) return;

		const urlPrefix = getEffectiveUrlPrefix(
			rule,
			this.plugin.settings.url,
		);
		const remotePath = normalizeAttachmentPath(sourcePath);
		if (urlPrefix === "" || remotePath === "/") return;

		return buildManagedUrl(urlPrefix, remotePath) + getFragment(sourcePath);
	}

	shouldProxy(url: string): boolean {
		const { disableBasicAuth, username, password } = this.plugin.settings;
		return (
			url !== "" &&
			!disableBasicAuth &&
			Boolean(username && password) &&
			this.plugin.isWebdavUrl(url)
		);
	}

	removeMount(mount: MediaDomBinding) {
		this.mounts.delete(mount);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const mount of Array.from(this.mounts)) {
			mount.dispose(true);
		}
		this.blobStore.destroy();
	}
}

class WebDavMediaRenderChild extends MarkdownRenderChild {
	private disposeMount?: () => void;
	private mountTimer?: number;

	constructor(
		containerEl: HTMLElement,
		private readonly loader: WebDavMediaLoader,
	) {
		super(containerEl);
	}

	onload() {
		// Reading view builds and recycles its sections asynchronously. Mutating a
		// section inside the post-processor call can prevent the renderer from
		// committing it. Mount on the next task and observe subsequent embed
		// resolution, matching Obsidian's section lifecycle.
		this.mountTimer = window.setTimeout(() => {
			this.mountTimer = undefined;
			this.disposeMount = this.loader.mount(this.containerEl, true);
		}, 0);
	}

	onunload() {
		if (this.mountTimer != null) {
			window.clearTimeout(this.mountTimer);
			this.mountTimer = undefined;
		}
		this.disposeMount?.();
		this.disposeMount = undefined;
	}
}

class WebDavMediaLoaderExtension implements PluginValue {
	private readonly disposeMount: () => void;

	constructor(view: EditorView, loader: WebDavMediaLoader) {
		this.disposeMount = loader.mount(view.dom, true);
	}

	destroy() {
		this.disposeMount();
	}
}

export function createWebDavMediaExtension(loader: WebDavMediaLoader) {
	return ViewPlugin.define(
		(view) => new WebDavMediaLoaderExtension(view, loader),
	);
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}

export function getMediaType(source: string): MediaType | undefined {
	const { extension } = getFileNameParts(source);
	return (Object.keys(MEDIA_EXTENSIONS) as MediaType[]).find((mediaType) =>
		MEDIA_EXTENSIONS[mediaType].has(extension),
	);
}

function createMediaElement(
	document: Document,
	mediaType: Exclude<MediaType, "image">,
	source: string,
): HTMLVideoElement | HTMLAudioElement;
function createMediaElement(
	document: Document,
	mediaType: MediaType,
	source: string,
): HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
function createMediaElement(
	document: Document,
	mediaType: MediaType,
	source: string,
): HTMLImageElement | HTMLVideoElement | HTMLAudioElement {
	const element = document.createElement(
		mediaType === "image" ? "img" : mediaType,
	);
	element.src = source;
	if (mediaType !== "image") {
		const media = element as HTMLMediaElement;
		media.controls = true;
		media.preload = "metadata";
	}
	return element;
}

function copyMediaPresentation(
	image: HTMLImageElement,
	media: HTMLVideoElement | HTMLAudioElement,
) {
	media.className = image.className;
	const label = image.alt || image.getAttribute("aria-label");
	if (label) media.setAttribute("aria-label", label);
	for (const attribute of ["width", "height", "style"] as const) {
		const value = image.getAttribute(attribute);
		if (value != null) media.setAttribute(attribute, value);
	}
}

function setMediaEmbedClasses(
	container: HTMLElement,
	mediaType: MediaType,
) {
	container.classList.remove(
		"file-embed",
		"image-embed",
		"mod-empty-attachment",
	);
	container.classList.add(
		"media-embed",
		`${mediaType}-embed`,
		"webdav-media-embed",
		`webdav-${mediaType}-embed`,
	);
}

function hasUrlScheme(source: string): boolean {
	return /^[a-z][a-z\d+.-]*:/i.test(source.trim());
}

function normalizeAttachmentPath(source: string): string {
	const path = source
		.split("#", 1)[0]
		.split("?", 1)[0]
		.replace(/\\/g, "/");
	const segments: string[] = [];
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

function getFragment(source: string): string {
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
