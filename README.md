# pi-workfeed

**Agent Workflow Evidence** — workflow telemetry for the [pi](https://pi.dev) coding agent.

> Record the Work. Preserve the Evidence.

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

**Contents:** [How it fits together](#how-it-fits-together) · [Install](#install) ·
[Privacy](#privacy) · [What you get](#what-you-get) ·
[What the digest looks like](#what-the-digest-looks-like) ·
[Ask the agent](#ask-the-agent-not-a-dashboard) · [Design philosophy](#design-philosophy) ·
[Verification](#verification) · [中文速用](#中文速用)

## How it fits together

```text
pi session  ──  tasks · turns · tool calls · tokens
  │
  ├─ todo extension ─────────► per-item timing   (in_progress elapsed, ids never reused)
  │
  └─ journal extension ──────► JSONL journal      (truth: append-only, one event per line)
                               workfeed-<sid>.jsonl
  every line shares  v · sid · task · item
         │
         ▼  replay.ts: parse → aggregate
       digest                                     (derived: rebuilt, never authoritative)
       workfeed-<sid>.digest.md
         │
         ▼  read by the model, with the bundled skill
       "where did this task's time go, and which call was slow"
```

The arrows only go one way: the extensions write the log, the digest is computed from the
log, and nothing feeds the digest back into the log. That is why `rebuildDigest(path)` can
rebuild it for a session this process never saw.

Here is what the stream actually looks like — the same call at `start` and at `end`, taken
verbatim from a real session (only the session id is shortened, nothing else edited):

```json
{"v":1,"ts":1794306999849,"sid":"<sid>","task":1,"item":1,"t":"tool","phase":"start","id":"call_00_ET_8lw2J5KaRKaxvp6nfIEi3067","name":"edit","args":{"path":"note.txt"}}
{"v":1,"ts":1794306999854,"sid":"<sid>","task":1,"item":1,"t":"tool","phase":"end","id":"call_00_ET_8lw2J5KaRKaxvp6nfIEi3067","name":"edit","durMs":4,"wallMs":5,"isError":false,"outBytes":45,"out":"Successfully replaced 1 block(s) in note.txt."}
```

- `t` is the event type, `ts` is epoch milliseconds, and `id` is what joins the two lines.
- `task` and `item` are identical on both because **attribution is frozen when the call
  starts** — if the todo list moves mid-call, the start and the end still belong together.
- `durMs` is monotonic execution time; `wallMs` includes scheduling, so it is an upper bound.
- This producer writes `args` only on `start` and `out` only on `end`; the schema allows
  either as optional, and a digest must not assume otherwise.

The field tables, per-`phase` required keys, envelope rules and the consumer checklist are in
[`docs/schema.md`](docs/schema.md); the machine-checkable form is
[`schemas/workfeed-event-v1.schema.json`](schemas/workfeed-event-v1.schema.json).
`test/schema-docs.test.mjs` also parses the two lines above and fails if they use a field the
schema does not declare.

## Install

> **Before you install: this records what you and the agent typed.** Prompt text and tool
> output go to a JSONL log under `~/.pi/agent/logs/<date>/`. Redaction is best effort
> (truncation, argument masking, path basenames) — not a guarantee. `PI_WORKFEED_CONTENT=0`
> turns content recording off and keeps timing. Read [Privacy](#privacy) before turning it on
> in a repository you would not want logged.

Requirements:

| Requirement | What this release was actually checked against |
|---|---|
| Node.js | **22.19.0 or newer** — pi's own floor (`@earendil-works/pi-coding-agent` declares the same in its `engines`), not a stricter one this package invented. Below it you are outside the version support is *stated* against, which is not the same as "will not run": the suites have also come back green on Node 22.12.0, and the first thing that would break on an older 22.x is the `--experimental-strip-types` flag itself. Verified here on 22.23.2 (Windows) and 24.22.1 (Linux) |
| pi coding agent | **verified on 1.5.0 (Windows 11) and 1.5.1 (Ubuntu 24.04)** — these are the two versions the release was exercised on end to end, not a compatibility range. Other versions are untested; a mismatch in event field names is exactly the kind of break this package survives by reporting rather than guessing |
| OS | Windows 11 and Ubuntu 24.04 verified. macOS is **untested** (no hardware available) — if it breaks there, please [open an issue](https://github.com/Wren-Xin/pi-workfeed/issues/new/choose) rather than assume it works |

The extensions import four packages they do not ship: `@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`. All four are
supplied by the running pi host, so they are declared as `peerDependencies` with `*` —
a version range there would promise compatibility this package cannot verify, and the copy
that actually loads is pi's, not npm's. Install through `pi install`; a bare `npm i
pi-workfeed` makes npm resolve those peers on its own, which is not how this package is
meant to be loaded.

### 1. Install the package

```bash
pi install npm:pi-workfeed      # personal: written to ~/.pi/agent/settings.json
pi install ./pi-workfeed        # from a checkout
pi install ./pi-workfeed -l     # project-local: .pi/settings.json, loads after project trust
```

`pi list` prints the declaration back if you want to confirm it landed.

### 2. Enable it

```
/reload
```

A new session picks the package up at startup; an already-open session needs `/reload`.
Two extensions (`todo`, `journal`) and one skill (`workfeed-analysis`) load together.

### 3. Verify that all three arrived

| Check | What it proves |
|---|---|
| `pi config` (Tab switches personal / project scope) | the package is listed and its resources — two extensions and the skill — are there and enabled |
| `/wf-todos` in a session | the todo extension loaded: it prints the current list (empty at first) |
| `/workfeed` | the journal loaded and is already writing: it prints the session id and both file paths |
| the first prompt after `/reload` | one line appears naming the log file — that is the journal announcing itself once, not a second install |

If `/wf-todos` and `/workfeed` work but the skill never appears in `pi config`, the skill
directory was filtered out: check that `pi.skills` in the installed `package.json` still
points at `./skills`.

**What gets created.** At install time, one entry in the pi settings file and nothing else.
At the first session: `~/.pi/agent/logs/<YYYY-MM-DD>/workfeed-<sid>.jsonl` immediately,
then `workfeed-<sid>.digest.md` once the first task settles (refreshed at session start,
at session end, and whenever you run `/workfeed-digest`). Nothing is written outside that
directory.

**To stop recording content** before the first prompt: `PI_WORKFEED_CONTENT=0` — timing,
tool names and todo structure still recorded, prompt text and tool output never written.
The per-channel detail is in [Privacy](#privacy).

## Privacy

The first session after install prints one line — where the log is, that prompt text and
tool output are recorded, and the switch that stops it — so the policy is visible at the
moment it starts applying, not only here.

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

## What you get

```text
~/.pi/agent/logs/<YYYY-MM-DD>/
├── workfeed-<sid>.jsonl         # truth: one event per line, append-only
└── workfeed-<sid>.digest.md    # derived: rebuilt from the .jsonl above, not from memory
```

Status line shows `⏱ elapsed · tool · #item · tN · calls`.

Two surfaces, both real:

| Surface | What it is | How you reach it |
|---|---|---|
| `/wf-todos`, `/workfeed`, `/workfeed-digest` | **pi slash commands**, handled in-process by the extension | type them inside a pi session — they are not shell commands |
| `rebuildDigest(path)` | **library API** (`extensions/journal/replay.ts`), returns `{ text, integrity }` | import it from your own script; `hasDamage(integrity)` gives the same verdict |

`/workfeed-digest` rebuilds the digest *inside a session* (after a restart, or when a digest
looks stale); rebuilding offline is the library call, not a command. There is no shell command
and no `npx` entry — the reasoning is in the CHANGELOG.

## What the digest looks like

One real session — three prompts, seven tool calls, one failed bash, one todo list that was
partly cleared — rebuilt offline from the JSONL. Session id and paths shortened, nothing else
edited:

```text
# workfeed digest

> derived from workfeed-<sid>.jsonl at 2026-11-10T10:36:44.368Z — regenerate, do not hand-edit.

- session: <sid>
- date: 2026-11-10
- model: deepseek-flash (deepseek)
- cwd: <…>/proj
- events: 43

## data quality

- tool calls: 7 finished
- item attribution: 4/7 calls carry an item (57%)
- token totals: 3/3 tasks report a non-zero total
- task coverage: 3/3 prompts have a settle
- compaction: 0 completed, 0 failed, 1 skipped — skipped: Compaction failed: Nothing to compact (session too small)

## tasks (3, wall clock 6.9s)

| # | time | turns | tools | tokens | status |
|---|---|---|---|---|---|
| 1 | 3.1s | 3 | 4 | 9.8k in / 286 out / 10.1k total | ok |
| 2 | 2.5s | 2 | 2 | 7.3k in / 249 out / 7.5k total | ok |
| 3 | 1.3s | 2 | 1 | 7.8k in / 44 out / 7.8k total | ok |

## tools (7 calls, 1 failed)

| tool | calls | total | avg | max | failed |
|---|---|---|---|---|---|
| bash | 2 | 192ms | 96ms | 108ms | 1 |
| read | 1 | 40ms | 40ms | 40ms | 0 |
| workfeed_todo | 3 | 6ms | 2ms | 4ms | 0 |
| edit | 1 | 4ms | 4ms | 4ms | 0 |

slowest calls

- 108ms · bash · task 2 · item 1 · FAILED
- 84ms · bash · task 1
- 40ms · read · task 1
- 4ms · workfeed_todo · task 1
- 4ms · edit · task 1 · item 1

last failures

- bash · task 2 · 10:36:41

## todo items (3)

1/3 completed · accumulated in-progress time 2.5s · 3 dropped from the list (timing kept)

| id | status | elapsed | share | text |
|---|---|---|---|---|
| 1 | completed · dropped | 2.5s | 100% | probe todo timing |
| 2 | in_progress · dropped | 0s | 0% | run a command |
| 3 | pending · dropped | 0s | 0% | edit a file |
```

What each block is for, in the order to read them:

- **`## data quality` first, on purpose.** `4/7 calls carry an item (57%)` says the item column
  is a lower bound; `1 skipped` is pi answering "nothing to compact" on a small session, not a
  failure — calling that an error would make a healthy install look broken.
- **`## tasks`** — one row per prompt; `ok` means a `settle` arrived, and a killed prompt shows
  up as started-without-settle instead of vanishing.
- **`## tools`** — keeps a slow tool and a broken tool apart (separate `failed` count) and keeps
  sub-second detail (`108ms`, `1.4s`): a floored column of `0s` cannot answer "which call was
  slow", which is the question this digest exists for.
- **`slowest calls` / `last failures`** — ranked evidence with `task` and `item` attached. Only
  two of these five carry an `item`; the ratio above is what tells you that.
- **`## todo items`** — `dropped (timing kept)`: an item that left the list keeps the time it
  already spent, so 2.5s does not collapse into "0 items".

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

## Design philosophy

### Work, not just conversations

A session is a workflow — tasks, work items, model turns, tool executions, outcomes — not a
message transcript. Recording it as correlated events is what makes "what it actually did"
answerable, instead of "what it said".

### Evidence before interpretation

Raw events are the truth; a digest is derived and never authoritative. Every number has a
definition (`durMs` vs `wallMs`, item time vs task time), and where the log cannot answer,
the answer is "not recorded", not a guess.

### Models as observability consumers

Dashboards are for humans skimming. This package writes compact evidence a model can inspect
and cross-check in-session — not a replacement for tracing infrastructure, but a different
question: "what happened during this task, and why was it slow".

### Rebuilt, not remembered

The digest is computed from the JSONL, never accumulated in memory: `JSONL → parse →
aggregate → digest` (`extensions/journal/replay.ts`), a module that imports no pi API. So a
digest can be deleted and regenerated, and 2 000 tool calls still count 2 000 — not the last
200 the process happened to remember.

Every line shares four keys (`v` / `sid` / `task` / `item`), which is what makes the stream
joinable; the format is specified as a protocol in [`docs/schema.md`](docs/schema.md), with a
machine-readable twin at
[`schemas/workfeed-event-v1.schema.json`](schemas/workfeed-event-v1.schema.json).

## How this relates to other tooling

- **SQLite tool-call audit extensions** are forensic logs for humans: what ran, in what
  order, after the fact. Workfeed records the layer above the command — which task and which
  work item the call belonged to — so "where did this task's time go" is already in the data
  rather than reconstructed by hand.
- **OpenTelemetry's GenAI semantic conventions** describe model and tool activity as spans
  for exporters and backends. This is not an OTLP exporter and does not replace tracing: it
  writes a local JSONL plus a digest the agent reads in-session. Fleet-level latency and cost
  live there; "what happened during this task, and why was it slow" lives here.

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
- **Path handling is portable** (`os.homedir()` + `path.join`, no separators assumed):
  Windows 11 and Ubuntu 24.04 are verified, macOS is **not verified** — see
  [Verification](#verification).
- **Logs are never rotated or deleted** by this package. Every session appends to
  `~/.pi/agent/logs/<date>/` and keeps growing, so delete the date folders you no longer
  need; a digest is derived, so removing it costs nothing, and removing a day removes that
  day's evidence. Each session prints its log path on startup, so a cleanup never has to guess.

## Verification

Reproduce the suite yourself — no build step, no dev install beyond Node:

```bash
node --experimental-strip-types test/run.mjs     # exactly what `npm test` calls
```

The run ends with `ALL SUITES PASS`. `--experimental-strip-types` needs Node 22.6+ (the
suites import the TypeScript sources directly); Node 22.19+ is the version this release
states support against.

Test suites run against stubs, and a stub can only prove the code matches *our description*
of pi's interface. A real session was therefore run end to end — real extension loading,
real `bash`/`read`/`edit`, real compaction, real fork, real restart — and it found two
field names the stubs had got wrong. The record, including what is still unverified, is in
[`docs/verification.md`](docs/verification.md).

- Windows (pi 1.5.0, Node 22): verified.
- Linux (Ubuntu 24.04, pi 1.5.1, Node 24): verified by a second-environment rerun of the
  same flow (the maintainer's own run on another machine, not a third party)
  — all suites pass, the nine-step scenario completed with a real compaction, 11
  JSONL↔digest cross-checks matched, and `0600`/`0700` file modes held.
- macOS: **not verified** — this project is limited by resources and has no Apple hardware
  available, so it was never exercised on macOS. If you run it there and hit a problem,
  [file an issue](https://github.com/Wren-Xin/pi-workfeed/issues/new/choose); the form asks
  for pi version, Node version and the `## data quality` block, which is exactly what a
  report needs to be diagnosable.

## Versioning

Wire, package and source versions are independent on purpose, and only the wire one is a
contract: it is **frozen at `v: 1` for this release** — no new fields, no new event types,
enforced by a snapshot test instead of a note in a document. Bump criteria, the release
checklist and the rules that keep the three numbers apart are in
[`docs/versioning.md`](docs/versioning.md).

## Roadmap

- v0.1.0 (this)

Next, in no promised order:

- per-task token attribution to work items
- cross-session query examples in the bundled skill

Release history — the pre-release iteration from `0.1.0-dev` to `0.4.6` — is in
[`HISTORY.md`](https://github.com/Wren-Xin/pi-workfeed/blob/main/HISTORY.md), kept in the
repository and deliberately not shipped in the package (so the link points at GitHub, not at
a path inside the tarball).

## 中文速用

- 安装：`pi install npm:pi-workfeed`，然后 `/reload`。
- 产出：`~/.pi/agent/logs/<日期>/workfeed-<会话>.jsonl`（真值）与 `workfeed-<会话>.digest.md`（派生，可删）。
- 用法：不要自己翻日志，直接让 agent 读 digest 给结论；摘要里已带慢命令、失败与各 todo 项耗时。
- 隐私：`PI_WORKFEED_CONTENT=0` 只记元数据——不落提示词、工具输出、命令正文与 todo 文本，路径只留末段；
  参数通道单独由 `PI_WORKFEED_ARGS`（`full`/`redacted`/`shape`/`off`）控制；任何模式下参数值都会过一遍脱敏（含 `full` 与未知工具的兜底分支）。
- 脱敏是**尽力而为**：能认出 `--token …`、`Authorization:`、`API_KEY=`、`sk-`、`AKIA`、JWT、PEM 私钥、`curl -u`、`DATABASE_URL=`、`scheme://user:pw@host` 这类形状，认不出「长得像普通单词」的密钥。日志文件按 `0600` 写在 `0700` 目录里（Windows 只能尽力），但无论哪种模式都请把它当敏感数据。

## License

MIT
