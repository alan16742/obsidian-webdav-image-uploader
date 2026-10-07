import test from "node:test";
import assert from "node:assert/strict";
import { TFile, TFolder, setRequestHandler, renderedSettings } from "./obsidian-mock.mjs";
import {
	buildUploadTarget, normalizeUploadRule, resolvePreviewUrl, getLocalLinkTarget,
	logicalToRemote, findUploadRule, validateUploadRule, formatUploadLink,
	createRuleTemplateResolver, formatTemplate, TEMPLATE_VARIABLE_NAMES,
} from "../src/lib/attachment/uploadRules.ts";
import { normalizeAttachmentPath } from "../src/lib/attachment/attachmentPaths.ts";
import { AttachmentPathResolver } from "../src/lib/attachment/pathResolver.ts";
import { sanitizeSettings } from "../src/settings.ts";
import { WebDavClient } from "../src/lib/webdavClient/index.ts";
import { WebDavBlobStore } from "../src/lib/webdavClient/webdavBlobStore.ts";
import { WebDavMediaLoader } from "../src/view/mediaLoader/index.ts";
import { createLink } from "../src/lib/link/index.ts";
import { matchLinks } from "../src/lib/note/noteLinks.ts";
import { TransferSession } from "../src/lib/transfer/transferSession.ts";
import { BatchDownloader, BatchUploader } from "../src/lib/batch/index.ts";
import { UploadRuleSettingRenderer } from "../src/view/settings/uploadRuleSettings.ts";

globalThis.window = globalThis;
const connectionUrl = "https://dav.example.com/dav";
const exampleRule = () => normalizeUploadRule({
	extensions: ["png", "pdf"], logicalPath: "Attachments/{{now:YYYY}}/{{nameext}}",
	remotePath: "Pictures/{{now:YYYY}}/{{nameext}}", previewUrl: "https://cdn.example.com/{{remotePath}}",
});
const vars = (name = "example.png", year = "2026") => ({
	attachment: { type: "string", value: "Attachments" }, nameext: { type: "string", value: name },
	name: { type: "string", value: name.split(".")[0] }, ext: { type: "string", value: name.split(".").pop() },
	now: { type: "date", value: { format: () => year } },
});

function fixture(options = {}) {
	const settings = sanitizeSettings({ url: connectionUrl, username: "alice", password: "secret", useLogicalLinks: true,
		uploadRules: [exampleRule()], ...options });
	const files = new Map();
	const created = [];
	const requests = [];
	const remote = new Map();
	const add = (path, data = "") => { const file = new TFile(path, data); files.set(path, file); return file; };
	const note = add("Notes/note.md");
	const app = {
		vault: {
			getConfig: name => ({ newLinkFormat: "relative", useMarkdownLinks: true })[name],
			getFileByPath: path => files.get(path) instanceof TFile ? files.get(path) : null,
			getAbstractFileByPath: path => files.get(path) ?? null,
			getFolderByPath: path => files.get(path) instanceof TFolder ? files.get(path) : null,
			getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile && file.extension === "md"),
			createFolder: async path => { created.push(path); const folder = new TFolder(path); files.set(path, folder); return folder; },
			createBinary: async (path, data) => { assert.ok(!files.has(path), "local collision must not overwrite"); created.push(path); return add(path, data); },
			create: async (path, data) => { assert.ok(!files.has(path)); created.push(path); return add(path, data); },
			read: async file => typeof file.data === "string" ? file.data : new TextDecoder().decode(file.data),
			cachedRead: async file => typeof file.data === "string" ? file.data : new TextDecoder().decode(file.data),
			readBinary: async file => typeof file.data === "string" ? new TextEncoder().encode(file.data).buffer : file.data,
			modifyBinary: async (file, data) => { file.data = data; },
			process: async (file, callback) => { return file.data = callback(file.data); },
			rename: async (file, path) => { files.delete(file.path); file.path = path; file.name = path.split("/").pop(); files.set(path, file); },
			delete: async file => { files.delete(file.path); },
		},
		fileManager: {
			getAvailablePathForAttachment: async filename => "Attachments/" + filename,
			trashFile: async file => { files.delete(file.path); },
		},
		metadataCache: {
			getFirstLinkpathDest(path, source) {
				try { return app.vault.getFileByPath(normalizeAttachmentPath(path, source, false).slice(1)); }
				catch { return null; }
			},
			getFileCache: () => ({ links: [], embeds: [] }),
		},
		workspace: { getLeavesOfType: () => [], getActiveFile: () => note },
	};
	const plugin = {
		app, settings,
		isWebdavUrl: url => new AttachmentPathResolver(plugin).findPreview(url) != null || resolvePreviewUrl(url, settings.uploadRules, settings.url) != null,
		async rememberPathMapping(mapping, previous) {
			settings.pathMappings = settings.pathMappings.filter(item => item.logicalPath !== mapping.logicalPath && item.logicalPath !== previous);
			settings.pathMappings.push({ ...mapping });
			plugin.saved = sanitizeSettings(settings);
		},
		async forgetPathMapping(path) { settings.pathMappings = settings.pathMappings.filter(item => item.logicalPath !== path); },
	};
	plugin.client = new WebDavClient(plugin);
	setRequestHandler(async request => {
		requests.push(request);
		assert.ok(request.url.startsWith(connectionUrl + "/"), "DAV requests must only use the connection URL");
		const path = decodeURIComponent(request.url.slice(connectionUrl.length + 1));
		let status = 200;
		let data = remote.get(path) ?? new ArrayBuffer(0);
		if (request.method === "PUT") { status = remote.has(path) ? 412 : 201; if (status === 201) remote.set(path, request.body); }
		if (request.method === "GET" && !remote.has(path)) status = 404;
		if (request.method === "HEAD") status = remote.has(path) ? 200 : 404;
		if (request.method === "DELETE") { status = remote.has(path) ? 204 : 404; remote.delete(path); }
		if (request.method === "PROPFIND") status = 207;
		if (request.method === "MOVE") {
			const destination = decodeURIComponent(request.headers.Destination.slice(connectionUrl.length + 1));
			status = !remote.has(path) ? 404 : remote.has(destination) ? 412 : 201;
			if (status === 201) { remote.set(destination, remote.get(path)); remote.delete(path); }
		}
		return { status, arrayBuffer: data, headers: { "content-type": "image/png" }, text: "" };
	});
	return { plugin, app, settings, files, note, add, created, requests, remote };
}

test("logical, remote and preview paths are independently rendered", () => {
	const target = buildUploadTarget(exampleRule(), connectionUrl, vars());
	assert.equal(target.logicalPath, "Attachments/2026/example.png");
	assert.equal(target.remotePath, "Pictures/2026/example.png");
	assert.equal(target.previewUrl, "https://cdn.example.com/Pictures/2026/example.png");
	assert.equal(getLocalLinkTarget(target.logicalPath, "Notes/note.md", "relative"), "../Attachments/2026/example.png");
	assert.equal(formatUploadLink({ linkTarget: target.logicalPath }, "example.png", false), "[[Attachments/2026/example.png]]");
});

test("empty path fields use the configured defaults", () => {
	const rule = normalizeUploadRule({ extensions: [".PNG", "png"], remotePath: " ", previewUrl: "" });
	assert.equal(rule.logicalPath, "{{attachment}}/{{nameext}}");
	assert.equal(rule.remotePath, "{{logicalPath}}");
	assert.equal(rule.previewUrl, "{{url}}/{{remotePath}}");
	assert.deepEqual(rule.extensions, ["png"]);
});

test("obsolete rule fields and switch values are ignored", () => {
	const defaults = normalizeUploadRule({});
	const rule = normalizeUploadRule({ linkFormat: "{{url}}/old/{{nameext}}", urlPrefix: "https://old.example.com/" });
	assert.deepEqual(rule, defaults);
	assert.equal("linkFormat" in rule, false);
	assert.equal("urlPrefix" in rule, false);
	assert.equal(sanitizeSettings(undefined).useLogicalLinks, false);
	assert.equal(sanitizeSettings({ enableLocalLinkUpload: true }).useLogicalLinks, false);
	assert.equal(sanitizeSettings({ enableLocalLinkUpload: false }).useLogicalLinks, false);
	const settings = sanitizeSettings({ enableLocalLinkUpload: false, useLogicalLinks: true });
	assert.equal(settings.useLogicalLinks, true);
	assert.equal("enableLocalLinkUpload" in settings, false);
});

test("every template field accepts the complete shared variable set", () => {
	for (const field of ["logicalPath", "remotePath", "previewUrl"]) {
		for (const variable of TEMPLATE_VARIABLE_NAMES) {
			assert.deepEqual(validateUploadRule({ ...exampleRule(), [field]: `{{${variable}}}` }, connectionUrl), [], `${field}: ${variable}`);
		}
	}
	for (const field of ["logicalPath", "remotePath", "previewUrl"]) {
		const rule = { ...exampleRule(), [field]: "{{url}}/{{nameext}}" };
		const resolver = createRuleTemplateResolver(rule, connectionUrl, vars());
		assert.equal(resolver.render(rule[field]), connectionUrl + "/example.png");
	}
});

test("template dependency resolution supports forward references and encodes URLs once", () => {
	const rule = normalizeUploadRule({ ...exampleRule(), logicalPath: "Attachments/{{remotePath}}", previewUrl: "{{url}}/{{remotePath}}?logical={{logicalPath}}" });
	const target = buildUploadTarget(rule, connectionUrl, vars("a b.png"));
	assert.equal(target.logicalPath, "Attachments/Pictures/2026/a b.png");
	assert.equal(target.remotePath, "Pictures/2026/a b.png");
	assert.equal(target.previewUrl, connectionUrl + "/Pictures/2026/a%20b.png?logical=Attachments%2FPictures%2F2026%2Fa%20b.png");
	assert.equal(resolvePreviewUrl(target.previewUrl, [rule], connectionUrl)?.logicalPath, target.logicalPath);
});

test("self references and circular dependencies fail without rewriting the rule", () => {
	for (const rule of [
		{ ...exampleRule(), logicalPath: "{{logicalPath}}" },
		{ ...exampleRule(), remotePath: "{{remotePath}}" },
		{ ...exampleRule(), logicalPath: "{{remotePath}}", remotePath: "{{logicalPath}}" },
	]) {
		const before = { ...rule };
		assert.throws(() => buildUploadTarget(rule, connectionUrl, vars()), /Circular template reference/);
		assert.deepEqual(rule, before);
	}
});

test("a known source path anchors references without recalculating its directory", () => {
	const rule = normalizeUploadRule({ ...exampleRule(), logicalPath: "{{remotePath}}", remotePath: "{{logicalPath}}" });
	const target = buildUploadTarget(rule, connectionUrl, vars(), "Existing/actual.png");
	assert.equal(target.logicalPath, "Existing/actual.png");
	assert.equal(target.remotePath, "Existing/actual.png");
	assert.equal(target.previewUrl, "https://cdn.example.com/Existing/actual.png");
});

test("known paths are normalized before being referenced by other templates", () => {
	const rule = normalizeUploadRule({ ...exampleRule(), logicalPath: "Attachments/{{remotePath}}" });
	const variables = { ...vars(), remotepath: { type: "string", value: "/Pictures/./2026/example.png" } };
	const target = buildUploadTarget(rule, connectionUrl, variables);
	assert.equal(target.logicalPath, "Attachments/Pictures/2026/example.png");
	assert.equal(target.remotePath, "Pictures/2026/example.png");
	assert.equal(target.previewUrl, "https://cdn.example.com/Pictures/2026/example.png");
});

test("unknown or unavailable variables fail through the shared parser", () => {
	for (const field of ["logicalPath", "remotePath", "previewUrl"]) {
		assert.throws(() => buildUploadTarget({ ...exampleRule(), [field]: "{{unknown}}" }, connectionUrl, vars()), /Unknown template variable/);
		assert.throws(() => buildUploadTarget({ ...exampleRule(), [field]: "{{notename}}" }, connectionUrl, vars()), /Unresolved template variable/);
	}
	assert.throws(() => formatTemplate("{{unknown}}", vars()), /Unknown template variable/);
	assert.equal(formatTemplate("{{now:YYYY}}", vars()), "2026");
});

test("URL mode inserts preview URLs on upload even when Obsidian prefers Wikilinks", async () => {
	const f = fixture({ useLogicalLinks: false });
	f.app.vault.getConfig = name => ({ newLinkFormat: "relative", useMarkdownLinks: false })[name];
	const file = new File(["image"], "space image.png");
	const result = await createLink(f.plugin, file, f.note.path).upload(f.note);
	assert.equal(result.markdownLink, `![space image.png](${result.previewUrl})`);
	assert.equal(matchLinks(result.markdownLink)[0].syntax, "markdown");
	assert.ok(result.previewUrl.includes("space%20image.png"));
	assert.ok(f.remote.has(result.remotePath));
	assert.deepEqual(f.created, []);
});

test("logical mode inserts Wikilinks when requested by Obsidian", async () => {
	const f = fixture();
	f.app.vault.getConfig = name => ({ newLinkFormat: "relative", useMarkdownLinks: false })[name];
	const result = await createLink(f.plugin, new File(["image"], "photo.png"), f.note.path).upload(f.note);
	assert.equal(result.markdownLink, `![[${result.logicalPath}]]`);
});

test("external Markdown links preserve URL syntax, escapes and query parameters", () => {
	const url = "https://cdn.example.com/a%20b(x).png?path=Pictures%2Fa.png&token=abc";
	const link = formatUploadLink({ linkType: "external", linkTarget: url }, "a[b].png", false);
	assert.equal(link, "[a\\[b\\].png](https://cdn.example.com/a%20b%28x%29.png?path=Pictures%2Fa.png&token=abc)");
	assert.equal(matchLinks(link)[0].path, url.replace("(x)", "%28x%29"));
});

test("rule summaries display the note target selected by the link mode", async () => {
	const f = fixture();
	const renderer = new UploadRuleSettingRenderer(f.app, f.plugin, () => {});
	const logical = await renderer.getUploadRuleSummary(f.settings.uploadRules[0]);
	assert.ok(logical.includes("../Attachments/") && !logical.includes("https:"));
	f.settings.useLogicalLinks = false;
	const external = await renderer.getUploadRuleSummary(f.settings.uploadRules[0]);
	assert.ok(external.includes("https://cdn.example.com/Pictures/"));
});

test("all three input dropdowns expose and insert the same variables", () => {
	const f = fixture();
	const rule = normalizeUploadRule({ ...exampleRule(), extensions: [] });
	const originalDocument = globalThis.document;
	globalThis.document = { createElement: () => ({ appendChild() {}, addEventListener() {}, empty() {} }) };
	renderedSettings.length = 0;
	let saves = 0;
	try {
		const renderer = new UploadRuleSettingRenderer(f.app, f.plugin, () => saves++);
		renderer.createUploadRuleCard(rule);
		for (const field of ["logicalPath", "remotePath", "previewUrl"]) {
			const row = renderedSettings.find(setting => setting.name === field);
			assert.deepEqual(row.dropdown.options, ["", ...TEMPLATE_VARIABLE_NAMES]);
			row.dropdown.change("url");
			assert.ok(rule[field].endsWith("{{url}}"));
		}
		assert.equal(saves, 3);
	} finally { globalThis.document = originalDocument; }
});

test("historical dates are captured from logical paths", () => {
	const target = logicalToRemote(exampleRule(), "Attachments/2021/old.png", connectionUrl, vars("old.png", "2030"));
	assert.equal(target.remotePath, "Pictures/2021/old.png");
});

test("date formats containing path separators preserve historical directory values", () => {
	const rule = normalizeUploadRule({ ...exampleRule(), logicalPath: "Attachments/{{now:YYYY/MM}}/{{nameext}}", remotePath: "Pictures/{{now:YYYY/MM}}/{{nameext}}" });
	const target = logicalToRemote(rule, "Attachments/2021/05/old.png", connectionUrl, vars("old.png", "2030/10"));
	assert.equal(target.remotePath, "Pictures/2021/05/old.png");
});

test("URL values encode special filenames once and can be resolved back", () => {
	for (const name of ["space image.png", "中文.png", "hash#percent%.png", "a(b).png", "literal%20.png"]) {
		const target = buildUploadTarget(exampleRule(), connectionUrl, vars(name));
		const resolved = resolvePreviewUrl(target.previewUrl, [exampleRule()], connectionUrl, vars(name));
		assert.equal(resolved?.remotePath, target.remotePath, name);
		assert.equal(resolved?.logicalPath, target.logicalPath, name);
	}
});

test("preview templates may use a different URL layout and query parameters", () => {
	const rule = normalizeUploadRule({ ...exampleRule(), previewUrl: "https://cdn.example.com/view?path={{remotePath}}&token=fixed" });
	const target = buildUploadTarget(rule, connectionUrl, vars());
	assert.equal(target.previewUrl, "https://cdn.example.com/view?path=Pictures%2F2026%2Fexample.png&token=fixed");
	assert.equal(resolvePreviewUrl(target.previewUrl, [rule], connectionUrl)?.remotePath, target.remotePath);
});

test("preview templates support repeated path variables, Unicode prefixes and fragments", () => {
	const rule = normalizeUploadRule({ ...exampleRule(), previewUrl: "https://cdn.example.com/图片/{{remotePath}}?path={{remotePath}}#t=15" });
	const target = buildUploadTarget(rule, connectionUrl, vars("中文.png"));
	assert.ok(target.previewUrl.includes("/%E5%9B%BE%E7%89%87/"));
	assert.equal(resolvePreviewUrl(target.previewUrl, [rule], connectionUrl)?.remotePath, target.remotePath);
});

test("invalid path results fail without being converted into preview URLs", () => {
	const rule = { ...exampleRule(), logicalPath: "{{url}}/{{nameext}}" };
	assert.deepEqual(validateUploadRule(rule, connectionUrl), []);
	assert.throws(() => buildUploadTarget(rule, connectionUrl, vars()), /Attachment paths/);
	assert.throws(() => buildUploadTarget({ ...exampleRule(), logicalPath: "../../bad.png" }, connectionUrl, vars()));
	assert.throws(() => buildUploadTarget({ ...exampleRule(), remotePath: "https://bad.example/file.png" }, connectionUrl, vars()));
	assert.throws(() => normalizeAttachmentPath("../../bad.png", "Notes/note.md"));
	assert.equal(resolvePreviewUrl("https://unrelated.example.com/example.png", [exampleRule()], connectionUrl), null);
});

test("first matching rule is retained", () => {
	const rules = [normalizeUploadRule({ ...exampleRule(), prefix: "IMG_" }), exampleRule()];
	assert.equal(findUploadRule(rules, "IMG_photo.png"), rules[0]);
	assert.equal(findUploadRule(rules, "photo.png"), rules[1]);
});

test("existing local upload preserves logical path and creates no remote directory in vault", async () => {
	const f = fixture();
	const source = f.add("Attachments/2021/old.png", "image bytes");
	const link = createLink(f.plugin, matchLinks("![](../Attachments/2021/old.png)")[0], f.note.path);
	await link.init();
	const result = await link.upload(f.note);
	assert.equal(result.logicalPath, source.path);
	assert.equal(result.remotePath, "Pictures/2021/old.png");
	assert.ok(result.markdownLink.includes("../Attachments/2021/old.png"));
	assert.ok(!result.markdownLink.includes("Pictures") && !result.markdownLink.includes("https:"));
	assert.deepEqual(f.created, []);
	assert.equal(f.requests[0].headers["If-None-Match"], "*");
	assert.equal(f.plugin.saved.pathMappings[0].remotePath, result.remotePath);
});

test("local media takes precedence and missing relative/wiki targets use the same mapping", async () => {
	const f = fixture();
	const loader = new WebDavMediaLoader(f.plugin, []);
	try {
		const expected = "Pictures/2021/example.png";
		assert.equal((await loader.resolveMissingAttachment("../Attachments/2021/example.png", f.note.path)).remotePath, expected);
		assert.equal((await loader.resolveMissingAttachment("Attachments/2021/example.png", f.note.path)).remotePath, expected);
		f.add("Attachments/2021/example.png");
		assert.equal(await loader.resolveMissingAttachment("../Attachments/2021/example.png", f.note.path), undefined);
		assert.deepEqual(f.requests, []);
	} finally { loader.destroy(); }
});

test("download, exists, PROPFIND, MOVE and DELETE only use remote paths", async () => {
	const f = fixture();
	const mapping = logicalToRemote(exampleRule(), "Attachments/2021/example.png", connectionUrl, vars());
	f.remote.set(mapping.remotePath, new TextEncoder().encode("bytes").buffer);
	const link = createLink(f.plugin, matchLinks("![](../Attachments/2021/example.png#anchor)")[0], f.note.path);
	await link.init();
	assert.equal(link.downloadable(), true);
	const result = await link.download(f.note);
	assert.equal(result.tFile.path, mapping.logicalPath);
	assert.ok(f.created.every(path => !path.startsWith("Pictures")));
	assert.equal(await link.session.client.exists(mapping.remotePath), true);
	assert.equal((await link.session.client.propfind(mapping.remotePath)).status, 207);
	const renamed = await link.rename(f.note, "Attachments/2021/renamed.png");
	assert.ok(renamed.includes("Attachments/2021/renamed.png"));
	assert.ok(f.files.has("Attachments/2021/renamed.png"));
	assert.ok(f.remote.has("Pictures/2021/renamed.png"));
	await link.delete(f.note);
	assert.ok(!f.remote.has("Pictures/2021/renamed.png"));
	assert.deepEqual(f.requests.map(request => request.method), ["GET", "HEAD", "PROPFIND", "HEAD", "MOVE", "DELETE"]);
});

test("batch download processes missing logical links and skips existing local files", async () => {
	const f = fixture({ createBatchLog: false });
	f.note.data = "![](../Attachments/2021/example.png)\n![](../Attachments/2021/local.png)";
	f.add("Attachments/2021/local.png", "local");
	f.remote.set("Pictures/2021/example.png", new TextEncoder().encode("remote").buffer);
	const batch = new BatchDownloader(f.plugin);
	await batch.downloadNoteFiles(f.note);
	assert.equal(batch.result.filter(item => item.status === "success").length, 1);
	assert.equal(batch.result.filter(item => item.status === "skipped").length, 1);
	assert.ok(f.files.has("Attachments/2021/example.png"));
	assert.ok(!f.note.data.includes("Pictures") && !f.note.data.includes("https:"));
});

test("batch upload reuses remote transfer and cleans only committed local references", async () => {
	const f = fixture({ createBatchLog: false });
	f.note.data = "![](../Attachments/2021/example.png)\n![](../Attachments/2021/example.png)";
	f.add("Attachments/2021/example.png", "source");
	const batch = new BatchUploader(f.plugin);
	await batch.uploadNoteFiles(f.note, true);
	assert.equal(f.requests.filter(request => request.method === "PUT").length, 1);
	assert.equal(batch.result.filter(item => item.status === "success").length, 2);
	assert.equal(f.files.has("Attachments/2021/example.png"), false, JSON.stringify(batch.cleanupResults));
	assert.ok(f.note.data.includes("../Attachments/2021/example.png"));
});

test("URL mode disables uploading existing local links without changing their note text", async () => {
	const f = fixture({ useLogicalLinks: false });
	f.note.data = "![](../Attachments/2021/local.png)";
	f.add("Attachments/2021/local.png", "local image");
	const link = createLink(f.plugin, matchLinks(f.note.data)[0], f.note.path);
	assert.equal(link.uploadable(), false);
	const batch = new BatchUploader(f.plugin);
	await batch.uploadNoteFiles(f.note, true);
	assert.deepEqual(f.requests, []);
	assert.equal(f.note.data, "![](../Attachments/2021/local.png)");
	assert.ok(f.files.has("Attachments/2021/local.png"));
});

test("URL mode renames the DAV path and keeps the new preview URL in the note", async () => {
	const f = fixture({ useLogicalLinks: false });
	const uploaded = await createLink(f.plugin, new File(["image"], "photo.png"), f.note.path).upload(f.note);
	const link = createLink(f.plugin, matchLinks(uploaded.markdownLink)[0], f.note.path);
	await link.init();
	const renamed = await link.rename(f.note, "Pictures/2021/renamed.png");
	assert.equal(matchLinks(renamed)[0].path, "https://cdn.example.com/Pictures/2021/renamed.png");
	assert.ok(f.remote.has("Pictures/2021/renamed.png"));
	assert.equal((await link.getMapping()).logicalPath, "Attachments/2021/renamed.png");
	assert.deepEqual(f.created, []);
});

test("URL mode permits DAV folder moves with an unchanged logical download path", async () => {
	const f = fixture({ useLogicalLinks: false });
	const uploaded = await createLink(f.plugin, new File(["image"], "photo.png"), f.note.path).upload(f.note);
	const link = createLink(f.plugin, matchLinks(uploaded.markdownLink)[0], f.note.path);
	await link.init();
	const renamed = await link.rename(f.note, "Archive/photo.png");
	assert.equal((await link.getMapping()).logicalPath, uploaded.logicalPath);
	assert.equal(matchLinks(renamed)[0].path, "https://cdn.example.com/Archive/photo.png");
	assert.ok(f.remote.has("Archive/photo.png"));
});

test("explicit download returns a local link in URL mode and batch downloads use the same destination", async () => {
	const f = fixture({ useLogicalLinks: false });
	const uploaded = await createLink(f.plugin, new File(["image"], "photo.png"), f.note.path).upload(f.note);
	const direct = createLink(f.plugin, matchLinks(uploaded.markdownLink)[0], f.note.path);
	await direct.init();
	const downloaded = await direct.download(f.note);
	assert.equal(downloaded.tFile.path, uploaded.logicalPath);
	assert.ok(!downloaded.markdownLink.includes("https:"));
	const second = await createLink(f.plugin, new File(["image"], "batch.png"), f.note.path).upload(f.note);
	f.note.data = second.markdownLink;
	const batch = new BatchDownloader(f.plugin);
	await batch.downloadNoteFiles(f.note);
	assert.equal(batch.result[0].status, "success");
	assert.ok(f.files.has(second.logicalPath));
	assert.ok(!f.note.data.includes("https:"));
});

test("existing logical links remain downloadable when switched to URL mode", async () => {
	const f = fixture();
	const uploaded = await createLink(f.plugin, new File(["image"], "photo.png"), f.note.path).upload(f.note);
	f.settings.useLogicalLinks = false;
	const link = createLink(f.plugin, matchLinks(uploaded.markdownLink)[0], f.note.path);
	assert.equal(link.downloadable(), true);
	await link.init();
	const downloaded = await link.download(f.note);
	assert.equal(downloaded.tFile.path, uploaded.logicalPath);
});

test("recorded mappings survive settings reload for non-recoverable time templates", async () => {
	const f = fixture({ uploadRules: [normalizeUploadRule({ ...exampleRule(), logicalPath: "Attachments/{{nameext}}", remotePath: "Pictures/{{now:YYYY-MM-DD}}/{{nameext}}" })] });
	const session = new TransferSession(f.plugin);
	const target = buildUploadTarget(f.settings.uploadRules[0], connectionUrl, vars("old.png", "2021-01-01"));
	await session.upload(new File(["bytes"], "old.png"), target);
	f.plugin.settings = sanitizeSettings(f.plugin.saved);
	const mapped = await new AttachmentPathResolver(f.plugin).resolve("../Attachments/old.png", f.note.path);
	assert.equal(mapped.remotePath, "Pictures/2021-01-01/old.png");
});

test("changing preview settings updates fallback without changing recorded storage paths", async () => {
	const f = fixture();
	const recorded = buildUploadTarget(exampleRule(), connectionUrl, vars());
	await f.plugin.rememberPathMapping(recorded);
	f.settings.uploadRules[0].remotePath = "NewDirectory/{{nameext}}";
	f.settings.uploadRules[0].previewUrl = "https://new-cdn.example.com/view?path={{remotePath}}";
	const result = await new AttachmentPathResolver(f.plugin).resolve("../Attachments/2026/example.png", f.note.path);
	assert.equal(result.remotePath, "Pictures/2026/example.png");
	assert.equal(result.previewUrl, "https://new-cdn.example.com/view?path=Pictures%2F2026%2Fexample.png");
	assert.deepEqual(f.requests, []);
});

test("invalid preview settings fail instead of using the persisted old URL", async () => {
	const f = fixture();
	const recorded = buildUploadTarget(exampleRule(), connectionUrl, vars());
	await f.plugin.rememberPathMapping(recorded);
	for (const previewUrl of ["{{unknown}}", "not-a-url/{{remotePath}}", "{{url}}/{{notavailable}}"] ) {
		f.settings.uploadRules[0].previewUrl = previewUrl;
		await assert.rejects(new AttachmentPathResolver(f.plugin).resolve("../Attachments/2026/example.png", f.note.path));
	}
	assert.deepEqual(f.requests, []);
	assert.equal(f.settings.pathMappings[0].previewUrl, recorded.previewUrl);
});

test("managed URL resolution reports an invalid matching template instead of trying another rule", () => {
	const invalid = { ...exampleRule(), previewUrl: "https://cdn.example.com/{{remotePath}}?token={{unknown}}" };
	const valid = { ...exampleRule(), previewUrl: "https://cdn.example.com/{{remotePath}}?token=value" };
	assert.throws(() => resolvePreviewUrl("https://cdn.example.com/Pictures/2026/example.png?token=value", [invalid, valid], connectionUrl), /Unknown template variable/);
});

test("rename keeps non-recoverable dates from the recorded remote directory", async () => {
	const f = fixture({ uploadRules: [normalizeUploadRule({ ...exampleRule(), logicalPath: "Attachments/{{nameext}}", remotePath: "Pictures/{{now:YYYY-MM-DD}}/{{nameext}}" })] });
	const recorded = buildUploadTarget(f.settings.uploadRules[0], connectionUrl, vars("old.png", "2021-01-01"));
	await f.plugin.rememberPathMapping(recorded);
	f.remote.set(recorded.remotePath, new TextEncoder().encode("bytes").buffer);
	const link = createLink(f.plugin, matchLinks("![](../Attachments/old.png)")[0], f.note.path);
	await link.init();
	await link.rename(f.note, "Attachments/new.png");
	assert.ok(f.remote.has("Pictures/2021-01-01/new.png"));
});

test("mapped attachments remain manageable when generated names no longer match the source rule", async () => {
	const rule = normalizeUploadRule({ ...exampleRule(), prefix: "IMG_", logicalPath: "Attachments/renamed.{{ext}}" });
	const f = fixture({ uploadRules: [rule], createBatchLog: false });
	const result = await createLink(f.plugin, new File(["bytes"], "IMG_photo.png"), f.note.path).upload(f.note);
	f.note.data = result.markdownLink;
	const link = createLink(f.plugin, matchLinks(result.markdownLink)[0], f.note.path);
	assert.equal(link.downloadable(), true);
	const batch = new BatchDownloader(f.plugin);
	await batch.downloadNoteFiles(f.note);
	assert.equal(batch.result[0].status, "success");
	assert.ok(f.files.has("Attachments/renamed.png"));
});

test("filename-only links use saved paths and reject ambiguous names", async () => {
	const f = fixture();
	const first = buildUploadTarget(exampleRule(), connectionUrl, vars("same.png", "2021"));
	await f.plugin.rememberPathMapping(first);
	const resolver = new AttachmentPathResolver(f.plugin);
	assert.equal((await resolver.resolve("same.png", f.note.path)).remotePath, first.remotePath);
	await f.plugin.rememberPathMapping(buildUploadTarget(exampleRule(), connectionUrl, vars("same.png", "2022")));
	await assert.rejects(resolver.resolve("same.png", f.note.path), /Ambiguous/);
	assert.equal((await resolver.resolve("Attachments/2021/same.png", f.note.path)).remotePath, first.remotePath);
});

test("cache keys use DAV destinations regardless of preview URLs and invalidate on changes", async () => {
	const f = fixture();
	const mapping = buildUploadTarget(exampleRule(), connectionUrl, vars());
	f.remote.set(mapping.remotePath, new TextEncoder().encode("bytes").buffer);
	const store = new WebDavBlobStore(f.plugin.client);
	try {
		const first = await store.acquire(mapping, "#one");
		const second = await store.acquire({ ...mapping, previewUrl: "https://different.example.com/x" }, "#two");
		assert.equal(first.src.split("#")[0], second.src.split("#")[0]);
		assert.equal(f.requests.length, 1);
		first.release(); second.release();
		store.invalidate(mapping.remotePath);
		const third = await store.acquire(mapping);
		assert.equal(f.requests.length, 2);
		third.release();
		const key = f.plugin.client.cacheKey(mapping.remotePath);
		f.plugin.client.initClient({ ...f.settings, password: "changed" });
		assert.notEqual(f.plugin.client.cacheKey(mapping.remotePath), key);
	} finally { store.destroy(); }
});

test("remote collisions retain the local file and do not replace mappings", async () => {
	const f = fixture();
	f.add("Attachments/2021/example.png", "local bytes");
	f.remote.set("Pictures/2021/example.png", new TextEncoder().encode("existing").buffer);
	const link = createLink(f.plugin, matchLinks("![](../Attachments/2021/example.png)")[0], f.note.path);
	await assert.rejects(link.upload(f.note), /already exists/);
	assert.ok(f.files.has("Attachments/2021/example.png"));
	assert.deepEqual(f.settings.pathMappings, []);
});

test("dummy PDF pointers use previewUrl but GET and MOVE use remotePath", async () => {
	const f = fixture({ enableDummyPdf: true });
	const target = buildUploadTarget(exampleRule(), connectionUrl, vars("file.pdf"));
	await f.plugin.rememberPathMapping(target);
	const pointer = f.add(target.logicalPath, target.previewUrl);
	f.remote.set(target.remotePath, new TextEncoder().encode("%PDF bytes").buffer);
	const link = createLink(f.plugin, matchLinks("![[" + target.logicalPath + "]]")[0], f.note.path);
	await link.init();
	await link.rename(f.note, "Attachments/2026/new.pdf");
	assert.equal(pointer.path, "Attachments/2026/new.pdf");
	assert.equal(pointer.data, "https://cdn.example.com/Pictures/2026/new.pdf");
	await link.download(f.note);
	assert.equal(new TextDecoder().decode(pointer.data), "%PDF bytes");
});

test("uploading an existing PDF creates its dummy under the logical folder and keeps bytes safe", async () => {
	const f = fixture({ enableDummyPdf: true });
	const original = f.add("Attachments/2021/original.pdf", "%PDF original");
	const link = createLink(f.plugin, matchLinks("![[Attachments/2021/original.pdf]]")[0], f.note.path);
	await link.init();
	const result = await link.upload(f.note);
	assert.equal(original.data, "%PDF original");
	assert.equal(result.logicalPath, "Attachments/2021/original 1.pdf");
	assert.equal(result.remotePath, "Pictures/2021/original.pdf");
	assert.equal(f.settings.pathMappings.length, 1);
	const dummy = createLink(f.plugin, matchLinks(result.markdownLink)[0], f.note.path);
	await dummy.init();
	await dummy.rename(f.note, "Attachments/2021/new.pdf");
	assert.ok(f.remote.has("Pictures/2021/new.pdf"));
	assert.ok(f.created.every(path => !path.startsWith("Pictures")));
});

test("URL mode inserts PDF URLs without creating dummy files", async () => {
	const f = fixture({ useLogicalLinks: false, enableDummyPdf: true });
	const result = await createLink(f.plugin, new File(["%PDF image"], "file.pdf"), f.note.path).upload(f.note);
	assert.equal(matchLinks(result.markdownLink)[0].path, result.previewUrl);
	assert.deepEqual(f.created, []);
	assert.equal(f.settings.pathMappings[0].logicalPath, result.logicalPath);
});
