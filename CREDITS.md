# Credits and thanks

This harness stands on other people's work. Thank you to everyone below. The files are not loaded into agent sessions;
they are here so the sources stay visible to people.

## everything-claude-code (ECC, MIT)

Most skills, agents, commands and rules in this mod, the fact-forcing gate messages and classifiers in `hooks/vendor/`,
the git hook-bypass check, the lint-config protection list, the cost and compaction notices, and the ideas behind
continuous learning and the delivery gate come from **everything-claude-code** 2.2.3 by **Affaan Mustafa** and its
contributors (https://github.com/affaan-m/ECC, npm package `ecc-universal`), under the MIT License (`LICENSES/everything-claude-code-MIT.txt`).

This mod edits that material: upstream-only instructions, tool names and runtime references were removed, items that
only work with the upstream tooling were dropped, and the hooks were rewritten to run inside a Claude Code hooks module.
Any mistakes in those edits are ours, not upstream's.

## Contributors whose work came through everything-claude-code

- GateGuard fact-forcing gate: zunoworks (https://github.com/zunoworks/gateguard).
- santa-method: Ronald Skelton (RapportScore.ai).
- Plankton write-time quality enforcement (plankton-code-quality): @alxfazio.
- frontend-design-direction: salvaged from community PR #1659 by linus707.
- Community skills: click-path-audit, codehealth-mcp, dev-team, frontend-a11y, frontend-design-direction, i18n-sync,
  inherit-legacy-style, make-interfaces-feel-better, plankton-code-quality, production-audit, repo-scan, skill-scout.
- The instinct model behind continuous learning: the Homunculus community project.
- Third-party tools named by some commands and skills (AgentShield, ccg-workflow, CodeScene, dmux, Plankton, repo-scan)
  belong to their authors and are installed separately.

## agent-skills (MIT)

The reference methods of the flow engine in `flow/vendor/agent-skills/` (14 skills, 3 agents and 7 references, copied
unchanged) come from **agent-skills** by **Addy Osmani** and its contributors (https://github.com/addyosmani/agent-skills,
commit `aeac41d4d005999432bb7312f7ff06383a91d59d`), under the MIT License (`LICENSES/agent-skills-MIT.txt`). Flow quotes
them in its tickets as text; Claude Code does not load them as skills or agents. `flow/vendor/agent-skills.lock.json`
lists every file with its hash, and `docs/vendor-update.md` says how they are updated.

## This mod

The hooks module that runs the harness (session journal, end-of-session handoff, project memory, the safety gate
rewritten from the vendored classifiers, path-rule loading, the sqlite3 installer), the flow engine (`hooks/flow*.ts` and
`flow/`, whose review rubrics and Definition of Done follow the agent-skills references above) and the /snagon-setup
interview were written for snagon-dev-mods.
