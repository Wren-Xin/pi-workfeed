#!/usr/bin/env node
/**
 * The artifact, not the checkout, is what a stranger gets. Pi loads a package by reading
 * `package.json` (`pi.extensions` / `pi.skills`), and it silently skips a skill whose
 * `SKILL.md` is malformed or has no description — a failure nobody would notice until a
 * model fails to use it. So the manifest and the shipped tree are checked here, in CI,
 * instead of being eyeballed once before a release.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let fails = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) fails += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`}`);
};

// ---- the manifest declares loadable entry points ----
const extensions = pkg.pi?.extensions ?? [];
check("pi.extensions declares at least the two shipped extensions", extensions.length >= 2, true);
for (const rel of extensions) {
	const abs = join(root, rel);
	check(`declared extension exists: ${rel}`, existsSync(abs) && statSync(abs).isFile(), true);
}

const skillRoots = pkg.pi?.skills ?? [];
check("pi.skills declares a skill root", skillRoots.length >= 1, true);
for (const rel of skillRoots) {
	const abs = join(root, rel);
	check(`declared skill root exists: ${rel}`, existsSync(abs) && statSync(abs).isDirectory(), true);
}

// ---- every skill under those roots is one pi will actually load ----
const skillDirs = [];
for (const rel of skillRoots) {
	const abs = join(root, rel);
	if (!existsSync(abs)) continue;
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = join(dir, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.name === "SKILL.md") skillDirs.push(dir);
		}
	};
	walk(abs);
}
check("at least one SKILL.md ships under pi.skills", skillDirs.length >= 1, true);

for (const dir of skillDirs) {
	const text = readFileSync(join(dir, "SKILL.md"), "utf8");
	const rel = dir.slice(root.length + 1).replace(/\\/g, "/");
	const opensWithFrontMatter = text.startsWith("---\n") || text.startsWith("---\r\n");
	check(`${rel}/SKILL.md opens with YAML front matter (pi's loader requires it)`, opensWithFrontMatter, true);
	const front = opensWithFrontMatter ? text.slice(4, text.indexOf("\n---", 3)) : "";
	const name = /^\s*name:\s*(.+)$/m.exec(front)?.[1]?.trim();
	const description = /^\s*description:\s*(.+)$/m.exec(front)?.[1]?.trim();
	check(`${rel}/SKILL.md has a non-empty name`, !!name && name.length > 0, true);
	// pi's rule: "skills without descriptions are not loaded" — so this is loadability, not style.
	check(`${rel}/SKILL.md has a description (without it pi skips the skill)`, !!description && description.length > 0, true);
	check(`${rel}/SKILL.md name matches its directory (how the model addresses it)`, name, dir.split(/[\\/]/).pop());
}

// ---- what npm would ship, as declared ----
const filesField = (pkg.files ?? []).map((f) => f.replace(/^\.\//, ""));
for (const required of ["extensions", "skills", "schemas", "docs", "README.md", "CHANGELOG.md", "LICENSE"]) {
	check(`package.json "files" ships ${required}`, filesField.includes(required), true);
}

// ---- the CLI stays removed: a published bin would resurrect the rejected design ----
check("no bin entry (the CLI was rejected on purpose)", pkg.bin, undefined);
check("engines.node declared (the suite needs --experimental-strip-types)", typeof pkg.engines?.node, "string");

console.log(fails === 0 ? "RESULT: PASS" : `RESULT: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
