#!/usr/bin/env node
/**
 * Golden re-record. Run only when the digest format changes on purpose:
 *
 *   node --experimental-strip-types test/golden/record.mjs
 *
 * Writes test/golden/resume-and-gaps.digest.md verbatim — no BOM, LF endings, trailing
 * newline — because the test compares bytes, not prose.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildDigest } from "../../extensions/journal/replay.ts";

const here = dirname(fileURLToPath(import.meta.url));
const logPath = join(here, "..", "fixtures", "resume-and-gaps.jsonl");
const out = join(here, "resume-and-gaps.digest.md");
const md = rebuildDigest(logPath, { cwd: "", sid: "golden" });
writeFileSync(out, md.endsWith("\n") ? md : `${md}\n`, "utf8");
console.log(`wrote ${out}`);
