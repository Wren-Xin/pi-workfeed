#!/usr/bin/env node
/**
 * Offline digest builder — the replay layer with a command-line surface.
 *
 * This is an analyzer, not a report for humans: it rebuilds the exact digest the
 * agent reads, from a log the current process never saw. No pi API, no network.
 *
 *   node bin/workfeed-digest.mjs <log.jsonl> [--out <file.md>] [--quiet] [--strict]
 *
 * Exit codes: 0 clean · 1 nothing parsed (not a workfeed log) · 2 damaged log
 * (corrupt lines or envelope violations in the middle; a torn tail alone is
 * expected and does not count).
 */
import { writeFileSync } from "node:fs";
import { describeIntegrity, hasDamage, replayLog } from "../extensions/journal/replay.ts";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
	console.error("usage: workfeed-digest <workfeed-<sid>.jsonl> [--out <file.md>] [--quiet] [--strict]");
	process.exit(args.length === 0 ? 2 : 0);
}

const logPath = args[0];
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const quiet = args.includes("--quiet");
const strict = args.includes("--strict");

const { text: md, integrity } = replayLog(logPath, { sid: "", cwd: "" });
if (outPath) {
	writeFileSync(outPath, md, "utf8");
	if (!quiet) console.error(`wrote ${outPath} (${Buffer.byteLength(md)} bytes)`);
} else {
	process.stdout.write(md);
}

if (!quiet) console.error(`log: ${describeIntegrity(integrity)}`);

// A digest that cannot cover the whole file is worse than none: say so loudly.
if (integrity.lines === 0) {
	console.error("warning: no events parsed — is this a workfeed JSONL?");
	process.exit(1);
}
if (hasDamage(integrity) || (strict && integrity.unknown.length > 0)) {
	console.error("warning: the log is damaged; the digest above covers only the readable lines");
	process.exit(2);
}
