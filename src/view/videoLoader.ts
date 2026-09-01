import type { MediaAdapter } from "./mediaTypes";

export const videoMediaAdapter: MediaAdapter = {
	selector: "video[src], video source[src]",

	matches(element) {
		return (
			element.tagName === "VIDEO" ||
			(element.tagName === "SOURCE" &&
				element.parentElement?.tagName === "VIDEO")
		);
	},

	getSource(element) {
		return getSourceElement(element).src;
	},

	setSource(element, source) {
		getSourceElement(element).src = source;
		getVideo(element).load();
	},

	restoreSource(element, source) {
		getSourceElement(element).src = source;
		getVideo(element).load();
	},

};

function getSourceElement(
	element: Element,
): HTMLVideoElement | HTMLSourceElement {
	return element as HTMLVideoElement | HTMLSourceElement;
}

function getVideo(element: Element): HTMLVideoElement {
	return element.tagName === "VIDEO"
		? (element as HTMLVideoElement)
		: element.parentElement as HTMLVideoElement;
}
