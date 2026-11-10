#!/usr/bin/env node
/**
 * Offline digest builder — the replay layer with a command-line surface.
 *
 * This is an analyzer, not a report for humans: it rebuilds the exact digest the
 * agent reads, from a log the current process never saw. No pi API, no network.
 *
 *   node bin/workfeed-digest.mjs <log.jsonl> [--out <file.md>] [--quiet]
 *
 * Without --out the digest goes to stdout, so it pipes.
 */
import { writeFileSync } from "node:fs";
import { rebuildDigest } from "../extensions/journal/replay.ts";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
	console.error("usage: workfeed-digest <workfeed-<sid>.jsonl> [--out <file.md>] [--quiet]");
	process.exit(args.length === 0 ? 2 : 0);
}

const logPath = args[0];
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const quiet = args.includes("--quiet");

const md = rebuildDigest(logPath, { sid: "", cwd: "" });
if (outPath) {
	writeFileSync(outPath, md, "utf8");
	if (!quiet) console.error(`wrote ${outPath} (${Buffer.byteLength(md)} bytes)`);
} else {
	process.stdout.write(md);
}

// A digest that cannot cover the whole file is worse than none: say so loudly.
if (md.includes("- events: 0")) {
	console.error("warning: no events parsed — is this a workfeed JSONL?");
	process.exit(1);
}
