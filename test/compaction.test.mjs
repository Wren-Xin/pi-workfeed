#!/usr/bin/env node
/**
 * Compaction records must use pi's real event fields.
 *
 * The first version of these handlers read `messagesBefore`/`messagesAfter` and `error`,
 * names taken from a stub this test suite itself had written. A real pi 1.5 session then
 * logged `compact` with no counts and `compact_failed` with no reason at all — the field
 * is `errorMessage`, and the counts live on `compactionEntry.tokensBefore`. The shapes
 * below are the ones declared in pi's `core/extensions/types.d.ts`
 * (`SessionCompactEvent`, `SessionCompactFailedEvent`).
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

register("./stubs/pi-loader.mjs", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "extensions");
const dir = mkdtempSync(join(tmpdir(), "workfeed-compact-"));
process.env.PI_WORKFEED_DIR = dir;
process.env.PI_WORKFEED_CONTENT = "1";

let failures = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const has = (name, haystack, needle) => {
	const ok = haystack.includes(needle);
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${ok ? "found" : "missing"} ${JSON.stringify(needle)}`);
};

const bus = new Map();
const pi = {
	handlers: new Map(),
	tools: [],
	commands: [],
	entries: [],
	on(n, f) { this.handlers.set(n, f); },
	registerTool(d) { this.tools.push(d); },
	registerCommand(n) { this.commands.push(n); },
	appendEntry(t, d) { this.entries.push({ t, d }); },
	events: { on(n, f) { bus.set(n, f); }, emit(n, d) { bus.get(n)?.(d); } },
};
const ctx = {
	hasUI: false,
	cwd: "D:\\demo",
	model: { id: "deepseek-flash", provider: "deepseek" },
	sessionManager: {
		getSessionId: () => "sid-compact",
		getBranch: () => [],
		getEntries: () => [],
		getSessionFile: () => "D:\\demo\\sessions\\sid-compact.jsonl",
	},
	ui: { setStatus() {}, notify() {} },
};

const journal = await import(pathToFileURL(join(ext, "journal", "index.ts")).href);
journal.default(pi);
await pi.handlers.get("session_start")({ reason: "startup" }, ctx);

// ---- pi 1.5 success shape: counts live on compactionEntry, not on the event ----
await pi.handlers.get("session_compact")({
	type: "session_compact",
	reason: "manual",
	compactionEntry: { summary: "…", firstKeptEntryId: "e1", tokensBefore: 68000 },
	fromExtension: false,
	willRetry: false,
});

// ---- pi 1.5 failure shape: error is `errorMessage`, and `aborted` is separate ----
await pi.handlers.get("session_compact_failed")({
	type: "session_compact_failed",
	reason: "manual",
	errorMessage: "Compaction failed: Nothing to compact (session too small)",
	aborted: true,
	willRetry: false,
	fromExtension: false,
});

await pi.handlers.get("session_shutdown")({ reason: "quit" }, ctx);

const files = readdirSync(dir, { recursive: true }).map(String);
const logFile = files.find((f) => f.endsWith(".jsonl"));
const digestFile = files.find((f) => f.endsWith(".digest.md"));
const logLines = readFileSync(join(dir, logFile), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const compactLine = logLines.find((l) => l.t === "compact");
const failedLine = logLines.find((l) => l.t === "compact_failed");
const digest = readFileSync(join(dir, digestFile), "utf8");

check("compact: token count kept", compactLine.before, 68000);
check("compact: no invented 'after' field", "after" in compactLine, false);
check("compact: reason kept", compactLine.reason, "manual");
check("compact_failed: real error text kept", failedLine.error, "Compaction failed: Nothing to compact (session too small)");
check("compact_failed: abort flag kept", failedLine.aborted, true);
has("digest: compaction reported in data quality", digest, "- compaction: 1 completed, 1 failed (1 of them aborted, not broken)");
has("digest: failure text survives into the digest", digest, "Nothing to compact (session too small)");

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
