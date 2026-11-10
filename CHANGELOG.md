# Changelog

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
