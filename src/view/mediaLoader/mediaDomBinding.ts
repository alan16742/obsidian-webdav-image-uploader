import { WebDavBlobStore, type BlobHandle } from "../../lib/webdavClient/webdavBlobStore";
import { getMediaType, type MediaType } from "../../lib/attachment/fileTypes";
import { getFileNameParts } from "../../lib/attachment/uploadRules";
import { EditorMediaLayout } from "./editorMediaLayout";
import type { MediaAdapter } from ".";
import {
	copyMediaPresentation,
	createMediaElement,
	setMediaEmbedClasses,
} from "./mediaElements";

export const MISSING_ATTACHMENT_SELECTOR =
	".internal-embed.mod-empty-attachment[src]";

export interface MediaDomLoader {
	readonly blobStore: WebDavBlobStore;
	readonly selector: string;
	getAdapter(element: Element): MediaAdapter | undefined;
	resolveMissingAttachment(
		linkPath: string,
		sourcePath?: string,
	): Promise<string | undefined>;
	shouldProxy(url: string): boolean;
}

interface ElementBinding {
	adapter: MediaAdapter;
	originalUrl: string;
	displayedUrl: string;
	handle?: BlobHandle;
}

export class MediaDomBinding {
	private readonly bindings = new Map<Element, ElementBinding>();
	private readonly transforms = new Map<Element, () => void>();
	private readonly missingPreparations = new WeakMap<
		HTMLElement,
		{ source: string | null; sourcePath: string; pending: Promise<Element | undefined> }
	>();
	private readonly editorLayout: EditorMediaLayout;
	private readonly observer?: MutationObserver;
	private disposed = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly loader: MediaDomLoader,
		observe: boolean,
		private readonly getSourcePath: () => string,
		requestMeasure?: () => void,
	) {
		this.editorLayout = new EditorMediaLayout(requestMeasure);
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

	dispose(restoreSources = true) {
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
		this.editorLayout.dispose();
	}

	private handleMutations(mutations: MutationRecord[]) {
		if (this.disposed) return;
		const affectedLines = new Set<HTMLElement>();

		// Release removed trees first. If CodeMirror moves a node, scan() below
		// sees its restored original URL and acquires the shared blob again.
		for (const mutation of mutations) {
			this.editorLayout.addAffectedLine(mutation.target, affectedLines);
			if (mutation.type !== "childList") continue;
			mutation.removedNodes.forEach((node) => {
				if (isElement(node)) {
					this.editorLayout.releaseTree(node);
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
					this.editorLayout.addAffectedLine(node, affectedLines);
					this.scan(node);
				}
			});
		}

		this.editorLayout.refreshLines(affectedLines);
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
		try { await this.bindElement(element); }
		catch (error) {
			if (!this.disposed) console.error("Failed to prepare WebDAV media", error);
		}
	}

	private async bindElement(element: Element) {
		if (this.disposed || !this.container.contains(element)) return;

		const preparedElement = await this.prepareElement(element);
		if (preparedElement == null) return;
		if (this.disposed || !this.container.contains(preparedElement)) return;
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

		if (this.editorLayout.mark(element)) {
			this.editorLayout.observeSize(element);
		}
		if (!this.loader.shouldProxy(currentUrl)) return;

		const binding: ElementBinding = {
			adapter,
			originalUrl: currentUrl,
			displayedUrl: currentUrl,
		};
		this.bindings.set(element, binding);

		try {
			const handle = await this.loader.blobStore.acquire(currentUrl);
			if (
				this.disposed ||
				this.bindings.get(element) !== binding || !this.container.contains(element) ||
				adapter.getSource(element) !== binding.displayedUrl
			) {
				handle.release();
				if (this.bindings.get(element) === binding) this.bindings.delete(element);
				return;
			}

			binding.handle = handle;
			binding.displayedUrl = handle.src;
			adapter.setSource(element, handle.src);
			binding.displayedUrl = adapter.getSource(element);
		} catch (error) {
			if (this.bindings.get(element) !== binding) return;

			binding.handle?.release();
			this.bindings.delete(element);
			console.error(
				`Failed to load WebDAV media: '${binding.originalUrl}'`,
				error,
			);
		}
	}

	private async prepareElement(element: Element): Promise<Element | undefined> {
		if (element.matches(MISSING_ATTACHMENT_SELECTOR)) {
			return await this.prepareMissingAttachmentOnce(
				element as HTMLElement,
			);
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

	private async prepareMissingAttachmentOnce(
		container: HTMLElement,
	): Promise<Element | undefined> {
		const existing = this.missingPreparations.get(container);
		const source = container.getAttribute("src");
		const sourcePath = this.getSourcePath();
		if (existing != null && existing.source === source && existing.sourcePath === sourcePath) return await existing.pending;

		const preparation = this.prepareMissingAttachment(container);
		this.missingPreparations.set(container, { source, sourcePath, pending: preparation });
		try {
			return await preparation;
		} finally {
			if (this.missingPreparations.get(container)?.pending === preparation) {
				this.missingPreparations.delete(container);
			}
		}
	}

	private async prepareMissingAttachment(
		container: HTMLElement,
	): Promise<Element | undefined> {
		const sourcePath = container.getAttribute("src")?.trim();
		if (sourcePath == null || sourcePath === "") return;

		const mediaType = getMediaType(sourcePath);
		if (mediaType == null) return;

		const notePath = this.getSourcePath();
		const sourceUrl = await this.loader.resolveMissingAttachment(
			sourcePath,
			notePath,
		);
		if (sourceUrl == null) return;
		if (this.disposed || !this.container.contains(container) ||
			container.getAttribute("src")?.trim() !== sourcePath || this.getSourcePath() !== notePath ||
			!container.matches(MISSING_ATTACHMENT_SELECTOR)) {
			return;
		}

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
			this.editorLayout.requestMeasure();

			this.transforms.set(media, () => {
				if (media.parentElement !== embed) return;
				embed.replaceChildren(...originalChildren);
				embed.className = originalClassName;
				this.editorLayout.restoreEmbed(embed);
			});
			return media;
		}

		image.replaceWith(media);
		this.editorLayout.requestMeasure();

		this.transforms.set(media, () => {
			if (media.parentNode == null) return;
			media.replaceWith(image);
			this.editorLayout.requestMeasure();
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
		if (restoreSource && binding.adapter.getSource(element) === binding.displayedUrl) {
			binding.adapter.restoreSource(element, binding.originalUrl);
		}
		binding.handle?.release();
	}
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}
