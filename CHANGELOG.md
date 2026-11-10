# Changelog

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
