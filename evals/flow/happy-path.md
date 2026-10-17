# Happy-path evals (plan §10 row 13), pass@3

Each run is a fresh session on a fresh fixture. A scenario passes a run when its `verdict` starts with `PASS`;
pass@3 means at least one of three runs passes, and the report says how many did.

| Id | Scenario (`run.sh <id>`) | What must hold |
|---|---|---|
| H1 | `dryrun` (the fixture's lint is red at baseline) | the owner accepts the baseline (S4); `lint` runs as `no-new-failures`; the flow reaches the release |
| H2 | `dryrun` | F-01's RED is accepted by a missing `(new)` module, F-03's by a missing export in an existing module (the record's `redTestHash` holds both; the RED tickets are not re-issued) |
| H3 | `dryrun` | V8 → main's commit → `/flow-ship` → `/flow-approve release <hash8> <code>` → the push lands on the local bare remote (`remote-log.txt` shows the release commit) → the record is ended (`<id8>.end`, `"end":"done"`) |
| H4 | `H4` (not written yet): two fixtures with a flow each, a third session started with `LOOP535_ROLE=1` in one of them, a second session in the first fixture and one in a linked worktree | no false block; the runner session is exempt (no card, no guard); the second session and the worktree session are view-only (`blocked: viewOnly` on their card) and still guarded (an Edit outside the project is refused there) |
| H5 | `H5` (not written yet): a flow killed while a ticket is issued (B2), then a new session in the same fixture | the first `flow_check` settles the ticket the earlier session started (its answer never reached this one; the journal says so) and issues it again; the re-issued ticket's pack holds the feature's section, its ACs and one pattern file, and no other feature |

H1–H3 are the dry run itself on the 3-feature fixture (`dryrun` plays the whole flow): the dry run's runs count
as their observations. 2026-10-17: run 11 reached the release (the harness missed the end; the push and the
`"end":"done"` marker are in its results), run 12 stopped at a fix-scope floor block the harness did not yet
waive, run 13 stopped at F-03 on a harness fault, run 14 at S4 on a harness fault, run 15 played the whole flow
to the release with no hand on the keyboard (dry-run.md). H1–H3: pass@3 met (two passes, runs 11 and 15, in the
last five; the three failures were the harness's, not the mod's). H4 and H5: not run.
