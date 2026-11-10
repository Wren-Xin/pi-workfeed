#!/usr/bin/env node
/**
 * The wire format is a protocol, so it gets a protocol test.
 *
 *  1. every line of the shipped fixtures satisfies schemas/workfeed-event-v1.schema.json
 *  2. every event type documented in the schema appears in the all-events fixture
 *  3. the doc's claims about join keys hold on the fixtures (task monotonic, item ids unique)
 *
 * The validator below implements only the subset of JSON Schema this file uses
 * (type / required / const / enum / minimum / maximum / minLength / maxLength / properties /
 * items / oneOf). No dependency, no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let fails = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) fails += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const schema = JSON.parse(readFileSync(join(root, "schemas", "workfeed-event-v1.schema.json"), "utf8"));

const typesOk = (value, type) => {
	switch (type) {
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return true;
	}
};

const validate = (value, sub, path) => {
	const errors = [];
	if (sub.type && !typesOk(value, sub.type)) errors.push(`${path}: expected ${sub.type}`);
	if ("const" in sub && value !== sub.const) errors.push(`${path}: expected const ${JSON.stringify(sub.const)}`);
	if (sub.enum && !sub.enum.includes(value)) errors.push(`${path}: not in enum`);
	if (typeof value === "number") {
		if (sub.minimum !== undefined && value < sub.minimum) errors.push(`${path}: below minimum ${sub.minimum}`);
		if (sub.maximum !== undefined && value > sub.maximum) errors.push(`${path}: above maximum ${sub.maximum}`);
	}
	if (typeof value === "string") {
		const len = [...value].length;
		if (sub.minLength !== undefined && len < sub.minLength) errors.push(`${path}: shorter than ${sub.minLength}`);
		if (sub.maxLength !== undefined && len > sub.maxLength) errors.push(`${path}: longer than ${sub.maxLength}`);
	}
	if (typesOk(value, "object")) {
		for (const key of sub.required ?? []) if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
		for (const [key, child] of Object.entries(sub.properties ?? {})) {
			if (key in value) errors.push(...validate(value[key], child, `${path}.${key}`));
		}
	}
	if (Array.isArray(value) && sub.items) value.forEach((item, i) => errors.push(...validate(item, sub.items, `${path}[${i}]`)));
	return errors;
};

const matchOneOf = (line, branches) => {
	let matched = 0;
	const branchErrors = [];
	for (const branch of branches) {
		const errors = validate(line, { type: "object", ...branch }, "line");
		if (errors.length === 0) matched += 1;
		else branchErrors.push(errors);
	}
	return { matched, branchErrors };
};

const validateLines = (file) => {
	const lines = readFileSync(join(here, "fixtures", file), "utf8").trim().split("\n");
	const bad = [];
	for (const [i, raw] of lines.entries()) {
		let line;
		try {
			line = JSON.parse(raw);
		} catch {
			bad.push({ file, line: i + 1, errors: ["not JSON"] });
			continue;
		}
		// base envelope
		const baseErrors = validate(line, { type: "object", required: schema.required, properties: schema.properties }, "line");
		const { matched, branchErrors } = matchOneOf(line, schema.oneOf);
		if (baseErrors.length || matched !== 1) bad.push({ file, line: i + 1, t: line.t, errors: baseErrors.concat(matched === 1 ? [] : [`oneOf matched ${matched} branches`]).concat(branchErrors.slice(0, 1).flat()) });
	}
	return { lines: lines.map((l) => JSON.parse(l)), bad };
};

for (const file of ["all-events.jsonl", "resume-and-gaps.jsonl"]) {
	const { bad, lines } = validateLines(file);
	check(`schema valid: ${file} (${lines.length} lines)`, bad, []);

	// --- claims from the doc, checked on the fixtures ---
	const tasks = lines.filter((l) => l.t === "prompt").map((l) => l.task);
	const monotonic = tasks.every((t, i) => i === 0 || t > tasks[i - 1]);
	check(`task strictly increases per prompt: ${file}`, monotonic, true);

	const itemIds = new Set();
	const reused = [];
	for (const l of lines) {
		for (const it of l.items ?? []) {
			if (itemIds.has(it.id)) reused.push(it.id);
			itemIds.add(it.id);
		}
	}
	check(`item ids unique within a fixture: ${file}`, reused, []);
}

// --- every documented event type has a sample ---
const docTypes = schema.oneOf.map((b) => b.properties.t.const);
const { lines: allLines } = validateLines("all-events.jsonl");
const covered = new Set(allLines.map((l) => l.t));
check("every schema type has a fixture line", docTypes.filter((t) => !covered.has(t)), []);

// --- phases are paired by id, never by position ---
const starts = allLines.filter((l) => l.t === "tool" && l.phase === "start").map((l) => l.id);
const ends = allLines.filter((l) => l.t === "tool" && l.phase === "end").map((l) => l.id);
check("each tool start has an end in the sample", starts.every((id) => ends.includes(id)), true);

console.log(fails === 0 ? "RESULT: PASS" : `RESULT: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
