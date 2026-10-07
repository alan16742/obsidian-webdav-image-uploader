export interface TemplateDateValue {
	format(pattern: string): string;
}

export type TemplateVariable =
	| { type: "string"; value: string }
	| { type: "date"; value: TemplateDateValue };
export type TemplateVariables = Record<string, TemplateVariable>;

export const TEMPLATE_VARIABLE_NAMES = [
	"url",
	"logicalPath",
	"remotePath",
	"attachment",
	"name",
	"ext",
	"nameext",
	"mtime",
	"now",
	"notename",
	"notectime",
	"notemtime",
] as const;

export const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*(\w+)(?::([^}]+))?\s*\}\}/g;
const VARIABLE_NAMES = new Set<string>(
	TEMPLATE_VARIABLE_NAMES.map((name) => name.toLowerCase()),
);
const DATE_VARIABLES = new Set(["mtime", "now", "notectime", "notemtime"]);

type ValueTransform = (value: string, key: string, offset: number) => string;

/** One variable context and parser for every template, regardless of its field. */
export class TemplateResolver {
	private readonly values: TemplateVariables;
	private readonly resolving: string[] = [];

	constructor(
		variables: TemplateVariables,
		private readonly templates: Record<string, string> = {},
		private readonly normalizeValue: (value: string) => string = (value) =>
			value,
	) {
		this.values = { ...variables };
	}

	render(template: string, transform?: ValueTransform): string {
		return template.replace(
			TEMPLATE_VARIABLE_PATTERN,
			(_, key: string, format: string | undefined, offset: number) => {
				const value = this.resolve(key, format);
				return transform == null
					? value
					: transform(value, key.toLowerCase(), offset);
			},
		);
	}

	resolve(key: string, format?: string): string {
		validateReference(key, format);
		const name = key.toLowerCase();
		let value = this.values[templateKey(name, format)] ?? this.values[name];
		if (value == null && this.templates[name] != null) {
			if (this.resolving.includes(name)) {
				const chain = [...this.resolving, name].map(
					(variable) =>
						TEMPLATE_VARIABLE_NAMES.find(
							(candidate) => candidate.toLowerCase() === variable,
						) ?? variable,
				);
				throw new Error(
					`Circular template reference: ${chain.join(" -> ")}.`,
				);
			}
			this.resolving.push(name);
			try {
				value = stringVariable(
					this.normalizeValue(this.render(this.templates[name])),
				);
				this.values[name] = value;
			} finally {
				this.resolving.pop();
			}
		}
		if (value == null)
			throw new Error(`Unresolved template variable: {{${key}}}.`);
		return value.type === "string"
			? value.value
			: value.value.format(format?.trim() || "YYYY-MM-DD HH:mm:ss");
	}
}

export function formatTemplate(
	template: string,
	variables: TemplateVariables,
): string {
	return new TemplateResolver(variables).render(template);
}

export function validateTemplate(template: string): string[] {
	const errors: string[] = [];
	for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
		try {
			validateReference(match[1], match[2]);
		} catch (error) {
			errors.push(String(error instanceof Error ? error.message : error));
		}
	}
	return errors;
}

function validateReference(key: string, format?: string): void {
	const name = key.toLowerCase();
	if (!VARIABLE_NAMES.has(name))
		throw new Error(`Unknown template variable: {{${key}}}.`);
	if (format != null && !DATE_VARIABLES.has(name))
		throw new Error(`Only date variables accept a format: {{${key}}}.`);
}

export function templateKey(key: string, format?: string): string {
	return key.toLowerCase() + (format == null ? "" : `:${format.trim()}`);
}

export function stringVariable(value: string): TemplateVariable {
	return { type: "string", value };
}
