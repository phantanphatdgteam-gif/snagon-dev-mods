---
description: Summarize this project's session costs from the harness log `.snagon/cost.jsonl` (one row per turn - time, session, cumulative USD, context %). Use for a per-day or per-session spend summary or a CSV export.
---

# Cost Report

The harness appends one JSON row per finished turn to `.snagon/cost.jsonl`:
`{"ts": "<ISO time>", "session": "<id>", "usd": <session total so far>, "contextPercent": <n>, "tokens": <n>}`.

1. Read `.snagon/cost.jsonl` in the project root. If it is missing, say no cost has been recorded yet (rows appear after the first finished turn).
2. A session's cost is the `usd` of its last row (the value is cumulative). Group sessions by the date of their last row.
3. Print a table: day, sessions, total USD, highest context %. With `--csv`, print `day,session,usd` lines instead.
4. Say that the figures are Claude Code's own session totals as the status line shows them; work outside the session (for example a handoff worker or `claude -p` runs) is not included.
