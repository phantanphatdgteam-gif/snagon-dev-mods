# snagon-dev-mods user guide

Version 0.5.4. Back to the [README](../README.md).

Contents: installing and updating, `/snagon-setup`, project memory, safety gate, session journal, compaction, handoff, cost and context notices, path rules, bundled skills/agents/commands, the flow, exempt sessions, troubleshooting, development.

## 1. Installing and updating

Requirements: Claude Code 2.1.296 or later, macOS or Linux, git. sqlite3 3.33 or later is optional. Windows is not supported yet. The flow has its own requirements (section 11).

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

The mod is a plugin whose hooks run in one hooks module, `hooks/register.ts`, inside Claude Code. There is no Node.js to install, no `npm install`, no MCP server and no background service. Your data is never kept in the plugin folder, so updates do not touch it. Uninstalling leaves `<project>/.snagon/` and `~/.snagon/` in place. Update between flows: a flow that is running when the mod's files change is blocked as `tampered` at its next check.

## 2. /snagon-setup

`/snagon-setup` is a skill the model cannot start by itself (`disable-model-invocation`). Only you, by typing it, run it.

Steps:

1. It looks at the project first: README, build files, CI, and these files if they exist: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.snagon/CLAUDE.md`, `~/.claude/CLAUDE.md`, `.snagon/config.json`. It also checks for sqlite3.
2. It interviews you in up to 4 rounds, at most 4 questions each:
   - You: reply language, your name together with how to address you (for example "anh Minh"; never a bare pronoun; "Chủ dự án" or "the project owner" if you prefer not to give a name), explanation level, what needs asking first.
   - Project: purpose, commands, areas that need care, what the agent must never do.
   - Files: where project rules go, the language of the files, automatic sqlite3 install.
   - Optional: allow rules in `.claude/settings.local.json` for the read-only and test commands you confirmed.
3. It writes a draft.
4. It removes every line that repeats the mod's always-on rules, its harness behaviour, `~/.claude/CLAUDE.md` or existing files.
5. It shows the result and asks you to confirm. Only then does it write. It writes only rules you gave or confirmed; a rule it thinks is missing is asked as a question.
6. It tells you where the project stands (setup → idea → criteria → design → plan → build → verify → ship → docs → learn) and recommends the next step: one recommended option and up to two others with their costs, plus a ready-to-type prompt.

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

Digest: at each session start the context gets a digest: the entry count plus up to 20 of the newest decision, lesson, feedback and preference entries. It is framed as notes, not as instructions.

Journal import: at session end, decision and lesson lines from journal files changed in the last 7 days are copied into memory. Duplicates are skipped, at most 200 lines are copied per session end, and lines that look like secrets are skipped. A decision line starts with `decisionWord` and a lesson line with `lessonWord` from the config; `Decision`, `Quyết định`, `Lesson` and `Bài học` always count too.

Search:

- With sqlite3 3.33 or later: SQLite FTS5 full-text search, accents ignored.
- Without it: a plain scan of the JSONL file, ranked by how many of the words match, then by date.

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

The gate watches tool calls. It does two things: it asks the agent to state facts once, and it refuses some actions outright. While a flow is active, the flow adds its own guards on top (section 11).

### Fact requests

The call is refused once, with a request to state facts, in these cases:

- Before the first edit or creation of each file in a session.
- Before the first Bash command of a session.
- Before each destructive command.

Each case asks for its own facts:

- before an edit: the files that import the file, the public functions it affects, the fields of any data file it reads or writes, and your instruction word for word;
- before creating a file: what will call it, that no existing file does the same job, and your instruction;
- before a destructive command: what it will change or delete, a one-line rollback, and your instruction;
- before the first Bash command: your request in one sentence, and what the command checks or produces.

The agent states them and retries.

Exceptions and reminders:

- Files inside `<project>/.snagon/` are exempt from the first-edit rule.
- Subagent edits are not gated again.
- A push reminder asks the agent to review what will be pushed.

### Always refused

The agent sees a refusal with the reason. These are not allowed:

- `git commit` or `git push` with `--no-verify` or other hook-bypass flags.
- Editing an existing lint or formatter config file (eslint, prettier, biome, ruff, stylelint, markdownlint and similar), since an edit there could weaken the checks.
- A `git commit` or `git push` that would add a secret or a private path. Private paths are `.snagon/`, `mods/*/local/`, `.env` files (except `.env.example`, `.env.sample`, `.env.template`, `.env.dist`), `.pem`, `.key`, `.p12` and `.pfx` files (since 0.6.0 a `.pem` that holds only certificates passes commit, push and release; a private key in any version of it still blocks, and `.key`, `.p12` and `.pfx` stay blocked by name), `id_rsa`, `id_ed25519` and `id_ecdsa` keys with their `.pub` files, and the memory files `memory.jsonl` and `memory.db`. The refusal names the file and the kind, never the value.
- Staging and committing in one command, such as `git add -A && git commit`.
- `git commit` or `git push` run after `cd`, with `-C`, `--git-dir` or `--work-tree`, or inside `sh -c`, `eval`, `env`, `xargs` and similar wrappers.
- `git commit` or `git push` through a git alias (given with `-c alias.…` or set in git config, chains included), through a shell alias that hands its words to git or a shell, with the command word quoted or in a variable (`"git" push`, `git "push"`, `$G push`, `git $(echo push)`), through git subcommands that run other commands (`submodule foreach`, `rebase -x`, `bisect run`), or as an unknown command when `help.autocorrect` would run the closest one. An environment prefix (`A=1 git push`), line breaks and shell syntax (`(git push)`, `then git commit`, functions, `case`) do not hide git from the guard.
- A push when more than 500 local commits are not on any remote.
- A commit or push when git itself fails.

### What it does not protect against

The gate protects against accidents by an agent. It does not protect against a determined person. Do not treat it as a security boundary.

## 5. Session journal and stop reminder

The journal is a Markdown file per day:

```
<project>/.snagon/journal/YYYY-MM-DD.md
```

The folder can be changed with `journalDir` in the config. It must be a relative folder inside the project, with no `.` or `..`, and it must already exist; otherwise the journal stays in `.snagon/journal`.

Stop reminder: if files were edited after the last journal entry, the first stop of the agent is held once with a reminder to write an entry. An entry has:

- a heading with the real local time,
- the files changed,
- lines that start with your `decisionWord` and `lessonWord` (default `Decision` and `Lesson`),
- the next step.

## 6. Compaction entry and journal tail

Before a compaction, an entry with the changed files is appended to the journal. After a compaction, the last 60 lines of the journal are added to the context.

## 7. End-of-session handoff

When it runs: at session end, if the journal changed since the last handoff.

What happens: a detached `claude -p` worker writes the handoff from the journal. The journal text is masked first: each secret-looking value is replaced where it stands, and private-key blocks are blanked. Settings of the worker:

- model sonnet, effort medium,
- no tools, no MCP servers,
- no budget cap (0.5.x set 1 USD; the cost caps were removed on 2026-10-20).

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

Exempt sessions: the worker's own session is exempt from all of this, so it never starts another worker. See section 12.

Cost: typically a few US cents per session end, and only when the journal changed.

## 8. Cost and context notices

- Cost notices when a session passes 5, 10 and 50 USD. They are informational.
- A compaction suggestion at 70% of the context window, then every 5 points.
- A reminder about the model and effort each time a subagent is spawned.
- A status line with the session cost and context use.
- Per-turn cost rows in `<project>/.snagon/cost.jsonl`.
- During a flow, the flow card shows the session cost and the flow cost (`Cost: session $X; flow $Y`), and after each main turn the status line shows `snagon-dev-mods flow: session $X; flow $Y; phase <phase> $Z`. During a flow this replaces the normal cost and context status, so context use is not shown while a flow runs. Nothing stops the flow because of an amount: the project owner removed every cost cap on 2026-10-20 (section 11, "Rounds and cost").

## 9. Path rules

Always-on instructions live in `instructions/always/common/*.md`: coding style, git workflow, testing, security, performance, patterns, hooks, code review, development workflow, agents and guidance (eleven files). Guidance makes the agent lead you to the next step after every task and address you the way your config says. The flow rules, `skills/flow-loop/SKILL.md`, load the same way in every conversation, and every ticket agent reads them too; their text applies only while a flow is active.

Path rules live in `instructions/paths/<language>/*.md`. A path rule loads once per session (and once more after a compaction), when you read or edit a file that matches the `paths:` globs of the rule. The language folders are:

```
angular, arkts, cpp, csharp, dart, fsharp, golang, java, kotlin, nuxt,
perl, php, python, react, react-native, ruby, rust, swift, typescript, vue, web
```

Your own instructions for every project go in:

```
~/.snagon/instructions/*.md
```

## 10. Bundled skills, agents and commands

The mod bundles 64 skills, 66 agents and 43 commands. Most come from everything-claude-code with the tool-specific parts removed. See [CREDITS.md](../CREDITS.md). The `skills/` folder holds one more, `flow-loop`, which nobody calls: it is the flow rules of section 9. The thirteen `/flow-*` commands are registered by the hooks module, not kept in `commands/`.

To list them, type `/help`, or type `/` and read the list. Call a command or skill by its slash name. Agents are called with the plugin prefix, for example:

```
snagon-dev-mods:planner
snagon-dev-mods:code-reviewer
```

Some commands need separate third-party tools and say so. For example the `multi-*` commands need ccg-workflow, and `council-multi-model` needs Codex.

## 11. The flow

The flow takes work from a plan to a release in fixed steps. The mod decides which agent does what through tickets; you start each phase and approve what it shows you. [flow.md](flow.md) is the owner's guide in Vietnamese, with the same content and the full fine print.

### What it needs

- macOS: the judge runs commands under `sandbox-exec`, so on another system the flow stops at its first judge run.
- A TypeScript project (`package.json` or `tsconfig.json`) with a test command: a `test` script, or `/flow-setup test="<argv>"`. Or a Python project (`pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt` or `Pipfile`) with a `.venv` that holds pytest (see "Python projects" below). A project that matches both stacks is refused until you pick one: `/flow-setup stack=typescript` or `/flow-setup stack=python`.
- A git repository on a branch (not a detached HEAD), with a remote to release to.
- Claude Code's Bash sandbox on for the project. `/flow-setup` proposes the settings block and you approve it.
- A permission mode other than `bypassPermissions`. In that mode the flow lets the agent only read.
- No registry credentials in the environment (`NPM_TOKEN` and the like; for Python `TWINE_PASSWORD`, `UV_PUBLISH_TOKEN` and the like, or a URL with a password in a `PIP_`, `UV_` or `POETRY_` variable) or in the project's `.npmrc` or `.yarnrc.yml` (for Python `pip.conf`, `uv.toml`, `poetry.toml`, `pyproject.toml`, `requirements*.txt`, `constraints*.txt`, `Pipfile` or `.pypirc`), and the mod loaded from an installed copy, not from a folder the agent could write.
- A journal folder under `.snagon/` or ignored by git; the default `.snagon/journal` is.

`/flow-setup` checks all of this and lists every problem at once.

### From setup to release

A flow belongs to one git repository (linked worktrees share it), and one session holds it at a time; another session only watches until you type a flow command there. With every prompt, main gets a flow card of at most 12 lines: the step, the rounds used, open findings, the blocked cause if there is one, the sandbox, the session and flow cost, and the next step with its command. `/flow-status` shows you the same card. The flow pane opens only when something waits for your approval, and the hash8 and the release code show only there.

1. Setup. `/flow-setup` finds the stack (TypeScript or Python; it names the one it chose on the first line, `Stack: <id>`) and the `test`, `lint`, `typecheck` and `build` commands, and shows them in the pane with the proposed sandbox block, the remote and the branch a release goes to. If anything keeps the flow from starting here, it replies with every reason instead. `/flow-approve setup <hash8>` freezes the setup. The agent writes the sandbox block into `.claude/settings.local.json` and runs a sandbox probe. The judge then runs every command once on the project as it is: that is the baseline. If a command is red, `/flow-status` shows the baseline and `/flow-approve baseline <hash8>` accepts it as "no new failures". A red command whose failures cannot be read has to be fixed, or dropped with `/flow-setup <command>=none`.
2. Plan. `/flow-plan <what to build>` hands your request to the planner (Opus), which writes `docs/flow/plan.md`. The mod checks the plan and sends the problems back to the planner. When it passes, `/flow-plan` with no text shows it in the pane, and `/flow-approve plan <hash8>` freezes it. `/flow-reject plan` throws it away so you can ask again.
3. Build. `/flow-build` runs the features in plan order, with no command from you in between. For each feature:
   - RED: tdd-guide writes the tests for its criteria. They must fail the right way (a missing new module, a missing export, or a failing assertion), and then they are frozen: editing or weakening them later is caught.
   - Implement: tdd-guide writes the code. It may change only the files the plan lists for the feature.
   - Judge: every approved command and the tests that carry the criteria ids run against the baseline, with scans for downgrades and newly added junk. A red judge gets a debug ticket.
   - Review, fixes and a second look until the feature passes (below). Then it is sealed and the next one starts.
4. Verify. `/flow-verify` runs every command again at the current tree with every Required criterion, scans the whole flow diff for junk, and writes `docs/flow/verify.md` in your language.
5. Ship. If the verified work is not committed yet, `/flow-ship` asks main to commit it (`.claude/settings.local.json` stays out of the commit), and you type `/flow-ship` again. Then it scans the commits to publish and the files of HEAD for private data, and shows the release on one screen: the commit, the remote, the number of commits, the scan result and `Verify report: docs/flow/verify.md (<hash8>)`. `/flow-approve release <hash8> <code>`, typed at the prompt, checks everything again; the mod pushes and the flow is done. A wrong code is used up, and `/flow-ship` shows a new one.

Main does not write the plan, the tests or the code itself; the flow rules tell it to start a ticket instead. For a ticket it calls the Agent tool with the prompt `TICKET <id>`, and the mod swaps in the ticket text, the routed agent and its model. The agent runs in the background; when its completion notice arrives, main calls `flow_check` to move the flow on. Finding and ticket ids are never reused within a flow, even after a feature is sealed.

### Commands

| Command | Use |
|---|---|
| `/flow-setup [stack=<id>] [test\|lint\|typecheck\|build="<argv>"] [<command>=none] [tools=+<Tool>] [mcp=+mcp__<server>__<tool>]` | Start a flow, or freeze the setup again (stack, commands, tools, MCP tools). `stack=typescript` or `stack=python` is needed only when both match |
| `/flow-plan <what to build>` | Hand the request to the planner |
| `/flow-plan` | Show the checked plan for approval |
| `/flow-build` | Build the features of the approved plan |
| `/flow-verify` | Verify everything after the last feature, or again when the flow says so |
| `/flow-ship` | Show the release and its code; if the verified work is not committed yet, ask main to commit it first |
| `/flow-approve setup\|baseline\|plan\|waive\|allow <hash8>` | Approve exactly what the pane shows |
| `/flow-approve release <hash8> <code>` | Approve the release, with the 6-character code |
| `/flow-decide <X-n> fix\|reject\|followup` | Decide a finding that blocks |
| `/flow-retry plan\|F-NN\|verify\|check` | One more set of rounds for a scope at its cap (once per scope), or a check run again |
| `/flow-waive check:<cmdId>\|FL-n\|J-n <reason>` | Waive a red check, or a floor or junk finding; the waiver shows in the pane and needs `/flow-approve waive <hash8>` |
| `/flow-allow red F-NN <reason>` | When a feature's RED tests have a fault of their own and its debug rounds ran out: the reason shows in the pane, and after `/flow-approve allow <hash8>` exactly one debug ticket of that feature may edit the RED test file. The change still comes back as a `red-test-changed` finding for you to read and waive. It needs the flow to be building that feature with its RED tests recorded. It costs no round and writes a line to `.snagon/flow/waivers.md` |
| `/flow-reject plan` | Reject the plan and plan again |
| `/flow-status` | Show where the flow stands |
| `/flow-off [<id8>]` | End the flow (its files in `.snagon/flow` stay as history), delete the refs that kept its git trees (below), name any repository config or git hook that changed since the freeze, and remind you to review `package.json` and the lockfile, reinstall the dependencies and look at the git hooks before your next commit (the reminder names both stacks: `rm -rf node_modules && npm ci`, or recreate `.venv` from the lockfile) |

Flow commands count only when you type them at the prompt or send them through Remote Control, and a release approval only at the prompt. The model cannot run them, as commands or as skills. A command typed while an agent works is queued and runs when the turn ends. A long text pasted after a command is sent to the model as a prompt, and the command never runs: keep the command short and put the description in a file (`/flow-plan Build the features described in docs/intent.md`).

### The plan

The planner writes `docs/flow/plan.md`, and you read it before you approve it. The mod accepts only this shape and reports each problem with its line so the planner can fix it:

```markdown
## Acceptance
- AC-001 (Required): adding two numbers returns their sum. Verification: test name contains `AC-001`
- AC-002 (Optional): a CLI prints the sum. Verification: test name contains `AC-002`

## Features
### F-01: Add numbers
- ACs: AC-001
- Files: src/sum.ts, tests/sum.test.ts (new)
- Security: no

### F-02: Print the sum
- ACs: AC-002
- Files: src/cli.ts (new), tests/cli.test.ts (new)
- Security: yes
```

- A criterion is one line, `- AC-nnn (Required|Optional): <behaviour>. Verification: …`, with no number used twice. It names new behaviour; "the existing tests stay green" is part of done for every feature, not a criterion. A criterion's tests carry its id in their names, which is how the judge knows which tests prove which criterion (`AC-001` for TypeScript; for Python also `AC_001` or `ac_001`, below).
- A feature is `### F-nn: <title>` followed by exactly the lines `- ACs:`, `- Files:` and `- Security: yes|no`, each once. Ids run F-01, F-02 and on, in order, at most 50 features.
- Every Required criterion is covered by a feature, and every feature lists at least one criterion and one test file.
- `Files:` holds plain file paths inside the project; a file that does not exist yet is marked `(new)`. Folders, wildcards, files of a loaded plugin, `.snagon/`, protected files (git, Claude or editor settings, rc files, `verify.md`) and private files (keys, `.env`) are refused.
- Nothing is left open (`TBD`, `TODO`, `later`, `Deferred:`), and no invisible character hides part of a line.
- `Security: yes` adds the security reviewer to every review round of that feature. The mod also adds it when the new code touches sensitive ground such as files, the network, processes, environment variables, cryptography, authentication or a database.

### Python projects

The Python stack is new in 0.6.0. [flow.md](flow.md) has the full description in Vietnamese. In short:

- The project has one of `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt` or `Pipfile` in its root. If a `package.json` or `tsconfig.json` is there too, `/flow-setup` refuses until you pick: `/flow-setup stack=python`.
- It proposes `.venv/bin/pytest` as the `test` command, `.venv/bin/mypy` as `typecheck` and `.venv/bin/ruff check` as `lint` when the project configures them, and never a `build`. Setup refuses when `.venv/bin/pytest` does not exist, or when the venv uses the system's site-packages or has a `.pth` line that puts a path outside the project on `sys.path`. Override a command with `/flow-setup test=".venv/bin/pytest -q"` (an argument that itself holds a space cannot be given).
- The judge runs the venv's pytest with its cache plugin off and reads each test's result from a JUnit XML report it asks pytest to write, trusted only while pytest's own last summary line agrees with it. A test command that is not pytest (`unittest`, tox, nox, `uv run pytest`) runs as approved but leaves no report: setup says so, no acceptance criterion can then be proven, and the judge stays red until you approve a pytest command. The same holds for a TypeScript runner that writes no report.
- A test proves an acceptance criterion only when the criterion's id is in the test's name, including its pytest parameter id: `AC-001`, `AC_001` or `ac_001` (so `test_ac_001_clamps_below` works; `ac-001`, `Ac_001` and a docstring or comment do not). The planner is told to name tests so. The example `Files:` line for Python is `src/pkg/a.py, tests/test_a.py (new)`; test files are `test_*.py`, `*_test.py`, `conftest.py` and anything under `tests/` or `test/`.
- A new test counts as RED when it fails by an assertion (including pytest's `DID NOT RAISE`), by a `ModuleNotFoundError` for a module the plan marks `(new)`, or by an `ImportError` or `AttributeError` for a name of the project's own that does not exist yet. A syntax error, a `NameError` or a setup error is not RED.
- The whole `.venv` is hashed by content before every judged run, with its interpreter, `.pth` files, `sitecustomize` and the pytest plugins it loads by name (about 0.36 s on the fixture, measured on 2026-10-21). Installing a package into it outside an accepted dependency-only edit blocks the flow as `tampered`. A feature that only changes dependencies in `pyproject.toml` (and in `uv.lock` or `poetry.lock`) and lists those files in `Files:` is accepted once and the hash is taken again. Changes to the other files that decide how the commands run block as `cmdSrc`: the pytest, mypy and ruff configs, `.gitignore`, `conftest.py` (one that a feature lists in `Files:` is a reviewed edit that forces `Security: yes`), the lock and requirements files, git-ignored files the judge can load (`*.py`, `*.pyc`, `*.so`, `*.pth` and the like, compared by content) and a new file that shadows a standard-library or runner module.
- Not covered: one stack per flow, with the root's `.venv` (monorepos with nested venvs are not modelled); no `build` command; pytest is the only runner that proves criteria; the base interpreter's standard library is hashed once at setup for the echo and not checked again; the fixture runs used Python 3.14.8, pytest 9.1.1, ruff 0.17.1 and mypy 2.4.0, and other versions are not verified.

### Rounds and cost

| Scope | Edit | Review | Debug | Judge runs at most | `/flow-retry` (once) adds |
|---|---|---|---|---|---|
| plan | 3 | — | — | 4 | 1 edit |
| each feature | 3 | 3 | 4 | 15 | 1 edit, 1 review, 2 debug |
| verify | 2 | — | 3 | 9 | 1 edit, 2 debug |

- Edit: in the plan, every planner ticket counts, the first one included. In a feature, the first RED and the first implementation are free; a RED or an implementation asked again, and each fix ticket, cost one. In verify, an edit is a junk fix.
- Review: the first round and each second look. A round holds every reviewer the feature needs. A round whose reviewer did not report back fully is asked again and still counts; a scope correction and a ticket lost when a session restarts do not count.
- Debug: each red judge handed to the debugger.

Cost: there is no cost cap. Through 0.5.4 a flow had a cap of 15 USD per session and a flow cap set from the size of the plan, and `/flow-retry cost` raised a cap by half; the project owner removed them all on 2026-10-20 (no session cap, no flow cap, no per-phase notice). The flow only measures and shows the spend: the card line `Cost: session $X; flow $Y`, and the status line after each main turn. The rounds above are the only limits. The informational notices at 5, 10 and 50 USD are kept. Measured on a three-feature TypeScript test project (dry runs 17 to 19, recorded 2026-10-18; the heading of the table that holds them says main on Opus 5.5): 8.09, 8.82 and 9.18 USD and 16 to 19 minutes for the whole flow. Per-phase figures exist for runs 11, 13 and 15 of that table: setup 0.20 to 0.25 USD, the plan 0.81 to 0.86, a feature 1.0 to 2.5, and in run 15 F-03, with a fix round, three waivers and a second look, cost 3.69, about 2.3 more than its clean F-02 at 1.38. Runs 20 and 21 (2026-10-18, same table heading) cost 6.61 and 7.02 USD. The 0.6.0 fixture dry runs with main on Haiku cost 3.57 USD and 13 minutes on the TypeScript fixture and 3.44 USD and 17 minutes on the Python fixture on 2026-10-20 (the code of that day), and 3.09 and 3.19 USD and 12 minutes (TypeScript) and 2.97 USD and 13 minutes (Python) on the code of this release (2026-10-21). The main model is your choice and the figures depend on it.

### Review and fixes

- A green judge opens a review round: a ticket for the code reviewer, plus the security reviewer when the feature needs one. The stack's own reviewer takes it when at least 70% of the changed lines are in the stack's files (`typescript-reviewer` for `.ts`, `.tsx`, `.mts`, `.cts`; `python-reviewer` for `.py`, `.pyi`); otherwise it is `code-reviewer`.
- A red judge gets a debug ticket. A red typecheck, build or lint goes to the stack's build fixer, a red test to the debugger (`tdd-guide`). TypeScript's build fixer is `build-error-resolver`; Python has none of its own yet, so `tdd-guide` takes it too. With several commands red, the first in the approved order decides.
- A CRITICAL or HIGH finding blocks the seal. MEDIUM and LOW findings still open at the seal become follow-ups in the verify report.
- While a blocking finding is open, the author gets a fix ticket. The reply answers findings with `FIX <id> | <file>:<first>-<last>` (where it fixed it) or `DISPUTE <id> | <reason>`. It must answer at least one open CRITICAL or HIGH finding of the feature, or it is not attested and the ticket goes out again; a finding it leaves out stays open for the next round. FIX lines are read as agents write them: an absolute path, a reason after the range and `file:n` are all understood.
- After a fix the judge runs again, and every changed hunk must sit inside a FIX range the author reported, or in the feature's test files. If one does not, the flow sends one scope-correction ticket per review round, free: the author reverts the hunk (`REVERT FL-n`) or reports a FIX range that holds it whole. A hunk still outside after that blocks the flow until you waive it (`/flow-waive FL-n <reason>`).
- The second look (a delta round) shows the reviewer only what changed since the round before. The reviewer marks each finding `RESOLVED`, `OPEN`, `UPHOLD` or `WITHDRAW`, with a reason if it likes. A reviewer that gives no verdict on a fixed or disputed finding is asked again, and no fix ticket is ever sent with nothing in it to fix.
- When the reviewer upholds a finding the author disputed, the flow blocks as `dispute` and you decide with `/flow-decide <id> fix|reject|followup`.
- A feature passes when the judge is green at the current tree, the last review round holds every required reviewer at that same tree, and no CRITICAL or HIGH finding is open.

### When the flow is blocked

Blocked is not done. The card says `Blocked, NOT done: <cause>`, and its last line, `Next: <you> decides. Command: …`, lists the exits. Main stops and reports; you pick one.

| Cause | Exits |
|---|---|
| A scope used all its rounds (`cap`) | `/flow-decide <X-n> fix\|reject\|followup` · `/flow-retry <scope>` · `/flow-reject plan`; when a feature's debug rounds ran out, also `/flow-allow red F-NN <reason>` (the RED tests have a fault of their own) |
| The reviewer upheld a disputed finding (`dispute`) | `/flow-decide <X-n> fix\|reject\|followup` · `/flow-reject plan` (`/flow-retry` adds rounds but does not settle a dispute) |
| The approved plan changed (`frozenChanged`); a feature too large for one ticket (`split`) | `/flow-reject plan` |
| Plan check errors (`planLint`) | `/flow-reject plan` · `/flow-retry plan` (one more planner round, once) |
| A file that decides what the commands do changed (`cmdSrc`); the remote or the git settings of the push changed (`remoteChanged`); a command ran too long (`tooSlow`); the sandbox differs from the approved block (`sandboxMismatch`); the sandbox probe was inconclusive (`probeInconclusive`); a settings key lets commands leave the sandbox (`sandboxKey`) | `/flow-setup` |
| A protected file changed (`tampered`): the runner's tree (`node_modules`, `.venv`), a git ref outside the flow's own that was frozen at setup, and the like; after a mod update the card names the old and the new version | `/flow-setup` · `/flow-off` |
| A check could not run (`couldNotRun`) | `/flow-retry check`; when the repository config or git hooks could not be read: fix that, then `/flow-setup` |
| Main did not start its ticket after 3 reminders (`stalled`) | `/flow-retry check` · `/flow-off` |
| A command is red (`redCheck`) | `/flow-waive check:<cmdId> <reason>` |
| A downgrade (`floor`), new junk (`junk`), text aimed at the reviewer (`injection`), an edited RED test (`redTestChanged`) | `/flow-waive <id> <reason>` |
| The remote rejected the push (`pushRejected`); the verify report changed after verify (`reportChanged`) | `/flow-verify` · `/flow-off` |
| Publishing would leak private data (`publish`) | `/flow-verify` · `/flow-ship` · `/flow-off` |
| Another session holds the flow (`viewOnly`) | `/flow-status`; any flow command typed here takes it over |

- When the flow only waits for one of your commands, the last card line (`Next: …`) names it; that is not a block. When no pane can be drawn where you typed a command, the reply says to open a terminal or the desktop app.
- `/flow-retry` gives each scope one more set of rounds, once. `/flow-retry check` runs the check again and costs no round.
- When main does not start the ticket it was given, the Stop hook sends it back at most 3 times for that ticket, then the flow blocks as `stalled` without charging a round. Every prompt you type yourself starts the count again. Read what main said, then type `/flow-retry check` to offer the ticket again, or `/flow-off`.
- A refusal that starts with `flow:` is a flow guard at work. Main follows its hint or stops to ask you; it never works around it.

### Guards while a flow is active

- Only ticket agents and read-only `Explore` agents start. The flow rules tell main not to write the feature itself (an instruction, not an enforced limit), and while the last check is red only the feature's files may change.
- Nothing runs in the background: `run_in_background`, an `&` that sends a command to the background, `setsid`, `tmux`, `screen` and Monitor are refused, because a background process could swap files between the judge's check and its run.
- Nothing is published before the release: `git push`, `npm publish`, and for Python `twine upload`, `uv publish`, `poetry publish`, `pdm publish`, `hatch publish`, `flit publish` and their relatives are refused. The mod pushes after your release approval.
- Tools outside the flow's list (WebFetch, WebSearch, an MCP tool you have not added) are refused. Add a tool with `/flow-setup tools=+<Name>`, or an MCP tool by its full name with `/flow-setup mcp=+mcp__<server>__<tool>`; the refusal gives the exact command.
- `.snagon/`, `.claude/`, `.git`, `.mcp.json` and the other protected files stay unchanged, apart from `*.md` files directly in the journal folder and the two writes the flow asks for (the approved settings block, the release commit). Flow data and transcripts cannot be read.
- Screen capture (`screencapture`, `osascript`, screen-reading MCP tools) is refused, since approvals and the release code are on the screen.
- A guard that cannot decide refuses the call (`flow: the guard could not check this call, so it is refused`).

### Before your first flow

[flow.md](flow.md) gives the full detail of four things, in Vietnamese. In short:

1. The sandbox is required. `/flow-setup` refuses settings that loosen it (`excludedCommands`, `allowUnixSockets`, `allowedDomains: ["*"]` and the like) and names the layer that holds them. The probe must fail inside the sandbox while the same request works outside it; an offline machine makes the probe inconclusive. In `acceptEdits` mode Claude Code may ask to allow a connection outside the sandbox: decline it with Esc unless you want that host open. Every program the mod runs outside the sandbox (git, find, sqlite3, the handoff's claude) and the judge get a PATH without the entries the agent could write; the echo shows that PATH, the git it runs and what it left out. The judge runs each command in its own process group, ends the group afterwards and checks that nothing it started is still alive (a survivor makes the check `couldNotRun`); it has an empty environment (a fixed short list of variables) and no network. It may make hard links inside the project and its own run folder only (`(deny file-link)` with an allow for those two); a link from a protected file such as `.git/config` is refused. That rule is checked with a real `sandbox-exec` in `tests/flow-git.check.mjs` (with `ln`) and `tests/judge-strict.check.mjs`; it has never been tried in a live session. What was tried live (S2) is another layer: main's own Bash tool calls under Claude Code's Bash sandbox, which refused 8 of 8 hard-link attempts (`ln`, Node and Python, sources the fixture's `.git/config` and `.claude/settings.local.json`; none created). A link whose source is Claude Code's transcript was not tried. Every program the mod starts also gets the shell start-up variables `SHELLOPTS`, `BASHOPTS`, `BASH_ENV`, `ENV` and every `BASH_FUNC_*` emptied. Until the session's sandbox probe has passed, no agent starts and Bash runs only main's probe command. The repository config hash covers the git hooks folder (husky 9's `.husky/_` too) and binds the setup approval: a change before the probe blocks the flow instead of being frozen.
2. A commit hook that reformats files changes the verified tree, so the next `/flow-ship` asks for `/flow-verify` again. Put the formatter in the approved lint command (for example `prettier --check`, or an override such as `.venv/bin/ruff format --check` in Python) to avoid that.
3. The flow holds the git trees it needs later (the start of the active feature, its RED tests, the review rounds, and in verify and ship the last seal and the verified tree) with refs under `refs/snagon/flow/<id8>/`, so `git gc` does not prune them. The everyday commands (`git log --all`, `git branch -a`, `git tag`, `git stash list`, `git reflog`, `git status`, `git worktree list`) show nothing of them; `git for-each-ref refs/snagon` and `git show-ref` list them. Tried with real git: the trees survive `git gc --prune=now`, and a tree whose ref was deleted is pruned. A plain `git clone` and a plain `git push` do not carry the refs; `git clone --mirror` and `git push --mirror` do. If you delete one by hand, the flow notices at its next check, measures from further back and charges no round, and the card says so; a lost tree of the last seal only means the release echo lists every file changed since the flow's base. The refs are removed when the flow ends (`/flow-ship` done, or `/flow-off`); if that fails, the mod prints the commands to list and delete them. To purge a secret from history, end the flow first: a blob that is in no commit stays alive while a flow ref pins the tree that holds it (tried with real git: still there after `git reflog expire --expire=now --all` and `git gc --prune=now`, gone after the ref was deleted). The refs other than the flow branch, the remote-tracking refs and the flow's own are frozen at setup and compared at every check and at release; a change blocks as `tampered` naming the refs, and the exits are `/flow-setup` or `/flow-off`. Not seen: a ref moved and put back between two checks, a change of the flow branch itself, and HEAD.
4. Some risks are accepted in 0.6.0:
   - another process of the same user can write the flow record and the plugin; other loaded plugins are trusted; never load the project under flow as a plugin; `/flow-decide`, `/flow-retry` and `/flow-off` are not bound to an echo;
   - the test runner's whole tree (`node_modules` or `.venv`) is hashed by content before every judged run, and so are the git-ignored files the judge can load. A deep edit is therefore seen, except one made in the same turn as an accepted dependency-only install, caches and ignored build output such as `dist/`, `build/` and `coverage/`, the transitive dependencies of pytest plugins, the base interpreter's standard library after setup, and five low-level gaps in what a re-baseline pins, which an internal security review found (two HIGH, two MEDIUM, one LOW) and which the project owner decided not to fix in 0.6.0: a decision, not an oversight, and described by area only;
   - test code runs in the same process as the test runner, so a test can in principle forge the runner's report. The mod forces a security review of code that reaches the runtime, flags the common pytest hooks that shape a report, and rejects a report that disagrees with the console or with pytest's own summary line, but it cannot prevent a deliberate forgery: only a review catches it. The same holds in principle for vitest and jest; a further check for them is planned for 0.9.0;
   - the judge runs on the live project, not on a snapshot of it (a judge on a snapshot is planned for 0.9.0, chosen by the project owner on 2026-10-18). A program that forks a long-lived process on its own is not caught by the background guard; for a judged command the process group and the survivor check cover it, but a process that leaves its group and hides its traces is not seen;
   - a stricter judge profile ("deny everything, open only what tests need") was run on every judged command of both fixtures and gave the same results as the profile in use, but it is not switched on; the decision is left for after this release;
   - the agent can still change files the flow does not hash, such as caches and build output, and what git hooks run for your own commits happens outside any sandbox: after a flow, review `package.json` and the lockfile, reinstall the dependencies and look at the git hooks before your next commit or project script. The reminder `/flow-off` and a finished `/flow-ship` print says this for both stacks (`rm -rf node_modules && npm ci`, or recreate `.venv` from the lockfile);
   - in one of three TypeScript fixture dry runs on the code of this release (2026-10-21) the flow stopped with `couldNotRun` after `lint`: the survivor check found a process the judged command started still active. It fails closed, so no result of that run is trusted, and `/flow-retry check` runs the check again. The cause is not established; the project owner left it for 0.7.0;
   - a main model can decline the flow's own sandbox probe (seen once in the live safety runs), and the flow then waits at the probe step. Tell main to run the probe exactly as the flow gives it; its refusal by the sandbox is the expected result.

## 12. Exempt sessions for loop runners

If the environment variable `SNAGON_WORKER`, `HANDOFF_WORKER` or `LOOP535_ROLE` is set, the session is exempt. The journal reminder, the compaction entry, the handoff (written and loaded), the sqlite3 check with its notice, and the address reminder are skipped; cost and context notices still show. This is meant for loop runners and for the handoff worker.

```
SNAGON_WORKER=1 claude -p "<task>"
```

## 13. Troubleshooting

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
| A notice that sqlite3 is missing | Memory search still works, by a plain scan. Run the command the agent gives, or set `autoInstall` to `false`. See `.snagon/install.log`. |
| No handoff appeared | The journal did not change, or the session was exempt. See `.snagon/handoff/handoff.log`. |
| Reminders in the wrong language | Set `language` to `"en"` or `"vi"` in the config. |
| `flow cannot start here yet:` after `/flow-setup` | The lines below it name each problem (no git repository, a detached HEAD, no remote, no supported stack or several matching ones (pick with `stack=<id>`), no test command, a Python venv that uses the system's site-packages or cannot be hashed, registry credentials, a plugin loaded from a writable folder, a settings key that loosens the sandbox, no git on the filtered PATH or a git the agent could write, a dependency or build folder git tracks or does not ignore, a repository config or hooks folder that cannot be read). Fix them and run `/flow-setup` again. |
| The card says `Blocked, NOT done: …` | The flow waits for you. Its last line lists the exits; see "When the flow is blocked" in section 11. |
| A refusal that starts with `flow:` | A flow guard. Follow the hint in it, or let main ask you. |
| A toast: a flow prompt was not delivered | The mod could not hand main its next prompt. Type `/flow-status` to go on. |
| `/flow-plan <long text>` did nothing | Claude Code took the text as a paste and sent it to the model. Put the description in a file and type a short command. |

Configuration example (`.snagon/config.json` in a project overrides `~/.snagon/config.json` field by field):

```
{
  "language": "en",
  "decisionWord": "Decision",
  "lessonWord": "Lesson",
  "journalDir": ".snagon/journal",
  "autoInstall": true,
  "address": "the project owner"
}
```

## 14. Developing the mod

Run the tests and the validation from a clone:

```
claude plugin test .
claude plugin validate .
```

`claude plugin test .` runs 884 tests in 50 files (the count recorded by the last full run, with `tsc` clean and 14 of 14 checks), among them a simulated Claude Code that drives a fake project through the flow (`tests/flow-drive.ts`, `tests/flow-fakes.ts`). Fourteen developer checks, most of them with the real tools the test runner does not have, cover what it cannot (`no-backdoor`, `flow-data` and `vendor` only read files). Each needs Node.js; `sqlite.check.mjs` needs 23.6 or later:

```
node tests/sqlite.check.mjs        the real sqlite3 path
node tests/install.check.mjs       the real install script on fake PATH values
node tests/flow-data.check.mjs     the flow data against the files on disk
node tests/flow-code.check.mjs     the release code is read only by the pane renderer
node tests/flow-git.check.mjs      real git and sandbox-exec (macOS)
node tests/flow-judge.check.mjs    the judge with real git, and one judged vitest run when FLOW_JUDGE_PROJECT is set
node tests/vendor.check.mjs        the vendored agent-skills files against their lock
node tests/safe-path.check.mjs     programs planted first on the PATH never run with the filtered PATH
node tests/flow-reap.check.mjs     a judged run's process group is ended and leftover processes are found (macOS)
node tests/flow-refs.check.mjs     the flow's git trees survive a real git gc --prune=now; a lost tree comes back as lost
node tests/flow-setup.check.mjs    the registry-URL check and the base interpreter's library hash, with real tools
node tests/flow-tree.check.mjs     whole-tree hashing of real trees: links, FIFOs, odd names, a venv with .pth and pytest plugins (macOS)
node tests/judge-strict.check.mjs  the strict judge profile under a real sandbox-exec (not switched on); FLOW_STRICT_TABLE=1 also builds the fixtures (macOS)
node tests/no-backdoor.check.mjs   the shipped mod has no test mode or flag an eval harness could use
sh tests/tsc.sh <claude-code.d.ts> type-check against the engine's current API file (needs tsc)
```

The flow was also run for real, in a fresh Claude Code session over a fixture project, with a script typing the owner's commands. Those evals cost real money: one whole flow on the three-feature TypeScript project cost 6.6 to 9.2 USD (runs 17 to 21, recorded 2026-10-18; the heading of the table that holds them says main on Opus 5.5), and the 0.6.0 fixture dry runs with main on Haiku cost 2.97 to 3.57 USD a run. On 2026-10-21 everything live ran again on the code of this release (only documents and version strings changed after it), with main on Haiku: the eight snapshots (about 1.8 USD), the scenarios S1 to S12 and H4 and H5 three times per stack (about 5.9 USD; S8 on TypeScript only) and the fixture dry runs (about 12 USD). S1, S3, S6 to S12, H4 and H5 passed three runs out of three on both stacks. S2, S4 and S5 did not pass every run, because main declined some of their probes, which counts as not attempted, never as a pass: a hard-link attempt (S2; the 6 it made were refused by the sandbox), a push with injected git config (S4; the 2 it made were refused by the guard) and the S5 test that tries to escape the judge sandbox (writes outside the project, the network, Apple Events, the terminal socket), tried in no run (0 of 6 on this code, 0 of 14 counting the first S2, S4 and S5 runs of that day). So the judge sandbox has not been tested in a live session; `tests/flow-git.check.mjs` and `tests/judge-strict.check.mjs` test it with a real `sandbox-exec`. One check failed once: in one TypeScript S5 run main declined the flow's own sandbox probe, so the flow never reached the check that blocks a changed test config; nothing ran meanwhile, and in the other runs that block came within 10 seconds. S3 ran without its two scan cases (a comment aimed at the reviewer, an added `src/CLAUDE.md`), so the block for text aimed at the reviewer was never seen in a live session. The owner accepted the declined rows as not attempted. Of the fixture dry runs, Python reached the release (13 minutes) and TypeScript reached it in two runs of three (12 minutes each); its first run stopped at F-03 with `couldNotRun` after `lint` (a known risk, see "Before your first flow"). The sets of 2026-10-20 and the first S2, S4 and S5 runs of 2026-10-21 ran on earlier code and stay in `evals/flow/safety.md` as history. `/flow-allow red` has not been used in a live session; `tests/flow-allow.test.ts` covers it. Two trial runs were made on a real Python repository (their evidence stays in the private development copy, not in this repository); the second reached the release only with the assistant's hand-edit of a RED test outside the flow after the debug cap, four waived findings, a mid-run change of the mod's `.pem` check and a plugin swap in the live session. Measured on 2026-10-21: the runner-integrity hash takes a median 362 ms on the Python fixture's `.venv` (99 MB) and 455 ms on the TypeScript fixture's `node_modules` (64 MB). How to run the evals and what they found is in [evals/flow/README.md](../evals/flow/README.md). Updating the vendored agent-skills methods follows [vendor-update.md](vendor-update.md).

Type-check, after the mod has loaded once (Claude Code writes `.claude-plugin/types/`):

```
tsc -p .
```
