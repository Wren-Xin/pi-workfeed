# Verification

What has actually been run against a real pi session, how, and what is still unverified.

## Why this page exists

The test suites run against stubs. A stub proves the code agrees with *our description of
pi's interface*; it cannot prove that description is right. Both defects recorded below
were introduced by a stub — a payload shape this project wrote itself — and only a real
session exposed them. So a green CI run is not evidence that workfeed works on a real
host, and this page is where the real evidence lives instead.

## How the real run was done

- pi 1.5.0 driven in RPC mode (`pi --mode rpc`): the same extension loading path and the
  same tool execution as the TUI, with commands sent over the documented JSONL protocol
- the extensions installed from this repository as a package (not copied into a test dir)
- the host's own tools — `bash`, `read`, `edit` — plus `workfeed_todo`
- a real session file on disk, a real compaction, a real fork, and a real restart of the
  same session file in a second process
- one hosted chat-completions provider; the model is incidental. What must be real is the
  host, the tools and the events, not which model answered

## What was checked

| # | Step | Observed |
|---|---|---|
| 1 | Start a session with the package installed | `session` line with sid, model, provider, cwd; digest written |
| 2 | Write three todo items, one `in_progress` | one `todo` snapshot per change, ids 1–3, `rev` increments |
| 3 | `bash`, `read`, `edit` | `start`/`end` pair per call, `durMs`, `exitCode`, `isError: false` |
| 4 | A command that exits 3 | `isError: true`, listed under last failures, tool rollup counts it as failed |
| 5 | Update items: first `completed`, second `in_progress` | ids kept (matched by text), later turns attribute to the new item |
| 6 | `clear` | empty snapshot; every item stays in the digest marked `dropped`, item timing kept |
| 7 | `/compact` on a session that is too small | `compact_failed` carrying pi's own message ("Nothing to compact"), reported in data quality |
| 8 | `/compact` on a large session | `compact` with `before` = 24604 tokens; the todo list survives — a tool call after compaction still carries the item that was in progress |
| 9 | `fork` | new sid and a new log file; item ids continue (4), task numbering restarts at 1 for the new session |
| 10 | Restart the same session file | task numbering continues (task 2, not a second task 1); one log, both processes' lines |
| 11 | Rebuild the digest offline from the JSONL | same bytes the producer wrote; a log killed mid-tool rebuilds to `1 started without an end line` plus `1/1 prompts have a settle — killed or still open` |

Both branches of compaction (7 and 8) needed a real pi: one because the failure text only
exists there, one because a summary is produced by an actual model call.

## Smoke matrix, re-run on a release candidate

The steps above were run once, fixing defects as they appeared. Before a release they are run
again as a smoke matrix, on the code that is about to be tagged, because a later patch can
regress a path that the suite covers only with stubs.

| Scenario | What must be true | Result @ 0.4.6 |
|---|---|---|
| restart the same session file in a second process | one log file, task numbers continue (`task 3`, not a second `task 1`), `3/3 prompts have a settle` | pass — 43 lines, tasks 1–3 in one file |
| `clear` the list | empty snapshot, every item kept with its timing (`3 dropped from the list (timing kept)`, `1/3 completed · accumulated in-progress time 2s`) | pass |
| `/compact` | either a real compaction with `before`, or the empty answer reported as `skipped` — never as a failure | pass — small session: `0 completed, 0 failed, 1 skipped — skipped: …Nothing to compact…`; large session: `1 completed, 0 failed`, `before: 24604` |
| abnormal exit (kill mid-tool) | `1 started without an end line`, `0/1 prompts have a settle — … unknown, not zero`; offline rebuild needs no pi | pass — 5 events, rebuilt digest says exactly that |

## Clean install from the published artifact

Installing from the checkout proves nothing about the artifact: the checkout has `test/`, the
git history and a symlink the package does not. The check below therefore installs the tarball
itself into a throwaway home.

1. `npm pack` → `pi-workfeed-<version>.tgz` (the file that would be published).
2. Extract it — the tree contains only `CHANGELOG.md`, `LICENSE`, `README.md`, `docs/`,
   `extensions/`, `package.json`, `schemas/`, `skills/`.
3. `pi install <extracted dir>` with `USERPROFILE`/`HOME` pointing at an empty directory, so
   the real `~/.pi/agent` is not involved. `pi list` then shows the package.
4. Start a session there and read the log directory of that throwaway home.

Observed at 0.4.6: the package installed, and the journal extension **ran** — a
`workfeed-*.jsonl` appeared under `<throwaway home>/.pi/agent/logs/2026-11-10/` with

```
{"v":1,"ts":…,"sid":"…","task":0,"t":"session","reason":"startup","cwd":"…\\wf-cleanprobe\\home", …}
```

which is the extension's own session handler writing into a home that contains nothing else.
`skills/workfeed-analysis/SKILL.md` is present in the extracted tree with valid front matter
(`name: workfeed-analysis`, a description). The `SKILL.md` rules pi documents — front matter,
a non-empty description, name matching the directory — are asserted by
`test/package.test.mjs`, so a skill pi would silently skip fails CI instead.

Not observable headlessly: that pi lists the skill in the model's system prompt. pi has no
command that prints the prompt, and forcing it through a model call would prove the model's
sentence, not pi's loader. The static checks above are what can be verified without inventing
evidence; if you want the end-to-end confirmation, run `pi` and check that
`/skill:workfeed-analysis` is offered.


## The two defects a real run found

1. **`compact_failed` lost its reason.** The handler read `event.error`; pi calls it
   `errorMessage`. Every real failure logged a row with no explanation at all.
2. **`compact` lost its counts.** The handler read `messagesBefore` / `messagesAfter`; pi
   reports a `CompactionEntry` whose `tokensBefore` is the only count it exposes, and the
   digest had no line for compaction either way.

Both are now fixed and covered by `test/compaction.test.mjs`, which uses pi's documented
field names rather than a shape invented for the test.

## Coverage, stated honestly

`item attribution` in the digest is a measurement, not a promise. A model that issues its
`workfeed_todo` call in the same turn as other tool calls makes those calls *start* before
the new snapshot arrives, so they carry no `item` — a real run showed `2/4` and `4/7`.
If you want every call of a task attributed, write the list first and alone.
The digest states the real ratio instead of rounding it.

## Platforms

| Platform | Status |
|---|---|
| Windows 11 · pi 1.5.0 · Node 22 | verified with the flow above |
| Linux (Ubuntu 24.04 x64) · pi 1.5.1 · Node 24 | **verified** by a second-environment rerun of the same flow (the maintainer's own run on another machine, not a third party): all suites pass, the nine-step scenario completed including a real compaction, and 11 JSONL↔digest cross-checks matched (80 events, 4 tasks, 15 finished calls, `10/15` item attribution, `1 completed, 0 failed`). Linux-specific expectations held: log and digest `0600`, log dir `0700`, POSIX paths, Chinese text intact, date directory in local time |
| macOS | **not verified.** This project is limited by resources — no Apple hardware is available, so the extension has never been exercised on macOS. If you run it there and hit a problem, please open an issue with your pi version, your Node version, and the `## data quality` block of the affected digest |

Linux and macOS run the same Node code path; the only platform-specific parts are the file
mode bits (best effort on Windows) and the host's shell. A problem on either should be
reported rather than assumed to be a local mistake.

## Known rough edges

- **A premature `/compact` is an empty answer, not a failure.** On a session below pi's
  keep-recent threshold, `/compact` replies "Nothing to compact (session too small)". The
  digest reports that as `skipped`, with pi's reason attached, so the first digest a new
  user reads does not say "1 failed" about an operation that had nothing to do.
- **A non-built-in model** needs an entry in `~/.pi/agent/models.json`; without pricing
  there, the host reports zero cost and workfeed passes through what the host reports. That
  is host configuration, not a workfeed setting.
- **Project-level `.pi/settings.json` versus `--approve`** is a host trust question. One
  Linux run changed both at once and could not attribute the difference — change one
  variable at a time if a project-level setting looks ignored.

## Reproducing

```bash
pi install /path/to/pi-workfeed     # or npm:pi-workfeed once published
pi --mode rpc --session-dir /tmp/s --provider <you> --model <yours> --approve
# send {"type":"prompt","message":"…"} and {"type":"compact"} on stdin,
# read {"type":"agent_settled"} to know when a task is done
node --experimental-strip-types test/run.mjs
```
