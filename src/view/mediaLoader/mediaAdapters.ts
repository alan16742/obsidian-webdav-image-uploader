import type { MediaAdapter } from ".";

function createHTMLMediaAdapter(tagName: "AUDIO" | "VIDEO"): MediaAdapter {
	const tag = tagName.toLowerCase();
	return {
		selector: `${tag}[src], ${tag} source[src]`,

		getSource(element) {
			return (element as HTMLMediaElement | HTMLSourceElement).src;
		},

		setSource(element, source) {
			(element as HTMLMediaElement | HTMLSourceElement).src = source;
			const media =
				element.tagName === tagName
					? (element as HTMLMediaElement)
					: (element.parentElement as HTMLMediaElement);
			media.load();
		},
	};
}

export const audioMediaAdapter = createHTMLMediaAdapter("AUDIO");
export const videoMediaAdapter = createHTMLMediaAdapter("VIDEO");
