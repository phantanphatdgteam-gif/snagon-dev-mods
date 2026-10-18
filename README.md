# snagon-dev-mods

Version 0.5.4. Vietnamese version: [README.vi.md](README.vi.md). Full guide: [docs/guide.md](docs/guide.md).

## What it is

snagon-dev-mods is a Claude Code "mod": a plugin whose hooks run in one hooks module (`hooks/register.ts`) inside Claude Code. It does two jobs.

- In every session it keeps a project memory, guards tool calls, keeps a journal, writes a handoff for the next session and shows cost and context. `/snagon-setup` writes your project instructions.
- When you start one, it runs a flow: a feature goes from plan to release through tickets, tests first, a judge that runs your real commands and a review that has to close. You approve each step by typing a command. For now the flow works on TypeScript projects on macOS.

It also bundles 64 skills, 66 agents and 43 commands, most of them from everything-claude-code. It needs nothing but Claude Code: no Node.js, no `npm install`, no MCP server and no background service.

## Features

In every session:

- `/snagon-setup`: a short interview, then your project instructions, without repeating what the mod already does.
- Project memory: the tools `memory_save`, `memory_search` and `memory_get`, kept per project and out of git.
- Safety gate: the agent states the facts before the first edit of a file, the first Bash command and any destructive command. Git hook bypass, edits to existing lint configs and commits that carry secrets are refused.
- Journal and handoff: a reminder to write a journal entry before stopping, the journal tail after a compaction, and a handoff the next session loads by itself.
- Cost and context: a status line, notices at 5, 10 and 50 USD, and a compaction suggestion from 70% of the context window.
- Always-on coding instructions, plus path rules for 21 stacks that load when you touch a matching file.

In a flow:

- You approve what you see. The setup, the baseline, the plan, each waiver and the release show in a pane with a hash, and they count only when you type `/flow-approve` with that hash. A release also needs the one-time code the pane shows.
- Agents work from tickets the mod writes: the planner, the RED test writer, the author, the reviewers and the fixers. The main session only starts them.
- The judge runs the test, lint, typecheck and build commands you approved, in a macOS sandbox with an empty environment and no network, and compares the result with the baseline. A reply that calls the work done while the judge is red is sent back.
- A feature passes review only when no CRITICAL or HIGH finding is open, and a second look at the changed lines confirms each fix. A fix must stay inside the lines it reports: the first stray fix of a round gets a free correction, after that you decide with a waiver.
- Everything has a limit: a feature gets 3 edit, 3 review and 4 debug rounds, a session 15 USD, the flow a cap set from the size of the plan, and a main session that does not start its ticket gets 3 reminders. When a limit or a guard stops the flow, it names the cause and the commands that get you out.

## How it works

Every session runs through the same hooks:

```mermaid
flowchart TD
  A["Session start"] --> B["Prompt"]
  B --> C["Tool call"]
  C --> B
  B --> D["Stop"]
  D --> E["Session end"]
  B -.->|context grows| F["Compaction"]
  F --> B
  A --- A1["Check sqlite3<br/>register the tools"]
  B --- B1["Add rules, memory digest,<br/>latest handoff, flow card"]
  C --- C1["Before: gate, git guard, flow guards<br/>After: record edits, notices"]
  D --- D1["Hold once for a<br/>journal entry"]
  F --- F1["Write journal entry before<br/>add journal tail after"]
  E --- E1["Start handoff writer<br/>copy decisions to memory"]
```

A flow is a fixed chain of steps. The mod moves it on; you start each phase and approve what it shows you:

```mermaid
flowchart TD
  S["Setup: /flow-setup"] --> P["Plan: /flow-plan"]
  P --> B["Build: /flow-build"]
  B --> V["Verify: /flow-verify"]
  V --> H["Ship: /flow-ship"]
  S --- S1["You approve the commands and the sandbox<br/>the judge records the baseline"]
  P --- P1["The planner writes docs/flow/plan.md<br/>you approve it"]
  B --- B1["Per feature: RED tests, code, judge,<br/>review and fixes until it passes"]
  V --- V1["Every command and every criterion again<br/>report in docs/flow/verify.md"]
  H --- H1["You approve with a one-time code<br/>the mod pushes"]
```

[docs/files.md](docs/files.md) says which module is behind each step, [docs/workflow.md](docs/workflow.md) walks through a session and a flow, and [docs/guide.md](docs/guide.md) explains the flow step by step.

## Strengths

| Plain Claude Code | With snagon-dev-mods |
|-------------------|----------------------|
| A new session does not know where the last one stopped unless you tell it | Journal, handoff and memory digest carry the context over by themselves |
| Memory, when enabled, is free-form Markdown notes | Typed entries (decision, lesson, feedback, fact and more) per project, out of git, with full-text search |
| Permission prompts ask whether a tool may run | The gate also makes the agent state the facts first: who uses a file before its first edit, what a destructive command touches and how to roll it back, and your instruction word for word |
| Nothing stops a commit that skips git hooks or carries a key | Hook-bypass flags are refused, and commits and pushes are scanned for secrets and private files |
| "Done" is whatever the agent says | In a flow, done means the judge ran your commands and they passed |
| A review is one more prompt to read | In a flow, a CRITICAL or HIGH finding has to close: fixed and confirmed, or decided by you |
| A push is one permission prompt away | In a flow, nothing is published until you type the release approval with its code |
| Cost is shown when you ask for it | Status line, cost notices, a per-turn cost log, and cost caps on a flow |
| You write all the rules yourself | Eleven always-on instruction files, path rules for 21 stacks, and `/snagon-setup` |

- Needs only Claude Code: one hooks module, no Node.js, npm, MCP server or background service.
- Degrades gracefully: without sqlite3 memory still works, a missing tool is reported with the exact install command, and every hook step fails safe. The flow fails closed: a guard that cannot decide refuses the call.
- Refusals name the file and the kind of secret, never the value.
- Tested: 545 automated tests and seven developer checks with real tools. The flow was also run end to end on a three-feature test project, with a script typing the owner's commands (runs 11, 15, 17, 18 and 19 reached the release), and its four written safety scenarios passed three runs out of three. The results are in [evals/flow/](evals/flow/README.md).
- Open: MIT licence, with credits to the sources.

## Documentation

- [docs/guide.md](docs/guide.md): the full guide, including the flow.
- [docs/workflow.md](docs/workflow.md): a project from idea to result, one session from start to end, and one flow from setup to release.
- [docs/files.md](docs/files.md): what every file does.
- [docs/flow.md](docs/flow.md): the owner's guide to the flow, in Vietnamese: commands, the plan format, rounds, blocked states and their exits, the sandbox, and the known risks.
- [docs/vendor-update.md](docs/vendor-update.md): how the vendored agent-skills methods are updated.
- [evals/flow/README.md](evals/flow/README.md): the live evals of the flow and what they found.
- Vietnamese: [README.vi.md](README.vi.md), [docs/vi/workflow.md](docs/vi/workflow.md), [docs/vi/files.md](docs/vi/files.md).

## Requirements

- Claude Code 2.1.296 or later (the version that runs hooks modules). The flow was tested on 2.1.302.
- macOS or Linux. The hooks call `/bin/sh`, `/bin/date` and `/usr/bin/tail`. Windows is not supported yet.
- git, for the git checks.
- Optional: sqlite3 3.33 or later, for full-text memory search.
- For the flow:
  - macOS: the judge runs your commands under `sandbox-exec`, so on another system the flow stops at its first judge run.
  - A TypeScript project (`package.json` or `tsconfig.json`) with a test command.
  - A git repository on a branch, with a remote to release to.
  - Claude Code's Bash sandbox, which `/flow-setup` proposes for you to approve.
  - A permission mode other than `bypassPermissions`: in that mode the flow lets the agent only read.

## Install

At the prompt of a Claude Code terminal session, run:

```
/plugin install snagon-dev-mods --marketplace phantanphatdgteam-gif/snagon-dev-mods
```

Answer `y` to add the marketplace, then pick a scope. User scope means every project.

The same thing in two steps:

```
/plugin marketplace add phantanphatdgteam-gif/snagon-dev-mods
/plugin install snagon-dev-mods@snagon-dev-mods
```

To update:

```
/plugin marketplace update snagon-dev-mods
```

To try it without installing, point Claude Code at a clone:

```
claude --plugin-dir <path to a clone>
```

## First steps

In your project, type:

```
/snagon-setup
```

Only you can start it; the model cannot. It looks at the project, asks up to 4 rounds of questions (including your name and how you want to be addressed, for example "anh Minh", or "the project owner" if you prefer no name), shows a draft and writes files only after you confirm. Personal preferences go to `<project>/.snagon/CLAUDE.md`, which git ignores. Project rules go to a shared `CLAUDE.md` or to `.snagon/CLAUDE.md`, as you choose. An existing file is backed up first and kept word for word. When it is done, it tells you where the project stands and suggests the next step with a ready-to-type prompt; the agent keeps doing that after every task.

To build something with the flow, write what you want in a file of the project, for example `docs/intent.md`. Then type these commands one at a time, each when the flow asks for it:

```
/flow-setup
/flow-approve setup <hash8>
/flow-plan Build the features described in docs/intent.md
/flow-plan
/flow-approve plan <hash8>
/flow-build
/flow-verify
/flow-ship
/flow-ship
/flow-approve release <hash8> <code>
```

- Each `<hash8>` and the release code show only in the flow pane. Type them yourself.
- After `/flow-approve setup` the agent writes the approved sandbox block into `.claude/settings.local.json`, then checks that the sandbox is on. If Claude Code asks before that write, allow it: it is the block you just approved.
- If a command is already red before any change, `/flow-status` shows that baseline and `/flow-approve baseline <hash8>` accepts it.
- The second `/flow-plan` shows the plan once it passes its checks. `/flow-build` then builds every feature of the plan, one after another. If the verified work is not committed yet, `/flow-ship` asks the agent to commit it, and the next `/flow-ship` shows the release.
- Between your commands the agents work on their own. `/flow-status` tells you what the flow is waiting for.

Keep the command short and the description in a file: Claude Code sends a long pasted command to the model as a prompt, and the command never runs.

## Where data lives and privacy

Per project, in `<project>/.snagon/`. The folder writes its own `.gitignore` containing `*`, so git ignores all of it:

```
<project>/.snagon/memory/memory.jsonl
<project>/.snagon/memory/memory.db
<project>/.snagon/memory/journal-synced.txt
<project>/.snagon/journal/YYYY-MM-DD.md
<project>/.snagon/handoff/<date>.md
<project>/.snagon/handoff/handoff.log
<project>/.snagon/handoff/state.json
<project>/.snagon/flow/                 views of a flow for you to read
<project>/.snagon/config.json
<project>/.snagon/CLAUDE.md
<project>/.snagon/handoff-prompt.md
<project>/.snagon/install.json
<project>/.snagon/install.log
<project>/.snagon/cost.jsonl
<project>/.snagon/backup/
```

Per user, in `~/.snagon/`:

```
~/.snagon/config.json
~/.snagon/instructions/*.md
~/.snagon/handoff-prompt.md
~/.snagon/flow/<id8>.v<N>.json          the flow record, one file per version
~/.snagon/flow/<id8>.baseline.json      what each approved command did before any change
~/.snagon/flow/<id8>.red.json           the RED tests as they were frozen
~/.snagon/flow/<id8>.end                marks a flow that has ended
```

When a flow ends (released, or `/flow-off`), its record, baseline and RED files are deleted; the `.end` marker and the views in `<project>/.snagon/flow/` stay as history.

A flow also writes into the project itself: the plan in `docs/flow/plan.md`, the verify report in `docs/flow/verify.md`, and the sandbox block you approved in `.claude/settings.local.json`, which stays after the flow.

Nothing is kept inside the installed plugin folder, so updates never overwrite your files. Memory is per project and per machine; it is not synced and not in git. `memory_save` refuses text that looks like a secret. The flow record sits outside the project, where no agent tool, sandboxed Bash command or judge run can write it; it holds hashes and counters, and ticket text stays in the session. The mod runs no server. Two things can run detached: the sqlite3 installer, when sqlite3 is missing, and the handoff worker, a `claude -p` run that reads the journal with secret-looking values masked.

## Configuration

`.snagon/config.json` in a project overrides `~/.snagon/config.json` field by field. The exception: `"autoInstall": false` in `~/.snagon/config.json` always wins.

| Field | Values | Default | Meaning |
|-------|--------|---------|---------|
| `language` | `"en"` or `"vi"` | `en` | Language of the mod's own reminders and of everything the flow shows you |
| `decisionWord` | text | `Decision` | Word that starts a decision line in the journal |
| `lessonWord` | text | `Lesson` | Word that starts a lesson line in the journal |
| `journalDir` | folder inside the project, relative, no `.` or `..` | `.snagon/journal` | Where journal files go; used only when that folder exists |
| `autoInstall` | `true` or `false` | `true` | Let the mod try to install sqlite3 |
| `address` | text, for example `anh Minh` | empty | How the agent and the flow address you; a reply that uses the bare pronoun gets a reminder on the next prompt |

## Cost notes

- The handoff worker uses model sonnet, medium effort, no tools, no MCP servers, and a budget cap of 1 USD. Typical cost is a few US cents per session end, and it runs only when the journal changed.
- Cost notices appear when a session passes 5, 10 and 50 USD. They are informational.
- Per-turn cost rows are written to `<project>/.snagon/cost.jsonl`.
- A flow costs real money. On the three-feature test project, dry runs 17 to 19 cost 8.1 to 9.2 USD each and took 16 to 19 minutes, with main on Opus 5.5, the planner on Opus and the other agents on Sonnet. Setup was about 0.2 USD, the plan about 0.85, a feature 1.1 to 1.4 when its first review passed, and each fix with its follow-up review added about 1 to 1.5. Verify cost 0.2 to 0.6 and the release about 1.
- A flow has two cost caps: 15 USD per session, and a flow cap fixed when you approve the plan, (2 × features + 1.2) × 1.5 rounded up, which is 11 USD for three features and 5 for one (60 until a plan is approved). At a cap the flow stops and waits for you; `/flow-retry cost` raises it by half, once.

## Uninstall

```
/plugin uninstall snagon-dev-mods
```

Your data in `<project>/.snagon/` and `~/.snagon/` stays, the flow's files included, and so does the sandbox block in `.claude/settings.local.json`. Delete them yourself if you want them gone.

## Credits and license

MIT License, see [LICENSE](LICENSE). Most skills, agents and commands, and the gate's classifiers, come from everything-claude-code by Affaan Mustafa and contributors, also MIT (`LICENSES/everything-claude-code-MIT.txt`). The methods the flow quotes in its tickets come from agent-skills by Addy Osmani and contributors, MIT (`LICENSES/agent-skills-MIT.txt`). See [CREDITS.md](CREDITS.md).
