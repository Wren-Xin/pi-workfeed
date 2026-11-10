# Versioning: three independent axes

`pi-workfeed` has three version numbers. They measure different things, they change for
different reasons, and **none of them is derived from another**. Confusing them is how a
release ends up claiming a protocol it does not implement.

| Axis | Where it lives | Changes when | Does **not** change when |
|---|---|---|---|
| **Wire (schema) version** | `v` field on every event; `SCHEMA_VERSION` in `extensions/journal/index.ts`; `const` in `schemas/workfeed-event-v1.schema.json`; the heading of `docs/schema.md` | the format breaks: a field is removed, renamed, retyped, given a new meaning, or an invariant guarantee changes | fields are added, docs improve, an analyzer gets smarter |
| **Package version** | `package.json` `version`; the README roadmap's `(this)` line; the top entry of `CHANGELOG.md` | anything installable changes: code, behaviour, dependencies, shipped docs | a git tag is cut, a release is uploaded |
| **Source version** | annotated git tag `v<package version>` on the commit that carries that `package.json` | a release is *cut*, i.e. someone decided this commit is the one to hand out | `package.json` alone changes on an ordinary commit |

Consequences worth stating out loud:

- **`0.3.1` may still be wire `1`.** Most releases are package-only.
- **Wire `2` forces at least a minor bump**, and a breaking one (consumers must handle it),
  but it does not have to be a major: the package is not a rewrite, just a new stream
  format. `docs/schema.md` §10 defines what counts as breaking.
- **A tag can lag `package.json`.** `main` may run ahead of the last tag with docs-only or
  test-only commits: those are real commits, not releases. A tag is never moved backwards,
  and never placed on a commit whose `package.json` disagrees with the tag name.

## Bump rules for the package version

| Bump | Use for | Examples from this repo |
|---|---|---|
| patch (`0.3.x`) | docs, tests, internal refactors, policy — nothing a consumer installing the package gets differently | a protocol doc rewrite, a consistency test |
| minor (`0.x.0`) | new capability or visible behaviour change | integrity reporting, join keys holding across restarts, removing the CLI (an install surface that changed shape) |
| major | breaking tool contract or install-time behaviour | renaming `workfeed_todo`, changing what `files` ships |

Wire version bumps follow the schema rules and are counted separately; when both change,
the package version moves at least to the next minor.

## Cutting a release

A tag is cut only when all of these are true on the commit being tagged:

1. `npm test` — every suite passes (`ALL SUITES PASS`).
2. `npm pack --dry-run` — the file list is what you expect (schemas, bin, docs included).
3. `package.json` version == top `CHANGELOG.md` entry == README roadmap `(this)` line;
   `test/version.test.mjs` checks exactly this and fails otherwise.
4. Wire version unchanged, or its bump documented in `docs/schema.md` §10 and reflected in
   `SCHEMA_VERSION`, the JSON schema `const`, and the protocol heading.
5. `git tag -a v0.3.1 -m "..."`, then push the tag to **both** remotes
   (`git push origin v0.3.1` and `git push gitee v0.3.1`) so the mirror cannot drift.
6. npm publication (when credentials exist) happens after the tag, from that commit.

## What enforces this

`test/version.test.mjs` reads the four declarations and compares them:

- `package.json` version
- first `## [x.y.z]` heading in `CHANGELOG.md`
- the roadmap's `vX.Y.Z (this)` line in `README.md`
- `SCHEMA_VERSION` in the producer vs `properties.v.const` in the JSON schema

It also looks at git: if `HEAD` is tagged, the tag must be `v<package version>`; if it is
untagged, that is allowed, but the newest tag may never name a version *higher* than
`package.json` (a tag ahead of the code means the tag was cut from the wrong commit).

Nothing here is a substitute for the checklist: the test catches text drifting apart, not a
release that skipped its own evidence.
