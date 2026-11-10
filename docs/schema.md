# Workfeed wire format v1 — protocol specification

**Status:** normative for `schemaVersion = 1`, shipped with `pi-workfeed` 0.2.x.
**Machine-readable form:** [`../schemas/workfeed-event-v1.schema.json`](../schemas/workfeed-event-v1.schema.json).

This is a protocol, not a feature tour. If you write a consumer (an analyzer, an importer,
another agent), the tables below are what you may rely on; anything not stated here is
implementation detail and may change without a version bump. Terms **MUST / SHOULD / MAY**
are used in their RFC 2119 sense.

A producer that violates an invariant in §5 is buggy, and the correct consumer behaviour is
to detect it (see §11), not to silently average it away.

## 1. Transport and file layout

```text
${PI_WORKFEED_DIR:-~/.pi/agent/logs}/<YYYY-MM-DD>/
├── workfeed-<sid>.jsonl         # truth: append-only event stream
└── workfeed-<sid>.digest.md     # derived: a projection of the .jsonl, delete-safe
```

- One session owns **exactly one** `.jsonl` file. `<YYYY-MM-DD>` is the day the session
  first logged; a session resumed after midnight keeps appending to its original file
  instead of starting a second one, so a consumer looking for a session SHOULD search all
  date directories for `workfeed-<sid>.jsonl` rather than assume today's directory.
- Files are created with mode `0600` inside a `0700` directory (POSIX; Windows applies them
  only partially). Treat the directory as sensitive regardless — see §7.
- `workfeed-<sid>.digest.md` is **derived data**. Deleting it MUST be safe (see §9).

## 2. Line grammar

- Encoding UTF-8, no BOM. One JSON object per line, terminated by `\n`. No pretty-printing,
  no comments, no multi-line objects.
- **Append-only.** Existing bytes are never rewritten, reordered or truncated by the producer.
  Ordering is by `ts` (non-decreasing); equal `ts` values are permitted and their relative
  order is meaningful (a `tool` `start` precedes its `end`).
- A **torn final line** is the expected artifact of a killed process. A parser MUST ignore
  a final line that does not parse, and MUST NOT treat it as corruption of earlier lines.
- **Corruption before the tail is not "recovered"; it is damage.** A parser MUST report
  unparsable lines by number, MUST NOT present its aggregates as complete, and MUST NOT
  silently continue as if the file were whole. The producer's own reader reports
  `corrupt`, `badEnvelope` and `unknown` as three distinct classes (`parseLogDetailed`
  in `extensions/journal/replay.ts`); a consumer SHOULD do the same rather than collapsing
  everything into "skipped".
- An **envelope violation** (unexpected `v`, missing or mistyped `ts`/`sid`/`task`/`t`) is
  a producer bug: reject the line, report it with a reason.
- An **unknown `t`** is normal forward compatibility: keep the line, label it, and do not
  let it contribute to any aggregate you do not understand.
- A parser MUST skip lines whose `v` is not `1` **or** unknown, rather than guessing their
  meaning.
- Unknown keys MUST be tolerated (forward compatibility). Absent keys MUST be treated as
  "not recorded", never as a default value.

## 3. Envelope (every line)

| Field | Type | Req | Constraints |
|---|---|---|---|
| `v` | integer | yes | exactly `1` for this document |
| `ts` | integer | yes | epoch milliseconds, non-decreasing within a file |
| `sid` | string | yes | non-empty session id, constant within a file |
| `task` | integer | yes | ≥ `0`; `0` only before the first user prompt; **non-decreasing**, incremented once per user prompt |
| `item` | integer | no | ≥ `1`; id of the work item that was `in_progress`; absent when none |
| `t` | string | yes | one of the event types in §4 |

`task` and `item` are the **join keys**. Their guarantees:

- `task` is assigned per session and **survives process restarts**: a producer MUST continue
  from the highest `task` already present in its file (§5, I1). Two lines with the same
  `sid` and `task` and different prompts is a protocol violation.
- `item` ids are **unique within a session**: never reused after `clear` (§5, I2). Two items
  with the same id in one session is a violation.
- **The source of `item` is replaceable.** The wire format says "the work item that was
  in_progress", not "the id of `workfeed_todo`": by default the todo extension supplies it,
  but a planner, an external issue list, or another extension may supply the same ids as
  long as they are unique per session and stable while the item exists. Consumers MUST treat
  `item` as an opaque id and MUST NOT assume the producing tool. `todo` snapshots are then
  just that source's state, which is why the digest treats them as evidence rather than as
  the definition of work.
- A `tool` `end` line **repeats the attribution captured at `start`**, not the state at
  finish (§5, I3). A consumer MUST use each line's own `item`; pairing `start`/`end` by
  timestamp to infer attribution is wrong by design.
- Item identity is **positional, not semantic**: the producer matches items by their `text`.
  Reword an item and it becomes a new id with fresh timing. Do not assume two equal texts
  across sessions are the same work.

### Scope of the join keys: session-local, not business ids

`task` and `item` are counters inside one `sid`. They are sufficient to join everything
inside one session and **insufficient** to compare sessions:

| Key | Scope | Stable across | Not stable across |
|---|---|---|---|
| `sid` | one session | restarts of the same session (same file) | `/new`, fork, compaction into a new session |
| `task` | one `sid` | process restarts (producer resumes the counter) | sessions — `task 3` in two sessions are unrelated |
| `item` | one `sid` | `clear` (ids are never reused) | sessions, and reworded items within a session |

Therefore a cross-session key MUST be built as `(sid, task)` or `(sid, task, item)`; a
consumer MUST NOT compare `task`/`item` values across files and infer that the same work
happened. Aggregating across sessions is allowed only over *dimensions* (tool names,
durations, failure rates), never over these ids directly.

v1 deliberately ships **no** globally unique task or item id: a stable id would have to be
assigned by the model (or a planner) rather than derived from a position, and inventing one
inside the producer would silently change the meaning of `task`. If a future version adds
`tid` / `iid`, those fields are additive and the positional keys above keep their meaning.

## 4. Event catalog

Field tables list **extra** fields only; the envelope of §3 is implied. "Req" = required
(MUST be present); "opt" = MAY be absent. `—` in `phase` means the event has no phase.

### `session`

Emitted on `session_start` (startup, resume, `/new`, fork).

| Field | Type | Req | Notes |
|---|---|---|---|
| `reason` | string | opt | producer-supplied reason (`startup`, `resume`, …) |
| `cwd` | string | opt | working directory; last path segment only when content is off (§7) |
| `sessionFile` | string | opt | pi session file; basename only when content is off |
| `model` | string | opt | model id at that moment |
| `provider` | string | opt | provider id |
| `pid` | integer | opt | process that wrote the line — distinguishes the runs of one file |

A file MAY contain several `session` lines (one per process). Consumers MUST NOT treat a
second `session` line as a new session: `sid` is the session identity.

### `prompt`

| Field | Type | Req | Notes |
|---|---|---|---|
| `chars` | integer | yes | length of the prompt, always recorded |
| `text` | string | opt | ≤3000 chars, scrubbed; omitted when content is off |
| `model` | string | opt | model that will serve this task |
| `thinking` | string | opt | thinking level |

Written only for **user** prompts. A tool-injected or compaction turn produces no `prompt`
line and no `settle` line.

### `agent_start`

No extra fields. Marks the agent loop beginning after a `prompt`.

### `turn`

| `phase` | Field | Type | Req | Notes |
|---|---|---|---|---|
| `start` | `turn` | integer | yes | 1-based index within the task |
| `start` | `model` | string | opt | model serving this turn |
| `end` | `turn` | integer | yes | same index as its `start` |
| `end` | `durMs` | integer | opt | `turn_start`→`turn_end` wall clock |
| `end` | `outcome` | string | opt | producer-supplied outcome token |
| `end` | `stopReason` | string | opt | provider stop reason |
| `end` | `usage` | object | opt | raw provider usage, passed through (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`…) |
| `end` | `tools` | integer | opt | tool calls executed in this turn |

`usage` is the provider's own object and MUST be treated as producer-specific; use
`settle.tokens` for normalized numbers (§8).

### `tool`

| `phase` | Field | Type | Req | Notes |
|---|---|---|---|---|
| `start` | `id` | string | yes | call id; correlates with the `end` line |
| `start` | `name` | string | yes | tool name |
| `start` | `parent` | string | opt | parent call id for nested calls |
| `start` | `args` | object | opt | policy-shaped (§7); may be `{keys,stringBytes}` in `shape` mode |
| `end` | `id` | string | yes | same id as its `start` |
| `end` | `name` | string | yes | tool name |
| `end` | `durMs` | integer | opt | monotonic `execute()` duration — trust this one (§8) |
| `end` | `wallMs` | integer | opt | `start`→`end` wall clock, includes scheduling |
| `end` | `isError` | boolean | yes | whether the call failed |
| `end` | `exitCode` | integer | opt | process exit code when the tool reports one |
| `end` | `truncated` | boolean | opt | producer-side truncation of the output |
| `end` | `outBytes` | integer | opt | true output size in bytes, before excerpting |
| `end` | `out` | string | opt | excerpt (≤`PI_WORKFEED_EXCERPT`), scrubbed; omitted when content is off |

Invariant I4: within a file, each `id` has **at most one** `start` and **at most one** `end`,
and an `end` NEVER precedes its `start`. An `id` with a `start` and no `end` is legal — the
process died (§12).

### `todo`

Full snapshot of the list, written **only when the list changes** (identical snapshots are
deduplicated by the producer, and by the journal as a defence in depth).

| Field | Type | Req | Notes |
|---|---|---|---|
| `rev` | integer | opt | monotonic snapshot counter within the session |
| `items` | array | yes | ordered list, `[]` = emptied |

Each entry:

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | integer | yes | ≥1, unique within the session |
| `status` | string | yes | `pending` \| `in_progress` \| `completed` |
| `elapsedMs` | integer | yes | accumulated completed in-progress time |
| `text` | string | opt | ≤120 chars, scrubbed; omitted when content is off |
| `textChars` | integer | opt | length of `text`, present **instead of** `text` when content is off |

**Snapshots replace, ids accumulate.** Each `todo` line is the full current list, so the
*last* line is the current state — but ids are unique per session (§3, I2), which means a
consumer SHOULD accumulate items by id instead of keeping only the last snapshot. Taking
only the last one loses the timing of items that no longer exist but that `tool` lines still
reference: after a `clear`, the item table would read "none" while slowest-calls still
cites `item 1`. The digest therefore merges snapshots and marks vanished items as dropped,
keeping their `elapsedMs` (§8, I8: absence is not zero).

`rev` MUST be non-decreasing. A consumer reading the last `todo` line gets the current list;
a consumer reconstructing item timing SHOULD process snapshots in order and treat
`elapsedMs` as authoritative (it is the producer's accumulated number, not a reconstruction).

### `user_bash`

A command run by the user outside the agent loop.

| Field | Type | Req | Notes |
|---|---|---|---|
| `chars` | integer | yes | always recorded |
| `command` | string | opt | ≤4000 chars, scrubbed; omitted when content is off |

### `provider`

Only written for HTTP status ≥ 400.

| Field | Type | Req | Notes |
|---|---|---|---|
| `status` | integer | yes | HTTP status |
| `requestId` | string | opt | provider request id, when exposed |

### `compact` / `compact_failed`

| `t` | Field | Type | Req | Notes |
|---|---|---|---|---|
| `compact` | `reason` | string | opt | why compaction ran |
| `compact` | `before` | integer | opt | messages before |
| `compact` | `after` | integer | opt | messages after |
| `compact_failed` | `reason` | string | opt | why it ran |
| `compact_failed` | `error` | string | opt | error message |

### `settle`

Closes one task. Written **only** when a user prompt opened a task (no prompt ⇒ no settle;
this is what keeps "duration 0 with the previous task's counters" from existing).

| Field | Type | Req | Notes |
|---|---|---|---|
| `taskMs` | integer | yes | `prompt`→`agent_settled` wall clock |
| `aborted` | boolean | yes | whether the turn was aborted |
| `turns` | integer | yes | turns in this task |
| `tools` | integer | yes | tool calls in this task |
| `tokens` | object | yes | normalized buckets, next table |

`tokens`:

| Field | Type | Req | Notes |
|---|---|---|---|
| `input` | integer | yes | prompt tokens |
| `output` | integer | yes | completion tokens |
| `cacheRead` | integer | yes | cache-hit tokens (0 when unreported) |
| `cacheWrite` | integer | yes | cache-write tokens (0 when unreported) |
| `total` | integer | yes | reported total **when positive**, otherwise `input+output+cacheRead+cacheWrite`; self-hosted endpoints that omit or send `0` are normalized here |

### `shutdown`

| Field | Type | Req | Notes |
|---|---|---|---|
| `reason` | string | opt | why the process ended |
| `turns` | integer | opt | counters of **that process** |
| `tools` | integer | opt | counters of that process |
| `tasks` | integer | opt | settled tasks seen by that process |
| `lastTaskMs` | integer | opt | last task duration seen by that process |

These are process-local counters and MUST NOT be used as session aggregates (§9).

## 5. Invariants

1. **I1 — task continues.** `task` is non-decreasing per file and continues from the
   maximum already present. A resumed process MUST replay the existing log before assigning
   the next task index.
2. **I2 — item ids unique per session.** Never reused, including after `clear`.
3. **I3 — attribution frozen.** `tool` `end` carries the `task`/`item` of its `start`.
4. **I4 — one start, one end per call id**, in that order; a `start` may have no `end`.
5. **I5 — todo only on change**, `rev` non-decreasing.
6. **I6 — single writer.** One process appends to a file at a time.
7. **I7 — digest is a pure projection.** `parse → aggregate → buildDigest`, no process
   memory, no retention cap, deterministic bytes.
8. **I8 — absence is not zero.** A missing field means "not recorded"; `0` means measured
   zero. Consumers MUST NOT conflate them.

## 6. Nullability and absence

- Optional fields are **omitted** when unrecorded; the producer does not emit `null`.
- Numbers are integers in milliseconds, tokens or bytes; they are never floats, never
  strings. A consumer MUST tolerate an unexpected `null` defensively (and treat it as
  "not recorded"), but a producer MUST NOT send one.
- Booleans are JSON booleans (`true` / `false`), not `0` / `1`.
- `item` absent means "no item was in progress". `item: 0` is not a valid value.

## 7. Privacy channels

Collection is a policy with an owner per channel. A metadata-only log contains no free text.

| Channel | Default | `PI_WORKFEED_CONTENT=0` | Owner |
|---|---|---|---|
| `t`, `ts`, `sid`, `task`, `item` | kept | kept | fixed |
| tool `name`, `durMs`, `wallMs`, `isError`, `exitCode`, `outBytes` | kept | kept | fixed |
| `usage` / `tokens` / `turn` counters | kept | kept | fixed |
| `todo` `id`, `status`, `elapsedMs`, `rev` | kept | kept | fixed |
| `tool` `args` for built-in tools (`command`, `pattern`, `path`) | kept, clipped 2000, scrubbed | omitted (`args` = shape) | `PI_WORKFEED_ARGS` |
| `tool` `args` for unknown tools (MCP, other extensions) | JSON, clipped 1200, **every string scrubbed** | omitted (`args` = shape) | `PI_WORKFEED_ARGS` |
| `prompt` `text` | kept ≤3000, scrubbed | omitted (`chars` only) | `PI_WORKFEED_CONTENT` |
| `tool` `out` | kept ≤`PI_WORKFEED_EXCERPT`, scrubbed | omitted (`outBytes` only) | `PI_WORKFEED_CONTENT` / `PI_WORKFEED_EXCERPT` |
| `write` / `edit` body | never — byte counts only | never | fixed |
| `cwd`, `sessionFile`, `args.path` | full | last path segment, `<…>/name` | `PI_WORKFEED_CONTENT` |
| `todo` `items[].text` | kept ≤120, scrubbed | omitted (`textChars` only) | `PI_WORKFEED_CONTENT` |
| `user_bash` `command` | kept ≤4000, scrubbed | omitted (`chars` only) | `PI_WORKFEED_CONTENT` |

`PI_WORKFEED_ARGS` ∈ {`full`, `redacted`, `shape`, `off`}; default `shape` when
`PI_WORKFEED_CONTENT=0`, else `redacted`. `shape` records `{keys, stringBytes}` — which
arguments existed and how large, never values. `off` omits `args` entirely.

Argument values are scrubbed in **every** mode, including `full` and the fallback branch for
unrecognized tools. Recognized shapes: `--token …`, `Authorization:` / `Bearer`,
`API_KEY=` / `PASSWORD=` / `DATABASE_URL=` style assignments, `sk-…` / `ghp_…` / `AKIA…`,
JWTs, inline PEM private keys, `curl -u u:p`, `scheme://user:password@host`.

**Best effort, not a guarantee.** A secret shaped like an ordinary word survives. Do not
treat a log as credential-free because it went through the scrubber.

Files `0600`, directories `0700` (POSIX; Windows honour them partially). Even metadata tells
which tools ran on which files for how long.

## 8. Measurement definitions

Definitions are normative: a consumer computing a different number MUST name it differently.

| Measurement | Definition | Source |
|---|---|---|
| **Task duration** | wall clock, user prompt → `agent_settled`; includes model latency, tool time and queueing | `settle.taskMs` |
| **Turn duration** | `turn_start` → `turn_end`: one model request plus its tool execution | `turn.end.durMs` |
| **Tool duration** | monotonic `execute()` duration reported by pi; the number to trust for "this command was slow" | `tool.end.durMs` |
| **Tool wall time** | `start`→`end` including scheduling and streaming; an upper bound only | `tool.end.wallMs` |
| **Item duration** | accumulated `in_progress` time; counts model and tool time alike; cannot separate agent work from a human leaving the terminal | `todo.items[].elapsedMs` |
| **Tokens** | normalized bucket from `usage`; `total` falls back to the sum of parts when the provider omits it or sends `0` | `settle.tokens` |
| **Digest wall clock** | sum of `settle.taskMs`, so concurrent/serialised tasks are not double-counted as one span | digest `## tasks` header |
| **Cost** | **not recorded.** A self-hosted OpenAI-compatible endpoint reports `cost: 0`, and a wrong number is worse than no number. Price tokens yourself. | — |

## 9. Digest contract

The digest is a projection of the log: `parse → aggregate → buildDigest`
(`extensions/journal/replay.ts`, no pi API, no I/O beyond the read).

- **No dependence on the collector.** Every line on disk is rendered, not just the part the
  current process witnessed.
- **No retention cap.** 250 tasks and 2 100 calls are counted exactly.
- **Deterministic.** Header timestamp is the last event's `ts`, so the same file yields
  byte-identical bytes; digests can be diffed or checksummed.
- **Deletable.** `rebuildDigest(path)` restores it offline, with no pi process involved.
- **States its own coverage.** `## data quality` reports finished calls, `start` lines with
  no matching `end`, item-attribution ratio, tasks with a non-zero token total, and a
  **log integrity** line: lines read, lines dropped (unparsable / envelope violations with
  the line number), a torn tail when there was one, and unknown event types. A low
  attribution ratio or a damaged file is a fact about the data, not something to hide.
- **Section sources.** `settle` → task table; `tool` `phase:"end"` → tool rollup and
  slowest/last-failure lists; the last `todo` → item table; `session` / `prompt` → model,
  provider, cwd. Counters inside `shutdown` lines are **not** digest sources.
- The digest is Markdown for a model to read, not a data format. Consumers wanting numbers
  MUST read the JSONL; the digest may be stale by one task.

## 10. Versioning and compatibility

- `v` is the **wire** version. It changes only for a breaking change: removing or renaming a
  field, changing a field's type or meaning, changing an invariant's guarantee.
- **Additive** fields do not bump `v`: consumers tolerate unknown keys.
- A producer MUST NOT reuse a field name for a different meaning within `v = 1`.
- Consumers MUST reject unknown `v` values (§2) rather than best-effort parse them.
- The wire version is only **one of three independent axes**. It does not follow the npm
  package version, and neither follows a git tag: see `docs/versioning.md` for how the three
  relate, when each moves, and the release checklist that keeps them from drifting apart.

## 11. Consumer checklist

If you build a parser or an analyzer, verify these in this order — each one is a real
failure mode, not a hypothetical:

1. Skip the torn last line; do not abort the file.
2. **Report any other unparsable line by number**, and say your aggregates cover only the
   readable part. Distinguish unparsable, envelope-violating and unknown-type lines —
   three different failures, three different responses.
3. Reject lines with unknown `v`; label unknown `t`; ignore unknown keys.
4. Use each line's own `task`/`item`; never reconstruct attribution from timestamps.
5. Treat a missing field as "not recorded"; do not substitute `0`.
6. Count `start` lines without `end` and report them; do not average them into tool time.
7. Use `durMs` for tool latency; `wallMs` only as an upper bound.
8. Confirm `task` is non-decreasing; a duplicate `task` after a `prompt` means the producer
   lost its counter — report it.
9. Confirm `item` ids are unique; a reused id means two lists were conflated — report it.
10. Use `settle.tokens.total` as-is (already normalized); do not re-derive a "better" total.
11. Never use `shutdown` counters as session totals.
12. Never compare `task`/`item` values across sessions; see the scope table in §3.

## 12. Known gaps

- **No `end` line ⇒ not in the tool table.** A crashed or killed call has a `start` and
  nothing else. The digest reports the count in `## data quality`; a consumer doing its own
  analysis must count `phase:"start"` versus `phase:"end"`.
- **Filename vs directory.** A session that spans midnight lives in the day it *started*;
  tools that only glob today's directory will miss it.
- **No schema-level validation in the producer.** Fields are written by hand in TypeScript;
  `schemas/workfeed-event-v1.schema.json` is normative for consumers, and the test suite
  validates shipped fixtures against it, but a producer-side regression is caught by tests
  only.
- **`usage` is passthrough.** Its keys are provider-specific; only `settle.tokens` is normalized.
- **No cross-session identity.** `task`/`item` are counters, not business ids (§3). Cross-session
  analysis is limited to dimensions until a future version adds explicit ids.
- **Integrity is reported, not repaired.** A damaged line is named in the digest and the CLI
  exits 2; nothing rewrites the log. Repairing truth is out of scope on purpose.
