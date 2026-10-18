# Dry run (plan §9)

`sh run.sh dryrun -k`: one whole flow on the 3-feature fixture, played to the release, first with the provisional
caps (session $15, flow $60), then with the caps the measurements set. Its numbers set the caps and tell where the
engine, the mod and the harness disagree.

## The fixture

`run.sh fixture`: vitest, eslint (with the TypeScript parser), tsc; `npm test` green (3 tests), `npm run lint`
red (an unused helper in `src/legacy.ts`: the baseline is red, so S4 and `no-new-failures` are exercised),
`npm run typecheck` green. `src/sum.ts` drops negative numbers (the seeded bug F-02 fixes); `src/stats.ts` holds
a `console.log` (pre-existing junk the scan must leave alone); `src/clamp.ts` does not exist (F-01, a `(new)`
module: RED by a missing module); F-03 adds `median` to `src/stats.ts` (RED by a missing export).

The intent typed at `/flow-plan` points at `docs/intent.md` in the fixture (a long command typed at the composer
is taken as a paste, D3): three features, two acceptance criteria each, one Optional (the even-count case of
`median`), `Security: yes` on F-02; keeping the existing tests green is named as the definition of done, not a
criterion (D7).

## What is recorded (`summary.json`, by `metrics.mjs`)

| Field | Source | Plan §9 item |
|---|---|---|
| `usd`, `turns` | the mod's `cost.jsonl` (one row per main turn) | spend |
| `spend.by` | the record's `spendBy` (phase and phase/feature) | spend per phase/F |
| `agents[]` | the subagent transcripts joined to the record's tickets by `agentId`, with the engine's `meta.json`: LLM calls, tool calls, seconds, tokens | LLM calls per task/agentId (§4.8) |
| `mainLlmCalls` | main's assistant messages per record state | LLM calls per task |
| `caps`, `blocked` | the record's counters and the timeline | caps hit |
| `cardChars` | the `flow · <phase> / <task>` block in each API request (characters; tokens ≈ chars / 4) | card tokens per turn |
| `judge.baselineMs` vs `judge.directTestMs` | the baseline file's `ms` per command against `npm test` run by the harness before the session | sandbox-exec overhead |
| `record.lastVersion`, `snapshots` | the record versions the 5 s poll saw | record writes (a 5 s poll cannot time them) |
| `nudges`, `denials` | run.log; `flow:` refusals in the transcript | — |

## Measurements (2026-10-17, Claude Code 2.1.302, main on Opus 5.5, agents as routed)

| Run | Outcome | USD session / flow | Main turns | Minutes |
|---|---|---|---|---|
| 11 | released to the local remote (the harness missed the end; `"end":"done"` in its results) | 7.74 / 6.41 | 20 | 15 |
| 12 | stopped at a fix-scope floor block the harness did not yet waive (F-01) | 2.93 | 9 | 5 |
| 13 | F-01 and F-02 sealed; stopped at F-03's floor block after the harness read a stale waiver hash (fixed) | 8.92 / 8.33 | 27 | 14 |
| 14 | stopped at S4 by the harness, which read a baseline approval back from the typed column (fixed; the mod was not at fault) | 0.67 | 2 | 1 |
| 15 | released to the local remote with no hand on the keyboard: F-03 took one fix round (three FL waivers, D11) and its delta; verify 40 s; the first `/flow-ship` came before main's commit, and the harness typed it again | 8.43 / 7.58 | 24 | 18 |
| 16 | stopped at B1 of F-02 (D12: a ticket id issued again after the seal; the first run of the code as fixed after the round-2 reviews; 2026-10-18) | 4.46 | — | 4 |
| 17 | released to the local remote, unattended, on the D12 fix: F-03 took one fix round and two fix-scope floors the harness waived (D11) | 8.09 | 24 | 16 |
| 18 | released to the local remote, unattended, on D10 + D11 (0.5.2): F-03's fix got one scope correction and no owner command (14 commands in all, 19 in run 17); the release echo 14 lines; a second fix and delta round came from two reply lines the parsers dropped (D14, D15) | 8.82 | 27 | 16 |
| 19 | released to the local remote, unattended, on 0.5.2 as published (D14, D15 and the review fixes): the fix agents again wrote FIX lines with absolute paths and the ranges were read (`src/sum.ts:1-10`, `src/stats.ts:13-13`, `17-21`), no fix-scope finding in the whole run (every fix round of runs 12–18 had one), every delta verdict landed (F-02 and F-03 sealed after one fix and one delta each), no refusal by a guard; 14 owner commands | 9.18 | 26 | 19 |
| 20 | released to the local remote, unattended, on 0.5.4 before its publish (the filtered PATH, `(deny file-link)` in the judge, the hooks path in H_cfg, the setup approval bound to H_cfg; 2026-10-18): no block, no nudge, no false `tampered`; vitest, eslint and tsc ran under the new judge profile; the harness typed `/flow-ship` again once, when the release line was not yet on the pane | 6.61 / 5.49 | 17 | 13 |

Run 15 by phase: setup $0.21, plan $0.86, F-01 $1.01, F-02 $1.38, F-03 $3.69 (the fix round, three waivers and the delta),
verify $0.42, ship ≈ $0.85; the card 220 characters a prompt, 281 at most; the judge's baseline `test` 656 ms under
`sandbox-exec` against 776 ms direct. Run 15 ran the code as reviewed in round 1 (the probe command of round 2 and the
later guards are covered by the safety runs).

Run 11 by phase: setup $0.20, plan $0.81, F-01 $1.31, F-02 $2.02 (one extra author round), F-03 $1.90, verify
$0.17, ship ≈ $0.6. Run 13: setup $0.25, plan $0.84, F-01 $2.53 (review, fix, two waivers, delta), F-02 $2.05,
F-03 $2.67 before the block. Agents (run 11): planner Opus 53 s and 18 LLM calls; RED (tdd-guide, Sonnet) 25–31 s
and 7–10 calls; author 31–37 s and 15–18 calls; typescript-reviewer 45–52 s and 12 calls; security-reviewer 16 s
and 8 calls; the plan's bound of 16 calls per feature holds for the tickets, main adds 6–23 calls per step (most at
S2b/S4 and ship). The card: 202–227 characters a prompt (≈55 tokens), 309 at most. The judge's baseline `test`
took 654–658 ms under `sandbox-exec` against 726 ms run directly: no measurable overhead. Build of three features:
9–11 minutes; verify (V1–V8) 20 s; commit, ship and release 3 minutes.

## Caps (plan §9, GAP-step13-10)

- session = max × 1.5: the largest session seen was $9.10 (run 7, with its extra rounds) → the session cap stays
  $15.
- flow = (per-F × planned F + setup/plan/verify) × 1.5: per feature $2 (the measured maximum with one extra round),
  fixed $1.2 → `flowCapFor(n) = ceil((2n + 1.2) × 1.5)`, frozen at P3: $11 for three features, $5 for one; $60
  until the plan is approved.
- phase notice = phase × 1.2: setup $0.24, plan $0.96, build $2.40 a feature, verify $0.24, ship $0.36.
- A tiny flow at $12+ drops the happy-path evals to pass@2: not reached ($7.7–8.9).
- e/r/d change only if a cap was hit without a real defect: none was; the two blocks seen were fix-scope floors.

## What the dry run found

Fifteen things the unit tests and the reviews could not see, each an assumption about the engine or about a real
agent; D1–D9, D12, D14 and D15 were fixed in the mod (and pinned by a test) before the next run, D10 and D11 after the
owner's decision (0.5.2), D13 is the owner's.

| Id | Seen at | Defect | Fix (GAP) |
|---|---|---|---|
| D1 | run 2, setup | `$.prompt.submit` is refused inside a `command.run` hook ("it would wait on the turn this hook is holding"), so no owner command could hand main its next prompt | `submitLater`: the submit goes out on a `$.clock.after` timer, retried 50 ms → 3 s (GAP-step13-1) |
| D2 | run 4, probe | the §2.2 probe (`curl https://example.com`) does not fail inside the sandbox in `acceptEdits` mode: the proxy asks the owner to allow the host; a decline gives exit 28, not 56 | the docs' own probe, `curl --noproxy '*' …` (exit 6, no dialog); `probeShowsSandbox` accepts it (GAP-step13-4) |
| D3 | run 4, plan | a long `/flow-plan <intent>` typed at the composer is taken as a paste and sent to the model as a prompt, never run as a command | the intent lives in a project file; the command stays short (docs/flow.md) |
| D4 | run 5, plan | the Agent tool answers the launch of a background run at once: the hook sees `{ isAsync: true, status: 'async_launched', agentId, … }` (the model sees "Async agent launched"), so the run's answer never reaches `tool.call`, and the launch read as a run that did not complete; the ticket was issued again three times | the launch is recognised by its status and the ticket is attested at the subagent's `turn.complete`; `flow_status` says "running" while it runs; main waits for the completion notice (GAP-step13-5) |
| D5 | run 6, plan | the vendored `planner` agent has no Write tool, so it cannot write docs/flow/plan.md; its answer still attested, and lint asked again | `tools:` of agents/planner.md gains Write, Edit (GAP-step13-6) |
| D6 | runs 7–10, review and plan | a `flow_check` while a ticket's agent still ran issued the ticket again beside it (a review round went r 1 → 3 with no finding; a planner ran three times): the first D4 fix looked for a launch with no `status`, while the real launch carries `status: 'async_launched'`. Found only by logging the hook's `out` from inside the mod: the transcript shows the model's text form, not the record the hook gets | `isLaunch` reads the status; a running ticket is one this session started (session state and module memory) and whose end it has not heard, with no call to `$.agent.list()` (GAP-step13-7) |
| D7 | run 7, RED | an acceptance criterion of the kind "the old behaviour stays" can have no failing new test, so RED (§3.3) refused every try until the cap | the planner ticket says a criterion is new behaviour; "existing tests stay green" is the definition of done (GAP-step13-8) |
| D8 | run 11, review | a reviewer that had read the file by its absolute path wrote the finding's location so; outside the artifact's relative paths, a HIGH and a MEDIUM finding were dropped (§4.2) and the gate passed with "0 findings"; main noticed the contradiction in verify.md and declined to ship | `normLoc` strips the project root from a location (parse context gains `root`); run 13 kept such findings |
| D9 | run 11, ship | the commit prompt's `git add -A` took `.claude/settings.local.json` (the approved sandbox settings, a local file) into the release commit | the prompt adds with a pathspec that excludes that file (GAP-step13-9) |
| D10 | run 11, ship | the release echo in the pane carries verify.md, so at 60 rows the line to type (`/flow-approve release <hash8> <code>`) sits below the visible pane; the harness reads the screen and could not find it (it did at 150 rows) | 0.5.2: the echo keeps its summary lines and names the report by path and hash (`Verify report: docs/flow/verify.md (<hash8>)`), 14 lines in run 18; the approval still binds the report through its file hash, and the report is written with every control, format and line-separator character escaped, so the file reads as its bytes |
| D12 | run 16, build (the first run of the code as fixed after the reviews) | after F-01's seal dropped its tickets, the next ticket got the id `T-2` again (the next id counted the tickets left in the record), and every session map keyed by ticket id still held F-01's `T-2`: the new agent's calls were refused as "ticket T-2 is settled" (SEC13R2-3), its run counted as judged (SEC13-4), the step moved on to `T-3`, and main itself refused "a closed ticket's id" | the record counts every ticket issued (`ticketSeq`, additive) and an id never comes round again |
| D13 | run 16, build | while main refused the ticket, each refusal re-issued it and the mod sent "a ticket is ready" again: about 19 prompts and $2.1 in four minutes before main stopped on its own; the cost caps are the only limit | the loop was the Stop hook's push ("the task is not passed; call flow_status"), not a re-issue: main was pushed back to the same unstarted ticket on every turn end (7 pushes and 10 prompts in run 16). 0.5.3 (the owner chose a limit, 2026-10-18): the Stop hook pushes main back to one ticket at most `STALL_LIMIT` (3) times, then the flow blocks `stalled` for the owner (`/flow-retry check` offers the ticket again, no round charged; the owner's own prompt starts the count again; the one hook line that calls that reset is not covered by a test, accepted in review round 4: the register harness would need a built flow to seed a ticket); the "ticket is ready" prompt after a ticket flow_check issued was redundant from the start (flow_check's own result names the ticket; queued behind main's turn, the prompt reached main after it had started the agent: eleven "no new ticket" turns in run 18), so only an owner command's ticket (`/flow-build`, `/flow-plan`) is prompted now, a prompt is queued once, and one that no unstarted ticket waits for any more is dropped as it enters |
| D11 | runs 12–13, fix | after a fix ticket the judge's fix-scope check (10) raised two FL findings (HIGH) per fix, on hunks outside the FIX ranges the fix agent reported (it rewrites the file with Write and reports the finding's lines), and the flow blocked for the owner's waiver: four owner commands per fix round; plan line 433 also allows "one correction per round", which the mod does not issue | 0.5.2 (plan line 433, "one correction per round"): the fix ticket asks for Edit-sized hunks and the ranges that cover them, and a reply with no FIX, DISPUTE or REVERT line on a finding of the ticket is not attested; the first fix-scope finding of a round gets one correction ticket, free, whose FIX claim must hold the flagged hunk whole (and covers nothing in a later round) or whose REVERT line reports the revert; a hunk still outside after it blocks for the owner as before. Run 18: one correction, no owner command. Known limit (review of D11, round 3): a correction that reverts one hunk and claims another in the same file can see the claimed hunk at a new line and block for the owner; fail-safe, not changed |
| D14 | run 18, fix | the fix agent reported `FIX CR-2 \| /private/tmp/…/src/stats.ts:16-16 (why)`: the absolute path (it had read the file so, like the reviewer of D8) and the reason after the range made the range parser drop the line, the hunk it named had no claim, and the judge raised a fix-scope finding on a fix that was in scope (the agent had used Edit, as the new ticket asks); the correction of D11 then cost a ticket | a FIX range is read from the first word after `\|`, quotes and trailing punctuation off, an absolute path under the project root made relative (the D8 rule, shared). Run 19: the same absolute paths, read; no fix-scope finding |
| D15 | run 18, delta | the delta reviewer wrote `RESOLVED CR-2: <why>`, `OPEN CR-3: …`, `WITHDRAW CR-4: …`; the verdict regex ended at the id, all three were dropped, CR-2 stayed fixed-unconfirmed, and the step issued a fix ticket that listed nothing (the author disputed the feature id); a second delta round resolved it: two tickets and about $1.5 for nothing | a verdict line may go on after the id; a delta reply with no verdict on a fixed or disputed blocking finding of the reviewer's own prefix is not attested, and the round is asked again as any review run that did not report back. Run 19: every verdict landed, no round asked again |

Also seen and worth the owner's eye: a command typed while main's turn runs is queued and runs when the turn ends
(never lost); the mod's own fact-forcing gate costs one extra main turn per session; main's journal reads before
the file existed were refused by the guard (four denials in run 11, correct but noisy); the fixture repository
had no git identity, so run 11's release commit carried the machine's (a harness gap, fixed); in run 11 main
read verify.md against the reviews, found the dropped findings (D8) and refused to ship on its own.
