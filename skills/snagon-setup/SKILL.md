---
name: snagon-setup
description: First-time setup of the snagon-dev-mods harness for one project. Interviews the user, then writes the project rules (a shared CLAUDE.md, or the personal .snagon/CLAUDE.md), the user's own preferences (always the personal .snagon/CLAUDE.md) and .snagon/config.json that fit them, without repeating what the harness already tells the agent. Runs only when the user types /snagon-setup.
disable-model-invocation: true
argument-hint: "[optional: answers to the interview, to skip those questions]"
---

# snagon-setup

The harness already brings general rules (coding style, testing, git, review, security, agents) and its own machinery (journal, memory, handoff, safety gate). This setup adds only what is particular to this project and this user, so nothing is said twice.

## Ground rules

- You are here because the user typed `/snagon-setup`. Never start this setup on your own, and never run it again unless they type it again.
- Write nothing until the user has approved the final draft. Never overwrite or delete a file's existing content without a yes: copy an existing file to `.snagon/backup/` first, then merge.
- Ask in the user's language (the language of their messages; English if there are none yet).
- Keep it short: at most 4 rounds with the AskUserQuestion tool, at most 4 questions each, every question offering what you detected as the first option.
- Write only rules the user gave or confirmed. A rule you think is missing (a disclaimer, a limit, a policy) is a question with options in the interview, never a silent addition to the draft.
- Answers already given (`$ARGUMENTS`, or earlier in this conversation) are not asked again. When the AskUserQuestion tool is not available (a non-interactive run), use the given answers and the detected facts, ask nothing, and mark a guess as `TODO(confirm)` in the draft. Arguments that say to write without asking again count as the approval in step 5.

Arguments: $ARGUMENTS

## Step 1: look before asking

Find, without asking anything yet:

1. The project: README, build and package files (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Makefile`, ...), CI config, test folders, `git log --oneline -10`.
2. Its commands, exactly as the repository defines them: build, test, lint, typecheck, format. Never invent one; a command you cannot find is left out.
3. Instruction files that already exist: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.snagon/CLAUDE.md` in the project, the user's `~/.claude/CLAUDE.md`, and `.snagon/config.json`.
4. What the harness already says: the headings and bullet lines of every file under `../../instructions/always/`, relative to this skill's base directory, and the list in "Harness behaviour" below.
5. Whether `sqlite3` is on the PATH (`command -v sqlite3`).

## Step 2: interview

- Round 1, the user: language for replies; how to address them, asked as their name together with the form of address their language uses (in Vietnamese for example "anh Minh" or "chị Lan"; in English just the name), with any form found in `~/.claude/CLAUDE.md` offered first. The user is then always addressed with that full form, never with a bare pronoun such as "anh" or "chị" on its own. A user who prefers not to give a name is addressed as "Chủ dự án" in Vietnamese and "the project owner" in English (the same idea in other languages); how much explanation they want; what must be asked first (commit, push, adding a dependency, deleting files, editing config, anything else).
- Round 2, the project: its purpose in one line (offer the detected one); the commands (offer the detected ones); areas needing extra care (data, money, security, public interfaces, migrations, ...); what the agent must never do here.
- Round 3, the files: where the project rules go, a shared `CLAUDE.md` (in git, for everyone) or the personal `.snagon/CLAUDE.md` (never in git, loaded by this harness for this user only); the language of the files (English is what models follow best; the user may pick theirs); whether the harness may install `sqlite3` by itself when it is missing. The journal words follow the reply language (`Quyết định` and `Bài học` for Vietnamese, `Decision` and `Lesson` otherwise) and the journal folder stays `.snagon/journal`; say they can be changed in `.snagon/config.json`, and ask only if the user wants to.
- Round 4, only if the user wants it: allow rules in `.claude/settings.local.json` for the confirmed read-only and test commands. Write only the rules they tick; never propose a destructive command.

## Step 3: draft

Two parts, each using only the sections that have content, together under about 60 lines. The user's own preferences (round 1) are personal: they always go to `.snagon/CLAUDE.md`, never to a file in git.

Personal part, `.snagon/CLAUDE.md`:

```markdown
# Working with <form of address>
- Address the user as "<form of address>" every time, never the bare "<pronoun>"; refer to yourself as "<self>".
- Reply in <language>; <how much explanation>.
- Ask before: <list>.
```

Project part, in the file chosen in round 3:

```markdown
# <Project name>

<What it is and who uses it, one or two lines.>

## Commands
- Test: `<command>`
- Lint: `<command>`

## Project rules
- <rules particular to this project: data, domain, areas needing care>

## Never
- <what the agent must never do here>
```

## Step 4: remove repeats

Go through the draft line by line and delete each line that says the same thing as any of these, even in other words:

- a rule in `../../instructions/always/` (for example immutability, file and function size, error handling, input validation, the 80% coverage target and test-first work, commit message format, the pull request steps, the review checklist, the security checklist, agent use, model choice);
- the harness behaviour below;
- the user's `~/.claude/CLAUDE.md`, or a file the project already has.

A project's exception to a harness rule stays, written as the exception (for example "Coverage target here is 60%, not 80%"). Keep a list of what you deleted to show the user.

## Step 5: show, confirm, write

1. Show both parts of the final draft, the config, any permission rules from round 4, and the lines removed as repeats (one line each). Ask: write / change something / cancel.
2. On write:
   - When both parts go to `.snagon/CLAUDE.md`, write them as one file. If a target file exists, copy it to `.snagon/backup/<file name>.<date +%Y%m%d-%H%M>` first, then merge: keep its text exactly as it is (same words, same order, same headings) and add the new sections after it. Leave out of the new sections whatever the existing text already says. Rewording, moving or deleting an existing line is a separate change: list it in step 5 and make it only on an explicit yes for that change; a general approval to write does not cover it.
   - Write `.snagon/config.json` with only the fields the user set (table below), always including `address` from round 1; when it exists, back it up and change only those fields. Permission rules from round 4 are added to the `permissions.allow` list of `.claude/settings.local.json` (backed up first; nothing in it is removed or replaced). If `.snagon/.gitignore` is missing, create it with the single line `*`.
3. Report in a few lines: the files written, the repeats left out, and that `/snagon-setup` can be run again at any time.
4. Lead the next step; never leave the user to work out what comes next. From what you learned about the project and its goal, say where it stands on the path setup → idea check → criteria and evals → design → plan → build each feature → verify → ship → docs → learn and measure, and what the next step is. When a decision is open now (for example the language and stack of a new project, the data store, the first feature), give one recommended option and up to two others, each with its reason and its cost, recommended first. Give a ready-to-type first prompt for that step, and end with a closed question.

## Harness behaviour (never restate it in the file)

- Session journal in the configured folder, the stop reminder to write it, and the entry written before a compaction.
- Project memory: the `memory_save`, `memory_search` and `memory_get` tools, the digest at session start, decision and lesson lines copied from the journal.
- The end-of-session handoff and its pickup by the next session.
- The fact-forcing gate before the first Bash command, before the first edit of each file and before destructive commands.
- The git guard: no `--no-verify`, no commit or push of a secret or a private path, no staging and committing in one command.
- Protection of lint and formatter config files.
- Cost and context notices, the subagent model reminder, rules loaded by file path.
- Leading the user to the next step with a recommended option (the always-on `guidance.md`).

## `.snagon/config.json`

| Field | Values | Default |
|---|---|---|
| `language` | `en` or `vi`: the language of the harness's own reminders | `en` |
| `decisionWord`, `lessonWord` | the words that start decision and lesson lines in the journal | `Decision`, `Lesson` |
| `journalDir` | a folder inside the project, relative | `.snagon/journal` |
| `autoInstall` | `true`: install `sqlite3` in the background when it is missing, only through Homebrew or, as root, the system package manager (never sudo) | `true` |
| `address` | the form of address from round 1, for example `anh Minh` or `Chủ dự án`; when it starts with a pronoun, a reply that uses the pronoun alone gets a reminder on the next prompt | empty |
