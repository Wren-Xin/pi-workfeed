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

- **A patch release may still be wire `1`.** Most releases are package-only.
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
2. `npm pack --dry-run` — the file list is exactly what you expect: `CHANGELOG.md`, `LICENSE`,
   `README.md`, `docs/`, `extensions/`, `package.json`, `schemas/`, `skills/` — nothing else.
   No `test/`, no `.git`, and no `bin` field: the CLI was removed on purpose, so there is no
   executable in the package and nothing to look for on `PATH`. `test/package.test.mjs` asserts
   this shape, that `pi.extensions` / `pi.skills` point at entries that exist, and that **every
   relative link in the README resolves to a file inside the declared ship set** — the README
   travels in the tarball, so a link that only works in a checkout sends a reader nowhere.
   `HISTORY.md` is at the repository root, outside `files`, and is linked by absolute URL for
   that reason.
   Peer dependencies (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
   `@earendil-works/pi-tui`, `typebox`) are declared with `*` and stay that way: the running
   pi host supplies all four, so any range would describe a copy that never loads. They are
   checked for existence and for import use, not for version compatibility — a pi release that
   renames a field is caught by a real run, not by npm.
3. `package.json` version == top `CHANGELOG.md` entry == README roadmap `(this)` line;
   `test/version.test.mjs` checks exactly this and fails otherwise.
4. Wire version unchanged, or its bump documented in `docs/schema.md` §10 and reflected in
   `SCHEMA_VERSION`, the JSON schema `const`, and the protocol heading. `schemaVersion = 1`
   is frozen for the first release: `test/schema-freeze.test.mjs` compares the machine schema
   with `test/fixtures/schema-freeze-v1.json` and fails on any added or removed field,
   required flag or event type. Adding to the wire is therefore a wire-version decision —
   bump the version and update the snapshot in the same commit; a plain patch cannot.
5. `git tag -a v<package version> -m "..."`, then push the tag to **both** remotes
   (`git push origin v<package version>` and `git push gitee v<package version>`) so the
   mirror cannot drift. The tag name is the version in `package.json`, never a literal you
   typed from memory — that is how a tag lands on the wrong commit.
6. npm publication (when credentials exist) happens **after** the tag and **from the tagged
   commit**, so `npm pack` of the published version produces the same tree the tag points at.
   If a doc fix lands after the tag and before the first publish, re-point the tag to the fixed
   commit (delete the old tag locally and on both remotes, cut it again) rather than publishing
   a tree the tag does not describe — then run the clean-install probe on that artifact, and
   verify from the registry (`npm view pi-workfeed versions`, `dist-tags.latest`) once it is out.

## What enforces this

`test/version.test.mjs` reads the four declarations and compares them:

- `package.json` version
- first `## [x.y.z]` heading in `CHANGELOG.md`
- the roadmap's `vX.Y.Z (this)` line in `README.md`
- `SCHEMA_VERSION` in the producer vs `properties.v.const` in the JSON schema

It also looks at git, three times. If `HEAD` is tagged, the tag must be `v<package version>`.
Every tag must name the version inside **its own commit** (`dev/0.4.6` must contain `0.4.6`).
And no release tag may claim a version above `package.json` — development milestones therefore
live under `dev/` (`dev/0.3.1`, `dev/0.4.0` … `dev/0.4.6`), because a `v0.4.6` tag beside an
npm `0.1.0` reads as "the latest version is 0.4.6" and contradicts the package a reader just
installed. The two rules together are what makes a number-line reset safe *and* visible: the
per-commit rule keeps an old tag honest about its own tree, and the ceiling rule keeps the
release line the only `v*` line.

Nothing here is a substitute for the checklist: the test catches text drifting apart, not a
release that skipped its own evidence.
