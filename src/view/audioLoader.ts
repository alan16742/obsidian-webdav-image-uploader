import type { MediaAdapter } from "./mediaLoader";

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

	setLoading(element) {
		setLoadingState(element, true);
		getSourceElement(element).removeAttribute("src");
		getAudio(element).load();
	},

	setSource(element, source) {
		getSourceElement(element).src = source;
		setLoadingState(element, false);
		getAudio(element).load();
	},

	restoreSource(element, source) {
		getSourceElement(element).src = source;
		getAudio(element).load();
	},

	setError(element) {
		setLoadingState(element, false);
		getAudio(element).classList.add("webdav-media-error");
	},

	clearState(element) {
		const audio = getAudio(element);
		audio.classList.remove("webdav-media-loading");
		audio.classList.remove("webdav-media-error");
		audio.removeAttribute("aria-busy");
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

function setLoadingState(element: Element, loading: boolean) {
	const audio = getAudio(element);
	audio.classList.toggle("webdav-media-loading", loading);
	audio.classList.remove("webdav-media-error");
	if (loading) {
		audio.setAttribute("aria-busy", "true");
	} else {
		audio.removeAttribute("aria-busy");
	}
}
