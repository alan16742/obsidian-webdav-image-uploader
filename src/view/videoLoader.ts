import type { MediaAdapter } from "./mediaLoader";

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

	setLoading(element) {
		setLoadingState(element, true);
		getSourceElement(element).removeAttribute("src");
		getVideo(element).load();
	},

	setSource(element, source) {
		getSourceElement(element).src = source;
		setLoadingState(element, false);
		getVideo(element).load();
	},

	restoreSource(element, source) {
		getSourceElement(element).src = source;
		getVideo(element).load();
	},

	setError(element) {
		setLoadingState(element, false);
		getVideo(element).classList.add("webdav-media-error");
	},

	clearState(element) {
		const video = getVideo(element);
		video.classList.remove("webdav-media-loading");
		video.classList.remove("webdav-media-error");
		video.removeAttribute("aria-busy");
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

function setLoadingState(element: Element, loading: boolean) {
	const video = getVideo(element);
	video.classList.toggle("webdav-media-loading", loading);
	video.classList.remove("webdav-media-error");
	if (loading) {
		video.setAttribute("aria-busy", "true");
	} else {
		video.removeAttribute("aria-busy");
	}
}
