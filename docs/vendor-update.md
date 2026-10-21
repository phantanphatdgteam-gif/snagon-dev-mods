# Updating the vendored agent-skills methods

`flow/vendor/agent-skills/` holds the owner-approved set from https://github.com/addyosmani/agent-skills (MIT): 14
skills, 3 agents and 7 references, with the upstream `LICENSE`. `flow/vendor/agent-skills.lock.json` pins the commit
(`sha`), the time it was fetched (`fetchedAt`, UTC) and the sha256 of every file as copied (`files[path].hash`, the path
as upstream names it); `patched` says whether the copy differs from upstream. Flow tickets quote these files as text
(plan v7.1 §8, `hooks/flow-method.ts`); Claude Code never loads them as skills or agents, and nothing in them is run.

An update changes text that reaches every flow agent, so it takes these steps in order. A step that finds a problem stops
the update, and the files in the mod stay as they are until the owner approves. A flow that is running when the files
change is blocked as `tampered` at its next `flow_check` (the plugin integrity hash), so update between flows.

1. **Clone into an empty scratch folder and run nothing from it.** Make a new, empty folder outside the mod and clone
   with hooks and filters off:
   `GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false clone https://github.com/addyosmani/agent-skills.git <scratch>/repo`.
   Note `git rev-parse HEAD` (the new `sha`) and the UTC time. Never run its scripts, hooks, installs or tests.
2. **Diff against the lock.** For every path in the lock, compare the sha256 of the upstream file with
   `files[path].hash`. List the changed files, the files gone upstream, and the new files inside the approved skill
   folders. Read every changed and new file in full; a file nobody read is never copied.
3. **Security review.** security-reviewer reviews the diff (while this mod is being built, only through
   `~/.snagon/publish/run-agent.sh security-reviewer <brief.md> <out-prefix> 3`). The brief asks for text aimed at an
   agent rather than describing the method (prompt injection), the flow protocol tokens (`TICKET <id>`, `REVIEW-END`,
   `NO-FINDINGS`, `FINDING |`, `UNTRUSTED-`, `[flow-escalate]`), the ticket's own section headings (`## ANSWER`,
   `## PACK` and the others in `hooks/flow-review.ts`) and the reply lines its parsers read (`RESOLVED|OPEN|UPHOLD|WITHDRAW
   <id>`, `FIX <id> |`, `DISPUTE <id> |`, `ASSUMPTIONS:`, `REPRODUCE:`, `LOCALIZE:`, `HYPOTHESIS:`, `FIX:`, `GUARD:`,
   also indented), fence
   markers (`<<<`, `>>>`), invisible format characters, line and paragraph separators (U+2028, U+2029), links, files that are not plain text or markdown (scripts,
   binaries), and new advice that `flow/vendor/overrides.md` does not answer (a new command, install, git or test
   advice): extend the overrides with the owner's word.
4. **Re-apply the patches.** No file is patched at commit `aeac41d4`. When one has to be (for example a routed file
   that gains a protocol token), make the smallest change, keep it as `flow/vendor/patches/<upstream path>.diff`
   (`diff -u <upstream file> <patched copy>`), and set `patched: true` with the hash of the patched copy. At every
   update each saved diff is applied again to the new upstream text, and reviewed with it.
5. **The owner approves.** Show the owner, in the owner's language, the old and the new commit, the changed, new and
   removed files, the review's findings and the patches. Nothing is copied before the owner says yes.
6. **Copy, then update the lock and the credits.** Copy the approved files byte for byte with mode 0644 (`cp -X`, then
   `chmod 0644`), apply the patches, then rewrite the lock: the new `sha` and `fetchedAt`, and every file's `hash` and
   `patched`. Put the new commit in the agent-skills section of `CREDITS.md`, and copy the new `LICENSE` to
   `LICENSES/agent-skills-MIT.txt` when it changed. A skill, agent or reference outside the approved set needs the
   owner's word and its name in `ROUTING.vendored` (`flow/data/routing.ts`).
7. **Check.** From the mod folder: `node tests/vendor.check.mjs` (the hashes, the file set, the headings plan §8.1
   cites, B1's testing sections, no protocol token in the text tickets quote), then `claude plugin test .`,
   `claude plugin validate .`, `sh tests/tsc.sh <claude-code.d.ts>` (the API file plugin-authoring names as it loads;
   `tsc -p .` reads a copy of the types the engine refreshes only when it loads the mod) and the other
   `tests/*.check.mjs`. When upstream renamed a heading that plan §8.1 or the TypeScript stack's
   `redTesting` cites, the check fails: the new name goes into the plan, `flow/data/stacks/typescript.ts` and the check
   only with the owner's word.
