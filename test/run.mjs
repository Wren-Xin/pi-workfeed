#!/usr/bin/env node
/**
 * Test entry: every suite runs in its own process, because the extensions read
 * `PI_WORKFEED_*` once at import time — one process cannot host two policies.
 *
 *   node --experimental-strip-types test/run.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
	{ file: "replay.test.mjs" },
	{ file: "schema.test.mjs" },
	{ file: "integrity.test.mjs" },
	{ file: "version.test.mjs" },
	{ file: "resume.test.mjs" },
	{ file: "item-ids.test.mjs" },
	{ file: "args-redact.test.mjs" },
	{ file: "args-redact.test.mjs", env: { PI_WORKFEED_ARGS: "full" } },
];

let failed = 0;
for (const suite of suites) {
	const child = spawn(process.execPath, ["--experimental-strip-types", join(here, suite.file)], {
		stdio: "inherit",
		env: { ...process.env, PI_WORKFEED_ARGS: "", ...(suite.env ?? {}) },
	});
	const code = await new Promise((res) => child.on("exit", (c) => res(c ?? 1)));
	if (code !== 0) failed += 1;
}

console.log(failed === 0 ? "ALL SUITES PASS" : `SUITES FAILED: ${failed}/${suites.length}`);
process.exit(failed === 0 ? 0 : 1);
