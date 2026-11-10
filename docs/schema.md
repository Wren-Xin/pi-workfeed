# Event schema (v1)

pi-workfeed writes two kinds of files per session, into one directory per day:

```text
${PI_WORKFEED_DIR:-~/.pi/agent/logs}/<YYYY-MM-DD>/
├── workfeed-<sid>.jsonl         truth layer, one event per line, append-only
└── workfeed-<sid>.digest.md    derived layer, rewritten on every settle, delete-safe
```

**Rule: `workfeed-*.jsonl` is the only source of truth. `digest-*.md` is derived.**
Deleting every digest file loses nothing — the numbers are recomputed from the log.
Never hand-edit a digest; never derive facts from one without checking the log when the
answer matters.

## Base fields

Every line carries these keys before the type-specific ones:

| Field | Type | Meaning |
|---|---|---|
| `v` | number | schema version, currently `1` |
| `ts` | number | epoch milliseconds |
| `sid` | string | session id |
| `task` | number | 1-based index of the user instruction this event belongs to (`0` before the first prompt) |
| `item` | number? | id of the todo item that was `in_progress` at that moment; absent when none |
| `t` | string | event type, see below |

`task` and `item` are the join keys. With them, a tool call can be attributed to the
user instruction and the todo item that caused it; without them the data is just a
chronological dump.

## Event types

| `t` | `phase` | Extra fields |
|---|---|---|
| `session` | — | `reason`, `cwd`, `sessionFile`, `model`, `provider`, `pid` |
| `prompt` | — | `chars`, `text` (truncated 3000, omitted when content is off), `model`, `thinking` |
| `agent_start` | — | — |
| `turn` | `start` | `turn`, `model` |
| `turn` | `end` | `turn`, `durMs`, `outcome`, `stopReason`, `usage` (`input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`), `tools` |
| `tool` | `start` | `id`, `name`, `parent`, `args` (slimmed per tool) |
| `tool` | `end` | `id`, `name`, `durMs` (monotonic, `execute()` time), `wallMs` (call→end), `isError`, `exitCode`, `truncated`, `outBytes`, `out` (excerpt, omitted when content is off) |
| `todo` | — | `rev`, `items`: `[{ id, status, elapsedMs, text }]` — full snapshot, written **only when the list changes**; an identical snapshot is never logged (UI repaints and duplicate emitters are dropped) |
| `user_bash` | — | `chars`, `command` (omitted when content is off) |
| `provider` | — | `status` (only written for HTTP ≥ 400), `requestId` |
| `compact` | — | `reason`, `before`, `after` |
| `compact_failed` | — | `reason`, `error` |
| `settle` | — | `taskMs` (prompt→`agent_settled` wall clock), `aborted`, `turns`, `tools`, `tokens` |
| `shutdown` | — | `reason`, `turns`, `tools`, `tasks`, `lastTaskMs` |

### Measurement definitions

Be explicit about these before drawing conclusions:

- **Task duration** = `settle.taskMs` = wall clock from the user prompt to `agent_settled`.
  It includes model latency, tool execution and time spent waiting on the queue.
- **Turn duration** = `turn.end.durMs` = `turn_start` → `turn_end`. One model request plus
  its tool execution.
- **Tool duration** = `tool.end.durMs`, the monotonic `execute()` duration reported by pi.
  This is the number to trust for "this command was slow". `wallMs` additionally carries
  scheduling and streaming overhead, so it is only an upper bound.
- **Item duration** = accumulated `in_progress` time in `todo` snapshots. It counts model
  and tool time alike; it cannot separate agent work from a human leaving the terminal.
- **Tokens** come from the provider's `usage`. **Cost is not recorded**: an
  OpenAI-compatible self-hosted endpoint reports `cost: 0`, and a wrong number is worse
  than no number. Count tokens, price them yourself if you need money.

## Reading a log without wasting context

1. Read `workfeed-<sid>.digest.md` first — it is a few hundred lines at most and holds every
   aggregate you usually need.
2. Only open `workfeed-<sid>.jsonl` when you need a specific event. Filter it, do not dump
   it: `grep '"t":"tool"' workfeed-*.jsonl | grep '"isError":true'`.
3. `digest` lists the slowest calls and last failures with `task` / `item` already attached,
   so a drill-down is a single lookup, not a full scan.

## Privacy

- `PI_WORKFEED_CONTENT=0` records metadata only: no prompt text, no tool output.
  Durations, counts, tokens, exit codes and todo state are still recorded.
- `PI_WORKFEED_EXCERPT` (default `2048`) sets how many bytes of tool output survive;
  `0` keeps none.
- Treat these files as sensitive: prompts and command output frequently contain paths,
  internal hostnames and fragments of credentials.

## Rebuild contract

The JSONL is the only truth; the digest is a projection of it. The projection is
`parse → aggregate → buildDigest` (`extensions/journal/replay.ts`), and it obeys:

- **No dependence on the collector.** A digest never reads the collecting process's
  counters or in-memory lists. Reopening a session after a restart renders every line on
  disk, not just the part the new process witnessed.
- **No retention cap.** Aggregates are computed over the whole file: 250 tasks and 2 100
  tool calls are counted exactly. Caps elsewhere are a UI concern and must never reach the
  digest.
- **Deterministic output.** The digest header timestamp is the last event's `ts`, not
  "now", so the same file yields byte-identical output and digests can be diffed or
  checksummed.
- **Deletable.** Removing every `*.digest.md` loses nothing: `rebuildDigest(path)` restores
  them offline, with no pi process involved.
- **Which events feed which section.** `settle` → task table; `tool` with `phase:"end"` →
  tool rollup and slowest/last-failure lists; the last `todo` → item table; `session` /
  `prompt` → model, provider, cwd. Counters embedded in `shutdown` lines describe the
  process that wrote them and are **not** digest sources.
