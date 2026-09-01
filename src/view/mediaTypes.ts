import { getFileNameParts } from "../lib/uploadRules";

export type MediaType = "image" | "video" | "audio";

export interface MediaAdapter {
	selector: string;
	matches(element: Element): boolean;
	getSource(element: Element): string;
	setSource(element: Element, source: string): void;
	restoreSource(element: Element, source: string): void;
}

const MEDIA_EXTENSIONS: Record<MediaType, Set<string>> = {
	image: new Set([
		"avif",
		"bmp",
		"gif",
		"ico",
		"jpeg",
		"jpg",
		"png",
		"svg",
		"webp",
	]),
	video: new Set([
		"avi",
		"m4v",
		"mkv",
		"mov",
		"mp4",
		"ogv",
		"webm",
	]),
	audio: new Set([
		"aac",
		"flac",
		"m4a",
		"mp3",
		"oga",
		"ogg",
		"opus",
		"wav",
	]),
};

export function getMediaType(source: string): MediaType | undefined {
	const { extension } = getFileNameParts(source);
	return (Object.keys(MEDIA_EXTENSIONS) as MediaType[]).find((mediaType) =>
		MEDIA_EXTENSIONS[mediaType].has(extension),
	);
}
