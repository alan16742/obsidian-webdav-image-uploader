import { reportTask } from "./utils";
import {
	debounce,
	Notice,
	PluginSettingTab,
	Setting,
	type App,
	type Debouncer,
} from "obsidian";
import type WebDavImageUploaderPlugin from "./main";
import { BatchUploader, BatchDownloader } from "./lib/batch";
import {
	isRecord,
	createDefaultUploadRule,
	sanitizeUploadRules,
	TEMPLATE_VARIABLE_NAMES,
	type UploadRule,
} from "./lib/attachment/uploadRules";
import { UploadRuleSettingRenderer } from "./view/settings/uploadRuleSettings";

export type { UploadRule } from "./lib/attachment/uploadRules";

export interface WebDavImageUploaderSettings {
	// Basic
	url: string;
	username?: string;
	password?: string;
	disableBasicAuth?: boolean;

	// Upload
	enableUpload: boolean;
	uploadedFileOperation: "default" | "delete" | "none";
	enableDummyPdf?: boolean;
	uploadRules: UploadRule[];

	// Batch processes
	createBatchLog: boolean;
}

export const DEFAULT_SETTINGS: WebDavImageUploaderSettings = {
	url: "",
	username: "",
	password: "",
	disableBasicAuth: false,

	enableUpload: true,
	uploadedFileOperation: "delete",
	enableDummyPdf: false,
	uploadRules: [
		{
			prefix: "",
			suffix: "",
			extensions: [
				"jpg",
				"jpeg",
				"png",
				"gif",
				"svg",
				"webp",
			],
			urlPrefix: "",
			linkFormat: "{{url}}/{{nameext}}",
		},
	],

	createBatchLog: true,
};

export function sanitizeSettings(data: unknown): WebDavImageUploaderSettings {
	const source = isRecord(data) ? data : DEFAULT_SETTINGS;
	const settings: WebDavImageUploaderSettings = {
		...DEFAULT_SETTINGS,
		uploadRules: sanitizeUploadRules(source),
	};

	for (const key of ["url", "username", "password"] as const) {
		const value = source[key];
		if (typeof value === "string") {
			settings[key] = value;
		}
	}

	for (const key of [
		"disableBasicAuth",
		"enableUpload",
		"enableDummyPdf",
		"createBatchLog",
	] as const) {
		const value = source[key];
		if (typeof value === "boolean") {
			settings[key] = value;
		}
	}

	const uploadedFileOperation = source.uploadedFileOperation;
	if (
		uploadedFileOperation === "default" ||
		uploadedFileOperation === "delete" ||
		uploadedFileOperation === "none"
	) {
		settings.uploadedFileOperation = uploadedFileOperation;
	}
	return settings;
}

export class WebDavImageUploaderSettingTab extends PluginSettingTab {
	plugin: WebDavImageUploaderPlugin;

	saveSettings: Debouncer<[], Promise<void>>;

	uploadRuleSettingRenderer: UploadRuleSettingRenderer;

	constructor(app: App, plugin: WebDavImageUploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;

		this.saveSettings = debounce(
			() => reportTask(() => this.plugin.saveSettings()),
			200
		);
		this.uploadRuleSettingRenderer = new UploadRuleSettingRenderer(
			this.app,
			this.plugin,
			() => {
				this.saveSettings();
			},
		);
	}

	display(): void {
		this.containerEl.empty();

		this.basic();

		this.upload();

		this.batch();

		this.commands();
	}

	basic() {
		const { containerEl } = this;

		new Setting(containerEl)
			.setName("Url")
			.setDesc("The URL of the WebDAV server.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.url)
					.setPlaceholder("https://yourdomain.com:8443/dav")
					.onChange((value) => {
						value = value.trim();
						if (value.endsWith("/")) {
							value = value.slice(0, -1);
						}
						this.plugin.settings.url = value;
						this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Username")
			.setDesc("The username for WebDAV authentication.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.username ?? "")
					.onChange((value) => {
						this.plugin.settings.username = value;
						this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Password")
			.setDesc("The password for WebDAV authentication.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.password ?? "").onChange(
					(value) => {
						this.plugin.settings.password = value;
						this.saveSettings();
					}
				);
			});

		new Setting(containerEl)
			.setName("Disable basic auth")
			.setDesc(
				"By default, protected WebDAV images, videos, and audio files are loaded through authenticated blob URLs. " +
				"Disable this when your media URLs are already publicly accessible. " +
				"Reopen the note to refresh existing previews."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.disableBasicAuth ?? false)
					.onChange((value) => {
						this.plugin.settings.disableBasicAuth = value;
						this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					const error = await this.plugin.client.testConnection();
					if (error == null) {
						new Notice("Connection successful!");
					} else {
						new Notice(error);
					}
					button.setDisabled(false);
				})
			);
	}

	upload() {
		const { containerEl } = this;

		new Setting(containerEl).setName("Upload").setHeading();

		new Setting(containerEl)
			.setName("Enable upload on drop/paste")
			.setDesc(
				"Toggle if auto-upload is enabled. If enabled, files will be uploaded when dropped or pasted."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableUpload)
					.onChange((value) => {
						this.plugin.settings.enableUpload = value;
						this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Uploaded file operation")
			.setDesc(
				"What to do with the local file after it is uploaded to WebDAV."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("delete", "Delete permanently")
					.addOption(
						"default",
						"Same as 'Files & Links -> Deleted files'"
					)
					.addOption("none", "Do nothing")
					.setValue(this.plugin.settings.uploadedFileOperation)
					.onChange((value) => {
						this.plugin.settings.uploadedFileOperation =
							value as WebDavImageUploaderSettings["uploadedFileOperation"];
						this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable dummy PDF")
			.setDesc(
				createFragment((frag) => {
					frag.createSpan({
						text: "If enabled, a ",
					});
					frag.createEl("a", {
						href: "https://ryotaushio.github.io/obsidian-pdf-plus/external-pdf-files.html",
						text: "dummy PDF file",
					});
					frag.createSpan({
						text: " will be created when uploading a PDF file. Add 'pdf' to an upload rule to enable PDF uploads.",
					});
				})
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDummyPdf ?? false)
					.onChange((value) => {
						this.plugin.settings.enableDummyPdf = value;
						this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Upload rules")
			.setDesc(
				"Rules are checked from top to bottom. The first matching rule controls the public URL and WebDAV path.",
			)
			.setHeading();

		const rulesEl = containerEl.createDiv("webdav-upload-rules");
		this.uploadRuleSettingRenderer.renderUploadRules(rulesEl);

		new Setting(containerEl)
			.setName("Add upload rule")
			.setDesc("Files that do not match any rule are skipped.")
			.addButton((button) =>
				button
					.setButtonText("Add rule")
					.setCta()
					.onClick(() => {
						const rule = createDefaultUploadRule();
						this.plugin.settings.uploadRules.push(rule);
						this.uploadRuleSettingRenderer.saveAndRefresh();
					}),
			);

		const variablesEl = containerEl.createEl("details", {
			cls: "webdav-upload-rule-variables",
		});
		variablesEl.createEl("summary", { text: "Available link variables" });
		variablesEl.createEl("p", {
			text: "Use {{var}} for values and {{dateVar:format}} for Moment.js date formatting.",
		});
		const variableList = variablesEl.createEl("ul");
		const descriptions: Record<string, string> = {
			url: "the rule URL prefix, or the main WebDAV URL when blank",
			attachment: "Obsidian's configured attachment folder for the current note",
			name: "file basename",
			ext: "file extension without the dot",
			nameext: "file name with extension",
			mtime: "file last modified time",
			now: "current time",
			notename: "note basename",
			notectime: "note creation time",
			notemtime: "note last modified time",
		};
		for (const variable of TEMPLATE_VARIABLE_NAMES) {
			const item = variableList.createEl("li");
			item.createEl("code", { text: `{{${variable}}}` });
			item.appendText(` — ${descriptions[variable]}`);
		}
	}

	batch() {
		const { containerEl } = this;

		new Setting(containerEl).setName("Batch processes").setHeading();

		new Setting(containerEl)
			.setName("Create batch operation log")
			.setDesc(
				"Toggle if a log file should be created after batch upload/download."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.createBatchLog ?? true)
					.onChange((value) => {
						this.plugin.settings.createBatchLog = value;
						this.saveSettings();
					})
			);
	}

	commands() {
		const { containerEl } = this;

		new Setting(containerEl).setName("Commands").setHeading();

		let uploadVaultSetting: Setting;
		let downloadVaultSetting: Setting;

		const warning = new Setting(containerEl)
			.setDesc(
				createFragment((frag) =>
					frag.createSpan({
						cls: "mod-warning",
						text: "The following operations may break your vault. Please make sure to back up your vault before proceeding.",
					})
				)
			)
			.addButton((button) =>
				button.setButtonText("I understand").onClick(() => {
					warning.clear();
					uploadVaultSetting!.setDisabled(false);
					downloadVaultSetting!.setDisabled(false);
				})
			);

		uploadVaultSetting = new Setting(containerEl)
			.setName("Upload all files")
			.setDesc("Upload all files to WebDAV.")
			.addButton((button) =>
				button
					.setButtonText("Upload")
					.setDisabled(true)
					.onClick(async () => {
						await reportTask(async () => {
							const uploader = new BatchUploader(this.plugin);
							await uploader.uploadVaultFiles();
							await uploader.createLog();
						});
					})
			);

		downloadVaultSetting = new Setting(containerEl)
			.setName("Download all files")
			.setDesc("Download all files from WebDAV.")
			.addButton((button) =>
				button
					.setButtonText("Download")
					.setDisabled(true)
					.onClick(async () => {
						await reportTask(async () => {
							const downloader = new BatchDownloader(this.plugin);
							await downloader.downloadVaultFiles();
							await downloader.createLog();
						});
					})
			);
	}
}
