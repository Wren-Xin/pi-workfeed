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

// A tag may never name a version the shipped code does not carry. Two rules, both cheap:
//   * every tag names the version its own commit ships (`dev/0.4.6` must contain 0.4.6),
//   * no release tag claims a version above `package.json`.
// The second is what keeps the published line honest: development milestones used to carry
// release-shaped names (`v0.4.6` beside an npm `0.1.0`), which reads on GitHub as "the latest
// version is 0.4.6" and contradicts the package a reader just installed. Milestones now live
// under `dev/`, so they keep their history without competing with the release line.
const versionInside = (tag) => {
	try {
		return JSON.parse(git("show", `${tag}:package.json`)).version;
	} catch {
		return "";
	}
};
const named = git("tag", "--list")
	.split("\n")
	.filter(Boolean)
	.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag) || /^dev\/\d+\.\d+\.\d+$/.test(tag));
const misnamed = named.filter((tag) => {
	const inside = versionInside(tag);
	return !inside || (tag !== `v${inside}` && tag !== `dev/${inside}`);
});
check("every tag names the version its own commit ships", misnamed, []);

const releaseTags = named.filter((tag) => tag.startsWith("v"));
const parts = (v) => v.split(".").map(Number);
const above = releaseTags.filter((tag) => {
	const [a, b, c] = parts(tag.slice(1));
	const [x, y, z] = parts(version);
	return a > x || (a === x && (b > y || (b === y && c > z)));
});
check("no release tag claims a version above package.json", above, []);

// ---- the shipped docs must actually be in the package ----
check("docs shipped by files[]", pkg.files.includes("docs"), true);
check("schemas shipped by files[]", pkg.files.includes("schemas"), true);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
