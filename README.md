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
stream joinable. See [`docs/schema.md`](docs/schema.md).

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
`shape`, `off`. Credential-looking fragments (`--token …`, `Authorization: …`,
`API_KEY=…`, `sk-…`) are replaced with `<redacted>` in **every** mode, including `full`.

Treat `~/.pi/agent/logs` as sensitive data either way: even metadata reveals which tools,
files and how long.

## Roadmap

- v0.1.4 (this): a tool call keeps the task/item it started under, even if the todo list moves mid-call
- v0.1.3: metadata-only finally covers tool arguments; explicit collection policy
  with credential redaction in every mode
- v0.1.2: digest rebuilt from the log via a pi-free replay layer; no retention cap reaches it
- v0.1.1: todo publishes only on state change; duplicates dropped in the journal
- v0.1: todo + journal + digest + skill, schema v1
- next: per-task token attribution to items, cross-session query examples in the skill

## 中文速用

- 安装：`pi install npm:pi-workfeed`，然后 `/reload`。
- 产出：`~/.pi/agent/logs/<日期>/workfeed-<会话>.jsonl`（真值）与 `workfeed-<会话>.digest.md`（派生，可删）。
- 用法：不要自己翻日志，直接让 agent 读 digest 给结论；摘要里已带慢命令、失败与各 todo 项耗时。
- 隐私：`PI_WORKFEED_CONTENT=0` 只记元数据——不落提示词、工具输出、命令正文与 todo 文本，路径只留末段；
  参数通道单独由 `PI_WORKFEED_ARGS`（`full`/`redacted`/`shape`/`off`）控制；任何模式下凭据样式片段都会被替换为 `<redacted>`。

## License

MIT
