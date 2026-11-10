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

## Read `## data quality` first — it decides how strong your claims may be

The digest opens with a `## data quality` section. It is not boilerplate: it states what the
recording *failed to capture*, and every conclusion downstream inherits those limits. Read
it before the tables, then carry its numbers into your wording.

| Line | How it constrains what you may say |
|---|---|
| `item attribution: N/M calls carry an item (P%)` | This is the share of tool time you can attribute to work items. Above ~80%, per-item claims are safe. Below ~50%, say "the log attributes only P% of calls to items, so per-item shares are indicative, not exact" — and do not rank items against each other as if the numbers were complete. |
| `task coverage: K/N prompts have a settle` | Prompts without a settle were killed, crashed, or are still running. Their duration and tokens are **unknown, not zero**. Never sum tasks to a session total when `K < N`; say the total covers only the settled ones. |
| `tool calls: N finished, U started without an end line` | `U` calls were cut off. Their time is missing from every tool total. When a tool looks cheap but has cut-off calls, say the evidence is partial. |
| `token totals: K/N tasks report a non-zero total` | Some endpoints report no totals. When `K < N`, report input/output separately and do not present a summed total as complete. |
| `log integrity: N lines, D dropped, X of unknown type` | The digest was built on a log with damage. See below. |

If a section you need is shaped by a missing line (e.g. no `task coverage` line because the
log predates it), say what you cannot separate instead of implying a clean number.

### When the log is damaged

`log integrity` is present on every digest. If it reports `D > 0` dropped lines, or lists
`corrupt lines` / `rejected line N: reason`, then:

1. **Report the damage before the analysis**, in one sentence: how many lines were dropped,
   where (line numbers), and what that means for ordering near them.
2. Then analyse, and mark the affected claims: "tool totals exclude the dropped lines, so the
   figures are a lower bound".
3. Never present an ordering-based conclusion (first failure, last call, retry sequence)
   around a dropped line without saying it is approximate.

Unknown event types (`X of unknown type`) are forward-compatibility, not damage: they are
kept and marked, they do not enter the aggregates, and you may ignore them unless a
conclusion depends on them.

If the analyzer reported exit code `2` (damaged log), or you rebuilt from a log where
`hasDamage(integrity)` is true, the first line of your answer is the damage statement — not
the headline number. A tidy conclusion over a damaged log is worse than a hedged one.

### Denominator discipline

Every percentage in the digest names its own denominator (`2/3`, `67%`). Quote both. Do not
recompute a percentage from a different population — a "70% of time in bash" computed from a
partial `item attribution` share is a new number with a new, unstated denominator.

## Procedure

1. **Read `## data quality`, then the digest.** Quality decides the strength of every claim
   (see above). The digest already holds the task table, tool rollup, slowest calls, last
   failures and per-item todo timing with shares. Most questions are answered here.
   Items marked `dropped` were removed from the list by `clear`; their timing is still
   evidence of work that happened, so include them when accounting for time.
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
   does not contain. Where a quality line capped the evidence, name that cap in the same
   sentence as the claim.

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
partial task as complete. If `task coverage` shows prompts without a settle, that is the
same rule applied to individual tasks: their absence from the task table means *unknown*,
never *zero*, and their tool calls still appear in the rollup — which is why the totals can
exceed the sum of listed tasks. Explain that gap rather than smoothing it away.

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
2. Evidence bullets: `digest` table or filtered event counts, each carrying the quality
   caveat that applies (attribution share, unsettled tasks, dropped lines).
3. Advice as 2–3 concrete, falsifiable changes ("fold the three `read` calls on
   `src/pipeline.py` into one"), not principles.
4. State what the log does **not** tell you (cost, human idle time, model-side latency).

Never publish a conclusion that needs data absent from the log without labelling it as a
guess.
