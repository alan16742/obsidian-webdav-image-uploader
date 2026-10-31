import moment from "moment";
export { moment };
export class TFile {
	constructor(path, data = "") {
		this.path = path;
		this.name = path.split("/").pop();
		this.extension = this.name.split(".").pop();
		this.basename = this.name.slice(0, -(this.extension.length + 1));
		this.data = data;
		this.stat = { ctime: 1_640_995_200_000, mtime: 1_640_995_200_000, size: data.length ?? data.byteLength };
	}
}
export class TFolder { constructor(path) { this.path = path; this.children = []; } }
export class MarkdownView { }
export class MarkdownRenderChild { constructor(containerEl) { this.containerEl = containerEl; } }
export class Plugin { }
export class PluginSettingTab { }
export class Modal { }
export const renderedSettings = [];
export class Setting {
	constructor() { renderedSettings.push(this); }
	setName(name) { this.name = name; return this; }
	setDesc() { return this; }
	addButton(callback) { callback(new MockControl()); return this; }
	addToggle(callback) { callback(new MockControl()); return this; }
	addText(callback) { this.text = new MockControl(); callback(this.text); return this; }
	addDropdown(callback) { this.dropdown = new MockControl(); callback(this.dropdown); return this; }
}
class MockControl {
	buttonEl = {};
	options = [];
	inputEl = {
		value: "", selectionStart: null, selectionEnd: null,
		setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); },
	};
	setButtonText() { return this; }
	setWarning() { return this; }
	setPlaceholder() { return this; }
	setValue(value) { this.inputEl.value = value; return this; }
	onClick(callback) { this.click = callback; return this; }
	onChange(callback) { this.change = callback; return this; }
	addOption(value) { this.options.push(value); return this; }
}
export class Notice { setMessage() { } hide() { } }
export const Platform = { isMobile: false };
export const debounce = callback => callback;
let handler;
export function setRequestHandler(value) { handler = value; }
export async function requestUrl(options) { return await handler(options); }
