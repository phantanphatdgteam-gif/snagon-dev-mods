---
name: continuous-learning-v2
description: Turn what a session learns into durable project memory with this harness - corrections and confirmed approaches, decisions and lessons - and decide when a lesson should become a rule or skill. Use when the user corrects you, when capturing lessons from a session, when reviewing what the project has learned, or before proposing a new rule, skill or instruction line.
---

# Continuous Learning (harness memory)

Learning here is atomic and evidence-backed, as in the instinct model this skill comes from (see CREDITS.md): one trigger, one action, with the evidence beside it. The store is the harness's project memory.

## How a lesson gets into memory

1. **As it happens (you):** call `memory_save` when
   - the user corrects you or confirms a non-obvious approach: kind `feedback`;
   - a decision is made that the code and git history will not show: kind `decision`;
   - something is learned the hard way: kind `lesson`;
   - a fact, reference or preference is worth keeping: `fact`, `reference`, `preference`.
   Write the title as the behaviour ("When X, do Y" or "Y, because Z"); put the evidence (what happened, when) and the scope (this project only, or general) in the body.
2. **At session end (the harness):** journal lines that start with the decision word or the lesson word are copied into memory automatically (kind `decision` or `lesson`, tag `journal`), once each.
3. **Recall:** the newest decisions, lessons and feedback are loaded at the start of each conversation; search the rest with `memory_search` before redoing work or re-deciding something, and read an entry with `memory_get`.

## Confidence

Tag an entry `tentative` when it rests on one observation and `confirmed` when the user confirmed it or it recurred. The store only grows: when an entry turns out wrong, save a new one that says so and names the old id; never try to edit or delete entries.

## Promotion is the user's call

A lesson confirmed by the user, or seen twice, is a candidate for a rule, a skill or an instruction line. Propose it to the user with the entry ids as evidence; never write rules, skills or instructions from memory on your own. A loop that rewrites its own rules needs stricter human review, not less (see `loop-design-check`).

## Privacy

Memory is per project and per machine (`.snagon/memory/`, kept out of git by its own `.gitignore`). A save that looks like it holds a secret is refused; never save other people's personal data.
