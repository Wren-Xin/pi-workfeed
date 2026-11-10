#!/usr/bin/env node
/**
 * Digest evidence tests — two cases where the summary used to lose facts it had
 * already recorded (protocol I8: absence is not zero).
 *
 *   - `clear` writes an empty todo snapshot. Taking only the last snapshot erased
 *     the timing of items that tool calls still point at, so the item table said
 *     "none" while the slowest-calls list still cited `item 1`.
 *   - a task killed between `prompt` and `settle` disappeared entirely: one task
 *     row, nothing in data quality, while its tool calls stayed in the rollup.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, parseLog } from "../extensions/journal/replay.ts";
import { buildDigest } from "../extensions/journal/digest.ts";

const here = dirname(fileURLToPath(import.meta.url));
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

const TS = 1770000000000;
const ev = (t, extra = {}) => JSON.stringify({ v: 1, ts: TS, sid: "evidence", task: 1, t, ...extra });

// ---- 1. a cleared list must not erase item timing that calls still reference ----
const clearLog = [
	ev("session", { model: "m", provider: "p", cwd: "<…>/demo" }),
	ev("prompt", { chars: 10, task: 1 }),
	ev("todo", { rev: 1, items: [{ id: 1, status: "in_progress", elapsedMs: 5000, text: "wire the parser" }] }),
	ev("tool", { phase: "start", id: "a", name: "bash", item: 1 }),
	ev("tool", { phase: "end", id: "a", name: "bash", durMs: 4000, wallMs: 4000, isError: false, item: 1 }),
	ev("todo", { rev: 2, items: [] }),
	ev("tool", { phase: "end", id: "b", name: "read", durMs: 2000, isError: false, task: 1 }),
	ev("settle", { taskMs: 9000, aborted: false, turns: 1, tools: 2, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } }),
].join("\n");

const clearMd = buildDigest(aggregate(parseLog(clearLog), { sid: "evidence", cwd: "<…>/demo" }));

has("cleared list: item still in the table", clearMd, "| 1 | in_progress · dropped | 5s |");
has("cleared list: timing is labelled, not zeroed", clearMd, "dropped from the list (timing kept)");
check("cleared list: section is not 'none'", /## todo items \(0\)/.test(clearMd), false);
has("cleared list: slowest call still resolves to the item", clearMd, "4s · bash · task 1 · item 1");

// ---- 2. a task with a prompt and no settle must be reported, not dropped ----
const openLog = [
	ev("session", { model: "m", provider: "p", cwd: "<…>/demo" }),
	ev("prompt", { chars: 10, task: 1 }),
	ev("tool", { phase: "end", id: "c", name: "bash", durMs: 1000, isError: false, task: 1 }),
	ev("settle", { taskMs: 9000, aborted: false, turns: 1, tools: 1, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } }),
	ev("prompt", { chars: 12, task: 2 }),
	ev("tool", { phase: "end", id: "d", name: "bash", durMs: 3000, isError: false, task: 2 }),
].join("\n");

const openMd = buildDigest(aggregate(parseLog(openLog), { sid: "evidence", cwd: "<…>/demo" }));

has("open task: one settled row only", openMd, "## tasks (1, wall clock 9s)");
has("open task: coverage line names the gap", openMd, "task coverage: 1/2 prompts have a settle");
has("open task: gap explained as unknown, not zero", openMd, "unknown, not zero");
has("open task: its tool call is still counted", openMd, "| bash | 2 |");
check("open task: no fabricated row for task 2", /^\| 2 \|/m.test(openMd), false);

// ---- 3. a failed compaction must be reported, and "none" must not be invented ----
// A real pi session that compacts nothing still logs whole tasks; the compaction result
// only survives in these two event types, so a digest that ignores them reads as if the
// context had been reduced. Field names come from pi's own event interfaces
// (errorMessage / aborted / willRetry), not from a payload shape we made up.
const compactLog = [
	ev("session", { model: "m", provider: "p", cwd: "<…>/demo" }),
	ev("prompt", { chars: 10, task: 1 }),
	ev("compact_failed", { reason: "manual", error: "Compaction failed: Nothing to compact (session too small)", aborted: true, willRetry: false }),
	ev("compact", { reason: "manual", before: 68000, willRetry: true }),
	ev("settle", { taskMs: 4000, aborted: false, turns: 1, tools: 0, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } }),
].join("\n");

const compactMd = buildDigest(aggregate(parseLog(compactLog), { sid: "evidence", cwd: "<…>/demo" }));

// A first session that says "/compact too early" gets an empty answer from pi, not a
// breakage — a real Linux run surfaced this as the first thing a new user reads, so the
// digest must call it skipped and keep the reason.
has("compaction: a premature /compact is skipped, not failed", compactMd, "- compaction: 1 completed, 0 failed, 1 skipped — skipped: Compaction failed: Nothing to compact (session too small)");
check("compaction: no 'failed' word for an empty answer", /0 failed, 1 skipped/.test(compactMd), true);

const plainMd = buildDigest(
	aggregate(
		parseLog([ev("session", { model: "m", provider: "p", cwd: "<…>/demo" }), ev("prompt", { chars: 10, task: 1 })].join("\n")),
		{ sid: "evidence", cwd: "<…>/demo" },
	),
);
check("compaction: no line when none happened", /^- compaction:/m.test(plainMd), false);

// ---- 4. sub-second durations must not collapse into a column of "0s" ----
// The old formatter floored to whole seconds, so every fast tool call read "0s" and the
// one question the digest exists to answer — which call was slowest — came out blank.
const fastLog = [
	ev("session", { model: "m", provider: "p", cwd: "<…>/demo" }),
	ev("prompt", { chars: 10, task: 1 }),
	ev("tool", { phase: "end", id: "e", name: "bash", durMs: 850, isError: false, task: 1 }),
	ev("tool", { phase: "end", id: "f", name: "read", durMs: 420, isError: false, task: 1 }),
	ev("tool", { phase: "end", id: "g", name: "edit", durMs: 1400, isError: false, task: 1 }),
	ev("settle", { taskMs: 4200, aborted: false, turns: 1, tools: 3, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } }),
].join("\n");

const fastMd = buildDigest(aggregate(parseLog(fastLog), { sid: "evidence", cwd: "<…>/demo" }));

has("fast calls: milliseconds below one second", fastMd, "| bash | 1 | 850ms |");
has("fast calls: one decimal below ten seconds", fastMd, "| edit | 1 | 1.4s |");
has("fast calls: slowest list keeps the order", fastMd, "- 1.4s · edit · task 1");
check("fast calls: no flattened 0s row", /^\| (bash|read) \| 1 \| 0s \|/m.test(fastMd), false);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
