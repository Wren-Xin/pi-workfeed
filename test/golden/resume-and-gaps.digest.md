# workfeed digest

> derived from workfeed-golden.jsonl at 2026-02-02T02:41:50.000Z — regenerate, do not hand-edit.

- session: golden
- date: 2026-02-02
- model: qwen3-8b (local-vllm)
- cwd: <…>/proj
- events: 16

## data quality

- tool calls: 3 finished, 1 started without an end line (crash, kill or abort)
- item attribution: 2/3 calls carry an item (67%)
- token totals: 2/2 tasks report a non-zero total
- log integrity: 16 lines, 0 dropped, 0 of unknown type

## tasks (2, wall clock 18s)

| # | time | turns | tools | tokens | status |
|---|---|---|---|---|---|
| 1 | 10s | 1 | 2 | 100 in / 20 out / 120 total | ok |
| 2 | 8s | 1 | 1 | 50 in / 10 out / 300 total | ok |

## tools (3 calls, 0 failed)

| tool | calls | total | avg | max | failed |
|---|---|---|---|---|---|
| edit | 1 | 3s | 3s | 3s | 0 |
| bash | 1 | 2s | 2s | 2s | 0 |
| read | 1 | 2s | 2s | 2s | 0 |

slowest calls

- 3s · edit · task 2 · item 2
- 2s · bash · task 1 · item 1
- 2s · read · task 1

## todo items (1)

0/1 completed · accumulated in-progress time 0s

| id | status | elapsed | share | text |
|---|---|---|---|---|
| 2 | in_progress | 0s | - | fix the counter |
