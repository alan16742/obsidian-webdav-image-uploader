import { normalizeVaultPath, safeDecodeURIComponent } from "./attachmentPaths";
import type { NewLinkFormat } from "./obsidianPaths";
import {
	TemplateResolver,
	TEMPLATE_VARIABLE_PATTERN,
	stringVariable,
	templateKey,
	validateTemplate,
	type TemplateVariables,
} from "./templates";

export {
	formatTemplate,
	stringVariable,
	TemplateResolver,
	TEMPLATE_VARIABLE_NAMES,
	type TemplateDateValue,
	type TemplateVariable,
	type TemplateVariables,
} from "./templates";

export interface UploadRule {
	prefix: string;
	suffix: string;
	extensions: string[];
	logicalPath: string;
	remotePath: string;
	previewUrl: string;
}

/** All paths are literal, vault/DAV-root relative paths, never URLs. */
export interface AttachmentMapping {
	logicalPath: string;
	remotePath: string;
	previewUrl: string;
}

export interface UploadTarget extends AttachmentMapping {
	rule: UploadRule;
}

export const DEFAULT_LOGICAL_PATH = "{{attachment}}/{{nameext}}";
export const DEFAULT_REMOTE_PATH = "{{logicalPath}}";
export const DEFAULT_PREVIEW_URL = "{{url}}/{{remotePath}}";
export function createDefaultUploadRule(): UploadRule {
	return {
		prefix: "",
		suffix: "",
		extensions: ["jpg"],
		logicalPath: DEFAULT_LOGICAL_PATH,
		remotePath: DEFAULT_REMOTE_PATH,
		previewUrl: DEFAULT_PREVIEW_URL,
	};
}

export function normalizeExtension(extension: string): string {
	return extension.trim().replace(/^\.+/, "").toLowerCase();
}

export function normalizeUrlPrefix(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

export function normalizeUploadRule(value: unknown): UploadRule {
	const source = isRecord(value) ? value : {};
	const extensions = Array.isArray(source.extensions)
		? [
				...new Set(
					source.extensions
						.filter(
							(extension): extension is string =>
								typeof extension === "string",
						)
						.map(normalizeExtension)
						.filter(Boolean),
				),
			]
		: [];
	return {
		prefix: stringValue(source.prefix),
		suffix: stringValue(source.suffix),
		extensions,
		logicalPath:
			stringValue(source.logicalPath).trim() || DEFAULT_LOGICAL_PATH,
		remotePath:
			stringValue(source.remotePath).trim() || DEFAULT_REMOTE_PATH,
		previewUrl:
			stringValue(source.previewUrl).trim() || DEFAULT_PREVIEW_URL,
	};
}

export function sanitizeUploadRules(settingsData: unknown): UploadRule[] {
	const source = isRecord(settingsData) ? settingsData : {};
	return Array.isArray(source.uploadRules)
		? source.uploadRules.map(normalizeUploadRule)
		: [createDefaultUploadRule()];
}

export function sanitizePathMappings(value: unknown): AttachmentMapping[] {
	if (!Array.isArray(value)) return [];
	const mappings = new Map<string, AttachmentMapping>();
	for (const item of value) {
		if (
			!isRecord(item) ||
			typeof item.logicalPath !== "string" ||
			typeof item.remotePath !== "string" ||
			typeof item.previewUrl !== "string"
		)
			continue;
		try {
			const logicalPath = normalizeFilePath(item.logicalPath);
			const remotePath = normalizeFilePath(item.remotePath);
			validatePreviewUrl(item.previewUrl);
			mappings.set(logicalPath, {
				logicalPath,
				remotePath,
				previewUrl: item.previewUrl,
			});
		} catch {
			/* Ignore malformed persisted mappings. */
		}
	}
	return [...mappings.values()];
}

export function getFileNameParts(filePath: string, isLink = true) {
	const cleanPath = isLink ? filePath.split(/[?#]/, 1)[0] : filePath;
	const encodedName = cleanPath.split(/[\\/]/).pop() ?? "";
	const nameext = isLink ? safeDecodeURIComponent(encodedName) : encodedName;
	const dotIndex = nameext.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === nameext.length - 1)
		return { name: nameext, extension: "", nameext };
	return {
		name: nameext.substring(0, dotIndex),
		extension: normalizeExtension(nameext.substring(dotIndex + 1)),
		nameext,
	};
}

export function matchesUploadRule(
	rule: UploadRule,
	filePath: string,
	isLink = true,
): boolean {
	const { name, extension } = getFileNameParts(filePath, isLink);
	return (
		name.toLowerCase().startsWith(rule.prefix.toLowerCase()) &&
		name.toLowerCase().endsWith(rule.suffix.toLowerCase()) &&
		(rule.extensions.length === 0 || rule.extensions.includes(extension))
	);
}

export function findUploadRule(
	rules: UploadRule[],
	filePath: string,
	isLink = true,
): UploadRule | null {
	return (
		rules.find((rule) => matchesUploadRule(rule, filePath, isLink)) ?? null
	);
}

export function validateUploadRule(
	rule: UploadRule,
	webdavUrl: string,
): string[] {
	const errors: string[] = [];
	try {
		const parsed = new URL(webdavUrl);
		if (
			!["http:", "https:"].includes(parsed.protocol) ||
			parsed.search ||
			parsed.hash ||
			parsed.username ||
			parsed.password
		) {
			errors.push(
				"WebDAV URL must use HTTP or HTTPS without credentials, a query string or fragment.",
			);
		}
	} catch {
		errors.push("Configure a valid WebDAV connection URL.");
	}
	for (const field of ["logicalPath", "remotePath", "previewUrl"] as const) {
		if (!rule[field].trim()) errors.push(`${field} cannot be empty.`);
		errors.push(...validateTemplate(rule[field]));
	}
	return [...new Set(errors)];
}

/** Resolve paths from the same variable context, including forward references. */
export function createRuleTemplateResolver(
	rule: UploadRule,
	webdavUrl: string,
	variables: TemplateVariables,
	mapping: Partial<
		Pick<AttachmentMapping, "logicalPath" | "remotePath">
	> = {},
): TemplateResolver {
	const values: TemplateVariables = {
		...variables,
		url: stringVariable(normalizeUrlPrefix(webdavUrl)),
	};
	for (const field of ["logicalPath", "remotePath"] as const) {
		const key = field.toLowerCase();
		const value = values[key];
		const path =
			mapping[field] ??
			(value?.type === "string" ? value.value : undefined);
		if (path != null) values[key] = stringVariable(normalizeFilePath(path));
	}
	return new TemplateResolver(
		values,
		{ logicalpath: rule.logicalPath, remotepath: rule.remotePath },
		normalizeFilePath,
	);
}

/** This is the only logical -> DAV -> preview mapping implementation. */
export function buildUploadTarget(
	rule: UploadRule,
	webdavUrl: string,
	variables: TemplateVariables,
	existingLogicalPath?: string,
): UploadTarget {
	const normalizedRule = normalizeUploadRule(rule);
	const errors = validateUploadRule(normalizedRule, webdavUrl);
	if (errors.length) throw new Error(errors.join(" "));
	const resolver = createRuleTemplateResolver(
		normalizedRule,
		webdavUrl,
		variables,
		{ logicalPath: existingLogicalPath },
	);
	const logicalPath = resolver.resolve("logicalPath");
	const remotePath = resolver.resolve("remotePath");
	const previewUrl = renderPreviewUrl(normalizedRule.previewUrl, resolver);
	return { rule: normalizedRule, logicalPath, remotePath, previewUrl };
}

export function buildPreviewUrl(
	template: string,
	webdavUrl: string,
	variables: TemplateVariables,
	mapping: Pick<AttachmentMapping, "logicalPath" | "remotePath">,
): string {
	// Encode values once at the URL boundary, preserving literal query syntax.
	return renderPreviewUrl(
		template,
		new TemplateResolver({
			...variables,
			logicalpath: stringVariable(mapping.logicalPath),
			remotepath: stringVariable(mapping.remotePath),
			url: stringVariable(normalizeUrlPrefix(webdavUrl)),
		}),
	);
}

export function logicalToRemote(
	rule: UploadRule,
	logicalPath: string,
	webdavUrl: string,
	variables: TemplateVariables,
): UploadTarget {
	const captured = matchPathTemplate(rule.logicalPath, logicalPath) ?? {};
	return buildUploadTarget(
		rule,
		webdavUrl,
		{ ...variables, ...captured },
		logicalPath,
	);
}

export function resolveUploadTarget(
	rules: UploadRule[],
	filePath: string,
	webdavUrl: string,
	variables: TemplateVariables,
	logicalPath?: string,
): UploadTarget | null {
	const rule = findUploadRule(rules, filePath, false);
	return rule == null
		? null
		: logicalPath == null
			? buildUploadTarget(rule, webdavUrl, variables)
			: logicalToRemote(rule, logicalPath, webdavUrl, variables);
}

/** Capture formatted dates too, so existing paths never substitute today's date. */
export function matchPathTemplate(
	template: string,
	path: string,
): TemplateVariables | null {
	return matchTemplate(
		template.replace(/\\/g, "/").replace(/^\/+/, ""),
		normalizeVaultPath(path),
	);
}

function matchTemplate(
	template: string,
	value: string,
	decodeValues = false,
): TemplateVariables | null {
	let pattern = "";
	let offset = 0;
	const keys: string[] = [];
	for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
		pattern += escapeRegExp(template.slice(offset, match.index));
		const key = templateKey(match[1], match[2]);
		keys.push(key);
		pattern +=
			["attachment", "logicalpath", "remotepath"].includes(key) ||
			match[2]?.includes("/")
				? "(.*?)"
				: "([^/]*?)";
		offset = (match.index ?? 0) + match[0].length;
	}
	pattern += escapeRegExp(template.slice(offset));
	const matched = new RegExp(`^${pattern}$`).exec(value);
	if (matched == null) return null;
	const variables: TemplateVariables = {};
	for (const [index, key] of keys.entries()) {
		const value = decodeValues
			? safeDecodeURIComponent(matched[index + 1])
			: matched[index + 1];
		const previous = variables[key];
		if (previous?.value !== undefined && previous.value !== value)
			return null;
		variables[key] = stringVariable(value);
	}
	return variables;
}

/** Resolve managed URL links through the same templates, without guessing a DAV host. */
export function resolvePreviewUrl(
	url: string,
	rules: UploadRule[],
	webdavUrl: string,
	variables: TemplateVariables = {},
): UploadTarget | null {
	if (!/^https?:\/\//i.test(url)) return null;
	const cleanUrl = stripUrlFragment(url);
	for (const rule of rules) {
		const template = canonicalTemplateUrl(
			rule.previewUrl.replace(
				/\{\{\s*url\s*\}\}/gi,
				normalizeUrlPrefix(webdavUrl),
			),
		);
		const captured = matchTemplate(
			stripUrlFragment(template),
			new URL(cleanUrl).href,
			true,
		);
		if (captured == null) continue;
		const vars = { ...variables, ...captured };
		const capturedRemote = captured.remotepath;
		if (capturedRemote?.type === "string") {
			const remoteVars = matchPathTemplate(
				rule.remotePath,
				capturedRemote.value,
			);
			if (remoteVars == null) continue;
			Object.assign(vars, remoteVars);
		}
		const target = buildUploadTarget(rule, webdavUrl, vars);
		if (samePreviewUrl(target.previewUrl, cleanUrl)) return target;
	}
	return null;
}

export function samePreviewUrl(left: string, right: string): boolean {
	try {
		return canonicalPreviewUrl(left) === canonicalPreviewUrl(right);
	} catch {
		return false;
	}
}

function canonicalPreviewUrl(value: string): string {
	const url = new URL(stripUrlFragment(value));
	const path = url.pathname
		.split("/")
		.map((segment) => encodePathSegment(safeDecodeURIComponent(segment)))
		.join("/");
	return (
		url.origin +
		path +
		url.search.replace(/%[\da-f]{2}/gi, (token) => token.toUpperCase())
	);
}

function canonicalTemplateUrl(template: string): string {
	const tokens: string[] = [];
	let marker = "webdavtemplateplaceholder";
	while (template.includes(marker)) marker += "x";
	const marked = template.replace(TEMPLATE_VARIABLE_PATTERN, (token) => {
		tokens.push(token);
		return marker + (tokens.length - 1);
	});
	return new URL(marked).href.replace(
		new RegExp(marker + "(\\d+)", "g"),
		(_, index: string) => tokens[Number(index)],
	);
}

export function isManagedUrl(
	url: string,
	webdavUrl: string,
	rules: UploadRule[],
	mappings: AttachmentMapping[] = [],
): boolean {
	return (
		mappings.some((mapping) => samePreviewUrl(mapping.previewUrl, url)) ||
		resolvePreviewUrl(url, rules, webdavUrl) != null
	);
}

export function formatUploadLink(
	target: { linkTarget: string; linkType?: "local" | "external" },
	fileName: string,
	useMarkdownLinks: boolean,
): string {
	const external = target.linkType === "external";
	if (!external && !useMarkdownLinks && !/[\[\]|#]/.test(target.linkTarget))
		return `[[${target.linkTarget}]]`;
	const linkText = fileName.replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&");
	const linkTarget = external
		? target.linkTarget.replace(/[()]/g, encodePathSegment)
		: encodeLocalLinkPath(target.linkTarget);
	return `[${linkText}](${linkTarget})`;
}

export function getLocalLinkTarget(
	logicalPath: string,
	sourcePath: string,
	newLinkFormat: NewLinkFormat,
): string {
	const normalizedTarget = normalizeVaultPath(logicalPath);
	if (newLinkFormat === "absolute") return "/" + normalizedTarget;
	// Keep the logical directory in remote-only links. A basename alone cannot
	// distinguish attachments with the same name after local copies are deleted.
	if (newLinkFormat === "shortest") return normalizedTarget;
	const targetSegments = normalizedTarget.split("/").filter(Boolean);
	const sourceSegments = normalizeVaultPath(sourcePath)
		.split("/")
		.filter(Boolean);
	sourceSegments.pop();
	let shared = 0;
	while (
		shared < sourceSegments.length &&
		shared < targetSegments.length &&
		sourceSegments[shared] === targetSegments[shared]
	)
		shared++;
	const relative = [
		...sourceSegments.slice(shared).map(() => ".."),
		...targetSegments.slice(shared),
	].join("/");
	return relative.startsWith("../") ? relative : `./${relative}`;
}

export function normalizeFilePath(path: string): string {
	if (/\{\{[^}]*\}\}/.test(path))
		throw new Error(`Unresolved path variable: '${path}'.`);
	if (/^[a-z][a-z\d+.-]*:/i.test(path.trim()) || path.startsWith("//"))
		throw new Error(
			"Attachment paths must be relative to the vault or WebDAV root, not URLs.",
		);
	const normalized = normalizeVaultPath(path.trim());
	if (!normalized || path.trim().endsWith("/"))
		throw new Error("Attachment path must include a filename.");
	return normalized;
}

export function encodeLocalLinkPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.map((segment) =>
			["", ".", ".."].includes(segment)
				? segment
				: encodePathSegment(segment),
		)
		.join("/");
}

function renderPreviewUrl(
	template: string,
	resolver: TemplateResolver,
): string {
	const rendered = resolver.render(template, (value, key, offset) => {
		if (key === "url") return normalizeUrlPrefix(value);
		const before = template.slice(0, offset);
		return /[?#]/.test(before)
			? encodeURIComponent(value)
			: value.split("/").map(encodePathSegment).join("/");
	});
	validatePreviewUrl(rendered);
	return new URL(rendered).href;
}

function validatePreviewUrl(value: string): void {
	if (/\{\{[^}]*\}\}/.test(value))
		throw new Error("Preview URL contains an unresolved variable.");
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error(
			"Preview URL must use HTTP or HTTPS without embedded credentials.",
		);
}

function stripUrlFragment(url: string): string {
	return url.split("#", 1)[0];
}
function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replace(
		/[()]/g,
		(char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
	);
}
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}
