import { getFileNameParts } from "./uploadRules";

export const MEDIA_TYPES = ["image", "video", "audio"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const FILE_TYPE_EXTENSIONS = {
	md: new Set(["md"]),
	pdf: new Set(["pdf"]),
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
} satisfies Record<string, ReadonlySet<string>>;

type KnownFileType = keyof typeof FILE_TYPE_EXTENSIONS;
export type FileType = KnownFileType | "attachment";

const MEDIA_TYPE_SET: ReadonlySet<string> = new Set(MEDIA_TYPES);

export function getFileType(source: string, isLink = true): FileType {
	const { extension } = getFileNameParts(source, isLink);
	return (Object.keys(FILE_TYPE_EXTENSIONS) as KnownFileType[]).find(
		(fileType) => FILE_TYPE_EXTENSIONS[fileType].has(extension),
	) ?? "attachment";
}

export function getMediaType(source: string): MediaType | undefined {
	const fileType = getFileType(source);
	return MEDIA_TYPE_SET.has(fileType) ? fileType as MediaType : undefined;
}
