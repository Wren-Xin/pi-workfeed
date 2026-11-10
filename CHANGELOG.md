# Changelog

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
