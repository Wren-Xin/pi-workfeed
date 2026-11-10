# Event schema (v1)

pi-workfeed writes two kinds of files per session, into one directory per day:

```text
${PI_WORKFEED_DIR:-~/.pi/agent/logs}/<YYYY-MM-DD>/
├── workfeed-<sid>.jsonl         truth layer, one event per line, append-only
└── workfeed-<sid>.digest.md    derived layer, rewritten on every settle, delete-safe
```

**Rule: `workfeed-<sid>.jsonl` is the only source of truth. `workfeed-<sid>.digest.md` is derived.**
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

**`tool` attribution is frozen at `start`.** A `tool` `end` line repeats the `task` and
`item` captured when the call started, not the ones current when it finished. A long call
whose todo list moved to another item mid-flight stays with the item that launched it; the
`todo` snapshot that moved the list is a separate line with its own `item`. Either way a
line's own `item` is authoritative — never pair a `start` and an `end` by timestamps.

**Item identity is positional, not semantic.** Ids are allocated by the todo extension and
never reused inside a session (`clear` keeps the counter), but a new `write` call matches
existing items by **text**: reword an item and it arrives as a new id with fresh timing. If
timing continuity matters, keep the wording stable.

**Known gap:** a call that never reaches `tool_execution_end` (crash, kill, aborted
process) has a `start` line and no `end` line, so the digest's tool table does not count it.
To detect that class of gap, count `phase:"start"` lines against `phase:"end"` lines in the
raw log.

## Event types

| `t` | `phase` | Extra fields |
|---|---|---|
| `session` | — | `reason`, `cwd`, `sessionFile` (basename only when content is off), `model`, `provider`, `pid` |
| `prompt` | — | `chars`, `text` (≤3000, redacted, omitted when content is off), `model`, `thinking` |
| `agent_start` | — | — |
| `turn` | `start` | `turn`, `model` |
| `turn` | `end` | `turn`, `durMs`, `outcome`, `stopReason`, `usage` (`input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`), `tools` |
| `tool` | `start` | `id`, `name`, `parent`, `args` — policy-shaped, see Privacy (values only when `PI_WORKFEED_ARGS` allows) |
| `tool` | `end` | `id`, `name`, `durMs` (monotonic, `execute()` time), `wallMs` (call→end), `isError`, `exitCode`, `truncated`, `outBytes`, `out` (excerpt, redacted, omitted when content is off) |
| `todo` | — | `rev`, `items`: `[{ id, status, elapsedMs, text }]` (`text` ≤120 and redacted, or `textChars` when content is off) — full snapshot, written **only when the list changes**; an identical snapshot is never logged (UI repaints and duplicate emitters are dropped) |
| `user_bash` | — | `chars`, `command` (≤4000, redacted, omitted when content is off) |
| `provider` | — | `status` (only written for HTTP ≥ 400), `requestId` |
| `compact` | — | `reason`, `before`, `after` |
| `compact_failed` | — | `reason`, `error` |
| `settle` | — | `taskMs` (prompt→`agent_settled` wall clock), `aborted`, `turns`, `tools`, `tokens`: `{ input, output, cacheRead, cacheWrite, total }` — `total` is the provider-reported total when it is **positive**, otherwise the sum of its parts (self-hosted endpoints often omit it or send `0`); written only for a user prompt, never for a tool-injected turn |
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

Collection is a policy, not an accident. Each channel has an owner, so a metadata-only
log contains no free text at all, and every argument value that is recorded has been
through the scrubber first — **best effort**, see the note below the table:

| Channel | Default | `PI_WORKFEED_CONTENT=0` | Owner |
|---|---|---|---|
| `t`, `ts`, `sid`, `task`, `item` | kept | kept | fixed |
| tool `name`, `durMs`, `wallMs`, `isError`, `exitCode`, `outBytes` | kept | kept | fixed |
| `usage` / `tokens` / `turn` counters | kept | kept | fixed |
| `todo` `id`, `status`, `elapsedMs`, `rev` | kept | kept | fixed |
| `tool` `args` for built-in tools (`command`, `pattern`, `path`) | kept, clipped 2000, redacted | omitted (`args` = shape) | `PI_WORKFEED_ARGS` |
| `tool` `args` for unknown tools (MCP, other extensions) | JSON, clipped 1200, every string redacted | omitted (`args` = shape) | `PI_WORKFEED_ARGS` |
| `prompt` `text` | kept ≤3000, redacted | omitted (`chars` only) | `PI_WORKFEED_CONTENT` |
| `tool` `out` | kept ≤`PI_WORKFEED_EXCERPT`, redacted | omitted (`outBytes` only) | `PI_WORKFEED_CONTENT` / `PI_WORKFEED_EXCERPT` |
| `write` / `edit` body | never — byte counts only | never | fixed |
| `session` `cwd`, `sessionFile`, `args.path` | full | last path segment, `<…>/name` | `PI_WORKFEED_CONTENT` |
| `todo` `items[].text` | kept ≤120, redacted | omitted (`textChars` only) | `PI_WORKFEED_CONTENT` |
| `user_bash` `command` | kept ≤4000, redacted | omitted (`chars` only) | `PI_WORKFEED_CONTENT` |

`PI_WORKFEED_ARGS` = `full` | `redacted` | `shape` | `off`; default is `shape` whenever
`PI_WORKFEED_CONTENT=0`, else `redacted`. `shape` records `{ keys, stringBytes }` — which
arguments existed and how large they were, never their values.

Argument values are scrubbed in **every** mode, including `full` and the fallback branch
for tools this package does not recognize. Patterns: `--token …`, `Authorization:` /
`Bearer`, `API_KEY=` / `PASSWORD=` / `DATABASE_URL=` style assignments, `sk-…` / `ghp_…` /
`AKIA…`, JWTs, inline PEM private keys, `curl -u user:pass`, and
`scheme://user:password@host`.

**This is best effort, not a guarantee.** A secret shaped like an ordinary word survives, and
a tool may encode data the scrubber cannot parse. Do not treat a log as credential-free
because it went through the scrubber.

Files are written `0600` inside a `0700` directory (POSIX modes; Windows honours them only
partially). Treat the directory as sensitive regardless: even a metadata-only log tells
which tools ran on which files and for how long.

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
- **States its own coverage.** The `## data quality` section reports finished calls,
  `start` lines with no matching `end` (crash, kill, abort), and how many finished calls
  carry an `item`. Attribution coverage belongs in the digest because the item structure is
  maintained by the model; a low ratio is a fact about the data, not a flaw to hide.
- **Which events feed which section.** `settle` → task table; `tool` with `phase:"end"` →
  tool rollup and slowest/last-failure lists; the last `todo` → item table; `session` /
  `prompt` → model, provider, cwd. Counters embedded in `shutdown` lines describe the
  process that wrote them and are **not** digest sources.
