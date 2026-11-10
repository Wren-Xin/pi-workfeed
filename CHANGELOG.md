# Changelog

## [0.1.0] - 2026-11-10

**First public release.**

Numbering note: this package was built in the open, and iteration was tagged as it happened —
`0.1.0` through `0.4.6` are development milestones, none of them published. The published
line starts here, so a reader of the package metadata sees a first release rather than the
tail of an internal counter. That iteration log lives in `HISTORY.md` in the repository and
is deliberately not shipped, because a 30 kB pre-release diary beside a first version tells
a stranger more about how the sausage was made than about the sausage. The development milestones are
tagged `dev/<version>` (`dev/0.3.1` … `dev/0.4.6`) for the same reason: a `v0.4.6` tag sitting
next to an npm `0.1.0` reads as "the latest version is 0.4.6" on GitHub, and a tag list that
contradicts the installable package is worse than no tag list.

What ships in this release:

- **Todo tracking with per-item timing** — `workfeed_todo` (`write` / `list` / `clear`),
  ids that are never reused, and a cleared item that keeps the time it already spent
  (`dropped`, with its elapsed time, instead of disappearing). The tool's own prompt
  guidelines now ask for the list to be written in a turn of its own, before the tools it
  tracks: attribution is captured only while an item is `in_progress`, so a list bundled with
  a `bash` call leaves that call without an item and shows up as a lower attribution rate.
- **One append-only event log per session** (`workfeed-<sid>.jsonl`) whose lines share the
  four join keys the docs promise: `v`, `ts`, `sid`, `task`, plus `item` when work is
  attributed. Task numbering continues when the same session file is reopened.
- **A digest derived from the log, never authoritative** — tasks, tool rollup, slowest
  calls, last failures, per-item todo timing, and a `## data quality` block that states
  coverage (attribution ratio, prompts without a settle, dropped log lines, compaction
  outcomes) so a reader can tell a hedged conclusion from a solid one.
- **Wire format `schemaVersion = 1`, frozen for this release** — no new fields, no new event
  types; a snapshot test fails on any addition. `docs/schema.md` is the normative protocol,
  `schemas/workfeed-event-v1.schema.json` its machine-readable companion.
- **Verified on real hosts, not only against stubs** — Windows (pi 1.5.0) end to end
  including restart, `clear`, compaction and a killed session; Linux (Ubuntu 24.04,
  pi 1.5.1) by a second-environment rerun of the same flow. macOS is declared unverified
  (no hardware) with a request to report problems. Details in
  [`docs/verification.md`](docs/verification.md).
- **No CLI, by decision.** The replay/aggregate/digest layer is a library so the data has
  one consumer surface, the agent's own session. The README lists only the surfaces that
  exist — pi slash commands and the `rebuildDigest(path)` library call — because a reader
  who has never seen a `workfeed-digest` CLI does not need a section defending its absence;
  the argument stays here, where a decision belongs.
- **Durations keep their resolution.** The digest used to floor every duration to whole
  seconds, which printed a column of `0s` for fast tool calls — in a digest whose stated job
  is answering "which call was slow". One decimal below ten seconds, milliseconds below one.
- **Recording announces itself once.** The first log file a session creates triggers a single
  `ui.notify` naming the path and the off switch (`PI_WORKFEED_CONTENT=0`), instead of the
  privacy policy living only in a README nobody re-reads after install. The README also states
  that logs are never rotated, and how to reclaim the space.
- **The bundled skill resolves its own paths.** `SKILL.md` referred to `docs/schema.md` and
  `extensions/journal/replay.ts` as if the reader stood at the package root; an agent holding
  the skill file stands in the skill directory. Both are now relative to it (`../../docs/…`).
