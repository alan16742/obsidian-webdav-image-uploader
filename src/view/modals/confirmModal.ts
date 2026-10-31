import { reportTask } from "../../utils";
import { Modal, Setting, type App } from "obsidian";

export interface ConfirmModalSettings {
	title?: string;
	content?: string;
}

export class ConfirmModal extends Modal {
	settings: ConfirmModalSettings;
	private submitted = false;
	private closed = false;

	onSubmit?: () => void | Promise<void>;
	onCancel?: () => void;

	constructor(app: App, settings: ConfirmModalSettings) {
		super(app);
		this.settings = settings;
	}

	onClose(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.submitted) this.onCancel?.();
		this.contentEl.empty();
	}

	onOpen(): void {
		const { content, title } = this.settings;

		this.titleEl.className = "mod-warning";

		this.setTitle(title ?? "Notice");

		if (content) {
			this.contentEl.createEl("p", { text: content });
		}

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(() => {
						if (this.submitted || this.closed) return;
						this.submitted = true;
						this.close();
						void reportTask(() => this.onSubmit?.());
					}),
			);
	}
}
