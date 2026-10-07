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
	samePreviewUrl,
	type AttachmentMapping,
	type TemplateVariables,
	type UploadTarget,
} from "./uploadRules";

/** Shared by note operations, batch transfers and media fallback. */
export class AttachmentPathResolver {
	constructor(
		private readonly plugin: WebDavImageUploaderPlugin,
		readonly settings: WebDavImageUploaderSettings = plugin.settings,
	) {}

	private get mappings(): AttachmentMapping[] {
		// Include mappings committed by other operations since a session started.
		return [
			...this.settings.pathMappings,
			...this.plugin.settings.pathMappings,
		];
	}

	findLogical(logicalPath: string): AttachmentMapping | undefined {
		return [...this.mappings]
			.reverse()
			.find((mapping) => mapping.logicalPath === logicalPath);
	}

	findPreview(previewUrl: string): AttachmentMapping | undefined {
		return this.mappings.find((mapping) =>
			samePreviewUrl(mapping.previewUrl, previewUrl),
		);
	}

	hasRecordedLink(
		linkPath: string,
		sourcePath: string,
		encoded = true,
	): boolean {
		try {
			const logicalPath = normalizeAttachmentPath(
				linkPath,
				sourcePath,
				encoded,
			).substring(1);
			return (
				this.findLogical(logicalPath) != null ||
				(isBareAttachmentPath(linkPath) &&
					this.mappings.some(
						(mapping) =>
							getFileNameParts(mapping.logicalPath, false)
								.nameext === logicalPath,
					))
			);
		} catch {
			return false;
		}
	}

	async currentPreview(
		mapping: AttachmentMapping,
		sourcePath: string,
	): Promise<AttachmentMapping> {
		const rule =
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
		if (rule == null) return mapping;
		const variables = {
			...(await this.variables(mapping.logicalPath, sourcePath)),
			...(matchPathTemplate(rule.logicalPath, mapping.logicalPath) ?? {}),
			...(matchPathTemplate(rule.remotePath, mapping.remotePath) ?? {}),
		};
		return {
			...mapping,
			previewUrl: buildPreviewUrl(
				rule.previewUrl,
				this.settings.url,
				variables,
				mapping,
			),
		};
	}

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
			const recorded = this.findPreview(linkPath);
			if (recorded != null) return recorded;
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
		const recorded = this.findLogical(logicalPath);
		if (recorded != null)
			return await this.currentPreview(recorded, sourcePath);
		let variables = await this.variables(logicalPath, sourcePath);
		if (local == null && isBareAttachmentPath(linkPath)) {
			const candidates = [
				...new Map(
					this.mappings
						.filter(
							(mapping) =>
								getFileNameParts(mapping.logicalPath, false)
									.nameext === logicalPath,
						)
						.map((mapping) => [mapping.logicalPath, mapping]),
				).values(),
			];
			const attachment = variables.attachment.value;
			const inFolder = candidates.filter(
				(mapping) =>
					typeof attachment === "string" &&
					mapping.logicalPath.startsWith(
						attachment ? attachment + "/" : "",
					),
			);
			const preferred = inFolder.length === 1 ? inFolder : candidates;
			if (preferred.length === 1)
				return await this.currentPreview(preferred[0], sourcePath);
			if (preferred.length > 1)
				throw new Error(
					`Ambiguous attachment '${linkPath}'; use its full logical path.`,
				);
			const rule = findUploadRule(
				this.settings.uploadRules,
				logicalPath,
				false,
			);
			if (rule == null) return null;
			// Expand only the directory. The final filename is already in the note
			// and must not have a rename/date template applied for a second time.
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
			const mapping = this.findLogical(logicalPath);
			if (mapping != null)
				return await this.currentPreview(mapping, sourcePath);
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
		let target: UploadTarget;
		if (this.settings.useLogicalLinks) {
			const previous =
				matchPathTemplate(rule.remotePath, mapping.remotePath) ?? {};
			for (const key of ["logicalpath", "name", "nameext", "ext"])
				delete previous[key];
			target = logicalToRemote(rule, path, this.settings.url, {
				...(await this.variables(path, sourcePath)),
				...previous,
			});
		} else {
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
			target = {
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
		const logicalPath = target.logicalPath;
		const occupied = this.findLogical(logicalPath);
		if (occupied != null && occupied.logicalPath !== mapping.logicalPath)
			throw new Error(`Logical path already mapped: '${logicalPath}'.`);
		return target;
	}

	assertAvailable(
		mapping: AttachmentMapping,
		previousLogicalPath?: string,
	): void {
		const conflict = this.mappings.find(
			(item) =>
				item.remotePath === mapping.remotePath &&
				item.logicalPath !== mapping.logicalPath &&
				item.logicalPath !== previousLogicalPath,
		);
		if (conflict != null)
			throw new Error(
				`Remote path '${mapping.remotePath}' is already mapped to '${conflict.logicalPath}'.`,
			);
	}

	async remember(
		mapping: AttachmentMapping,
		previousLogicalPath?: string,
	): Promise<void> {
		const record = {
			logicalPath: mapping.logicalPath,
			remotePath: mapping.remotePath,
			previewUrl: mapping.previewUrl,
		};
		this.settings.pathMappings = this.settings.pathMappings.filter(
			(item) =>
				item.logicalPath !== record.logicalPath &&
				item.logicalPath !== previousLogicalPath,
		);
		this.settings.pathMappings.push(record);
		await this.plugin.rememberPathMapping(record, previousLogicalPath);
	}

	async forget(logicalPath: string): Promise<void> {
		this.settings.pathMappings = this.settings.pathMappings.filter(
			(mapping) => mapping.logicalPath !== logicalPath,
		);
		await this.plugin.forgetPathMapping(logicalPath);
	}
}
