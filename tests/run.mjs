import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "webdav-tests-"));
try {
	const outfile = join(directory, "tests.cjs");
	await build({
		entryPoints: ["tests/pathMapping.test.mjs"], outfile, bundle: true, platform: "node", format: "cjs",
		plugins: [{
			name: "obsidian-test-api",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: resolve("tests/obsidian-mock.mjs") }));
				build.onResolve({ filter: /^moment$/ }, () => ({
					path: require.resolve("moment", { paths: [dirname(require.resolve("obsidian/package.json"))] }),
				}));
			},
		}],
	});
	const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
	process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
