# pi-workfeed

Workflow telemetry for the [pi](https://pi.dev) coding agent.

Not another todo list and not another tracer. `pi-workfeed` is a **data entry point**:
it records what the agent did, in a form a model can read and reason about, so that
answers like "where did this task's time go" or "why was this run slow" are derived
from evidence instead of impressions.

Three smallest necessary pieces:

1. **`workfeed_todo` tool with per-item timing** — the task structure the agent already
   maintains, now with timing attached. The tool is deliberately named `workfeed_todo` so it
   can coexist with other todo extensions instead of failing to load on a name conflict.
2. **event journal** — tasks, turns, tool calls, tokens, todo changes as one JSONL stream.
3. **digest** — a small derived summary so the model reads 200 lines, not 20 000.

The digest is **rebuilt from the JSONL, never from the running process**:
`JSONL → parse → aggregate → digest` (`extensions/journal/replay.ts`). So a digest can be
deleted, regenerated after a restart, or rebuilt for a session this process never saw —
and 2 000 tool calls later it still counts 2 000 calls instead of the last 200. The replay
module imports no pi API, which is what makes an offline analyzer possible later.

Everything shares four keys (`v` / `sid` / `task` / `item`), which is what makes the
stream joinable. The wire format is specified as a protocol in
[`docs/schema.md`](docs/schema.md) — envelope constraints, per-event field tables with
required/optional markers, invariants, versioning rules and a consumer checklist — with a
machine-readable form at
[`schemas/workfeed-event-v1.schema.json`](schemas/workfeed-event-v1.schema.json). If you
write a parser, those two files are the contract.

## Design philosophy

### Work, not just conversations

An AI agent session is more than a sequence of messages. It is a workflow composed of
tasks, work items, model turns, tool executions, and outcomes. Workfeed records these
activities as structured, correlated events, making it possible to understand not just
what an agent said, but what it actually did.

### Evidence before interpretation

Raw events are the source of truth. Digests and summaries are derived views, never
authoritative records. Every measurement has an explicit definition — `durMs` versus
`wallMs`, item time versus task time — and analysis is grounded in recorded evidence rather
than inferred from impressions. Where the log cannot answer a question, the answer is "not
recorded", not a guess.

### Models as observability consumers

Traditional observability tools primarily present metrics to humans through dashboards.
Workfeed takes a different approach: it provides structured, compact, verifiable evidence
that AI models can inspect, correlate, and reason about. The goal is not to replace
observability infrastructure, but to make agent workflows easier to understand through the
agents themselves.

## Install

```bash
pi install npm:pi-workfeed
# or from a checkout
pi install ./pi-workfeed
```

Then `/reload`. Two extensions load, plus one skill (`workfeed-analysis`) that teaches the
agent how to read the output.

## What you get

```text
~/.pi/agent/logs/<YYYY-MM-DD>/
├── workfeed-<sid>.jsonl         # truth: one event per line, append-only
└── workfeed-<sid>.digest.md    # derived: rebuilt from the .jsonl above, not from memory
```

Status line shows `⏱ elapsed · tool · #item · tN · calls`. Commands:

- `/wf-todos` — the task list with per-item elapsed time
- `/workfeed` — log and digest paths, plus this session's counters
- `/workfeed-digest` — rebuild the digest from the log (use after a restart or if a digest looks stale)

## Ask the agent, not a dashboard

There is deliberately no report generator, no HTML page, no metrics daemon. The entry
point is the files; the consumer is the model. Typical prompts that work out of the box:

- "read today's workfeed digest and tell me where this session's time went"
- "which tool calls were slow, and were they slow because of the tool or the model?"
- "which todo item ate the most time, and did it actually finish?"
- "look at the last failures and tell me whether they are one root cause"

The bundled skill gives the agent the measurement definitions and the drill-down
procedure, so it does not guess what `durationMs` means or confuse wall clock with
monotonic tool time.

## How this relates to other tooling

- **SQLite tool-call audit extensions** answer "what commands ran, in order, for later
  inspection". They are forensic logs for humans. Workfeed records the layer above the
  command: which task and which work item the call belonged to, so the answer to "where did
  this task's time go" already exists in the data instead of being reconstructed by hand.
- **OpenTelemetry's GenAI semantic conventions** standardize how model and tool activity is
  described as spans for exporters and backends. Workfeed is not an OTLP exporter and
  does not replace tracing: it writes a local append-only JSONL plus a digest contract the
  agent reads in-session. If you already run OTel, the two answer different questions —
  fleet-level latency and cost there, "what happened during this task, and why was it slow"
  here.
- **What is distinctive here** is the combination: the todo list acts as a semantic layer
  (ids are join keys, timing lives on the item), and the digest is a contract written for a
  model to read, cross-check and re-derive — not another dashboard for a human to skim.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_WORKFEED_DIR` | `~/.pi/agent/logs` | log root |
| `PI_WORKFEED_EXCERPT` | `2048` | bytes of tool output kept per call, `0` keeps none |
| `PI_WORKFEED_CONTENT` | `1` | `0` = metadata only: no prompt text, no tool output, no command text, no todo text, paths reduced to basenames |
| `PI_WORKFEED_ARGS` | `redacted` (`shape` when `PI_WORKFEED_CONTENT=0`) | tool arguments: `full` \| `redacted` \| `shape` \| `off` |
| `PI_WORKFEED_OFF` | — | `1` disables the journal |
| `PI_WORKFEED_TODO_OFF` | — | `1` disables the todo extension |

## Honest notes

- **Cost is not recorded.** Self-hosted OpenAI-compatible endpoints report `cost: 0`;
  writing that number into a log teaches wrong lessons. Tokens are recorded, price them
  yourself.
- **Todo state is stored twice on purpose**: in tool result `details` (correct after
  `/fork` and `/tree`) and in a `pi.appendEntry` custom entry (survives compaction, which
  drops old messages). Losing the list on `/compact` is the bug this design avoids.
- **Item timing cannot separate agent time from human time.** It measures how long an item
  stayed `in_progress`.
- **Attribution is frozen at tool start, not at settle.** A slow call keeps the `task` and
  `item` that launched it; if the todo list moves mid-call the `todo` line moves, the call
  does not. Read each line's own `item` instead of pairing lines by timestamp.
- **File names are prefixed `workfeed-`** so this logger never collides with another
  extension that writes `session-*.jsonl` into the same directory. Two loggers in one
  folder would interleave foreign lines into each other's files.
- **Windows, macOS, Linux** are all supported: paths come from `os.homedir()` and
  `path.join`.

## Privacy

What each channel records is a fixed policy, not an accident — a log is expected to be
shared, attached to a bug report, or read by a colleague:

| Data | Default | `PI_WORKFEED_CONTENT=0` |
|---|---|---|
| tool name, duration, exit code, error flag | kept | kept |
| token counts, turn and task counters | kept | kept |
| todo id / status / elapsed | kept | kept |
| command text | kept, clipped, credential patterns redacted | **never** |
| prompt text | kept ≤3000 chars, redacted | **never** |
| tool output | kept ≤`PI_WORKFEED_EXCERPT` bytes (head + tail), redacted | **never** |
| file content (`write` / `edit` bodies) | never — byte counts only | never |
| paths (cwd, session file, read/write targets) | full | last segment only, `<…>/name` |
| other tool arguments | per-tool summary (`redacted`) | key names + byte counts (`shape`) |
| todo text | kept ≤120 chars | omitted, length only |

`PI_WORKFEED_ARGS` overrides the argument channel alone: `full` (debugging), `redacted`,
`shape`, `off`. Argument values are scrubbed in **every** mode, including `full` and the
fallback branch used for tools this package does not know (MCP servers, other extensions).

**Redaction is best effort, not a guarantee.** It matches common shapes: `--token …`,
`Authorization: …`, `API_KEY=…`, `sk-…`, `AKIA…`, JWTs, inline PEM keys, `curl -u u:p`,
`DATABASE_URL=…`, and `scheme://user:password@host` DSNs. A secret that reads like an
ordinary word will survive — no pattern list can fix that. The log is written `0600` in a
`0700` directory (best effort on Windows, which has no POSIX modes) because even a
metadata-only log reveals which tools ran, on which files, and for how long. Treat the
directory as sensitive either way.

## Offline analyzer

The replay layer needs no pi, so the digest can be rebuilt for a session this process never
saw — handy when a run already ended, or when someone hands you their log:

```bash
npx pi-workfeed-digest ~/.pi/agent/logs/2026-11-10/workfeed-<sid>.jsonl
npx pi-workfeed-digest <log.jsonl> --out digest.md
```

It prints the same digest the agent reads, not a human report. Exit codes: `0` clean, `1`
nothing parsed (that was not a workfeed log), `2` damaged log — parseable lines, but some
line in the middle was dropped or violated the envelope. `--strict` additionally fails on
unknown event types. The same verdict is written into the digest itself under
`## data quality` → `log integrity`, because the analyzer is not always the reader.

## Versioning

Three numbers, three meanings: the **wire version** (`v` on every event, specified in
`docs/schema.md`), the **package version** (`package.json`, this README, the CHANGELOG),
and the **source version** (an annotated git tag `v<package version>` on the commit that
carries it). They are deliberately independent — a patch release still ships wire `v: 1`,
and `main` may run ahead of the last tag with docs-only commits. Rules, bump criteria and
the release checklist are in [`docs/versioning.md`](docs/versioning.md);
`test/version.test.mjs` fails when the declarations drift apart, and refuses a tag that is
ahead of `package.json`.

## Roadmap

- v0.3.1 (this): one version policy instead of three implied ones — wire / package / source
  spelled out, machine-checked, and the first tag cut at `v0.3.1`
- v0.3.0: a damaged log is reported, never silently skimmed — the parser separates a
  torn tail (expected) from corruption in the middle (damage), envelope violations and
  unknown event types, and the digest states all four
- v0.2.0: join keys actually hold — task resumes from the log, item ids are never
  reused, token totals fall back to their parts, data quality is stated in the digest, and
  the redaction claim is narrowed to what the code does
- v0.1.4: a tool call keeps the task/item it started under, even if the todo list moves mid-call
- v0.1.3: metadata-only finally covers tool arguments; explicit collection policy
- v0.1.2: digest rebuilt from the log via a pi-free replay layer; no retention cap reaches it
- v0.1.1: todo publishes only on state change; duplicates dropped in the journal
- v0.1: todo + journal + digest + skill, schema v1
- next: per-task token attribution to items, cross-session query examples in the skill

## 中文速用

- 安装：`pi install npm:pi-workfeed`，然后 `/reload`。
- 产出：`~/.pi/agent/logs/<日期>/workfeed-<会话>.jsonl`（真值）与 `workfeed-<会话>.digest.md`（派生，可删）。
- 用法：不要自己翻日志，直接让 agent 读 digest 给结论；摘要里已带慢命令、失败与各 todo 项耗时。
- 隐私：`PI_WORKFEED_CONTENT=0` 只记元数据——不落提示词、工具输出、命令正文与 todo 文本，路径只留末段；
  参数通道单独由 `PI_WORKFEED_ARGS`（`full`/`redacted`/`shape`/`off`）控制；任何模式下参数值都会过一遍脱敏（含 `full` 与未知工具的兜底分支）。
- 脱敏是**尽力而为**：能认出 `--token …`、`Authorization:`、`API_KEY=`、`sk-`、`AKIA`、JWT、PEM 私钥、`curl -u`、`DATABASE_URL=`、`scheme://user:pw@host` 这类形状，认不出「长得像普通单词」的密钥。日志文件按 `0600` 写在 `0700` 目录里（Windows 只能尽力），但无论哪种模式都请把它当敏感数据。

## License

MIT
