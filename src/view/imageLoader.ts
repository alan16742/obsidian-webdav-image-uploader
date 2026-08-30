import type { MediaAdapter } from "./mediaLoader";

const loadingLight =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS13aWR0aD0iMiIgZmlsbD0ibm9uZSIgc3Ryb2tlLWRhc2hhcnJheT0iNiwgMzAiPjxhbmltYXRlVHJhbnNmb3JtIGF0dHJpYnV0ZU5hbWU9InRyYW5zZm9ybSIgdHlwZT0icm90YXRlIiBmcm9tPSIwIDEyIDEyIiB0bz0iMzYwIDEyIDEyIiBkdXI9IjFzIiByZXBlYXRDb3VudD0iaW5kZWZpbml0ZSIvPjwvY2lyY2xlPjwvc3ZnPg==";
const loadingDark =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iMiIgZmlsbD0ibm9uZSIgc3Ryb2tlLWRhc2hhcnJheT0iNiwgMzAiPjxhbmltYXRlVHJhbnNmb3JtIGF0dHJpYnV0ZU5hbWU9InRyYW5zZm9ybSIgdHlwZT0icm90YXRlIiBmcm9tPSIwIDEyIDEyIiB0bz0iMzYwIDEyIDEyIiBkdXI9IjFzIiByZXBlYXRDb3VudD0iaW5kZWZpbml0ZSIvPjwvY2lyY2xlPjwvc3ZnPg==";

export const imageMediaAdapter: MediaAdapter = {
	selector: "img[src]",

	matches(element) {
		return element.tagName === "IMG";
	},

	getSource(element) {
		return (element as HTMLImageElement).src;
	},

	setLoading(element) {
		const image = element as HTMLImageElement;
		image.classList.add("webdav-media-loading");
		image.classList.remove("webdav-media-error");
		image.setAttribute("aria-busy", "true");
		image.src = image.ownerDocument.body.classList.contains("theme-dark")
			? loadingDark
			: loadingLight;
	},

	setSource(element, source) {
		const image = element as HTMLImageElement;
		image.src = source;
		this.clearState(image);
	},

	restoreSource(element, source) {
		(element as HTMLImageElement).src = source;
	},

	setError(element) {
		this.clearState(element);
		element.classList.add("webdav-media-error");
	},

	clearState(element) {
		element.classList.remove("webdav-media-loading");
		element.classList.remove("webdav-media-error");
		element.removeAttribute("aria-busy");
	},
};
