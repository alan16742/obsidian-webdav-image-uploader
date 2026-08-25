import { FileType, LinkInfo } from "../../utils";
import { TFile } from "obsidian";
import WebDavImageUploaderPlugin from "../../main";

export interface Link<T extends LinkData> {
	data: T;

	init(): Promise<void>;

	uploadable(): boolean;

	downloadable(): boolean;

	getTFile(): TFile;

	upload(note: TFile): Promise<UploadFileInfo>;

	download(note: TFile): Promise<DownloadFileInfo>;

	rename(note: TFile, newPath: string): Promise<string>;

    delete(note: TFile): Promise<void>;
}

export type LinkData = LinkInfo | File;

export type LinkType = "local" | "external";

export interface UploadFileInfo {
	fileName?: string;

	url: string;

	markdownLink: string;
}

export interface DownloadFileInfo {
	tFile: TFile;

	markdownLink: string;
}

export type LinkFactory = {
	create<T extends LinkData>(
		plugin: WebDavImageUploaderPlugin,
		fileType: FileType,
		data: T
	): Link<T> | null;
};
