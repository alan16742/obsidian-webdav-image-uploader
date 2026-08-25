export interface UploadRule {
	prefix: string;
	suffix: string;
	extensions: string[];
	urlPrefix: string;
	linkFormat: string;
}

export interface TemplateDateValue {
	format(pattern: string): string;
}

export type TemplateVariable =
	| { type: "string"; value: string }
	| { type: "date"; value: TemplateDateValue };

export type TemplateVariables = Record<string, TemplateVariable>;

export interface UploadTarget {
	rule: UploadRule;
	urlPrefix: string;
	remotePath: string;
	url: string;
}

export const DEFAULT_UPLOAD_RULE: UploadRule = {
	prefix: "",
	suffix: "",
	extensions: ["jpg", "jpeg", "png", "gif", "svg", "webp"],
	urlPrefix: "",
	linkFormat: "{{url}}/{{nameext}}",
};

export const TEMPLATE_VARIABLE_NAMES = [
	"url",
	"name",
	"ext",
	"nameext",
	"mtime",
	"now",
	"notename",
	"notectime",
	"notemtime",
] as const;

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*(\w+)(?::([^}]+))?\s*\}\}/g;
const URL_VARIABLE_AT_START_PATTERN = /^\s*\{\{\s*url\s*\}\}/i;

export function createDefaultUploadRule(): UploadRule {
	return {
		...DEFAULT_UPLOAD_RULE,
		extensions: [...DEFAULT_UPLOAD_RULE.extensions],
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
		? source.extensions
				.filter((extension): extension is string =>
					typeof extension === "string",
				)
				.map(normalizeExtension)
				.filter((extension, index, values) =>
					extension !== "" && values.indexOf(extension) === index,
				)
		: [];

	return {
		prefix: stringValue(source.prefix),
		suffix: stringValue(source.suffix),
		extensions,
		urlPrefix: normalizeUrlPrefix(stringValue(source.urlPrefix)),
		linkFormat: stringValue(source.linkFormat),
	};
}

export function sanitizeUploadRules(settingsData: unknown): UploadRule[] {
	const source = isRecord(settingsData) ? settingsData : {};
	return Array.isArray(source.uploadRules)
		? source.uploadRules.map(normalizeUploadRule)
		: [createDefaultUploadRule()];
}

export function getFileNameParts(filePath: string) {
	const cleanPath = filePath.split(/[?#]/, 1)[0];
	const encodedName = cleanPath.split(/[\\/]/).pop() ?? "";
	const nameext = safeDecodeURIComponent(encodedName);
	const dotIndex = nameext.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === nameext.length - 1) {
		return { name: nameext, extension: "", nameext };
	}

	return {
		name: nameext.substring(0, dotIndex),
		extension: normalizeExtension(nameext.substring(dotIndex + 1)),
		nameext,
	};
}

export function matchesUploadRule(rule: UploadRule, filePath: string): boolean {
	const normalizedRule = normalizeUploadRule(rule);
	const { name, extension } = getFileNameParts(filePath);
	const normalizedName = name.toLowerCase();
	const prefix = normalizedRule.prefix.toLowerCase();
	const suffix = normalizedRule.suffix.toLowerCase();

	return (
		(prefix === "" || normalizedName.startsWith(prefix)) &&
		(suffix === "" || normalizedName.endsWith(suffix)) &&
		(normalizedRule.extensions.length === 0 ||
			normalizedRule.extensions.includes(extension))
	);
}

export function findUploadRule(
	rules: UploadRule[],
	filePath: string,
): UploadRule | null {
	return rules.find((rule) => matchesUploadRule(rule, filePath)) ?? null;
}

export function formatTemplate(
	template: string,
	variables: TemplateVariables,
): string {
	return template.replace(
		TEMPLATE_VARIABLE_PATTERN,
		(match, key: string, format: string | undefined) => {
			const value = variables[key.toLowerCase()];
			if (value == null) {
				return match;
			}

			if (value.type === "string") {
				return value.value;
			}

			return value.value.format(format?.trim() || "YYYY-MM-DD HH:mm:ss");
		},
	);
}

export function validateUploadRule(
	rule: UploadRule,
	webdavUrl: string,
): string[] {
	const errors: string[] = [];
	const urlPrefix = getEffectiveUrlPrefix(rule, webdavUrl);

	if (urlPrefix === "") {
		errors.push("Set a URL prefix or configure the main WebDAV URL.");
	} else {
		try {
			const parsedUrl = new URL(urlPrefix);
			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				errors.push("URL prefix must use HTTP or HTTPS.");
			}
			if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
				errors.push("URL prefix cannot contain a query string or fragment.");
			}
		} catch {
			errors.push("URL prefix is not a valid URL.");
		}
	}

	if (!URL_VARIABLE_AT_START_PATTERN.test(rule.linkFormat)) {
		errors.push("Link format must start with {{url}}.");
	}

	const knownVariables = new Set<string>(TEMPLATE_VARIABLE_NAMES);
	const unknownVariables = Array.from(rule.linkFormat.matchAll(TEMPLATE_VARIABLE_PATTERN))
		.map((match) => match[1].toLowerCase())
		.filter((name, index, names) =>
			!knownVariables.has(name) && names.indexOf(name) === index,
		);
	if (unknownVariables.length > 0) {
		errors.push(`Unknown variable: ${unknownVariables.join(", ")}.`);
	}

	return errors;
}

export function buildUploadTarget(
	rule: UploadRule,
	webdavUrl: string,
	variables: TemplateVariables,
): UploadTarget {
	const normalizedRule = normalizeUploadRule(rule);
	const errors = validateUploadRule(normalizedRule, webdavUrl);
	if (errors.length > 0) {
		throw new Error(errors.join(" "));
	}

	const urlPrefix = getEffectiveUrlPrefix(normalizedRule, webdavUrl);
	const renderedUrl = formatTemplate(normalizedRule.linkFormat, {
		...variables,
		url: { type: "string", value: urlPrefix },
	}).trim();
	const remotePath = hasUrlPrefix(renderedUrl, urlPrefix)
		? normalizeRemotePath(renderedUrl.substring(urlPrefix.length))
		: null;
	if (remotePath == null || remotePath === "/") {
		throw new Error(
			"Link format must produce a file path after the URL prefix.",
		);
	}

	return {
		rule: normalizedRule,
		urlPrefix,
		remotePath,
		url: buildManagedUrl(urlPrefix, remotePath),
	};
}

export function resolveUploadTarget(
	rules: UploadRule[],
	filePath: string,
	webdavUrl: string,
	variables: TemplateVariables,
): UploadTarget | null {
	const rule = findUploadRule(rules, filePath);
	return rule == null ? null : buildUploadTarget(rule, webdavUrl, variables);
}

export function getEffectiveUrlPrefix(
	rule: UploadRule,
	webdavUrl: string,
): string {
	return normalizeUrlPrefix(rule.urlPrefix || webdavUrl);
}

export function getManagedUrlPrefix(
	url: string,
	webdavUrl: string,
	rules: UploadRule[],
): string | null {
	const candidates = [
		...rules.map((rule) => getEffectiveUrlPrefix(rule, webdavUrl)),
		normalizeUrlPrefix(webdavUrl),
	]
		.filter((candidate, index, values) =>
			candidate !== "" && values.indexOf(candidate) === index,
		)
		.sort((left, right) => right.length - left.length);

	return candidates.find((candidate) => hasUrlPrefix(url, candidate)) ?? null;
}

export function isManagedUrl(
	url: string,
	webdavUrl: string,
	rules: UploadRule[],
): boolean {
	return getManagedUrlPrefix(url, webdavUrl, rules) != null;
}

export function extractRemotePath(
	url: string,
	webdavUrl: string,
	rules: UploadRule[],
): string {
	const prefix = getManagedUrlPrefix(url, webdavUrl, rules);
	if (prefix == null) {
		throw new Error(`URL is not managed by an upload rule: '${url}'`);
	}

	const path = extractPathForPrefix(url, prefix);
	if (path == null || path === "/") {
		throw new Error(`URL does not contain a WebDAV file path: '${url}'`);
	}
	return path;
}

export function buildManagedUrl(urlPrefix: string, remotePath: string): string {
	const prefix = normalizeUrlPrefix(urlPrefix);
	return encodeURI(prefix) + encodeRemotePath(remotePath);
}

function extractPathForPrefix(url: string, prefix: string): string | null {
	const cleanUrl = url.trim().split(/[?#]/, 1)[0];
	const normalizedPrefix = normalizeUrlPrefix(prefix);
	const encodedPrefix = encodeURI(normalizedPrefix);
	const matchingPrefix = hasUrlPrefix(cleanUrl, normalizedPrefix)
		? normalizedPrefix
		: hasUrlPrefix(cleanUrl, encodedPrefix)
			? encodedPrefix
			: null;
	if (matchingPrefix == null) {
		return null;
	}

	return decodeRemotePath(cleanUrl.substring(matchingPrefix.length));
}

function hasUrlPrefix(url: string, prefix: string): boolean {
	const cleanUrl = url.trim().split(/[?#]/, 1)[0];
	const normalizedPrefix = normalizeUrlPrefix(prefix);
	const encodedPrefix = encodeURI(normalizedPrefix);
	return [normalizedPrefix, encodedPrefix].some(
		(candidate) =>
			cleanUrl === candidate || cleanUrl.startsWith(candidate + "/"),
	);
}

function normalizeRemotePath(path: string): string {
	const withoutLeadingSlashes = path.replace(/^\/+/, "");
	return "/" + withoutLeadingSlashes.replace(/\/{2,}/g, "/");
}

function encodeRemotePath(path: string): string {
	return normalizeRemotePath(path)
		.split("/")
		.map((segment) => encodeURIComponent(safeDecodeURIComponent(segment)))
		.join("/");
}

function decodeRemotePath(path: string): string {
	return normalizeRemotePath(path)
		.split("/")
		.map(safeDecodeURIComponent)
		.join("/");
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}
