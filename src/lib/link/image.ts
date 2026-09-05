import type WebDavImageUploaderPlugin from "../../main";
import { AttachmentLink } from "./attachment";
import type { TFile } from "obsidian";
import type { LinkData, LinkFactory, LinkContext } from "./types";
import type { FileType } from "../attachment/fileTypes";

const factory: LinkFactory = {
	create<T extends LinkData>(
		plugin: WebDavImageUploaderPlugin,
		type: FileType,
		data: T,
		context: LinkContext,
	) {
		if (type !== "image") {
			return null;
		}
		return new ImageLink(plugin, data, context);
	},
};
export default factory;

export class ImageLink<T extends LinkData> extends AttachmentLink<T> {
	async upload(note: TFile) {
		const uploadInfo = await super.upload(note);
		return {
			...uploadInfo,
			markdownLink: uploadInfo.markdownLink.startsWith("!")
				? uploadInfo.markdownLink
				: `!${uploadInfo.markdownLink}`,
		};
	}

	async download(note: TFile) {
		const info = await super.download(note);

		if (!info.markdownLink.startsWith("!")) {
			info.markdownLink = `!${info.markdownLink}`;
		}

		return info;
	}
}
