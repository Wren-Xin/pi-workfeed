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

// ---- source version: a tag may never name a version the shipped code does not have ----
const git = (...args) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};
const headTag = git("describe", "--tags", "--exact-match", "HEAD");
if (headTag) {
	// Compare against the version *committed* at HEAD, not the working copy: a tag names
	// a commit, and the working copy is legitimately one bump ahead while you prepare the
	// next release.
	let committed = "";
	try {
		committed = JSON.parse(git("show", "HEAD:package.json")).version;
	} catch {
		committed = version;
	}
	check("HEAD tag names the version committed at HEAD", headTag, `v${committed}`);
	if (committed !== version) note(`working copy is ${version}, HEAD is tagged v${committed} (release in progress)`);
} else {
	note(`HEAD is untagged (allowed between releases; the next release cuts v${version})`);
}

// A tag may never name a version the shipped code does not carry. The comparison is scoped
// to tags created **after** package.json last changed: the first public release starts its
// own number line (0.1.0) beneath development tags that reached 0.4.6, and those older tags
// are history, not a defect. Sorting by version number would report the reset itself as the
// bug, so the window is "since this version was declared".
// Every tag must name the version its own commit ships. That invariant survives a number-line
// reset: the first public release starts at 0.1.0 beneath development tags that reached 0.4.6,
// so comparing tags against the *current* package version would report the deliberate reset as
// a defect, while comparing each tag against its own commit asks the question that matters —
// can you install the tag and find a different number inside?
const mismatch = git("tag", "--list", "v*")
	.split("\n")
	.filter(Boolean)
	.filter((tag) => {
		let inside = "";
		try {
			inside = JSON.parse(git("show", `${tag}:package.json`)).version;
		} catch {
			return true;
		}
		return tag !== `v${inside}`;
	});
check("every tag names the version its own commit ships", mismatch, []);

// ---- the shipped docs must actually be in the package ----
check("docs shipped by files[]", pkg.files.includes("docs"), true);
check("schemas shipped by files[]", pkg.files.includes("schemas"), true);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
