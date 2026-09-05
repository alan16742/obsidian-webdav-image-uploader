import {
	ViewPlugin,
	type EditorView,
	type PluginValue,
} from "@codemirror/view";
import { MarkdownRenderChild, MarkdownView } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";
import { WebDavBlobStore } from "../../lib/webdavClient/webdavBlobStore";
import {
	buildManagedUrl,
	findPreviewRule,
	getFileNameParts,
	getEffectiveUrlPrefix,
	resolveBareUploadPath,
	normalizeRemotePath,
} from "../../lib/attachment/uploadRules";
import {
	MediaDomBinding,
	type MediaDomLoader,
	MISSING_ATTACHMENT_SELECTOR,
} from "./mediaDomBinding";
import {
	getFragment,
	hasUrlScheme,
	isBareAttachmentPath,
	normalizeAttachmentPath,
} from "../../lib/attachment/attachmentPaths";
import { getAttachmentFolderPath } from "../../lib/attachment/obsidianPaths";

export { imageMediaAdapter } from "./imageLoader";
export { videoMediaAdapter } from "./videoLoader";
export { audioMediaAdapter } from "./audioLoader";
export { getMediaType } from "../../lib/attachment/fileTypes";
export type { MediaType } from "../../lib/attachment/fileTypes";

export interface MediaAdapter {
	selector: string;
	matches(element: Element): boolean;
	getSource(element: Element): string;
	setSource(element: Element, source: string): void;
	restoreSource(element: Element, source: string): void;
}

export class WebDavMediaLoader implements MediaDomLoader {
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

	mount(
		container: HTMLElement,
		observe: boolean,
		sourcePath: string | (() => string) = "",
		requestMeasure?: () => void,
	): () => void {
		if (this.destroyed) return () => undefined;
		const getSourcePath = typeof sourcePath === "function"
			? sourcePath
			: () => sourcePath;
		const mount = new MediaDomBinding(
			container,
			this,
			observe,
			getSourcePath,
			requestMeasure,
		);
		this.mounts.add(mount);
		return () => {
			mount.dispose();
			this.mounts.delete(mount);
		};
	}

	mountMarkdown(
		container: HTMLElement,
		sourcePath: string,
	): MarkdownRenderChild {
		return new WebDavMediaRenderChild(container, this, sourcePath);
	}

	getAdapter(element: Element): MediaAdapter | undefined {
		return this.adapters.find((adapter) => adapter.matches(element));
	}

	async resolveMissingAttachment(
		linkPath: string,
		sourcePath = "",
	): Promise<string | undefined> {
		if (hasUrlScheme(linkPath)) return;

		const rule = findPreviewRule(this.plugin.settings.uploadRules, linkPath);
		if (rule == null) return;

		const urlPrefix = getEffectiveUrlPrefix(
			rule,
			this.plugin.settings.url,
		);
		let resolvedLinkPath = linkPath;
		let remotePath: string;
		if (isBareAttachmentPath(linkPath)) {
			const fileName = getFileNameParts(linkPath).nameext;
			const attachmentFolder = await getAttachmentFolderPath(
				this.plugin.app,
				sourcePath,
				fileName,
			);
			resolvedLinkPath = resolveBareUploadPath(
				rule,
				fileName,
				attachmentFolder,
			) ?? "";
			remotePath = normalizeRemotePath(resolvedLinkPath);
		} else {
			remotePath = normalizeAttachmentPath(resolvedLinkPath, sourcePath);
		}
		if (resolvedLinkPath === "") return;
		if (urlPrefix === "" || remotePath === "/") return;

		return buildManagedUrl(urlPrefix, remotePath) + getFragment(linkPath);
	}

	getMarkdownSourcePath(container: HTMLElement): string {
		const leaf = this.plugin.app.workspace
			.getLeavesOfType("markdown")
			.find(({ view }) => view.containerEl.contains(container));
		return leaf?.view instanceof MarkdownView
			? leaf.view.file?.path ?? ""
			: this.plugin.app.workspace.getActiveFile()?.path ?? "";
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

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const mount of this.mounts) {
			mount.dispose(true);
		}
		this.mounts.clear();
		this.blobStore.destroy();
	}
}

class WebDavMediaRenderChild extends MarkdownRenderChild {
	private disposeMount?: () => void;
	private mountTimer?: number;

	constructor(
		containerEl: HTMLElement,
		private readonly loader: WebDavMediaLoader,
		private readonly sourcePath: string,
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
			this.disposeMount = this.loader.mount(
				this.containerEl,
				true,
				this.sourcePath,
			);
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
		this.disposeMount = loader.mount(
			view.dom,
			true,
			() => loader.getMarkdownSourcePath(view.dom),
			() => view.requestMeasure(),
		);
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
