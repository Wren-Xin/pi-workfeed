#!/usr/bin/env node
/**
 * Replay-layer tests. No pi, no network, no clock: a fixture log plus expected bytes.
 *
 *   node --experimental-strip-types test/replay.test.mjs
 *
 * The fixture encodes four things that used to be wrong in the product:
 *   - one log written by two processes (a resume), which must not repeat `task 1`
 *   - a settle whose token total is a literal 0 (self-hosted endpoints)
 *   - a tool call with no `end` line (crash / kill), which the digest must admit
 *   - a finished call with no item attribution, which the coverage line must count
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildDigest, resumeState } from "../extensions/journal/replay.ts";

const here = dirname(fileURLToPath(import.meta.url));
const logPath = join(here, "fixtures", "resume-and-gaps.jsonl");
const goldenPath = join(here, "golden", "resume-and-gaps.digest.md");

let failures = 0;
const check = (name, actual, expected) => {
	const ok = actual === expected;
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
/** contains, for prose assertions */
const has = (name, haystack, needle) => {
	const ok = haystack.includes(needle);
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${ok ? "found" : "missing"} ${JSON.stringify(needle)}`);
};

// 1. A fresh process must resume the counter, not restart it.
const resume = resumeState(logPath);
check("resume nextTask", resume.nextTask, 3);
check("resume settled tasks", resume.tasks, 2);

// 2. Byte-determinism: the same file twice produces the same digest.
const md = rebuildDigest(logPath, { cwd: "", sid: "golden" });
const md2 = rebuildDigest(logPath, { cwd: "", sid: "golden" });
check("deterministic bytes", md === md2, true);

// 3. The two tasks must stay distinguishable in the digest.
const section = (title) => {
	const start = md.indexOf(`## ${title}`);
	if (start < 0) return "";
	const end = md.indexOf("\n## ", start + 1);
	return end < 0 ? md.slice(start) : md.slice(start, end);
};
const taskRows = section("tasks").split("\n").filter((l) => /^\| \d+ \|/.test(l));
check("two task rows", taskRows.length, 2);
has("task #1 present", md, "| 1 |");
has("task #2 present", md, "| 2 |");
check("no duplicate #1 row", taskRows.filter((l) => l.startsWith("| 1 |")).length, 1);

// 4. A reported total of 0 must not hide the parts we know (100 in + 20 out).
has("task 1 tokens fall back to the sum", md, "120");
check("no zero-total claim for task 1", /120 total/.test(md), true);

// 5. Data quality: the digest states what it could not see.
has("unfinished call admitted", md, "1 started without an end line");
has("attribution coverage stated", md, "item attribution: 2/3 calls carry an item (67%)");

// 6. Golden bytes: intentional changes to the digest format must update this file.
const golden = readFileSync(goldenPath, "utf8");
check("golden digest bytes", md, golden);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
