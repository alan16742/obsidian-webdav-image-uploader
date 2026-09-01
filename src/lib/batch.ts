import { App, Notice, TAbstractFile, TFile, TFolder, moment } from "obsidian";
import {
	getFileByPath,
	LinkInfo,
	isLocalPath,
	matchLinks,
	noticeError,
} from "../utils";
import WebDavImageUploaderPlugin from "../main";
import { getFileType } from "./fileTypes";
import { createLink, UploadFileInfo } from "./link";

export class BatchUploader {
	plugin: WebDavImageUploaderPlugin;

	uploadedFiles: Map<TFile, UploadFileInfo> = new Map();

	result: BatchProcessFileResult[] = [];
	deleteErrors: { file: TFile; error: string }[] = [];

	constructor(plugin: WebDavImageUploaderPlugin) {
		this.plugin = plugin;
	}

	async createLog() {
		if (!this.plugin.settings.createBatchLog) {
			return;
		}

		await createBatchLog(
			this.plugin.app,
			this.result,
			async (content: string) => {
				content += `\n\n## Failed to Delete Local Files\n\n`;

				const headers = ["File", "Error Message"];
				const headerRow = `| ${headers.join(" | ")} |`;
				const separatorRow = `| ${headers
					.map(() => "---")
					.join(" | ")} |`;
				content += headerRow + "\n" + separatorRow + "\n";

				for (const { file, error } of this.deleteErrors) {
					content += `| ${file.path} | ${error} |\n`;
				}

				return content;
			},
		);
	}

	async uploadVaultFiles() {
		await this.uploadFolderFiles();
	}

	async uploadFolderFiles(folder?: TFolder) {
		const notes =
			folder == null
				? this.plugin.app.vault.getMarkdownFiles()
				: getMarkdownFilesInFolder(folder);

		const notice = new Notice("", 0);

		let count = 1;
		const total = notes.length;
		for (const note of notes) {
			notice.setMessage(
				`Uploading files in '${note.path}'\n${count++}/${total}...`,
			);

			try {
				await this.uploadNoteFiles(note, false);
			} catch (e) {
				noticeError(`Failed to upload files from '${note.path}', ${e}`);
			}
		}

		new Notice(`All files uploaded finished.`);

		notice.hide();

		await this.deleteUploadedFiles();
	}

	async uploadAttachments(folder: TFolder) {
		const attachments = folder.children.filter(
			(file) => file instanceof TFile,
		);
		const noteAttachmentsMap = getNotesByAttachments(
			attachments,
			this.plugin.app,
		);

		const notice = new Notice("", 0);

		let count = 1;
		const total = noteAttachmentsMap.size;
		for (const { note, attachments } of noteAttachmentsMap.values()) {
			notice.setMessage(
				`Uploading attachments in '${note.path
				}'\n${count++}/${total}...`,
			);

			try {
				await this.uploadNoteFiles(note, false, attachments);
			} catch (e) {
				noticeError(`Failed to upload files from '${note.path}', ${e}`);
			}
		}

		new Notice(`All files uploaded finished.`);

		notice.hide();

		await this.deleteUploadedFiles();
	}

	async uploadNoteFiles(
		note: TFile,
		deleteAfterUpload: boolean,
		attachments?: Set<TAbstractFile>,
	) {
		const content = await this.plugin.app.vault.read(note);
		const links = matchLinks(content).filter(
			(link) =>
				isLocalPath(link.path) &&
				(this.plugin.settings.enableDummyPdf ||
					getFileType(link.path) !== "pdf"),
		);
		const total = links.length;
		if (total === 0) {
			return;
		}

		const notice = new Notice("", 0);

		let count = 0;
		let newContent = content;
		for (const linkInfo of links) {
			count += 1;

			try {
				const tFile = getFileByPath(this.plugin.app, linkInfo.path);
				if (tFile == null) {
					throw new Error(`File not found in vault.`);
				}

				// only upload if specified in attachments
				if (attachments != null && !attachments.has(tFile)) {
					continue;
				}

				if (this.plugin.isExcludeFile(tFile.name)) {
					this.result.push({
						status: "skipped",
						message: "No upload rule matched this file.",
						note,
						link: linkInfo,
					});
					continue;
				}

				// skip if already uploaded(when the file has been link by multiple notes),
				// and reuse the uploaded url
				let fileInfo = this.uploadedFiles.get(tFile);
				if (fileInfo == null) {
					notice.setMessage(
						`Uploading '${tFile.path}'\n${count}/${total}...`,
					);

					const link = createLink(this.plugin, linkInfo);
					fileInfo = await link.upload(note);
				}

				if (linkInfo.raw !== fileInfo.markdownLink) {
					newContent =
						newContent.substring(0, linkInfo.start) +
						fileInfo.markdownLink +
						newContent.substring(linkInfo.end);
				}
				this.result.push({
					status: "success",
					note,
					link: linkInfo,
					newLink: fileInfo.url,
				});

				this.uploadedFiles.set(tFile, fileInfo);
			} catch (e) {
				const message = `Failed to upload file '${linkInfo.path}' from ${note.path}, ${e}`;
				this.result.push({
					status: "failed",
					message,
					note,
					link: linkInfo,
				});
				noticeError(message);
			}
		}

		if (content !== newContent) {
			await this.plugin.app.vault.modify(note, newContent, note.stat);
		}

		notice.hide();

		if (deleteAfterUpload) {
			await this.deleteUploadedFiles();
		}
	}

	async deleteUploadedFiles() {
		const notice = new Notice("", 0);

		const total = this.uploadedFiles.size;
		let count = 1;
		for (const file of this.uploadedFiles.keys()) {
			try {
				notice.setMessage(
					`Deleting local file '${file.path}'\n${count++}/${total}...`,
				);

				await this.plugin.deleteLocalFile(file);
			} catch (e) {
				const message = `Failed to delete local file '${file.path}', ${e}`;
				noticeError(message);
				this.deleteErrors.push({ file, error: message });
			}
		}

		notice.hide();
	}
}

export class BatchDownloader {
	plugin: WebDavImageUploaderPlugin;

	result: BatchProcessFileResult[] = [];

	constructor(plugin: WebDavImageUploaderPlugin) {
		this.plugin = plugin;
	}

	async createLog() {
		if (!this.plugin.settings.createBatchLog) {
			return;
		}
		await createBatchLog(this.plugin.app, this.result);
	}

	async downloadVaultFiles() {
		await this.downloadFolderFiles();
	}

	async downloadFolderFiles(folder?: TFolder) {
		const notes =
			folder == null
				? this.plugin.app.vault.getMarkdownFiles()
				: getMarkdownFilesInFolder(folder);

		const notice = new Notice("", 0);

		let count = 1;
		const total = notes.length;
		for (const note of notes) {
			notice.setMessage(
				`Downloading files in '${note.path}'\n${count++}/${total}...`,
			);

			try {
				await this.downloadNoteFiles(note);
			} catch (e) {
				noticeError(
					`Failed to download files from '${note.path}', ${e}`,
				);
			}
		}

		new Notice(`All files downloaded finished.`);

		notice.hide();
	}

	async downloadNoteFiles(note: TFile) {
		const content = await this.plugin.app.vault.read(note);
		const links = matchLinks(content).filter(
			(link) =>
				(!this.plugin.settings.enableDummyPdf ||
					getFileType(link.path) !== "pdf") &&
				this.plugin.isWebdavUrl(link.path),
		);
		const total = links.length;
		if (total === 0) {
			return;
		}

		const notice = new Notice("", 0);

		let count = 1;
		let newContent = content;
		for (const linkInfo of links) {
			try {
				notice.setMessage(
					`Downloading '${linkInfo.path}'\n${count++}/${total}...`,
				);

				const link = createLink(this.plugin, linkInfo);

				const newLink = await link.download(note);

				if (linkInfo.raw !== newLink.markdownLink) {
					newContent =
						newContent.substring(0, linkInfo.start) +
						newLink.markdownLink +
						newContent.substring(linkInfo.end);
				}

				this.result.push({
					status: "success",
					note,
					link: linkInfo,
					newLink: newLink.tFile.path,
				});
			} catch (e) {
				const message = `Failed to download file '${linkInfo.path}' from ${note.path}, ${e}`;
				this.result.push({
					status: "failed",
					message,
					note,
					link: linkInfo,
				});
				noticeError(message);
			}
		}

		if (content !== newContent) {
			await this.plugin.app.vault.modify(note, newContent, note.stat);
		}

		notice.hide();
	}
}

function getMarkdownFilesInFolder(folder: TFolder) {
	const files: TFile[] = [];
	for (const item of folder.children) {
		if (item instanceof TFile && item.extension === "md") {
			files.push(item);
		} else if (item instanceof TFolder) {
			files.push(...getMarkdownFilesInFolder(item));
		}
	}
	return files;
}

// Obsidian has an internal `app.metadataCache.getBacklinksForFile` can be used to get backlinks to a specific file,
// see: https://github.com/mnaoumov/obsidian-backlink-cache
// but I think it is not necessary to use this here, even though it may be more efficient
function getNotesByAttachments(attachments: TAbstractFile[], app: App) {
	const noteAttachmentsMap = new Map<
		string,
		{ note: TFile; attachments: Set<TAbstractFile> }
	>();
	const attachmentByPath = new Map(
		attachments.map((attachment) => [attachment.path, attachment]),
	);
	const resolvedLinks = app.metadataCache.resolvedLinks;
	for (const [notePath, links] of Object.entries(resolvedLinks)) {
		for (const link of Object.keys(links)) {
			const attachment = attachmentByPath.get(link);
			if (attachment == null) continue;

			let data = noteAttachmentsMap.get(notePath);
			if (data == null) {
				data = {
					note: getFileByPath(app, notePath)!,
					attachments: new Set(),
				};
				noteAttachmentsMap.set(notePath, data);
			}
			data.attachments.add(attachment);
		}
	}

	return noteAttachmentsMap;
}

export interface BatchProcessFileResult {
	status: "success" | "failed" | "skipped";

	message?: string;

	note: TFile;

	link: LinkInfo;

	newLink?: string;
}

export async function createBatchLog(
	app: App,
	results: BatchProcessFileResult[],
	appendLog?: (content: string) => Promise<string>,
) {
	const logPath = `webdav-batch-log-${moment().format("YYYYMMDD-HHmmss")}.md`;

	const noteResults = results.reduce((map, result) => {
		const arr = map.get(result.note) ?? [];
		arr.push(result);
		map.set(result.note, arr);
		return map;
	}, new Map<TFile, BatchProcessFileResult[]>());

	let content = "## Processed Notes\n\n";

	const headers = ["Status", "Original Link", "New Link", "Error Message"];
	const headerRow = `| ${headers.join(" | ")} |`;
	const separatorRow = `| ${headers.map(() => "---").join(" | ")} |`;

	for (const [note, results] of noteResults) {
		content += `### ${app.fileManager.generateMarkdownLink(
			note,
			logPath,
			undefined,
			note.basename,
		)}\n\n`;
		const statusOrder: Record<BatchProcessFileResult["status"], number> = {
			success: 0,
			skipped: 1,
			failed: 2,
		};
		results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
		content += headerRow + "\n" + separatorRow + "\n";
		for (const result of results) {
			const statusIcon =
				result.status === "success"
					? "✅"
					: result.status === "skipped"
						? "⏭️"
						: "❌";
			content += `| ${statusIcon} | ${result.link.path
				} | ${result.newLink ?? ""} | ${result.message ?? ""} |\n`;
		}
	}

	if (appendLog) {
		content = await appendLog(content);
	}

	let file = getFileByPath(app, logPath);
	if (file != null) {
		await app.vault.modify(file, content);
	} else {
		file = await app.vault.create(logPath, content);
	}

	await app.workspace.getLeaf(true).openFile(file);
	return file;
}
