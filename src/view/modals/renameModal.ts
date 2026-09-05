import { Modal, Notice, Setting, type App } from "obsidian";

export async function getRenamePath(app: App, path: string) {
	return new Promise<string | null>((resolve) => {
		const modal = new RenameModal(app, {
			title: "Rename File on WebDAV",
			path: path,
			onConfirm: (newPath: string) => resolve(newPath),
			onCancel: () => resolve(null),
		});
		modal.open();
	});
}

export interface RenameModalSettings {
	title?: string;
	path: string;
	onCancel?: () => void;
	onConfirm: (newPath: string) => void | Promise<void>;
}

export class RenameModal extends Modal {
	settings: RenameModalSettings;
	private submitted = false;
	private submitting = false;
	private closed = false;

	constructor(app: App, settings: RenameModalSettings) {
		super(app);
		this.settings = settings;
	}

	onClose(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.submitted) this.settings.onCancel?.();
		this.contentEl.empty();
	}

	onOpen(): void {
		const { title, path, onConfirm } = this.settings;

		this.setTitle(title ?? "Notice");

		const inputEl = this.contentEl.createEl("input", {
			type: "text",
			value: path,
			cls: "webdav-rename-input",
		});

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
					.onClick(async () => {
						if (this.submitting || this.submitted || this.closed) return;
						const newPath = inputEl.value.trim();
						if (newPath.length === 0) {
							new Notice("New path is empty.");
							return;
						}

						if (newPath === path) {
							new Notice("Path is not modified.");
							return;
						}

						this.submitting = true;
						try {
							await onConfirm(newPath);
							this.submitted = true;
							this.close();
						} catch (error) { new Notice(String(error)); }
						finally { this.submitting = false; }
					}),
			);
	}
}
