import type { MediaType } from "../lib/fileTypes";

export function createMediaElement(
	document: Document,
	mediaType: Exclude<MediaType, "image">,
	source: string,
): HTMLVideoElement | HTMLAudioElement;
export function createMediaElement(
	document: Document,
	mediaType: MediaType,
	source: string,
): HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
export function createMediaElement(
	document: Document,
	mediaType: MediaType,
	source: string,
): HTMLImageElement | HTMLVideoElement | HTMLAudioElement {
	const element = document.createElement(
		mediaType === "image" ? "img" : mediaType,
	);
	element.src = source;
	if (mediaType !== "image") {
		const media = element as HTMLMediaElement;
		media.controls = true;
		media.preload = "metadata";
	}
	return element;
}

export function copyMediaPresentation(
	image: HTMLImageElement,
	media: HTMLVideoElement | HTMLAudioElement,
) {
	media.className = image.className;
	const label = image.alt || image.getAttribute("aria-label");
	if (label) media.setAttribute("aria-label", label);
	for (const attribute of ["width", "height", "style"] as const) {
		const value = image.getAttribute(attribute);
		if (value != null) media.setAttribute(attribute, value);
	}
}

export function setMediaEmbedClasses(
	container: HTMLElement,
	mediaType: MediaType,
) {
	container.classList.remove(
		"file-embed",
		"image-embed",
		"mod-empty-attachment",
	);
	container.classList.add(
		"media-embed",
		`${mediaType}-embed`,
	);
}
