import WebDavImageUploaderPlugin from "../../main";
import { type FileType, getFileType } from "../fileTypes";
import { Link, LinkData } from "./types";
import { LinkFactory } from "./types";
import imageLinkFactory from "./image";
import dummyPdfLinkFactory from "./pdf";
import { AttachmentLink } from "./attachment";

export * from "./types";

const factories: LinkFactory[] = [imageLinkFactory, dummyPdfLinkFactory];

export function createLink<T extends LinkData>(
	plugin: WebDavImageUploaderPlugin,
	data: T
): Link<T> {
	let fileType: FileType;
	if (data instanceof File) {
		fileType = getFileType(data.name);
	} else {
		fileType = getFileType(data.path);
	}

	for (const factory of factories) {
		const link = factory.create(plugin, fileType, data);
		if (link != null) {
			return link;
		}
	}
	return new AttachmentLink(plugin, data);
}
