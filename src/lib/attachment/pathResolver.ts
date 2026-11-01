import type WebDavImageUploaderPlugin from "../../main";
import type { WebDavImageUploaderSettings } from "../../settings";
import { getFileByPath, getFormatVariables, isLocalPath } from "../../utils";
import { getAttachmentFolderPath } from "./obsidianPaths";
import {
	isBareAttachmentPath,
	normalizeAttachmentPath,
} from "./attachmentPaths";
import {
	buildPreviewUrl,
	createRuleTemplateResolver,
	findUploadRule,
	getFileNameParts,
	matchPathTemplate,
	logicalToRemote,
	normalizeFilePath,
	resolvePreviewUrl,
	type AttachmentMapping,
	type TemplateVariables,
	type UploadTarget,
} from "./uploadRules";

/** Resolve every attachment from the current note context and ordered rules. */
export class AttachmentPathResolver {
	constructor(
		private readonly plugin: WebDavImageUploaderPlugin,
		readonly settings: WebDavImageUploaderSettings = plugin.settings,
	) {}

	async variables(
		filePath: string,
		sourcePath: string,
	): Promise<TemplateVariables> {
		const name = getFileNameParts(filePath, false).nameext;
		const note = this.plugin.app.vault.getFileByPath(sourcePath);
		const local = this.plugin.app.vault.getFileByPath(filePath);
		const attachmentFolder = await getAttachmentFolderPath(
			this.plugin.app,
			sourcePath,
			name,
		);
		return getFormatVariables(
			new File([], name, {
				lastModified: local?.stat.mtime ?? note?.stat.mtime ?? 0,
			}),
			note ?? {
				basename: getFileNameParts(sourcePath, false).name,
				stat: { ctime: 0, mtime: 0 },
			},
			attachmentFolder,
		);
	}

	/** Resolve a note link to a canonical logical path before mapping it. */
	async resolve(
		linkPath: string,
		sourcePath: string,
		encoded = true,
	): Promise<AttachmentMapping | null> {
		if (!isLocalPath(linkPath)) {
			return resolvePreviewUrl(
				linkPath,
				this.settings.uploadRules,
				this.settings.url,
				await this.variables(
					getFileNameParts(linkPath).nameext,
					sourcePath,
				),
			);
		}
		const local = getFileByPath(
			this.plugin.app,
			linkPath,
			sourcePath,
			encoded,
		);
		let logicalPath =
			local?.path ??
			normalizeAttachmentPath(linkPath, sourcePath, encoded).substring(1);
		const variables = await this.variables(logicalPath, sourcePath);
		if (local == null && isBareAttachmentPath(linkPath)) {
			const rule = findUploadRule(
				this.settings.uploadRules,
				logicalPath,
				false,
			);
			if (rule == null) return null;
			// A shortest link supplies only the filename. Expand its directory from
			// the current note context without applying the filename template twice.
			const format = rule.logicalPath.replace(/\\/g, "/");
			const slash = format.lastIndexOf("/");
			const directory =
				slash === -1
					? ""
					: createRuleTemplateResolver(
							rule,
							this.settings.url,
							variables,
						).render(format.slice(0, slash));
			logicalPath = normalizeFilePath(
				[directory, logicalPath].filter(Boolean).join("/"),
			);
		}
		const rule = findUploadRule(
			this.settings.uploadRules,
			logicalPath,
			false,
		);
		if (rule == null) return null;
		return logicalToRemote(rule, logicalPath, this.settings.url, variables);
	}

	async renameTarget(
		mapping: AttachmentMapping,
		newPath: string,
		sourcePath: string,
	): Promise<UploadTarget> {
		const path = normalizeFilePath(newPath);
		const rule =
			(this.settings.useLogicalLinks
				? findUploadRule(this.settings.uploadRules, path, false)
				: null) ??
			findUploadRule(
				this.settings.uploadRules,
				mapping.logicalPath,
				false,
			) ??
			this.settings.uploadRules.find(
				(rule) =>
					matchPathTemplate(rule.logicalPath, mapping.logicalPath) !=
					null,
			);
		if (rule == null)
			throw new Error("No upload rule matches the renamed attachment.");
		if (this.settings.useLogicalLinks) {
			const previous =
				matchPathTemplate(rule.remotePath, mapping.remotePath) ?? {};
			for (const key of ["logicalpath", "name", "nameext", "ext"])
				delete previous[key];
			return logicalToRemote(rule, path, this.settings.url, {
				...(await this.variables(path, sourcePath)),
				...previous,
			});
		}
		// URL mode accepts the actual DAV path. Derive a download destination
		// from reversible templates, retaining the old logical folder otherwise.
		const previous =
			matchPathTemplate(rule.logicalPath, mapping.logicalPath) ?? {};
		for (const key of ["logicalpath", "name", "nameext", "ext"])
			delete previous[key];
		const captured = matchPathTemplate(rule.remotePath, path);
		const variables = {
			...(await this.variables(path, sourcePath)),
			...previous,
			...(captured ?? {}),
		};
		const filename = getFileNameParts(path, false).nameext;
		const folder = mapping.logicalPath.substring(
			0,
			mapping.logicalPath.lastIndexOf("/") + 1,
		);
		const logicalPath =
			captured == null
				? folder + filename
				: createRuleTemplateResolver(
						rule,
						this.settings.url,
						variables,
						{ remotePath: path },
					).resolve("logicalPath");
		return {
			rule,
			logicalPath: normalizeFilePath(logicalPath),
			remotePath: path,
			previewUrl: buildPreviewUrl(
				rule.previewUrl,
				this.settings.url,
				variables,
				{ logicalPath, remotePath: path },
			),
		};
	}
}
