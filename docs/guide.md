# snagon-dev-mods user guide

Version 0.4.0. Back to the [README](../README.md).

Contents: installing and updating, `/snagon-setup`, project memory, safety gate, session journal, compaction, handoff, cost and context notices, path rules, bundled skills/agents/commands, exempt sessions, troubleshooting, development.

## 1. Installing and updating

Requirements: Claude Code 2.1.296 or later, macOS or Linux, git. sqlite3 3.33 or later is optional. Windows is not supported yet.

At the prompt of a Claude Code terminal session:

```
/plugin install snagon-dev-mods --marketplace phantanphatdgteam-gif/snagon-dev-mods
```

Answer `y` to add the marketplace, then pick a scope. User scope means every project. The two-step form:

```
/plugin marketplace add phantanphatdgteam-gif/snagon-dev-mods
/plugin install snagon-dev-mods@snagon-dev-mods
```

Update and uninstall:

```
/plugin marketplace update snagon-dev-mods
/plugin uninstall snagon-dev-mods
```

Try it without installing:

```
claude --plugin-dir <path to a clone>
```

The mod is a plugin whose hooks run in one hooks module, `hooks/register.ts`, inside Claude Code. There is no Node.js to install, no `npm install`, no MCP server and no background service. Your data is never kept in the plugin folder, so updates do not touch it. Uninstalling leaves `<project>/.snagon/` and `~/.snagon/` in place.

## 2. /snagon-setup

`/snagon-setup` is a skill the model cannot start by itself (`disable-model-invocation`). Only you, by typing it, run it.

Steps:

1. It looks at the project first: README, build files, CI, and these files if they exist: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.snagon/CLAUDE.md`, `~/.claude/CLAUDE.md`, `.snagon/config.json`. It also checks for sqlite3.
2. It interviews you in up to 4 rounds, at most 4 questions each:
   - You: reply language, how to address you, explanation level, what needs asking first.
   - Project: purpose, commands, areas that need care, what the agent must never do.
   - Files: where project rules go, the language of the files, automatic sqlite3 install.
   - Optional: allow rules in `.claude/settings.local.json` for the read-only and test commands you confirmed.
3. It writes a draft.
4. It removes every line that repeats the mod's always-on rules, its harness behaviour, `~/.claude/CLAUDE.md` or existing files.
5. It shows the result and asks you to confirm. Only then does it write.

What goes where:

```
<project>/.snagon/CLAUDE.md             personal preferences, never in git
<project>/CLAUDE.md                     project rules shared with the team, in git
<project>/.claude/settings.local.json   optional allow rules
```

Personal preferences always go to `.snagon/CLAUDE.md`. Project rules go to a shared `CLAUDE.md`, or also to `.snagon/CLAUDE.md`, as you choose in the Files round.

Merge and backup: an existing file is first copied to:

```
<project>/.snagon/backup/<name>.<YYYYMMDD-HHMM>
```

The existing text is kept word for word. New sections are added after it. Changing an existing line needs a separate yes from you.

Re-running: you can run `/snagon-setup` any time.

Non-interactive runs: with `claude -p` there is nobody to answer, so pass the answers as arguments:

```
/snagon-setup <answers>
```

## 3. Project memory

Memory is a list of short notes the agent can save and search. It is per project and per machine. It is not synced and not in git.

Tools for the model (full names are `mcp__snagon-dev-mods__memory_save` and so on):

| Tool | Use |
|------|-----|
| `memory_save` | Save one entry |
| `memory_search` | Search entries, up to 20 results |
| `memory_get` | Read one entry in full |

Kinds: `decision`, `lesson`, `feedback`, `fact`, `reference`, `preference`, `note`.

Limits: title 200 characters, body 8000 characters, up to 10 tags of 40 characters each, search returns up to 20 results.

Secrets: `memory_save` refuses text that looks like a secret: private keys, Anthropic, OpenAI, GitHub, AWS, Slack and Google keys, and quoted passwords. The refusal names only the kind of secret, never the value.

Files:

```
<project>/.snagon/memory/memory.jsonl         append-only entries
<project>/.snagon/memory/memory.db            SQLite FTS5 index, rebuilt from the JSONL when needed
<project>/.snagon/memory/journal-synced.txt   journal import bookkeeping
```

Digest: at each session start the context gets a digest: the entry count plus up to 20 newest entries. It is framed as notes, not as instructions.

Journal import: at session end, decision and lesson lines from journal files changed in the last 7 days are copied into memory. Duplicates are skipped, at most 200 lines are copied per session end, and lines that look like secrets are skipped. The words that mark these lines are `decisionWord` and `lessonWord` in the config.

Search:

- With sqlite3 3.33 or later: SQLite FTS5 full-text search, accents ignored.
- Without it: a plain scan of the JSONL file. It still works, with no ranking.

### Installing sqlite3

At session start, if sqlite3 3.33 or later is missing and `autoInstall` is true, the mod tries to install it, at most once per project per day:

- As root, it uses the system package manager: apt-get, dnf, yum, apk, pacman or zypper.
- Otherwise it uses Homebrew if present.
- It never uses sudo and never downloads a binary.
- It runs in the background and logs to `<project>/.snagon/install.log`.

When it cannot install (an ordinary user on Linux without Homebrew, or macOS without Homebrew), you see one notice line. At the start of its next reply the agent tells you what is missing and gives the exact command for your system. It does not run the command. Commands by system:

```
sudo apt-get update && sudo apt-get install -y sqlite3
sudo dnf install -y sqlite
sudo yum install -y sqlite
sudo apk add sqlite
sudo pacman -S --needed sqlite
sudo zypper install -y sqlite3
```

On macOS, install Homebrew first, then:

```
brew install sqlite
```

To stop the installer, set this in `.snagon/config.json` or `~/.snagon/config.json`:

```
{ "autoInstall": false }
```

A `false` in `~/.snagon/config.json` always wins over the project file.

## 4. Safety gate

The gate watches tool calls. It does two things: it asks the agent to state facts once, and it refuses some actions outright.

### Fact requests

The call is refused once, with a request to state facts, in these cases:

- Before the first edit or creation of each file in a session.
- Before the first Bash command of a session.
- Before each destructive command.

The agent sees a message asking it to state the facts: the files touched, a rollback, and your instruction. It states them and retries.

Exceptions and reminders:

- Files inside `<project>/.snagon/` are exempt from the first-edit rule.
- Subagent edits are not gated again.
- A push reminder asks the agent to review what will be pushed.

### Always refused

The agent sees a refusal with the reason. These are not allowed:

- `git commit` or `git push` with `--no-verify` or other hook-bypass flags.
- Editing an existing lint or formatter config file to weaken it (eslint, prettier, biome, ruff, stylelint, markdownlint and similar).
- A `git commit` or `git push` that would add a secret or a private path. Private paths are `.snagon/`, `.env` files (except `.env.example`, `.env.sample`, `.env.template`, `.env.dist`), `.pem`, `.key`, `.p12` and `.pfx` files, `id_*` keys, and memory files. The refusal names the file and the kind, never the value.
- Staging and committing in one command, such as `git add -A && git commit`.
- `git commit` or `git push` run after `cd`, with `-C`, `--git-dir` or `--work-tree`, or inside `sh -c`, `eval`, `env`, `xargs` and similar wrappers.
- A push when more than 500 local commits are not on any remote.
- A commit or push when git itself fails.

### What it does not protect against

The gate protects against accidents by an agent. It does not protect against a determined person. Do not treat it as a security boundary.

## 5. Session journal and stop reminder

The journal is a Markdown file per day:

```
<project>/.snagon/journal/YYYY-MM-DD.md
```

The folder can be changed with `journalDir` in the config. It must be a relative folder inside the project, with no `.` or `..`.

Stop reminder: if files were edited after the last journal entry, the first stop of the agent is held once with a reminder to write an entry. An entry has:

- a heading with the real local time,
- the files changed,
- lines that start with your `decisionWord` and `lessonWord` (default `Decision` and `Lesson`),
- the next step.

## 6. Compaction entry and journal tail

Before a compaction, an entry with the changed files is appended to the journal. After a compaction, the last 60 lines of the journal are added to the context.

## 7. End-of-session handoff

When it runs: at session end, if the journal changed since the last handoff.

What happens: a detached `claude -p` worker writes the handoff from the journal. Lines that look like secrets are removed from the journal text first. Settings of the worker:

- model sonnet, effort medium,
- no tools, no MCP servers,
- a budget cap of 1 USD.

Files:

```
<project>/.snagon/handoff/<date>.md
<project>/.snagon/handoff/handoff.log
<project>/.snagon/handoff/state.json
```

The next session gets the latest handoff in its context.

Extra instructions for the writer can go in either of these files:

```
<project>/.snagon/handoff-prompt.md
~/.snagon/handoff-prompt.md
```

Exempt sessions: the worker's own session is exempt from all of this, so it never starts another worker. See section 11.

Cost: typically a few US cents per session end, and only when the journal changed.

## 8. Cost and context notices

- Cost notices when a session passes 5, 10 and 50 USD. They are informational.
- A compaction suggestion at 70% of the context window, then every 5 points.
- A reminder when a subagent is spawned without a model.
- A status line with the session cost and context use.
- Per-turn cost rows in `<project>/.snagon/cost.jsonl`.

## 9. Path rules

Always-on instructions live in `instructions/always/common/*.md`: coding style, git workflow, testing, security, performance, patterns, hooks, code review, development workflow and agents (ten files).

Path rules live in `instructions/paths/<language>/*.md`. A path rule loads once per session, when you read or edit a file that matches the `paths:` globs of the rule. The language folders are:

```
angular, arkts, cpp, csharp, dart, fsharp, golang, java, kotlin, nuxt,
perl, php, python, react, react-native, ruby, rust, swift, typescript, vue, web
```

Your own instructions for every project go in:

```
~/.snagon/instructions/*.md
```

## 10. Bundled skills, agents and commands

The mod bundles 64 skills, 66 agents and 43 commands. Most come from everything-claude-code with the tool-specific parts removed. See [CREDITS.md](../CREDITS.md).

To list them, type `/help`, or type `/` and read the list. Call a command or skill by its slash name. Agents are called with the plugin prefix, for example:

```
snagon-dev-mods:planner
snagon-dev-mods:code-reviewer
```

Some commands need separate third-party tools and say so. For example the `multi-*` commands need ccg-workflow, and `council-multi-model` needs Codex.

## 11. Exempt sessions for loop runners

If the environment variable `SNAGON_WORKER`, `HANDOFF_WORKER` or `LOOP535_ROLE` is set, the session is exempt. The journal reminder, compaction entry, handoff, sqlite3 check and notices are skipped. This is meant for loop runners and for the handoff worker.

```
SNAGON_WORKER=1 claude -p "<task>"
```

## 12. Troubleshooting

Debug log: start Claude Code with `--debug` or `--debug-file <file>`. Lines from the mod start with `snagon-dev-mods:`.

```
claude --debug-file /tmp/claude-debug.log
grep 'snagon-dev-mods:' /tmp/claude-debug.log
```

Common situations:

| What you see | Meaning and action |
|--------------|--------------------|
| A call refused once with a request for facts | The safety gate. The agent states the files, rollback and your instruction, then retries. |
| A commit refused naming a file and a kind | The gate found a secret or private path. Unstage that file. |
| A notice that sqlite3 is missing | Memory search still works, without ranking. Run the command the agent gives, or set `autoInstall` to `false`. See `.snagon/install.log`. |
| No handoff appeared | The journal did not change, or the session was exempt. See `.snagon/handoff/handoff.log`. |
| Reminders in the wrong language | Set `language` to `"en"` or `"vi"` in the config. |

Configuration example (`.snagon/config.json` in a project overrides `~/.snagon/config.json` field by field):

```
{
  "language": "en",
  "decisionWord": "Decision",
  "lessonWord": "Lesson",
  "journalDir": ".snagon/journal",
  "autoInstall": true
}
```

## 13. Developing the mod

Run the tests and the validation from a clone:

```
claude plugin test .
claude plugin validate .
```

`claude plugin test .` runs 89 tests. Two developer checks use the real sqlite3 and the real install script on fake `PATH` values:

```
node tests/sqlite.check.mjs
node tests/install.check.mjs
```

Type-check, after the mod has loaded once (Claude Code writes `.claude-plugin/types/`):

```
tsc -p .
```
