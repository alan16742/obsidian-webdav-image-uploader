import { moment, type App, type TFile } from "obsidian";
import type { LinkInfo } from "../note/noteLinks";
import type { CleanupResult } from "../attachment/attachmentCleanup";
import { getAvailableVaultPath } from "../attachment/obsidianPaths";

export interface BatchProcessFileResult {
	status: "success" | "failed" | "skipped";
	message?: string;
	note: TFile;
	link?: LinkInfo;
	newLink?: string;
}

function cell(value = ""): string {
	return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export async function createBatchLog(app: App, results: BatchProcessFileResult[], cleanup: CleanupResult[] = []) {
	const path = getAvailableVaultPath(app, `webdav-batch-log-${moment().format("YYYYMMDD-HHmmss")}.md`);
	let content = "## Transfers\n\n| Status | Note | Original Link | New Link | Message |\n| --- | --- | --- | --- | --- |\n";
	for (const result of results) {
		content += "| " + [result.status, result.note.path, result.link?.path, result.newLink, result.message].map(value => cell(value)).join(" | ") + " |\n";
	}
	if (cleanup.length > 0) {
		content += "\n## Local attachment cleanup\n\n| Status | File | Message |\n| --- | --- | --- |\n";
		for (const result of cleanup) content += "| " + [result.status, result.file.path, result.message].map(cell).join(" | ") + " |\n";
	}
	const file = await app.vault.create(path, content);
	await app.workspace.getLeaf(true).openFile(file);
	return file;
}
