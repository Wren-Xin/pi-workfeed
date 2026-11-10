# Changelog

## [0.4.4] - 2026-11-10

Every suite passed while two event handlers read fields pi does not emit. The stubs were
written from this project's own description of pi's interface, so they agreed with the
handlers and never with pi. A real session (pi 1.5.0, RPC mode, real tools, real
compaction) was run to settle it — and it found the drift immediately.

- **`compact_failed` logged no reason on real pi.** The handler read `event.error`; the
  field is `errorMessage`, with `aborted` and `willRetry` alongside it. A real failure
  ("Nothing to compact (session too small)") produced a row with nothing in it.
- **`compact` logged no counts on real pi.** The handler read `messagesBefore` /
  `messagesAfter`; pi reports a `CompactionEntry` whose `tokensBefore` is the only count
  it exposes. There is no "after" count, and the protocol no longer pretends there is.
- **The digest now reports compaction.** A failed or aborted compaction changes no task
  or tool row, so a digest that ignored it read as if the context had been reduced. Data
  quality gains one line, printed only when compaction happened — no fabricated zero:
  `- compaction: 1 completed, 0 failed — last: …`.
- **`test/compaction.test.mjs`** drives the handlers with pi's documented payloads
  (`compactionEntry.tokensBefore`, `errorMessage`, `aborted`) and asserts the fields reach
  the log and the digest. `test/digest-evidence.test.mjs` gains the third evidence case
  (a failed compaction is reported, and a session without compaction grows no line).
- **`docs/verification.md`**: what a real run covered, the eleven steps with their
  observed output, the two defects only it could find, the measured (not promised)
  `item attribution` ratio, and the platform matrix — Windows verified, Linux not yet
  recorded, macOS not verified for lack of Apple hardware (please open an issue).

Verified on a real session after the fix: `compact` with `before: 24604`, digest line
`compaction: 1 completed, 0 failed`, the todo list still attributable after compaction; and
the abort branch reporting pi's own message.

## [0.4.3] - 2026-11-10

The protocol is described twice: prose tables in `docs/schema.md` that a reader builds a
consumer from, and `schemas/workfeed-event-v1.schema.json` that a validator runs. Nothing
compared them, so the machine form could omit a field the prose promised, or demand one the
prose called optional, and only a human diff would notice.

The diff found three real gaps in the machine form — all on the side a program trusts:

- `session` declared no properties at all, so `reason`/`cwd`/`sessionFile`/`model`/
  `provider`/`pid` existed only in prose.
- `tool` required `isError` in prose for `phase:"end"` only; the schema had no
  phase-conditional requirement, so it accepted an `end` line that omitted it.
- `turn` had the same shape of omission for its `end` phase.

The schema now states both conditionals with `if/then`, and the reconciliation test fails if
either side moves:

- **`test/schema-docs.test.mjs`** derives the contract twice — field names and `yes`/`opt`
  from §4's tables (including their per-`phase` and per-`t` grouping columns), properties
  and `required` from the `oneOf` branches — and compares `{fields, required}` per event
  type and per phase. Nested objects (`todo.items[]`, `settle.tokens`) are compared the
  same way, and the §3 envelope table is checked against the top-level `properties` /
  `required`.
- It is proven to catch drift, not just to pass: dropping `parent` from the schema and
  clearing the `end` requirement for `isError` both fail with the exact field named
  (negative probe, schema restored byte-identical afterwards).

Also corrected in the same pass: `docs/schema.md` §12 still said "the CLI exits 2" (there
is no CLI since 0.4.0), and two comments in `replay.ts` plus one line in the analysis skill
still credited an "analyzer exit code 2".

## [0.4.2] - 2026-11-10

Three docs and two comments still described the package the way it was two releases ago.
None of it broke behaviour — it broke meaning, which is worse to debug later.

- `docs/schema.md` said the protocol shipped with `pi-workfeed` 0.2.x. A normative status line
  pinned to a package line expires silently on the next release. It now names only
  `schemaVersion = 1` and points at the three-axis policy.
- `docs/versioning.md` asked the pack step to check that `bin` was included (removed in
  0.4.0), and its release commands were literals `v0.3.1`, which is how a tag lands on the
  wrong commit. Now: `schemas/`, `docs/`, `skills/` in the checklist with a note that there is
  no `bin/`, and `v<package version>` in the commands.
- `item` was still "the todo id" in `replay.ts`, in the event-shape comment of `index.ts`, in
  the JSON schema `description`, and in the skill's drill-down line. The protocol defines it
  as a **source-neutral work-item id**; the machine schema said something else, which is
  exactly what a consumer reads. All four now agree.

New `test/docs-consistency.test.mjs` keeps this class closed rather than fixing it once:

- no file under `docs/` or `skills/` may pin the protocol to a package line
- no doc may advertise the removed surface (`npx pi-workfeed`, `bin/workfeed-digest`,
  `--strict/--quiet/--out`, a pack step expecting `bin/`)
- `schemas/`, `extensions/`, `docs/schema.md` and the skill must describe `item` as a work
  item; a redefinition as "the todo id" fails
- the machine schema's `item` description must say source-neutral
- the protocol's status line must name `schemaVersion` and no package version

## [0.4.1] - 2026-11-10

README and code are now checked against each other, because the README is install
documentation and a stale one sends readers to a command that does not exist.

The v0.4.0 pass had already removed the CLI section, the `npx` usage and the roadmap marker.
Two things remained: the `## No CLI` paragraph opened with "There is no `workfeed-digest`
command", which contradicts the `/workfeed-digest` **slash command** documented 100 lines
earlier and still registered by the extension; and nothing prevented that class of drift from
recurring.

- The paragraph now distinguishes an **executable** (npm `bin`, `npx` target, flags, exit
  codes — gone) from the **pi slash command** (`/workfeed-digest` — kept, handled in-process).
  Same for the command list, which is labelled as slash commands rather than shell commands.
- New `test/readme.test.mjs` treats the README as a claim set and the source as the truth:
  every `` `/command` `` mentioned must be registered by an extension (with an explicit allow
  list for pi's own `/reload`, `/compact`, `/fork`, `/tree`), every registered command must be
  documented, and the README may not advertise a removed surface (`npx pi-workfeed`,
  `bin/workfeed-digest`, `--strict|--quiet|--out`, `## Offline analyzer`). It also asserts one
  roadmap bullet carries `(this)` and that it names the shipped version, and that install
  instructions use `pi install` rather than a global npm install.

## [0.4.0] - 2026-11-10

The digest stops losing evidence it already recorded, and the CLI is removed by decision.

**Two cases where the summary contradicted its own log** (protocol I8: absence is not zero):

- *Cleared list erased item timing.* `aggregate()` kept only the last `todo` snapshot, and
  `clear` writes an empty one — so the digest printed `## todo items (0) _none_` while
  `slowest calls` still cited `· item 1`. Item timing is the feature's point. Snapshots are
  now merged by id (ids are session-unique, I2), and an item that vanishes is marked
  `dropped` with its `elapsedMs` kept: the table says `1 dropped from the list (timing
  kept)` and the row reads `in_progress · dropped`.
- *Killed tasks vanished.* Tasks were only pushed on `settle`, so a task with a `prompt` and
  no `settle` (killed, crashed, still running) disappeared — one row, nothing in data
  quality — while its tool calls stayed in the rollup, making totals exceed the listed
  tasks with no explanation. `aggregate()` now counts prompts, and the digest states
  `task coverage: K/N prompts have a settle — M were killed or are still open, so their
  duration and tokens are unknown, not zero`.

**CLI removed, and that is the decision.** `bin/workfeed-digest.mjs`, the `bin` field and the
`files[]` entry are gone; README's `## Offline analyzer` is replaced by `## No CLI, on
purpose`, which records the reasoning: the consumer is the model, a CLI is a second consumer
surface that drifts from the digest contract, and everything it did is one call away —
`rebuildDigest(path)` / `replayLog(path)` returning `{ text, integrity }`. Offline analysis is
a library, not a command. Protocol §9 and §12 no longer reference it.

**Skill contract.** `skills/workfeed-analysis/SKILL.md` now opens with "Read
`## data quality` first — it decides how strong your claims may be": each quality line is
mapped to the wording it licenses (attribution share → hedge per-item claims; task coverage →
never sum unsettled tasks; cut-off calls → figures are a lower bound; damage → report before
analysing), plus denominator discipline. It also states that `dropped` items remain evidence
of work that happened.

**Portability.** `test/item-ids.test.mjs` imported the todo extension, which imports pi's host
packages — so a fresh clone failed one of eight. The suite now registers a loader hook
(`test/stubs/pi-loader.mjs`) mapping `@earendil-works/*` and `typebox` to local stubs, so
`npm test` runs with no install step. Added `.github/workflows/test.yml` (node 22, `npm test`
+ `npm pack --dry-run`), because there was no CI at all.

**`item` is source-neutral.** The schema defined `item` as "the id of the todo item"; it is now
"the id of the work item that was in_progress" — unique per session, stable while the item
exists, but the *source* (todo extension, planner, external list) is replaceable, and consumers
must treat the id as opaque.

## [0.3.1] - 2026-11-10

Versioning: three axes, stated once and checked, instead of three implied ones.

The repository had a correct `package.json` but no git tags, so "which commit is a
release?" had no answer. The three numbers are now defined as independent axes in
`docs/versioning.md`:

- **wire version** — `v` on every event, `SCHEMA_VERSION`, the JSON schema `const`, and the
  heading of `docs/schema.md`. Moves only for a breaking format change.
- **package version** — `package.json`, the README roadmap's `(this)` line, the top
  CHANGELOG entry. Moves for anything installable: patch for docs/tests/policy, minor for a
  new capability, major for a breaking tool contract.
- **source version** — annotated tag `v<package version>` on the commit that carries that
  `package.json`. Cut deliberately, never moved, never ahead of the code.

The doc also fixes the release checklist (tests green, pack list checked, three declarations
agree, wire bump documented, tag pushed to both remotes, npm after the tag) and states the
obvious consequences people get wrong: a patch release still ships wire `v: 1`, wire `2`
forces at least a package minor, and `main` may run ahead of the last tag with docs-only
commits.

- New `test/version.test.mjs` compares `package.json` / CHANGELOG / README roadmap /
  `SCHEMA_VERSION` / JSON schema `const` / `docs/schema.md` heading, checks that the shipped
  `files[]` includes `docs` and `schemas`, and inspects git: a tagged `HEAD` must equal
  `v<version>`, and the newest tag may never name a version higher than `package.json`.
  Untagged `HEAD` is allowed — it is the normal state between releases, and the test says so
  instead of failing.
- README gained a `## Versioning` section; `docs/schema.md` §10 now points at the policy
  rather than implying the wire version tracks the package.
- First release tag cut: `v0.3.1`, pushed to both remotes.

## [0.3.0] - 2026-11-10

Integrity: a damaged log is now reported, never silently skimmed.

- `parseLog` used to skip any unparsable line, anywhere in the file, and return only the
  survivors. A digest could look complete while facts were missing from the middle.
  `parseLogDetailed` now separates four outcomes: a **torn tail** (expected artifact of a
  killed append, line number reported), **corruption in the middle** (damage, lines
  reported by number), an **envelope violation** (unexpected `v`, missing or mistyped
  `ts`/`sid`/`task`/`t` — rejected with a reason), and an **unknown event type**
  (kept, labelled, ignored by aggregates).
- `parseLog` stays as the events-only view so existing callers are unaffected;
  `replayLog(path)` returns `{ text, integrity }`, `hasDamage()` and
  `describeIntegrity()` give the verdict in one line.
- The digest's `## data quality` gained `log integrity` (lines read / dropped, torn tail,
  rejected lines with reasons, unknown types), so a reader who only sees the Markdown still
  knows the file was damaged. Formatting is deterministic, so the golden file changed.
- `bin/workfeed-digest.mjs` now exits `2` on a damaged log, `1` when nothing parsed, and
  `--strict` also fails on unknown event types. A torn tail alone stays `0`: that is
  expected, not damage.
- New `test/integrity.test.mjs` covers all four classes plus the CLI exit codes. It
  asserts that a clean-looking digest is impossible when the middle of the file is broken.
- `docs/schema.md`: §2 now states that corruption before the tail is damage that MUST be
  reported, distinguishes the three failure classes, and the consumer checklist gained the
  corresponding step. A new §3 subsection fixes the **scope of the join keys** as
  session-local: cross-session keys must be `(sid, task)` / `(sid, task, item)`, and v1
  deliberately ships no global task/item ids.

## [0.2.1] - 2026-11-10

Docs: `schema.md` becomes the protocol it was being treated as, with a machine-readable
counterpart. The old file read like feature notes — a consumer could not tell which fields
are required, which are optional, or what a parser should do when the log was truncated.

- `docs/schema.md` rewritten as a normative specification: envelope table with constraints
  (`v=1`, `ts` non-decreasing, `task` monotonic, `item ≥ 1`), a field table per event type
  with required/optional markers, enumerations (`phase`, todo `status`), invariants I1–I8
  (task continues, item ids unique, attribution frozen, one start/one end per call,
  todo only on change, single writer, digest purity, absence ≠ zero), line grammar
  (append-only, torn last line must be skipped, unknown `v` rejected, unknown keys
  tolerated), versioning/compatibility rules, and a numbered consumer checklist.
- Field-level gaps that made consumers guess are now explicit: `textChars` as the
  metadata-mode substitute for `text`, the four `PI_WORKFEED_ARGS` modes and what `shape`
  emits, basename-only paths when content is off, `0600`/`0700` file modes, replay as an
  independent module, attribution frozen at `start`, token `total` normalization.
- New `schemas/workfeed-event-v1.schema.json` (JSON Schema draft-07): one branch per event
  type, `oneOf` discriminated by `t`, base envelope required, `additionalProperties: true`
  for forward compatibility.
- New `test/schema.test.mjs`: validates every line of both shipped fixtures against that
  schema, asserts every documented event type has a sample, and re-checks the join-key
  claims (strictly increasing `task` per prompt, unique item ids) on the fixtures. It
  immediately caught a fixture that omitted the required `settle.aborted` field — the test
  can fail, which is the point.
- Measurement table now also defines the digest's wall clock (sum of `settle.taskMs`) and
  states explicitly that cost is not recorded.

## [0.2.0] - 2026-11-10

Join keys and stated measurements: the four keys now actually hold across restarts, clears
and endpoint quirks. Everything below was found by reading the code against what the README
and schema promised.

- **Task numbering survives a restart.** `task` was in-memory and resumed at 1 while the
  log kept appending, so one file could carry two `task: 1` rows. On `session_start` the
  journal now replays the existing log (`resumeState`) and continues from the last task.
- **Item ids are never reused.** `clear` reset `nextId` to 1, so a second list's `#1`
  collided with the first list's `#1` in the same session. The counter now survives `clear`,
  and recovery falls back to max+1 instead of length+1.
- **A session keeps one log across days.** `ensureFiles` pinned the first date directory and
  returned early, so a resume after midnight opened a second file under today's date and the
  digest only covered part of the session. The writer now looks for an existing
  `workfeed-<sid>.jsonl` in any date directory and re-binds when the session id changes
  (`/new`, `/resume` in a live process).
- **Missing token totals fall back to the parts.** `usage.totalTokens ?? usage.total ?? 0`
  cannot rescue a literal `0`, so a self-hosted endpoint reporting no total produced
  `total: 0` and the replay's own fallback never fired. Both the collector and `tokensOf`
  now use the reported value only when positive, else `input + output + cacheRead +
  cacheWrite`.
- **No ghost settles.** `agent_settled` fired for turns that `before_agent_start` had
  skipped (non-user messages), writing a settle with the previous task's counters and a
  duration of 0. Settles are now gated on a task actually being open, and counters reset
  when a task closes.
- **Redaction covers the branch that leaked.** `full` and the unknown-tool fallback
  serialized raw arguments, so every MCP/custom tool bypassed the scrubber entirely. Both
  now redact every string (`redactValue`), and the pattern set grew to cover
  `scheme://user:pass@host`, `AKIA…`, JWTs, `curl -u`, `.env` style assignments and inline
  PEM keys. Logs and digests are written `0600` inside a `0700` directory.
- **The digest reports its own coverage.** New `## data quality` section: finished calls,
  `start` lines with no matching `end`, item-attribution ratio, tasks with a non-zero token
  total. A low attribution ratio is a fact about the data, not something the reader should
  infer.
- **Offline analyzer.** `bin/workfeed-digest.mjs` (installed as `workfeed-digest`) rebuilds
  the digest for any log without pi: `npx pi-workfeed-digest <log.jsonl> [--out digest.md]`.
- **Tests in the repo.** `test/replay.test.mjs` runs fixture JSONL against expected digest
  bytes (`node --experimental-strip-types test/replay.test.mjs`), covering restart numbering,
  token fallback, unfinished calls and attribution coverage. The earlier ad-hoc `wl_*` smoke
  scripts are superseded by this file and are not part of the package.
- **Docs de-drifted.** `schema.md` named `digest-*.md` (the real name is
  `workfeed-<sid>.digest.md`), `digest.ts` pointed at `events.jsonl`, and the roadmap still
  labelled 0.1.4 as current. Also documented: item identity is positional (reworded items
  arrive as new ids), redaction is best effort, and the digest's token definition.

## [0.1.5] - 2026-11-10

Docs: the package now states what it is for, not only what it does.

- New README section **Design philosophy** with three commitments: *Work, not just
  conversations* (a session is a workflow of tasks, items, turns and tool executions);
  *Evidence before interpretation* (raw events are truth, digests are derived, every
  measurement has an explicit definition, "not recorded" beats a guess); *Models as
  observability consumers* (compact verifiable evidence for models to reason about, not
  another human dashboard).
- No code or schema change.

## [0.1.4] - 2026-11-10

Fix: a tool call could be re-attributed to a different todo item mid-flight. `tool` `end`
lines took `item` from the current in_progress todo, so a slow call that started under
item A and finished after the list moved to B was recorded against B, splitting one call
across two work items.

- `tool_call` now stores `task` and `item` with the call's start time; `tool_execution_end`
  writes those back onto the `end` line. Attribution is frozen where the work began.
- Verified with `wl_tool_attribution.mjs`: A→B move mid-call leaves `start item 1`,
  `end item 1`, the moving `todo` line `item 2`, and a subsequent call under B at
  `item 2` — plus the digest's slowest-calls list showing the same split.
- `docs/schema.md` states the rule: a line's own `item` is authoritative, and `tool` `end`
  repeats the start-time pair rather than the moment it finished.

## [0.1.3] - 2026-11-10

Security: `PI_WORKFEED_CONTENT=0` did not cover tool arguments. `slimArgs()` ran
unconditionally, so a metadata-only log still carried bash command lines, grep patterns and
file paths.

- Arguments are now its own channel: `PI_WORKFEED_ARGS` = `full` | `redacted` | `shape` | `off`.
  Default follows content (`shape` when metadata-only, else `redacted`).
- **Metadata-only now covers**: tool arguments (key names + byte counts only), todo text
  (length only), `user_bash` command, `cwd` / `sessionFile` / paths (last segment only,
  `<…>/name`).
- **Credential redaction added in every mode**, including `full`: `--token …`,
  `Authorization: …`, `API_KEY=…`, `sk-…` become `<redacted>` / `<redacted-token>` in
  prompt text, commands, grep patterns, todo text and tool output.
- Collection policy is now documented as a table (README + `docs/schema.md`, channel by
  channel and owner by owner), so "what leaks" is a design decision rather than an audit
  finding.
- `outBytes` is now the true output size; the excerpt is redacted after measuring.

## [0.1.2] - 2026-11-10

Fix: the digest was derived from memory, not from the log. `buildDigest()` was fed the
collector's live `taskList` / `toolRecords` / `todos`, which reset on process restart and
were capped at 200 tasks / 2 000 tool calls. The JSONL was recoverable; the derived
layer was not.

- New pi-free replay layer `extensions/journal/replay.ts`:
  `parseLog() → aggregate() → rebuildDigest()`, i.e. `JSONL → parse → aggregate → digest`.
- `writeDigest()` now always replays the log file. A session reopened after a restart
  renders the whole session, not just this process's share.
- Removed the retention caps from the digest path along with the in-memory aggregates they
  capped — aggregates are computed over the entire file.
- Digest output is deterministic: the header timestamp is the last event's `ts`, so the
  same log always yields byte-identical digest bytes.
- New command `/workfeed-digest` rebuilds on demand; `rebuildDigest(path)` is the offline
  entry point (no pi API imported, no process needed).

## [0.1.1] - 2026-11-10

Fix: the todo journal was inflating. The 2s status ticker republished the whole
list on every repaint, so a session where nothing happened still appended a `todo`
line every 2s — contradicting the schema's "snapshot on change" semantics.

- Publish and repaint are now separate paths. `renderStatus()` (UI, runs every 2s) never
  emits; `publish()` emits only when the list identity actually changes (ids, texts,
  statuses, timing stretches, next id). Startup with an empty list emits nothing.
- Snapshots carry a monotonic `rev`, incremented once per emit.
- The journal drops a repeated snapshot even if something else re-emits it, so duplicates
  cannot reach the log. `todo` lines now record `rev`.
- No API change; `workfeed_todo` semantics, timing and digest are untouched.

## [0.1.0] - 2026-11-10

First cut. Two extensions, one skill, schema v1.

- `workfeed_todo` tool (named to avoid clashing with other todo extensions): whole-list
  write semantics with per-item timing, at most one item in progress, status rolled back to
  pending keeps history. Rebuild accepts results from the older `todo` tool name as well.
- Todo state persisted twice: tool result `details` for branch replay after `/fork` and
  `/tree`, and a `pi.appendEntry` custom entry (`workfeed:todo`) so the list survives
  compaction.
- Event journal as JSONL, one line per event, per-day directory, join keys `v`/`sid`/`task`/`item`.
- Event types: `session`, `prompt`, `agent_start`, `turn(start|end)`, `tool(start|end)`,
  `todo`, `user_bash`, `provider` (HTTP ≥400), `compact`, `compact_failed`, `settle`, `shutdown`.
- Derived digest (`workfeed-<sid>.digest.md`), rewritten on every settle: task table, tool rollup,
  slowest calls, last failures, per-item todo timing with share.
- Privacy switches: `PI_WORKFEED_CONTENT=0` (metadata only), `PI_WORKFEED_EXCERPT`,
  `PI_WORKFEED_OFF`, `PI_WORKFEED_TODO_OFF`, `PI_WORKFEED_DIR`.
- Skill `workfeed-analysis`: measurement definitions and drill-down procedure, so the model
  reads the digest first and filters the JSONL instead of dumping it.
- Commands: `/wf-todos`, `/workfeed`.
