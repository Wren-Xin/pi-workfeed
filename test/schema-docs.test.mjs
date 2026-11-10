#!/usr/bin/env node
/**
 * Protocol ↔ prose reconciliation. `docs/schema.md` is what a human (or a model) reads to
 * build a consumer; `schemas/workfeed-event-v1.schema.json` is what a program validates
 * against. Two documents, one contract — and until now nothing compared them, so a field
 * added to one side could silently be missing from the other.
 *
 * This test derives the contract twice and diffs it:
 *   - from the prose tables in §4 (field names, `yes`/`opt`, per-`phase` rows)
 *   - from the `oneOf` branches (declared properties, `required`, `if/then` per phase)
 *
 * Nothing here validates instances (that is `schema.test.mjs`); this only asks whether both
 * descriptions of the same format agree.
 */
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

const md = read("docs/schema.md");
const schema = JSON.parse(read("schemas/workfeed-event-v1.schema.json"));

// ---------------------------------------------------------------------------
// prose side
// ---------------------------------------------------------------------------
const catalog = md.split(/^## 4\. Event catalog$/m)[1].split(/^## 5\. /m)[0];
const blocks = catalog.split(/^### /m).slice(1);

/** @type {Map<string, {fields: Set<string>, required: Map<string, Set<string>>}>} */
const prose = new Map();
const proseNested = new Map(); // "todo.items" | "settle.tokens" -> {fields, required}

const splitRow = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c));

for (const block of blocks) {
	const lines = block.split("\n");
	const typeNames = [...lines[0].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
	for (const t of typeNames) if (!prose.has(t)) prose.set(t, { fields: new Set(), required: new Map() });

	// contiguous table runs, each carrying the last prose line before it as an anchor
	let anchor = "";
	let tableIndex = 0;
	let run = null;
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (!line.startsWith("|")) {
			if (run) {
				consumeTable(run, anchor, tableIndex);
				tableIndex += 1;
				run = null;
			}
			if (line.trim()) anchor = line.trim();
			continue;
		}
		if (!run) run = [];
		run.push(line);
	}
	if (run) consumeTable(run, anchor, tableIndex);

	function consumeTable(tableLines, tableAnchor, index) {
		// header cells are backticked in the doc (`phase`, `t`), plain in others — normalise first
		const header = splitRow(tableLines[0]).map((c) => c.replace(/`/g, ""));
		let fieldCol = 0;
		let reqCol = header.indexOf("Req");
		let groupCol = null;
		if (header[0] === "phase" || header[0] === "t") {
			groupCol = header[0];
			fieldCol = header.indexOf("Field");
		}
		if (reqCol < 0 || fieldCol < 0) return;

		const rows = tableLines.slice(1).filter((l) => !isSeparator(splitRow(l)));
		const nestedKey = index > 0 ? (tableAnchor.includes("Each entry") ? `${typeNames[0]}.items` : `${typeNames[0]}.tokens`) : null;
		const sink = nestedKey
			? (proseNested.set(nestedKey, { fields: new Set(), required: new Set() }), proseNested.get(nestedKey))
			: null;

		for (const line of rows) {
			const cells = splitRow(line);
			const field = (cells[fieldCol] ?? "").replace(/`/g, "");
			if (!field) continue;
			const req = (cells[reqCol] ?? "").toLowerCase();
			const kind = req === "yes" ? "required" : req === "opt" ? "optional" : null;
			if (!kind) continue;

			const group = (cells[0] ?? "").replace(/`/g, "");
			const targets = groupCol === "t" ? [group].filter((c) => typeNames.includes(c)) : typeNames;
			// a second table describes a nested object, not more fields of the event
			if (sink) {
				sink.fields.add(field);
				if (kind === "required" && targets.length === 1) sink.required.add(field);
				continue;
			}
			for (const t of targets) {
				const entry = prose.get(t);
				entry.fields.add(field);
				const phase = groupCol === "phase" ? group : "";
				if (!entry.required.has(phase)) entry.required.set(phase, new Set());
				if (kind === "required") entry.required.get(phase).add(field);
			}
		}
	}
}

// a type that legitimately has no fields (agent_start) still needs an empty requirement set
for (const entry of prose.values()) if (entry.required.size === 0) entry.required.set("", new Set());

// ---------------------------------------------------------------------------
// schema side
// ---------------------------------------------------------------------------
/** @type {Map<string, {fields: Set<string>, base: Set<string>, byPhase: Map<string, Set<string>>, branch: any}>} */
const machine = new Map();
for (const branch of schema.oneOf) {
	const t = branch.properties.t.const;
	const fields = new Set(Object.keys(branch.properties).filter((k) => k !== "t" && k !== "phase"));
	const base = new Set((branch.required ?? []).filter((k) => k !== "t" && k !== "phase"));
	const byPhase = new Map();
	for (const clause of branch.allOf ?? []) {
		const phase = clause.if?.properties?.phase?.const;
		if (!phase) continue;
		byPhase.set(phase, new Set((clause.then?.required ?? []).filter((k) => k !== "phase" && k !== "t")));
	}
	machine.set(t, { fields, base, byPhase, branch });
}

// ---------------------------------------------------------------------------
// comparisons
// ---------------------------------------------------------------------------
const allTypes = [...new Set([...prose.keys(), ...machine.keys()])].sort();
check("every event type is described on both sides", allTypes.filter((t) => !prose.has(t) || !machine.has(t)), []);
check("twelve event types", allTypes.length, 12);

const fieldDrift = [];
for (const t of allTypes) {
	if (!prose.has(t) || !machine.has(t)) continue;
	const docFields = [...prose.get(t).fields].sort();
	const codeFields = [...machine.get(t).fields].sort();
	if (JSON.stringify(docFields) !== JSON.stringify(codeFields)) {
		fieldDrift.push({ type: t, onlyInDocs: docFields.filter((f) => !machine.get(t).fields.has(f)), onlyInSchema: codeFields.filter((f) => !prose.get(t).fields.has(f)) });
	}
}
check("field names agree per event type", fieldDrift, []);

const requiredDrift = [];
for (const t of allTypes) {
	if (!prose.has(t) || !machine.has(t)) continue;
	const m = machine.get(t);
	const phases = [...prose.get(t).required.keys()];
	const effective = (phase) => {
		const set = new Set(m.base);
		for (const f of m.byPhase.get(phase) ?? []) set.add(f);
		return [...set].sort();
	};
	for (const phase of phases) {
		const docs = [...(prose.get(t).required.get(phase) ?? new Set())].sort();
		const code = effective(phase);
		if (JSON.stringify(docs) !== JSON.stringify(code)) {
			requiredDrift.push({ type: phase ? `${t}@${phase}` : t, onlyInDocs: docs.filter((f) => !code.includes(f)), onlyInSchema: code.filter((f) => !docs.includes(f)) });
		}
	}
}
check("required flags agree per event type and phase", requiredDrift, []);

// nested objects: todo items[], settle tokens{}
const nestedDrift = [];
const nestedCases = [
	{ key: "todo.items", node: machine.get("todo")?.branch.properties.items.items },
	{ key: "settle.tokens", node: machine.get("settle")?.branch.properties.tokens },
];
for (const { key, node } of nestedCases) {
	const doc = proseNested.get(key);
	if (!doc || !node) {
		nestedDrift.push({ key, problem: "missing on one side" });
		continue;
	}
	const docFields = [...doc.fields].sort();
	const codeFields = Object.keys(node.properties).sort();
	if (JSON.stringify(docFields) !== JSON.stringify(codeFields)) nestedDrift.push({ key, onlyInDocs: docFields.filter((f) => !codeFields.includes(f)), onlyInSchema: codeFields.filter((f) => !docFields.includes(f)) });
	const docReq = [...doc.required].sort();
	const codeReq = [...node.required].sort();
	if (JSON.stringify(docReq) !== JSON.stringify(codeReq)) nestedDrift.push({ key, requiredOnlyInDocs: docReq.filter((f) => !codeReq.includes(f)), requiredOnlyInSchema: codeReq.filter((f) => !docReq.includes(f)) });
}
check("nested object fields agree (todo items, settle tokens)", nestedDrift, []);

// ---- the envelope table must match the declared top-level properties ----
// stop before the join-key subsection, which has a table of its own
const envelope = (md.split(/^## 3\. Envelope/m)[1] ?? "").split("`task` and `item` are the **join keys**")[0];
const envelopeRows = envelope
	.split("\n")
	.filter((l) => l.startsWith("|") && !isSeparator(splitRow(l)))
	.filter((l) => splitRow(l)[0].replace(/`/g, "") !== "Field");
const envelopeFields = envelopeRows.map((l) => splitRow(l)[0].replace(/`/g, ""));
check("envelope table lists exactly the declared top-level properties", envelopeFields.sort(), Object.keys(schema.properties).sort());
check(
	"envelope required flags match `required`",
	envelopeRows.filter((l) => splitRow(l)[2] === "yes").map((l) => splitRow(l)[0].replace(/`/g, "")).sort(),
	[...schema.required].sort(),
);

// ---- the README's sample lines must be real wire events, not an invented shape ----
// The README shows two JSONL lines so a stranger can see the format before reading the spec.
// A sample that invents a field (`type`, `timestamp`) teaches a parser that cannot consume
// the log, so the sample is validated against the same schema the code is.
const readmeText = read("README.md");
const sampleBlocks = [...readmeText.matchAll(/```json\n([\s\S]*?)\n```/g)]
	.map((m) => m[1])
	.filter((b) => b.includes('"v"'));
check("README carries a JSONL event sample", sampleBlocks.length > 0, true);

const badParse = [];
const badField = [];
const unknownType = [];
const badEnvelope = [];
for (const line of (sampleBlocks[0] ?? "").split("\n").filter((l) => l.trim())) {
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		badParse.push(line.slice(0, 60));
		continue;
	}
	const branch = schema.oneOf.find((b) => b.properties.t.const === ev.t);
	if (!branch) {
		unknownType.push(ev.t);
		continue;
	}
	const allowed = new Set([...Object.keys(branch.properties), ...Object.keys(schema.properties)]);
	for (const k of Object.keys(ev)) if (!allowed.has(k)) badField.push(`${ev.t}:${k}`);
	for (const k of schema.required) if (!(k in ev)) badEnvelope.push(k);
	if (ev.v !== 1) badEnvelope.push("v != 1");
	// every line carries the join keys the digest promises
	for (const k of ["sid", "task"]) if (typeof ev[k] === "undefined") badEnvelope.push(k);
}
check("README sample lines parse as JSON", badParse, []);
check("README sample uses only fields the schema declares", badField, []);
check("README sample uses only event types the schema declares", unknownType, []);
check("README sample carries the envelope and join keys", badEnvelope, []);

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
