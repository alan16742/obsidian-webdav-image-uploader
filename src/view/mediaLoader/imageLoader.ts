import type { MediaAdapter } from ".";

export const imageMediaAdapter: MediaAdapter = {
	selector: "img[src]",

	getSource(element) {
		return (element as HTMLImageElement).src;
	},

	setSource(element, source) {
		(element as HTMLImageElement).src = source;
	},
};
