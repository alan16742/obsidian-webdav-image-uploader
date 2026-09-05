import type { MediaAdapter } from ".";

export const audioMediaAdapter: MediaAdapter = {
	selector: "audio[src], audio source[src]",

	matches(element) {
		return (
			element.tagName === "AUDIO" ||
			(element.tagName === "SOURCE" &&
				element.parentElement?.tagName === "AUDIO")
		);
	},

	getSource(element) {
		return getSourceElement(element).src;
	},

	setSource(element, source) {
		getSourceElement(element).src = source;
		getAudio(element).load();
	},

	restoreSource(element, source) {
		getSourceElement(element).src = source;
		getAudio(element).load();
	},

};

function getSourceElement(
	element: Element,
): HTMLAudioElement | HTMLSourceElement {
	return element as HTMLAudioElement | HTMLSourceElement;
}

function getAudio(element: Element): HTMLAudioElement {
	return element.tagName === "AUDIO"
		? (element as HTMLAudioElement)
		: element.parentElement as HTMLAudioElement;
}
