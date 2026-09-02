import { App, Notice, Setting } from "obsidian";
import type WebDavImageUploaderPlugin from "../main";
import { getFormatVariables } from "../utils";
import {
	buildUploadTarget,
	getLocalLinkTarget,
	normalizeExtension,
	normalizeUploadRule,
	TEMPLATE_VARIABLE_NAMES,
	UploadRule,
} from "../lib/uploadRules";
import {
	getAttachmentFolderPath,
	getNewLinkFormat,
} from "../lib/obsidianPaths";

interface UploadRuleCard {
	cardEl: HTMLDetailsElement;
	titleEl: HTMLSpanElement;
	previewEl: HTMLSpanElement;
	upButton: HTMLButtonElement;
	downButton: HTMLButtonElement;
}

export class UploadRuleSettingRenderer {
	private expandedUploadRules = new Set<UploadRule>();
	private ruleCards = new Map<UploadRule, UploadRuleCard>();
	private rulesContainerEl: HTMLElement | null = null;

	constructor(
		private app: App,
		private plugin: WebDavImageUploaderPlugin,
		private saveSettings: () => void,
	) { }

	renderUploadRules(containerEl: HTMLElement) {
		if (this.rulesContainerEl !== containerEl) {
			this.ruleCards.clear();
			this.rulesContainerEl = containerEl;
		}
		this.refreshUploadRules();
	}

	private refreshUploadRules(focusRule?: UploadRule) {
		const containerEl = this.rulesContainerEl;
		if (containerEl == null) {
			return;
		}

		const rules = this.plugin.settings.uploadRules;
		const activeRules = new Set(rules);
		for (const [rule, card] of this.ruleCards) {
			if (!activeRules.has(rule)) {
				card.cardEl.remove();
				this.ruleCards.delete(rule);
			}
		}

		rules.forEach((rule, index) => {
			let card = this.ruleCards.get(rule);
			if (card == null) {
				card = this.createUploadRuleCard(rule);
				this.ruleCards.set(rule, card);
			}

			card.titleEl.textContent = `Rule ${index + 1}`;
			card.upButton.disabled = index === 0;
			card.downButton.disabled = index === rules.length - 1;

			const currentChild = containerEl.children[index];
			if (currentChild !== card.cardEl) {
				containerEl.insertBefore(card.cardEl, currentChild ?? null);
			}
		});

		if (focusRule != null) {
			this.ruleCards.get(focusRule)?.cardEl
				.querySelector<HTMLElement>("summary")
				?.focus();
		}
	}

	private createUploadRuleCard(rule: UploadRule): UploadRuleCard {
		const cardEl = document.createElement("details");
		cardEl.className = "webdav-upload-rule";
		cardEl.open = this.expandedUploadRules.has(rule);
		cardEl.addEventListener("toggle", () => {
			if (cardEl.open) {
				this.expandedUploadRules.add(rule);
			} else {
				this.expandedUploadRules.delete(rule);
			}
		});

		const summaryEl = document.createElement("summary");
		summaryEl.className = "webdav-upload-rule-summary";
		const titleEl = document.createElement("span");
		titleEl.className = "webdav-upload-rule-title";
		summaryEl.appendChild(titleEl);
		const previewEl = document.createElement("span");
		previewEl.className = "webdav-upload-rule-preview";
		summaryEl.appendChild(previewEl);
		cardEl.appendChild(summaryEl);

		const contentEl = document.createElement("div");
		contentEl.className = "webdav-upload-rule-content";
		cardEl.appendChild(contentEl);

		let summaryRevision = 0;
		const refreshSummary = () => {
			const revision = ++summaryRevision;
			previewEl.textContent = "Resolving preview…";
			void this.getUploadRuleSummary(rule).then((summary) => {
				if (revision === summaryRevision) {
					previewEl.textContent = summary;
				}
			});
		};
		refreshSummary();

		let upButton: HTMLButtonElement;
		let downButton: HTMLButtonElement;
		const getRules = () => this.plugin.settings.uploadRules;
		const getRuleIndex = () => getRules().indexOf(rule);
		const extensionsContainerEl = document.createElement("div");

		new Setting(contentEl)
			.setName("Rule actions")
			.setDesc("All configured match conditions must match.")
			.addButton((button) => {
				upButton = button.buttonEl;
				button
					.setButtonText("Up")
					.onClick(() => {
						const rules = getRules();
						const index = getRuleIndex();
						if (index <= 0) {
							return;
						}
						[rules[index - 1], rules[index]] = [
							rules[index],
							rules[index - 1],
						];
						this.saveAndRefresh();
					});
			})
			.addButton((button) => {
				downButton = button.buttonEl;
				button
					.setButtonText("Down")
					.onClick(() => {
						const rules = getRules();
						const index = getRuleIndex();
						if (index < 0 || index >= rules.length - 1) {
							return;
						}
						[rules[index], rules[index + 1]] = [
							rules[index + 1],
							rules[index],
						];
						this.saveAndRefresh();
					});
			})
			.addButton((button) =>
				button.setButtonText("Duplicate").onClick(() => {
					const rules = getRules();
					const index = getRuleIndex();
					if (index < 0) {
						return;
					}
					rules.splice(index + 1, 0, normalizeUploadRule(rule));
					this.saveAndRefresh();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Delete")
					.setWarning()
					.onClick(() => {
						const rules = getRules();
						const index = getRuleIndex();
						if (index < 0) {
							return;
						}
						this.expandedUploadRules.delete(rule);
						const focusRule =
							rules[index + 1] ?? rules[index - 1];
						rules.splice(index, 1);
						this.saveAndRefresh(focusRule);
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
						refreshSummary();
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
						refreshSummary();
						this.saveSettings();
					}),
			);

		new Setting(contentEl)
			.setName("Any extension")
			.setDesc("Ignore file extensions when matching.")
			.addToggle((toggle) =>
				toggle.setValue(rule.extensions.length === 0).onChange((value) => {
					rule.extensions = value ? [] : ["jpg"];
					this.renderExtensions(
						extensionsContainerEl,
						rule,
						refreshSummary,
					);
					refreshSummary();
					this.saveSettings();
				}),
			);

		contentEl.appendChild(extensionsContainerEl);
		this.renderExtensions(extensionsContainerEl, rule, refreshSummary);

		new Setting(contentEl)
			.setName("URL prefix")
			.setDesc("Leave blank to use the main WebDAV URL.")
			.addText((text) =>
				text
					.setPlaceholder("https://img.example.com")
					.setValue(rule.urlPrefix)
					.onChange((value) => {
						rule.urlPrefix = value;
						refreshSummary();
						this.saveSettings();
					}),
			);

		let formatInput: HTMLInputElement | null = null;
		new Setting(contentEl)
			.setName("Link format")
			.setDesc(
				"Start with {{url}} for a standard Markdown URL link. Without it, the result is a local link target using Obsidian's link format setting. Use {{attachment}} for Obsidian's configured attachment folder.",
			)
			.addText((text) => {
				formatInput = text.inputEl;
				text
					.setPlaceholder("{{url}}/images/{{nameext}}")
					.setValue(rule.linkFormat)
					.onChange((value) => {
						rule.linkFormat = value;
						refreshSummary();
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
					refreshSummary();
					this.saveSettings();
					dropdown.setValue("");
				});
			});

		return {
			cardEl,
			titleEl,
			previewEl,
			upButton: upButton!,
			downButton: downButton!,
		};
	}

	private renderExtensions(
		containerEl: HTMLElement,
		rule: UploadRule,
		refreshSummary: () => void,
	) {
		containerEl.empty();
		if (rule.extensions.length === 0) {
			return;
		}

		const extensionSetting = new Setting(containerEl)
			.setName("Extensions")
			.setDesc("Press Enter or Add; dots and case are normalized.");
		const controlsEl = extensionSetting.controlEl.createDiv(
			"webdav-upload-rule-extension-controls",
		);
		const tagsEl = controlsEl.createDiv("webdav-upload-rule-tags");
		const addEl = controlsEl.createDiv("webdav-upload-rule-extension-add");
		const inputEl = addEl.createEl("input", {
			type: "text",
			placeholder: "jpg, png",
		});

		const renderTags = (focusExtension?: string) => {
			tagsEl.empty();
			for (const extension of rule.extensions) {
				const tag = tagsEl.createEl("button", {
					cls: "webdav-upload-rule-tag",
					text: `${extension} ×`,
					attr: { type: "button", "aria-label": `Remove ${extension}` },
				});
				if (extension === focusExtension) {
					tag.focus();
				}
				tag.addEventListener("click", () => {
					if (rule.extensions.length === 1) {
						new Notice(
							"Keep at least one extension, or enable Any extension.",
						);
						return;
					}
					const removedIndex = rule.extensions.indexOf(extension);
					const nextFocusExtension =
						rule.extensions[removedIndex + 1] ??
						rule.extensions[removedIndex - 1];
					rule.extensions = rule.extensions.filter(
						(value) => value !== extension,
					);
					renderTags(nextFocusExtension);
					refreshSummary();
					this.saveSettings();
				});
			}
		};
		renderTags();

		const addExtensions = () => {
			const additions = inputEl.value
				.split(/[,\s]+/)
				.map(normalizeExtension)
				.filter((extension) => extension !== "");
			if (additions.length === 0) {
				return;
			}
			rule.extensions = Array.from(
				new Set([...rule.extensions, ...additions]),
			);
			renderTags();
			refreshSummary();
			this.saveSettings();
		};
		inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				addExtensions();
			}
		});
		addEl.createEl("button", {
			text: "Add",
			attr: { type: "button" },
		}).addEventListener("click", addExtensions);
	}

	private async getUploadRuleSummary(rule: UploadRule): Promise<string> {
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
			const activeFile = this.app.workspace.getActiveFile();
			const note = activeFile ?? {
				basename: "test-note",
				stat: { ctime: now, mtime: now },
			};
			const sourcePath = activeFile?.path ?? "";
			const attachmentFolder = await getAttachmentFolderPath(
				this.app,
				sourcePath,
				exampleName,
			);
			const variables = getFormatVariables(
				new File([""], exampleName, { lastModified: now }),
				note,
				attachmentFolder,
			);
			const target = buildUploadTarget(
				rule,
				this.plugin.settings.url,
				variables,
			);
			const previewTarget = target.linkType === "local"
				? getLocalLinkTarget(
					target.linkTarget,
					sourcePath,
					getNewLinkFormat(this.app),
				)
				: target.linkTarget;
			return `${conditions.join(" · ")} → ${previewTarget}`;
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

	saveAndRefresh(focusRule?: UploadRule) {
		this.saveSettings();
		this.refreshUploadRules(focusRule);
	}
}
