import { TransferSession } from "../transfer/transferSession";
import type WebDavImageUploaderPlugin from "../../main";
import { getFileType, type FileType } from "../attachment/fileTypes";
import type { Link, LinkData, LinkFactory } from "./types";
import imageLinkFactory from "./image";
import dummyPdfLinkFactory from "./pdf";
import { AttachmentLink } from "./attachment";

export * from "./types";

const factories: LinkFactory[] = [imageLinkFactory, dummyPdfLinkFactory];

export function createLink<T extends LinkData>(
	plugin: WebDavImageUploaderPlugin,
	data: T,
	sourcePath: string,
	session = new TransferSession(plugin),
): Link<T> {
	const note = plugin.app.vault.getFileByPath(sourcePath);
	if (note != null) session.captureNote(note);
	let fileType: FileType;
	if (data instanceof File) {
		fileType = getFileType(data.name, false);
	} else {
		fileType = getFileType(data.path);
	}

	for (const factory of factories) {
		const link = factory.create(plugin, fileType, data, { sourcePath, session });
		if (link != null) {
			return link;
		}
	}
	return new AttachmentLink(plugin, data, { sourcePath, session });
}
