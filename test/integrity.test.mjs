#!/usr/bin/env node
/**
 * Log integrity tests — the difference between "recovered" and "recovered but
 * silently missing facts".
 *
 *   node --experimental-strip-types test/integrity.test.mjs
 *
 * A skip is allowed only when it can be explained. Four cases, each with the
 * explanation the digest must print:
 *   - torn tail (killed append)      -> expected, used everything before it
 *   - corrupt line in the middle     -> damage, line number reported
 *   - envelope violation (v≠1, ...)  -> damage, line rejected with a reason
 *   - unknown event type             -> tolerated, listed as forward compatible
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeIntegrity, hasDamage, parseLogDetailed, rebuildDigest } from "../extensions/journal/replay.ts";

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

const base = (t, extra = {}) => JSON.stringify({ v: 1, ts: 1770000000000, sid: "integrity", task: 1, t, ...extra });
const dir = mkdtempSync(join(tmpdir(), "workfeed-integrity-"));

try {
	// ---- 1. torn tail: the expected artifact of a killed process ----
	const torn = [base("session"), base("prompt", { chars: 5 }), '{"v":1,"ts":1770000000,"sid":"integri'].join("\n");
	const tornParsed = parseLogDetailed(torn);
	check("torn tail: events kept", tornParsed.events.length, 2);
	check("torn tail: reported at the last line", tornParsed.integrity.tornTail, 3);
	check("torn tail: not counted as corruption", tornParsed.integrity.corrupt, []);
	check("torn tail: not damage", hasDamage(tornParsed.integrity), false);
	const tornPath = join(dir, "torn.jsonl");
	writeFileSync(tornPath, torn, "utf8");
	const tornMd = rebuildDigest(tornPath, { sid: "integrity", cwd: "" });
	has("torn tail: digest says so", tornMd, `torn tail: line 3 was an interrupted append`);

	// ---- 2. corruption in the middle: must be reported, not skipped quietly ----
	const mid = [base("session"), "this is not json", base("prompt", { chars: 5 }), base("settle", { taskMs: 10, aborted: false, turns: 1, tools: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } })].join("\n");
	const midParsed = parseLogDetailed(mid);
	check("corrupt middle: events kept", midParsed.events.length, 3);
	check("corrupt middle: line reported", midParsed.integrity.corrupt, [2]);
	check("corrupt middle: is damage", hasDamage(midParsed.integrity), true);
	const midPath = join(dir, "mid.jsonl");
	writeFileSync(midPath, mid, "utf8");
	const midMd = rebuildDigest(midPath, { sid: "integrity", cwd: "" });
	has("corrupt middle: digest names the line", midMd, "corrupt lines: 2");
	has("corrupt middle: digest counts dropped", midMd, "4 lines, 1 dropped (1 unparsable, 0 violating the envelope)");

	// ---- 3. envelope violations: the producer broke the protocol ----
	const bad = [base("session", { v: 2 }), JSON.stringify({ ts: 1, sid: "x", task: 1, t: "prompt", chars: 1 }), base("prompt", { chars: 5 })].join("\n");
	const badParsed = parseLogDetailed(bad);
	check("bad envelope: only the valid line survives", badParsed.events.length, 1);
	check("bad envelope: two rejections", badParsed.integrity.badEnvelope.length, 2);
	has("bad envelope: reason names the version", badParsed.integrity.badEnvelope[0].reason, "v=2");
	has("bad envelope: reason names the missing key", badParsed.integrity.badEnvelope[1].reason, "v=");
	const badPath = join(dir, "bad.jsonl");
	writeFileSync(badPath, bad, "utf8");
	const badMd = rebuildDigest(badPath, { sid: "integrity", cwd: "" });
	has("bad envelope: digest lists a rejection", badMd, "rejected line");

	// ---- 4. unknown type: forward compatible, but labelled ----
	const unk = [base("session"), base("telemetry_v2"), base("settle", { taskMs: 5, aborted: false, turns: 0, tools: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })].join("\n");
	const unkParsed = parseLogDetailed(unk);
	check("unknown type: kept as an event", unkParsed.events.length, 3);
	check("unknown type: recorded", unkParsed.integrity.unknown, [{ line: 2, t: "telemetry_v2" }]);
	check("unknown type: not damage by itself", hasDamage(unkParsed.integrity), false);
	const unkPath = join(dir, "unk.jsonl");
	writeFileSync(unkPath, unk, "utf8");
	const unkMd = rebuildDigest(unkPath, { sid: "integrity", cwd: "" });
	has("unknown type: digest names it", unkMd, "unknown event types: telemetry_v2");

	// ---- 5. the verdict is a function, not an exit code (there is no CLI) ----
	has("callers can assert damage without parsing prose", String(hasDamage(midParsed.integrity)), "true");
	check("a torn tail alone is not damage", hasDamage(tornParsed.integrity), false);

	// ---- 6. the summary line is honest ----
	check("summary: names every class", describeIntegrity(midParsed.integrity), "4 lines · 1 corrupt in the middle (lines 2)");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
