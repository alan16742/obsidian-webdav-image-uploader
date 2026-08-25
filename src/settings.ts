import {
	App,
	debounce,
	Debouncer,
	Notice,
	PluginSettingTab,
	Setting,
} from "obsidian";
import WebDavImageUploaderPlugin from "./main";
import { getFormatVariables } from "./utils";
import { BatchUploader, BatchDownloader } from "./batch";
import {
	buildUploadTarget,
	createDefaultUploadRule,
	normalizeExtension,
	normalizeUploadRule,
	sanitizeUploadRules,
	TEMPLATE_VARIABLE_NAMES,
	UploadRule,
} from "./uploadRules";

export type { UploadRule } from "./uploadRules";

export interface WebDavImageUploaderSettings {
	// Basic
	url: string;
	username?: string;
	password?: string;
	disableBasicAuth?: boolean;

	// Upload
	enableUpload: boolean;
	uploadRules: UploadRule[];
	uploadedFileOperation: "default" | "delete" | "none";
	enableDummyPdf?: boolean;

	// Batch processes
	createBatchLog: boolean;
}

export const DEFAULT_SETTINGS: WebDavImageUploaderSettings = {
	url: "",
	username: "",
	password: "",
	disableBasicAuth: false,

	enableUpload: true,
	uploadRules: [createDefaultUploadRule()],
	uploadedFileOperation: "delete",
	enableDummyPdf: false,

	createBatchLog: true,
};

export function sanitizeSettings(data: unknown): WebDavImageUploaderSettings {
	const source = isRecord(data) ? data : {};
	const uploadRules = sanitizeUploadRules(source);
	const uploadedFileOperation = ["default", "delete", "none"].includes(
		stringValue(source.uploadedFileOperation),
	)
		? (source.uploadedFileOperation as WebDavImageUploaderSettings["uploadedFileOperation"])
		: DEFAULT_SETTINGS.uploadedFileOperation;

	return {
		url: stringValue(source.url, DEFAULT_SETTINGS.url),
		username: stringValue(source.username, DEFAULT_SETTINGS.username),
		password: stringValue(source.password, DEFAULT_SETTINGS.password),
		disableBasicAuth: booleanValue(
			source.disableBasicAuth,
			DEFAULT_SETTINGS.disableBasicAuth ?? false,
		),
		enableUpload: booleanValue(
			source.enableUpload,
			DEFAULT_SETTINGS.enableUpload,
		),
		uploadRules,
		uploadedFileOperation,
		enableDummyPdf: booleanValue(
			source.enableDummyPdf,
			DEFAULT_SETTINGS.enableDummyPdf ?? false,
		),
		createBatchLog: booleanValue(
			source.createBatchLog,
			DEFAULT_SETTINGS.createBatchLog,
		),
	};
}

export class WebDavImageUploaderSettingTab extends PluginSettingTab {
	plugin: WebDavImageUploaderPlugin;

	saveSettings: Debouncer<[], () => Promise<void>>;

	expandedUploadRules = new Set<UploadRule>();

	constructor(app: App, plugin: WebDavImageUploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;

		this.saveSettings = debounce(
			this.plugin.saveSettings.bind(this.plugin),
			200
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
				"By default, the plugin will intercept image requests for WebDAV authentication. " +
					"It may cause some rendering mistakes when scrolling up and down the content. " +
					"If you don't need this feature, you can disable it. " +
					"You may need to restart Obsidian for this setting to take effect."
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
		this.plugin.settings.uploadRules.forEach((rule, index) =>
			this.renderUploadRule(rulesEl, rule, index),
		);

		new Setting(containerEl)
			.setName("Add upload rule")
			.setDesc("Files that do not match any rule are skipped.")
			.addButton((button) =>
				button
					.setButtonText("Add rule")
					.setCta()
					.onClick(() => {
						const rule = createDefaultUploadRule();
						rule.extensions = ["jpg"];
						this.plugin.settings.uploadRules.push(rule);
						this.saveAndRedisplay();
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

	renderUploadRule(containerEl: HTMLElement, rule: UploadRule, index: number) {
		const cardEl = containerEl.createEl("details", {
			cls: "webdav-upload-rule",
		});
		cardEl.open = this.expandedUploadRules.has(rule);
		cardEl.addEventListener("toggle", () => {
			if (cardEl.open) {
				this.expandedUploadRules.add(rule);
			} else {
				this.expandedUploadRules.delete(rule);
			}
		});
		const summaryEl = cardEl.createEl("summary", {
			cls: "webdav-upload-rule-summary",
		});
		summaryEl.createSpan({
			cls: "webdav-upload-rule-title",
			text: `Rule ${index + 1}`,
		});
		const summaryPreviewEl = summaryEl.createSpan({
			cls: "webdav-upload-rule-preview",
			text: this.getUploadRuleSummary(rule),
		});
		const contentEl = cardEl.createDiv("webdav-upload-rule-content");
		const rules = this.plugin.settings.uploadRules;
		new Setting(contentEl)
			.setName("Rule actions")
			.setDesc("All configured match conditions must match.")
			.addButton((button) =>
				button
					.setButtonText("Up")
					.setDisabled(index === 0)
					.onClick(() => {
						[rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
						this.saveAndRedisplay();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText("Down")
					.setDisabled(index === rules.length - 1)
					.onClick(() => {
						[rules[index], rules[index + 1]] = [rules[index + 1], rules[index]];
						this.saveAndRedisplay();
					}),
			)
			.addButton((button) =>
				button.setButtonText("Duplicate").onClick(() => {
					rules.splice(index + 1, 0, normalizeUploadRule(rule));
					this.saveAndRedisplay();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Delete")
					.setWarning()
					.onClick(() => {
						this.expandedUploadRules.delete(rule);
						rules.splice(index, 1);
						this.saveAndRedisplay();
					}),
			);

		new Setting(contentEl)
			.setName("Filename starts with")
			.setDesc("Optional; matched without the extension.")
			.addText((text) =>
				text
					.setPlaceholder("IMG_")
					.setValue(rule.prefix)
					.onChange((value) => {
						rule.prefix = value;
						this.saveSettings();
					}),
			);
		new Setting(contentEl)
			.setName("Filename ends with")
			.setDesc("Optional; matched without the extension.")
			.addText((text) =>
				text
					.setPlaceholder("_thumb")
					.setValue(rule.suffix)
					.onChange((value) => {
						rule.suffix = value;
						this.saveSettings();
					}),
			);

		new Setting(contentEl)
			.setName("Any extension")
			.setDesc("Ignore file extensions when matching.")
			.addToggle((toggle) =>
				toggle.setValue(rule.extensions.length === 0).onChange((value) => {
					rule.extensions = value ? [] : ["jpg"];
					this.saveAndRedisplay();
				}),
			);

		if (rule.extensions.length > 0) {
			const extensionSetting = new Setting(contentEl)
				.setName("Extensions")
				.setDesc("Press Enter or Add; dots and case are normalized.");
			const controlsEl = extensionSetting.controlEl.createDiv(
				"webdav-upload-rule-extension-controls",
			);
			const tagsEl = controlsEl.createDiv("webdav-upload-rule-tags");
			for (const extension of rule.extensions) {
				const tag = tagsEl.createEl("button", {
					cls: "webdav-upload-rule-tag",
					text: `${extension} ×`,
					attr: { type: "button", "aria-label": `Remove ${extension}` },
				});
				tag.addEventListener("click", () => {
					if (rule.extensions.length === 1) {
						new Notice(
							"Keep at least one extension, or enable Any extension.",
						);
						return;
					}
					rule.extensions = rule.extensions.filter(
						(value) => value !== extension,
					);
					this.saveAndRedisplay();
				});
			}
			const addEl = controlsEl.createDiv("webdav-upload-rule-extension-add");
			const inputEl = addEl.createEl("input", {
				type: "text",
				placeholder: "jpg, png",
			});
			const addExtensions = () => {
				const additions = inputEl.value
					.split(/[,\s]+/)
					.map(normalizeExtension)
					.filter((extension) => extension !== "");
				rule.extensions = Array.from(
					new Set([...rule.extensions, ...additions]),
				);
				if (additions.length > 0) {
					this.saveAndRedisplay();
				}
			};
			inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					addExtensions();
				}
			});
			const addButton = addEl.createEl("button", {
				text: "Add",
				attr: { type: "button" },
			});
			addButton.addEventListener("click", addExtensions);
		}

		new Setting(contentEl)
			.setName("URL prefix")
			.setDesc("Leave blank to use the main WebDAV URL.")
			.addText((text) =>
				text
					.setPlaceholder("https://img.example.com")
					.setValue(rule.urlPrefix)
					.onChange((value) => {
						rule.urlPrefix = value;
						this.saveSettings();
					}),
			);

		let formatInput: HTMLInputElement | null = null;
		new Setting(contentEl)
			.setName("Link format")
			.setDesc("Must start with {{url}} and produce the complete public URL.")
			.addText((text) => {
				formatInput = text.inputEl;
				text
					.setPlaceholder("{{url}}/images/{{nameext}}")
					.setValue(rule.linkFormat)
					.onChange((value) => {
						rule.linkFormat = value;
						this.saveSettings();
					});
			})
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Insert variable…");
				for (const variable of TEMPLATE_VARIABLE_NAMES) {
					dropdown.addOption(variable, `{{${variable}}}`);
				}
				dropdown.onChange((variable) => {
					if (variable === "" || formatInput == null) {
						return;
					}
					const token = `{{${variable}}}`;
					formatInput.setRangeText(
						token,
						formatInput.selectionStart ?? formatInput.value.length,
						formatInput.selectionEnd ?? formatInput.value.length,
						"end",
					);
					rule.linkFormat = formatInput.value;
					this.saveSettings();
					dropdown.setValue("");
				});
			});
	}

	getUploadRuleSummary(rule: UploadRule) {
		const conditions: string[] = [];
		conditions.push(
			rule.extensions.length === 0
				? "any extension"
				: rule.extensions.join(", "),
		);
		const extension = rule.extensions[0] ?? "ext";
		const exampleName = `${rule.prefix}file${rule.suffix}.${extension}`;
		const now = Date.now();
		const variables = getFormatVariables(
			new File([""], exampleName, { lastModified: now }),
			this.app.workspace.getActiveFile() ?? {
				basename: "test-note",
				stat: { ctime: now, mtime: now },
			},
		);			
		const target = buildUploadTarget(
			rule,
			this.plugin.settings.url,
			variables,
		);
		return `${conditions.join(" · ")} → ${target.url}`;
	}

	saveAndRedisplay() {
		this.saveSettings();
		this.display();
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
						const uploader = new BatchUploader(this.plugin);
						await uploader.uploadVaultFiles();
						await uploader.createLog();
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
						const downloader = new BatchDownloader(this.plugin);
						await downloader.downloadVaultFiles();
						await downloader.createLog();
					})
			);
	}
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}
