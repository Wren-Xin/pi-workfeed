---
name: workfeed-analysis
description: Read pi-workfeed output and explain where a session's time, tokens and failures went. Use when the user asks why a run was slow, where the time went, which tool calls failed or repeated, how long todo items took, or asks for workflow tuning advice based on session logs.
---

# workfeed-analysis

`pi-workfeed` records a session as two files. Read them in this order and never the other
way round.

## Where the files are

```text
${PI_WORKFEED_DIR:-~/.pi/agent/logs}/<YYYY-MM-DD>/
├── workfeed-<sid>.digest.md     start here
└── workfeed-<sid>.jsonl        drill down here, filtered
```

`/workfeed` prints both paths for the current session. The digest is derived data: it may
be stale by one task, and it may be regenerated at any time from the JSONL — `/workfeed-digest`
rebuilds it in place, and `extensions/journal/replay.ts` (`rebuildDigest(path)`) rebuilds it
offline, after a restart, or for a session no process is watching. When a number matters,
confirm it in the JSONL.

Read `docs/schema.md` (shipped next to this skill's package root) before interpreting
fields.

## Procedure

1. **Read the digest.** It already holds the task table, tool rollup, slowest calls, last
   failures and per-item todo timing with shares. Most questions are answered here.
2. **Form a hypothesis with a number attached.** "bash accounts for 70% of tool time",
   "item #3 took 40% of the run", "the last three failures share exit code 2".
3. **Drill down only to test it.** Filter the JSONL, never page through it:

   ```bash
   grep '"t":"tool"' workfeed-*.jsonl | grep '"phase":"end"' | grep '"isError":true'
   grep '"t":"tool"' workfeed-*.jsonl | grep '"name":"bash"' | grep '"durMs"'
   grep '"t":"todo"'  workfeed-*.jsonl | tail -3
   ```

   To attribute work, filter by `task` (user instruction) or `item` (todo id).
4. **Report evidence, then advice.** Every claim names its source: `digest`, or the event
   type and count you filtered. Do not average, extrapolate or round-trip numbers the log
   does not contain.

## Measurement definitions (do not improvise)

| Number | Source | Means |
|---|---|---|
| task time | `settle.taskMs` | prompt → `agent_settled` wall clock |
| turn time | `turn.end.durMs` | one model request + its tool execution |
| tool time | `tool.end.durMs` | monotonic `execute()` duration — **the only trustworthy "this was slow" number** |
| tool wall time | `tool.end.wallMs` | call → end, includes scheduling; upper bound only |
| item time | `todo.items[].elapsedMs` | accumulated `in_progress` time; mixes agent and human time |
| tokens | `turn.end.usage` | provider-reported usage |
| cost | — | **not recorded**; self-hosted endpoints report 0. Price tokens yourself or say "cost unknown" |

If the session has no `settle` event yet (still running), say so instead of reporting a
partial task as complete.

## Patterns worth naming

Look for these before recommending anything generic:

- **One tool dominates** — check whether it is one slow command or many fast ones
  (rollup `calls` vs `avg`). Both look identical in total time.
- **Retry storms** — same `name` + same `exitCode` + same `item`, clustered in time. The fix
  is usually the command, not the model.
- **Long tool, no artifact** — `durMs` large, but no later `write`/`edit` in the same `item`,
  and the next `read` touches the same path. Often a wasted exploration pass.
- **Item stall** — an item whose `elapsedMs` share is high but whose status never became
  `completed` before the next `write` demoted it.
- **Turn inflation** — high `turns` with low `tools` per turn: the model is thinking in
  circles, or a `prompt` was too vague.
- **Compaction pressure** — many `compact` events in one task means the task is carrying
  more context than the window; suggest splitting it.

## Output shape

1. One or two sentences of answer, with the headline number.
2. Evidence bullets: `digest` table or filtered event counts.
3. Advice as 2–3 concrete, falsifiable changes ("fold the three `read` calls on
   `src/pipeline.py` into one"), not principles.
4. State what the log does **not** tell you (cost, human idle time, model-side latency).

Never publish a conclusion that needs data absent from the log without labelling it as a
guess.
