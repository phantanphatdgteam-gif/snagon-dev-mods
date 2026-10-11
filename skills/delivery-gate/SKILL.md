---
name: delivery-gate
description: The harness's mechanical end-of-turn checks - a stop is held once when files changed after the last journal entry, and phrases that suggest a shortcut ("skip the tests for now", "pre-existing bug") are flagged to the person. Use to understand or answer the stop reminder, or when judging whether work is really finished.
---

# Delivery Gate (harness stop checks)

Deterministic checks at the end of a turn, from file times and text patterns, never from model judgment (idea from the upstream delivery-gate skill; see CREDITS.md).

| Check | How | On a hit |
|---|---|---|
| Journal freshness | Files changed with Edit, Write, MultiEdit or NotebookEdit after the newest journal file was written | The stop is held once with the files, the real local time and what to write; the next stop passes |
| Shortcut phrases | Patterns in your last reply ("skip the tests for now", "pre-existing bug", "not related to my change", "will fix it later", and Vietnamese equivalents) | A notice to the person only; never blocks |

Sessions started by a loop runner or by the handoff worker are exempt from the journal check.

## Answering the reminder

Append the entry it asks for: the heading with the time it gives (never estimate a time), the files changed, decision lines and lesson lines with the words it names, and the next step, in the journal's language. If the edits need no entry, append one line saying why.

## What it does not check

- Files written through Bash (heredocs, `cp`, scripts) are not seen.
- The quality of the entry: pair it with the real verification (tests, lint, type checks) before saying work is done.
- Disk space and other learning libraries (part of the upstream skill, not of this harness).
