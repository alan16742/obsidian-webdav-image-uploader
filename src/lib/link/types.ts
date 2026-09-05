import type { TransferSession } from "../transfer/transferSession";
import type { FileType } from "../attachment/fileTypes";
import type { LinkInfo } from "../../utils";
import type { TFile } from "obsidian";
import type WebDavImageUploaderPlugin from "../../main";

export interface Link<T extends LinkData> {
	readonly data: T;
	readonly session: TransferSession;
	getRemoteUrl(): string;

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
	fileName: string;
	remotePath: string;
	localPath?: string;

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
		data: T,
		context: LinkContext,
	): Link<T> | null;
};

export interface LinkContext {
	sourcePath: string;
	session: TransferSession;
}
