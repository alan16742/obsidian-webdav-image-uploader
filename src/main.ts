import {
	Notice,
	Platform,
	Plugin,
	TFile,
	TFolder,
	type Editor,
	type Menu,
	type TAbstractFile,
} from "obsidian";
import type { MarkdownFileInfo } from "obsidian";
import { WebDavClient } from "./lib/webdavClient";
import {
	createWebDavMediaExtension,
	WebDavMediaLoader,
	imageMediaAdapter,
	videoMediaAdapter,
	audioMediaAdapter,
} from "./view/mediaLoader";
import { getCurrentEditor, reportTask } from "./utils";
import {
	sanitizeSettings,
	WebDavImageUploaderSettingTab,
	type WebDavImageUploaderSettings,
} from "./settings";
import { BatchDownloader, BatchUploader } from "./lib/batch";
import { ConfirmModal } from "./view/modals/confirmModal";
import { findUploadRule, isManagedUrl } from "./lib/attachment/uploadRules";
import { EditorActions } from "./lib/note/editorActions";

export default class WebDavImageUploaderPlugin extends Plugin {
	settings!: WebDavImageUploaderSettings;
	client!: WebDavClient;
	mediaLoader!: WebDavMediaLoader;
	private editorActions!: EditorActions;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new WebDavImageUploaderSettingTab(this.app, this));

		this.client = new WebDavClient(this);
		this.editorActions = new EditorActions(this);

		this.mediaLoader = new WebDavMediaLoader(this, [
			imageMediaAdapter,
			videoMediaAdapter,
			audioMediaAdapter,
		]);

		this.addCommand({
			id: "toggle-auto-upload",
			name: "Toggle auto upload",
			callback: () => { void reportTask(() => this.toggleAutoUpload()); },
		});

		// upload file when pasted or dropped
		this.registerEvent(
			this.app.workspace.on("editor-paste", this.onUploadFile.bind(this)),
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.onUploadFile.bind(this)),
		);

		// register right click menu items when clicking on image link
		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				this.onRightClickLink.bind(this),
			),
		);
		// on mobile platform, obsidian is not trigger `editor-menu` event on right-clicking the url,
		// and trigger `url-menu` event instead
		if (Platform.isMobile) {
			this.registerEvent(
				this.app.workspace.on("url-menu", (menu) => {
					const editor = getCurrentEditor(this.app);
					if (editor) {
						this.onRightClickLink(menu, editor);
					}
				}),
			);
		}

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, source) => {
				// obsidian is not trigger `editor-menu` event on mobile platform,
				// and only trigger `link-context-menu` event
				if (Platform.isMobile && source === "link-context-menu") {
					const editor = getCurrentEditor(this.app);
					if (editor) {
						return this.onRightClickLink(menu, editor);
					}
					return;
				}

				// register right click menu items in file explorer
				if (source === "file-explorer-context-menu") {
					void this.onRightClickExplorer(menu, file);
				}
			}),
		);

		// Replace protected WebDAV media sources with authenticated blob URLs.
		// The loader stays registered so settings changes apply to newly rendered
		// media without patching the global fetch implementation.
		this.registerEditorExtension(
			createWebDavMediaExtension(this.mediaLoader),
		);
		this.registerMarkdownPostProcessor((el, context) => {
			context.addChild(
				this.mediaLoader.mountMarkdown(el, context.sourcePath),
			);
		}, 0);
	}

	onunload() {
		this.editorActions?.destroy();
		this.mediaLoader?.destroy();
	}

	async loadSettings() {
		this.settings = sanitizeSettings(await this.loadData());

		if (this.client != null) {
			this.client.initClient();
		}
	}

	async saveSettings() {
		await this.saveData(sanitizeSettings(this.settings));
		this.client.initClient();
	}

	async toggleAutoUpload() {
		this.settings.enableUpload = !this.settings.enableUpload;
		await this.saveSettings();
		new Notice(
			`Auto upload is ${this.settings.enableUpload ? "enabled" : "disabled"
			}.`,
		);
	}

	onUploadFile(event: ClipboardEvent | DragEvent, editor: Editor, info?: MarkdownFileInfo) {
		return this.editorActions.pasteOrDrop(event, editor, info);
	}

	onRightClickLink(menu: Menu, editor: Editor, info?: MarkdownFileInfo) {
		this.editorActions.addMenu(menu, editor, info);
	}

	async onRightClickExplorer(menu: Menu, file: TAbstractFile) {
		const confirm = (action: () => Promise<void>) => {
			const modal = new ConfirmModal(this.app, {
				title: "Warning",
				content:
					"The following operations may break your vault. Please make sure to back up your vault before proceeding, are you sure to continue?",
			});
			modal.onSubmit = action;
			modal.open();
		};

		if (file instanceof TFile && file.extension === "md") {
			menu.addItem((item) =>
				item
					.setTitle("Upload files in note to WebDAV")
					.setIcon("arrow-up-from-line")
					.onClick(() => {
						confirm(async () => {
							const uploader = new BatchUploader(this);
							await uploader.uploadNoteFiles(file, true);
							await uploader.createLog();
						});
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("Download files in note from WebDAV")
					.setIcon("arrow-down-from-line")
					.onClick(() => {
						confirm(async () => {
							const downloader = new BatchDownloader(this);
							await downloader.downloadNoteFiles(file);
							await downloader.createLog();
						});
					}),
			);
		}

		if (file instanceof TFolder) {
			menu.addItem((item) =>
				item
					.setTitle("Upload attachments to WebDAV")
					.setIcon("arrow-up-from-line")
					.onClick(() => {
						confirm(async () => {
							const uploader = new BatchUploader(this);
							await uploader.uploadAttachments(file);
							await uploader.createLog();
						});
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("Upload files in folder's notes to WebDAV")
					.setIcon("arrow-up-from-line")
					.onClick(() => {
						confirm(async () => {
							const uploader = new BatchUploader(this);
							await uploader.uploadFolderFiles(file);
							await uploader.createLog();
						});
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("Download files in folder's notes from WebDAV")
					.setIcon("arrow-down-from-line")
					.onClick(() => {
						confirm(async () => {
							const downloader = new BatchDownloader(this);
							await downloader.downloadFolderFiles(file);
							await downloader.createLog();
						});
					}),
			);
		}
	}

	isWebdavUrl(url: string) {
		return isManagedUrl(url, this.settings.url, this.settings.uploadRules);
	}

	isExcludeFile(path: string) {
		return findUploadRule(this.settings.uploadRules, path, false) == null;
	}
}
