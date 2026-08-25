import { App, Notice, Setting } from "obsidian";
import type WebDavImageUploaderPlugin from "../main";
import { getFormatVariables } from "../utils";
import {
	buildUploadTarget,
	normalizeExtension,
	normalizeUploadRule,
	TEMPLATE_VARIABLE_NAMES,
	UploadRule,
} from "../lib/uploadRules";

export class UploadRuleSettingRenderer {
	private expandedUploadRules = new Set<UploadRule>();

	constructor(
		private app: App,
		private plugin: WebDavImageUploaderPlugin,
		private saveSettings: () => void,
		private redisplay: () => void,
	) {}

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
		summaryEl.createSpan({
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

	private getUploadRuleSummary(rule: UploadRule) {
		const conditions: string[] = [];
		conditions.push(
			rule.extensions.length === 0
				? "any extension"
				: rule.extensions.join(", "),
		);

		try {
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
		} catch {
			const hasUrl =
				rule.urlPrefix.trim() !== "" ||
				this.plugin.settings.url.trim() !== "";
			const prompt = hasUrl
				? "Fix URL or upload rule to preview"
				: "Configure WebDAV URL to preview";
			return `${conditions.join(" · ")} → ${prompt}`;
		}
	}

	saveAndRedisplay() {
		this.saveSettings();
		this.redisplay();
	}
}
