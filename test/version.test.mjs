#!/usr/bin/env node
/**
 * Version consistency test — the three axes never borrow each other's numbers.
 *
 *   wire version    v field / SCHEMA_VERSION / JSON schema `const` / schema heading
 *   package version package.json / CHANGELOG top entry / README roadmap "(this)"
 *   source version  git tag v<package version> on HEAD (optional between releases)
 *
 * This catches the cheap drift (a doc claiming 0.2.0 while package.json says 0.1.0),
 * not a release that skipped its checklist.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const note = (msg) => console.log(`note ${msg}`);

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

check("version looks like semver", /^\d+\.\d+\.\d+$/.test(version), true);

// ---- package version: three declarations, one number ----
const changelog = read("CHANGELOG.md");
const firstEntry = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
check("CHANGELOG top entry matches package.json", firstEntry?.[1], version);

const readme = read("README.md");
const roadmapThis = readme.match(/^- v(\d+\.\d+\.\d+) \(this\)/m);
check("README roadmap marks this version", roadmapThis?.[1], version);

// ---- wire version: producer code and machine schema must agree ----
const indexTs = read("extensions/journal/index.ts");
const codeWire = Number(indexTs.match(/const SCHEMA_VERSION = (\d+)/)?.[1]);
const jsonSchema = JSON.parse(read("schemas/workfeed-event-v1.schema.json"));
check("JSON schema const matches SCHEMA_VERSION", jsonSchema.properties.v.const, codeWire);

const schemaDoc = read("docs/schema.md");
const docWire = Number(schemaDoc.match(/schemaVersion = (\d+)/)?.[1]);
check("schema.md heading matches SCHEMA_VERSION", docWire, codeWire);
check("wire version is a whole number above zero", Number.isInteger(codeWire) && codeWire > 0, true);

// ---- source version: tags are cut deliberately, never ahead of the code ----
const git = (...args) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};
const headTag = git("describe", "--tags", "--exact-match", "HEAD");
if (headTag) {
	check("HEAD tag names the package version", headTag, `v${version}`);
} else {
	note(`HEAD is untagged (allowed between releases; the next release cuts v${version})`);
}

const tags = git("tag", "--list", "v*").split("\n").filter(Boolean).sort((a, b) => {
	const pa = a.slice(1).split(".").map(Number);
	const pb = b.slice(1).split(".").map(Number);
	for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
});
const newest = tags.at(-1);
if (newest) {
	const [a, b, c] = newest.slice(1).split(".").map(Number);
	const [x, y, z] = version.split(".").map(Number);
	const ahead = a > x || (a === x && (b > y || (b === y && c > z)));
	check(`newest tag (${newest}) is not ahead of package.json`, ahead, false);
} else {
	note("no tags yet — this repository has never cut a release");
}

// ---- the shipped docs must actually be in the package ----
check("docs shipped by files[]", pkg.files.includes("docs"), true);
check("schemas shipped by files[]", pkg.files.includes("schemas"), true);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
