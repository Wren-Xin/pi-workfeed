#!/usr/bin/env node
/**
 * README ↔ code contract. The README is install documentation: if it names a command the
 * package does not register, a reader follows instructions into nothing. If it advertises an
 * entry point that was removed (the npm `bin` / `npx` CLI), the same thing happens.
 *
 * So the README is checked against the source, not against itself:
 *   - every `/command` in the README is registered by an extension
 *   - every registered command is documented
 *   - no removed surface is described as available
 *   - exactly one roadmap bullet is marked current, and it is this version
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

let failures = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// ---- commands, both directions ----
const extDir = join(root, "extensions");
const registered = new Set();
for (const entry of readdirSync(extDir, { withFileTypes: true, recursive: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
	const source = readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8");
	for (const m of source.matchAll(/registerCommand\("([^"]+)"/g)) registered.add(m[1]);
}

const documented = new Set([...readme.matchAll(/`\/([a-z][a-z0-9-]+)`/g)].map((m) => m[1]));
// pi's own commands may be mentioned while explaining usage; they are not ours to register.
const hostCommands = new Set(["reload", "compact", "fork", "tree", "new", "resume", "model"]);
check(
	"every documented command is registered (or is a pi host command)",
	[...documented].filter((c) => !registered.has(c) && !hostCommands.has(c)).sort(),
	[],
);
check("every registered command is documented", [...registered].filter((c) => !documented.has(c)).sort(), []);
check("three commands, in case the README drifts silently", registered.size, 3);

// ---- removed surfaces must not be advertised ----
const forbidden = [
	{ name: "npx entry point", pattern: /npx\s+pi-workfeed/i },
	{ name: "bin file path", pattern: /bin\/workfeed-digest/ },
	{ name: "CLI flags", pattern: /--(strict|quiet|out)\b/ },
	{ name: "offline analyzer section", pattern: /##\s+Offline analyzer/i },
];
const hits = [];
for (const f of forbidden) if (f.pattern.test(readme)) hits.push(f.name);
check("no removed CLI surface is advertised", hits, []);

// ---- roadmap: one current marker, and it is the shipped version ----
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const current = [...readme.matchAll(/^- v(\d+\.\d+\.\d+) \(this\)/gm)].map((m) => m[1]);
check("exactly one roadmap bullet is marked current", current.length, 1);
check("that bullet is this version", current[0], pkg.version);

// ---- install instructions must be installable as written ----
check("install section uses pi install, not npm", /pi install/.test(readme), true);
check("README does not claim an npm global install", /npm (i|install) -g/i.test(readme), false);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
