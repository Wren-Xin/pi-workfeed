#!/usr/bin/env node
/**
 * v1 is frozen: no new fields, no new event types before the first release.
 *
 * A "please do not add fields" note in a document is not a constraint — the next
 * well-meaning patch adds one and nobody notices. So the frozen contract is stored as
 * a snapshot (test/fixtures/schema-freeze-v1.json) and this test rebuilds the same
 * summary from schemas/workfeed-event-v1.schema.json and compares them field by field.
 *
 * Any difference is a deliberate decision, not an accident: if the wire format really
 * must change, bump the wire version (see docs/versioning.md), ship v2 alongside v1,
 * and update this snapshot in the same commit. If it must not change, this test is
 * the reason the reviewer finds out.
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
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`}`);
};
const has = (name, haystack, needle) => {
	const ok = haystack.includes(needle);
	if (!ok) fails += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  missing: ${needle}`}`);
};

const schema = JSON.parse(readFileSync(join(root, "schemas", "workfeed-event-v1.schema.json"), "utf8"));
const frozen = JSON.parse(readFileSync(join(here, "fixtures", "schema-freeze-v1.json"), "utf8"));
const indexTs = readFileSync(join(root, "extensions", "journal", "index.ts"), "utf8");

const names = (d) => Object.keys(d.properties ?? {}).sort();

// Rebuild the same summary the snapshot holds — from the schema, not from the snapshot.
const live = {
	schemaVersion: schema.properties.v.const,
	envelope: { required: [...schema.required].sort(), properties: names(schema) },
	events: schema.oneOf
		.map((br) => ({
			t: br.properties.t.const,
			required: [...(br.required ?? [])].sort(),
			properties: names(br),
			phaseRules: (br.allOf ?? []).map((al) => ({
				ifPhase: al.if.properties.phase.const,
				thenRequired: [...al.then.required].sort(),
			})),
		}))
		.sort((a, b) => (a.t < b.t ? -1 : 1)),
};

check("wire version still 1 (frozen)", live.schemaVersion, 1);
check("the producer still writes SCHEMA_VERSION = 1", /const SCHEMA_VERSION = 1;/.test(indexTs), true);
check("frozen snapshot is itself the v1 snapshot", frozen.schemaVersion, 1);

const frozenTypes = frozen.events.map((e) => e.t);
const liveTypes = live.events.map((e) => e.t);
check("no event type was added or removed", liveTypes, frozenTypes);

const sameEnvelope = JSON.stringify(live.envelope) === JSON.stringify(frozen.envelope);
check("envelope fields unchanged (names and required)", sameEnvelope, true);
if (!sameEnvelope) {
	const before = new Set(frozen.envelope.properties);
	const after = new Set(live.envelope.properties);
	console.log(`  added:   ${[...after].filter((f) => !before.has(f)).join(", ") || "-"}`);
	console.log(`  removed: ${[...before].filter((f) => !after.has(f)).join(", ") || "-"}`);
}

for (const ev of live.events) {
	const was = frozen.events.find((e) => e.t === ev.t);
	if (!was) continue; // already reported by the type-set check
	const name = `event '${ev.t}'`;
	if (JSON.stringify(ev) !== JSON.stringify(was)) {
		check(`${name} fields/required unchanged`, ev, was);
		const before = new Set(was.properties);
		const after = new Set(ev.properties);
		console.log(`  added:   ${[...after].filter((f) => !before.has(f)).join(", ") || "-"}`);
		console.log(`  removed: ${[...before].filter((f) => !after.has(f)).join(", ") || "-"}`);
	} else {
		check(`${name} fields/required unchanged`, true, true);
	}
}

// The freeze is about the wire format, not about the producer's internals: a new key may
// appear in the digest or in a stub, and that is fine. Only this line has to stay still.
has(
	"the schema says it is normative for consumers",
	readFileSync(join(root, "schemas", "workfeed-event-v1.schema.json"), "utf8"),
	"Consumers must tolerate unknown properties",
);

console.log(fails === 0 ? "RESULT: PASS" : `RESULT: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
