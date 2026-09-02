import type { App } from "obsidian";
import { normalizeVaultPath } from "./attachmentPath";

export type NewLinkFormat = "shortest" | "relative" | "absolute";

type ConfigurableVault = App["vault"] & {
	getConfig?: (name: string) => unknown;
};

/**
 * Resolve the default attachment folder through Obsidian's public file API.
 * The result is a canonical vault path with no leading or trailing slash.
 */
export async function getAttachmentFolderPath(
	app: App,
	sourcePath: string,
	newFilePath: string,
): Promise<string> {
	const attachmentPath =
		await app.fileManager.getAvailablePathForAttachment(
			newFilePath,
			sourcePath,
		);
	const normalizedPath = normalizeVaultPath(attachmentPath);
	const slashIndex = normalizedPath.lastIndexOf("/");
	return slashIndex === -1
		? ""
		: normalizedPath.substring(0, slashIndex);
}

/**
 * Obsidian currently exposes link generation but no typed public getter for
 * the link-format preferences needed before a remote-only file exists. Keep
 * the runtime compatibility access isolated here; never read app.json.
 */
function getVaultConfig(app: App, name: string): unknown {
	return (app.vault as ConfigurableVault).getConfig?.(name);
}

export function getNewLinkFormat(app: App): NewLinkFormat {
	const value = getVaultConfig(app, "newLinkFormat");
	return value === "relative" || value === "absolute" || value === "shortest"
		? value
		: "shortest";
}

export function getUseMarkdownLinks(app: App): boolean {
	return getVaultConfig(app, "useMarkdownLinks") === true;
}

/** Return a collision-free vault path while preserving its parent folder. */
export function getAvailableVaultPath(app: App, requestedPath: string): string {
	const normalizedPath = normalizeVaultPath(requestedPath);
	if (normalizedPath === "") {
		throw new Error("Attachment path is empty.");
	}
	if (app.vault.getAbstractFileByPath(normalizedPath) == null) {
		return normalizedPath;
	}

	const slashIndex = normalizedPath.lastIndexOf("/");
	const parentPath = slashIndex === -1
		? ""
		: normalizedPath.substring(0, slashIndex);
	const fileName = normalizedPath.substring(slashIndex + 1);
	const dotIndex = fileName.lastIndexOf(".");
	const stem = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
	const extension = dotIndex > 0 ? fileName.substring(dotIndex) : "";

	for (let index = 1; ; index++) {
		const candidateName = `${stem} ${index}${extension}`;
		const candidatePath = parentPath === ""
			? candidateName
			: `${parentPath}/${candidateName}`;
		if (app.vault.getAbstractFileByPath(candidatePath) == null) {
			return candidatePath;
		}
	}
}

/** Ensure every parent directory for a vault file path exists. */
export async function ensureVaultParentFolder(
	app: App,
	filePath: string,
): Promise<void> {
	const normalizedPath = normalizeVaultPath(filePath);
	const slashIndex = normalizedPath.lastIndexOf("/");
	if (slashIndex === -1) return;

	const segments = normalizedPath.substring(0, slashIndex).split("/");
	let currentPath = "";
	for (const segment of segments) {
		currentPath = currentPath === ""
			? segment
			: `${currentPath}/${segment}`;
		if (app.vault.getFolderByPath(currentPath) != null) continue;
		if (app.vault.getAbstractFileByPath(currentPath) != null) {
			throw new Error(`Attachment parent is not a folder: '${currentPath}'.`);
		}
		await app.vault.createFolder(currentPath);
	}
}
