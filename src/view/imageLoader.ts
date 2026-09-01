import type { MediaAdapter } from "./mediaLoader";

export const imageMediaAdapter: MediaAdapter = {
	selector: "img[src]",

	matches(element) {
		return element.tagName === "IMG";
	},

	getSource(element) {
		return (element as HTMLImageElement).src;
	},

	setSource(element, source) {
		(element as HTMLImageElement).src = source;
	},

	restoreSource(element, source) {
		(element as HTMLImageElement).src = source;
	},

};
