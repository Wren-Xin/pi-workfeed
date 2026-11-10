#!/usr/bin/env node
/**
 * Docs ↔ design consistency. The README check (`readme.test.mjs`) covers install claims.
 * This one covers the *other* prose that people treat as contract: `docs/`, the bundled
 * skill, and the field-level wording inside the code and the machine schema.
 *
 * Three classes of drift kept showing up:
 *   - a doc pinned to a package line ("shipped with 0.2.x") that silently expires
 *   - docs describing a packaging surface that was removed (a `bin/` entry to check for)
 *   - `item` described as "the todo id" while the protocol defines it as a source-neutral
 *     work-item id — same key, two meanings, exactly the kind of thing a consumer misreads
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let failures = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// ---- 1. prose that claims a package line must not name one ----
const proseFiles = [];
for (const dir of ["docs", "skills"]) {
	for (const e of readdirSync(join(root, dir), { withFileTypes: true, recursive: true })) {
		if (e.isFile() && e.name.endsWith(".md")) proseFiles.push(join(e.parentPath ?? e.path, e.name));
	}
}
const pinned = [];
for (const p of proseFiles) {
	const text = readFileSync(p, "utf8");
	const hits = [
		...text.matchAll(/\b(?:shipped with|released as|part of)\s+`?\S*\s?0\.\d+\.x/g),
		...text.matchAll(/`pi-workfeed`\s+0\.\d+\.\d+/g),
	].map((m) => m[0]);
	if (hits.length) pinned.push(`${relative(root, p)}: ${hits[0]}`);
}
check("no doc pins the protocol to a package line", pinned, []);

// ---- 2. no doc advertises the removed packaging surface ----
const removed = [
	{ name: "pack expects bin/", pattern: /npm pack[^\n]*(schemas, bin|bin, docs)/ },
	{ name: "bin file path", pattern: /bin\/workfeed-digest/ },
	{ name: "npx entry", pattern: /npx\s+pi-workfeed/i },
	{ name: "CLI flags", pattern: /--(strict|quiet|out)\b/ },
];
const advertised = [];
for (const p of proseFiles) {
	const text = readFileSync(p, "utf8");
	for (const r of removed) if (r.pattern.test(text)) advertised.push(`${relative(root, p)}: ${r.name}`);
}
check("no doc advertises a removed CLI surface", advertised, []);

// ---- 3. `item` is a source-neutral work-item id everywhere ----
const itemConsumers = [
	"schemas/workfeed-event-v1.schema.json",
	"extensions/journal/index.ts",
	"extensions/journal/replay.ts",
	"docs/schema.md",
	"skills/workfeed-analysis/SKILL.md",
];
const stale = [];
for (const p of itemConsumers) {
	const text = read(p);
	// "a todo id" may appear as an honest example; redefining `item` as *the* todo id may not.
	if (/todo item id|\bitem\s+is\s+(the\s+)?todo|item.{0,20}is the todo/i.test(text)) stale.push(p);
	if (p !== "docs/schema.md" && p !== "skills/workfeed-analysis/SKILL.md" && !/work item/i.test(text)) stale.push(`${p} (no work-item wording)`);
}
check("`item` is described as a work item id, not a todo id", stale, []);

// ---- 4. the machine schema and the prose schema agree on `item` ----
const jsonItem = JSON.parse(read("schemas/workfeed-event-v1.schema.json")).properties.item.description;
check("schema.json item mentions the source neutrality", /source-neutral/i.test(jsonItem), true);
check("schema.json item is not the todo tool's id", /todo item id/i.test(jsonItem), false);

// ---- 5. the wire status line matches the wire version, not the package ----
const schemaDoc = read("docs/schema.md");
const statusLine = schemaDoc.match(/^\*\*Status:\*\*[^\n]*/m)?.[0] ?? "";
check("protocol status names schemaVersion", /schemaVersion = \d+/.test(statusLine), true);
check("protocol status does not name a package version", /0\.\d+\.\d+/.test(statusLine), false);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
