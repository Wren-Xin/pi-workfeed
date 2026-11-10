# Docs

- [schema.md](schema.md) — the wire protocol: envelope, join keys, every event type, the
  digest contract, privacy and damage reporting
- [versioning.md](versioning.md) — wire / package / source versions, bump criteria, release
  checklist
- [verification.md](verification.md) — what a real pi session covered, what the stubs could
  not prove, and the platform matrix

The machine-readable form of the protocol is
[`schemas/workfeed-event-v1.schema.json`](../schemas/workfeed-event-v1.schema.json);
`test/schema-docs.test.mjs` fails when it and `schema.md` disagree.
