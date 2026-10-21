# Live flow evals

Plan v7.1 §9 (dry run) and §10 row 13 (safety S1–S11, happy path H1–H5): the flow engine run for real, in a
fresh interactive `claude` session over a fixture TypeScript repository, with the owner's commands typed at the
composer and the judge running `sandbox-exec`. Unit tests (`claude plugin test`) and reviews cannot show what
only the engine decides: how a hook's answer reaches main, what the Agent tool answers, how the pane draws, what
the sandbox refuses. The dry run of 2026-10-17 found eleven such things (dry-run.md).

## Files

| File | Role |
|---|---|
| `run.sh` | Builds a fixture repository per run, starts the session, plays the owner (the robot), keeps the evidence, calls the scenario and the metrics |
| `pty-drive.sh` | The session's terminal: a tmux server of its own (`-L flowev`, 200×150); typing, screen reads, busy detection |
| `scenarios.sh` | One `scenario_<id>` function per scenario; writes `verdict` |
| `metrics.mjs` | Reads a run folder and prints the summary JSON (spend per phase and feature, LLM calls per agent and per main step, caps, card size, judge time, record versions, denials) |
| `dry-run.md`, `safety.md`, `happy-path.md` | What each scenario does, what counts as a pass, what was found |
| `results/` | Reports copied here after a campaign (never during a run); kept in the private development copy and not published, because the evidence holds this machine's paths and the trial project's own files |

## Run

```sh
cd <mod>/evals/flow
sh run.sh selftest                       # the pure helpers
sh run.sh dryrun -k                      # one whole 3-feature flow, fixture kept
sh run.sh S1 -n 3                        # a safety scenario, pass^3
sh run.sh H123 -n 3                      # the tiny release flow, pass@3
FLOW_EVAL_WORK=/path sh run.sh H4        # fixtures, remotes and results under /path (default $TMPDIR/flow-evals)
sh run.sh dryrun --model sonnet          # main on a cheaper model (the agents keep the routed ones)
sh run.sh daemon-stop                    # the git daemon that serves the local remotes
```

Each run makes `<work>/<scenario>-<n>-<hhmmss>/` (the fixture, removed unless `-k`), a bare remote under
`<work>/remotes/` served over `git://127.0.0.1:9419` by `git daemon` (the mod refuses a path remote), and the
evidence under `<work>/results/<scenario>/<run>/`: `run.log`, `timeline.tsv`, `record-v*.json` (one per version
seen), the baseline and RED files, the transcript and its `subagents/`, `cost.jsonl`, the screen, the views,
`verdict`, `summary.json`.

The session loads a synced copy of the mod (`~/.snagon/flow-eval-mod`, rsync before each run): the engine
reloads a `--plugin-dir` folder on every save and the mod hashes its own tree at every `flow_check`, so the
source stays editable while runs go on. The command line: `claude --plugin-dir <copy> --strict-mcp-config
--permission-mode acceptEdits --session-id <uuid> --settings <the user's other plugins off>`, started by tmux in
the fixture. The fixture's `.claude/settings.json` allows Bash and the mod's tools; the sandbox block itself comes
from `/flow-setup`, as for any project.

## What the robot does

It reads the flow record (`~/.snagon/flow/<id8>.v<N>.json`, outside the project) every 5 s and types what the
`awaiting` field asks for: `/flow-plan <intent>` at P1, `/flow-plan` then the approval at P3, `/flow-build`,
`/flow-verify`, `/flow-ship` (again after main's commit), the release approval. Every `/flow-approve` takes its
hash8 (and the release code) from the pane on screen, as the owner would; after each command it waits for the
record to move or for main to go idle, and never types twice into that wait (a command typed while main works is
queued by Claude Code and runs when the turn ends). Claude Code's own dialogs are answered as the owner would:
the write into `.claude/` (the approved S2b settings) is confirmed, anything else (a host outside the allowed
domains) is declined with Escape; both are counted. There is no cost cap (owner's decision, 2026-10-20). A
`floor` block on the scope rules' findings (fix-scope, out-of-scope) is waived finding by finding with a reason and
the waiver approved, at most six times a run; any other block, and any other finding (a changed RED test, an
injection, a trivial assertion), ends the run with the reason in `verdict`. While a ticket's agent runs in the
background the robot waits; when main is idle for 3 minutes with nothing running and nothing waiting for the
owner, it is nudged ("Call flow_status and do what it says.") and the nudge is counted. At the end the run's flow
record is ended as `/flow-off` would.

## Budget

Plan §9: dry run $20–60, safety $35–100, happy path $75–180. `summary.json` carries the session's spend from the
mod's own `cost.jsonl`; the campaign report adds them up. The dry run's measured flow: $6.4–7.7 a run on the
3-feature fixture, about 15 minutes.
