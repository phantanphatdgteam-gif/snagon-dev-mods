// A flow record as snagon-dev-mods 0.5.3 wrote it (R2 plan AC-CORE-3): dry run 1 on 2026-10-18, version 63, at B1 with
// F-01 sealed and the F-02 RED ticket issued; frozen before 0.5.4, so it has no plugin.version. Only the project path,
// the PATH, the lock and the ticket run ids (toolUseId, agentId) are rewritten to the test world (tests/flow-fakes.ts);
// every other value is as written. PLAN_053 is the approved docs/flow/plan.md of that run (it hashes to frozen.plan).
import { REPO_KEY } from '../flow-fakes'
import type { FlowRecord } from '../../hooks/flow-state'

export const RECORD_053 = {
 "version": 63,
 "flowId": "65b45522",
 "repoKey": REPO_KEY,
 "root": "/Users/u/proj",
 "branch": "main",
 "lifecycle": "active",
 "phase": "build",
 "task": "B1",
 "lock": {
  "sessionId": "sess-1",
  "root": "/Users/u/proj",
  "branch": "main",
  "heartbeatAt": 1792260902680
 },
 "approvals": [
  {
   "kind": "setup",
   "echoHash": "6070638928e8be479ede68ed5ef7ba6c41f246a849f1ec7ca444d0b5430f3c43",
   "at": 1792259055174,
   "origin": "composer"
  },
  {
   "kind": "baseline",
   "echoHash": "d3b05e753df1f1ce7e59f544d0060a240d37dfebf23d19e591224f43948b9292",
   "at": 1792259149760,
   "origin": "composer"
  },
  {
   "kind": "plan",
   "echoHash": "86a50dd8f6d8f36a82732f767496db1d9cc1e1486c11dae36e05a125b6410776",
   "at": 1792259259634,
   "origin": "composer"
  }
 ],
 "frozen": {
  "post": "03af072908fc9cd27e97e2971e650da1e3185b06d5796ba1eab723310e349603",
  "plugin": "938c0494f56142bd",
  "runner": "fbc91b0b9565c4451ef4a7809631d0b3c6f8200b57453af5405a1dee3ed296fc",
  "remote.url": "git://127.0.0.1:9419/dryrun-1-004353.git",
  "remote.rules": "811c9dc501000193",
  "remote.global": "6bd1242a3985d65e",
  "remote.keys": "",
  "env.PATH": "/usr/bin:/bin",
  "src:eslint.config.js": "69498982a36d0917",
  "src:package-lock.json": "f6cdfc8b98423a61",
  "src:package.json": "2cb2cdb4ebcf4859",
  "src:tsconfig.json": "d5c55d63c1ec71c8",
  "src:git:config": "6b2aa0d19562c607",
  "src:git:info/exclude": "2036ce6ebd3eb246",
  "src:git:config.worktree": "absent",
  "sandbox": "{\"additionalDirectories\":[],\"editAllow\":[],\"sandbox\":{\"allowUnsandboxedCommands\":false,\"enabled\":true,\"filesystem\":{\"allowWrite\":[\"~/.npm\"],\"denyRead\":[\"~/.npmrc\",\"~/.yarnrc\",\"~/.yarnrc.yml\",\"~/.config/yarn\",\"~/.bunfig.toml\",\"~/.netrc\",\"~/.git-credentials\",\"~/.config/gh\",\"~/.pypirc\",\"~/.docker/config.json\",\"~/.ssh\",\"~/.aws\",\"~/.config/gcloud\",\"~/.kube\",\"~/.claude/projects\",\"~/.snagon/flow\"]},\"network\":{\"allowedDomains\":[\"registry.npmjs.org\"]}},\"webFetchDomains\":[]}",
  "hCfg": "b12cb4e8d8b0e03a",
  "cfg:/Users/u/proj/.git/config": "62ffe14a4b85aa7f",
  "cfg:/Users/u/proj/.git/config.worktree": "absent",
  "cfg:/Users/u/proj/.git/hooks/applypatch-msg.sample": "a35cdc2909509866",
  "cfg:/Users/u/proj/.git/hooks/commit-msg.sample": "3c4d889ece2966cc",
  "cfg:/Users/u/proj/.git/hooks/fsmonitor-watchman.sample": "6af7baaac4c21ef4",
  "cfg:/Users/u/proj/.git/hooks/post-update.sample": "dd969d9316aba3b4",
  "cfg:/Users/u/proj/.git/hooks/pre-applypatch.sample": "ff281576fa50dd8c",
  "cfg:/Users/u/proj/.git/hooks/pre-commit.sample": "19974e073b96c91c",
  "cfg:/Users/u/proj/.git/hooks/pre-merge-commit.sample": "256f19c0214fd168",
  "cfg:/Users/u/proj/.git/hooks/pre-push.sample": "aba9e53cbc501333",
  "cfg:/Users/u/proj/.git/hooks/pre-rebase.sample": "295d51286dc7c665",
  "cfg:/Users/u/proj/.git/hooks/pre-receive.sample": "a583027018fa51f4",
  "cfg:/Users/u/proj/.git/hooks/prepare-commit-msg.sample": "035cb67eaf16b0fa",
  "cfg:/Users/u/proj/.git/hooks/push-to-checkout.sample": "88d73d871c1ace63",
  "cfg:/Users/u/proj/.git/hooks/sendemail-validate.sample": "46efbcde3f02866a",
  "cfg:/Users/u/proj/.git/hooks/update.sample": "81e5ce77489af8c0",
  "cfg:/Users/u/proj/.git/info/exclude": "2036ce6ebd3eb246",
  "cfg:/Users/u/proj/.claude/settings.json": "2b9a49bea53ceb7d",
  "cfg:/Users/u/proj/.claude/settings.local.json": "78f2393134f980c5",
  "cfg:/Users/u/proj/.mcp.json": "absent",
  "baseline": "36ec447ad942eb539076d59ad229332ac1fe3b4745b5f1ca3487108e9405a48f",
  "baseSha": "d554b28480a275ce30415346f5c72a5ab9a606f6",
  "ignored": "e62c87601a0dfdce",
  "plan": "ac5600f9d1a4e2e6",
  "acceptance": "247ca75902d2470c",
  "routing": "b57a5a899d835f38",
  "rubric:code": "de6cdaf775870598231f23496f06c0a91a410723d3bc3446f2e948476faf28da",
  "rubric:security": "b7acbf5684c2014a8c9b700eb83d0e933e09d62452ecbcdfaff411c8ce3012bf",
  "start:F-01": "65718c7a07ec2fe16964a35d81e54f15555b8e11",
  "red:F-01": "3c7601cb630538a8b1380a609d108da182c61731",
  "start:F-02": "0b251e6c1e020c9d50c3296fdd6bf8362227ed34"
 },
 "counters": {
  "plan": {
   "e": 1,
   "r": 0,
   "d": 0,
   "retried": false
  },
  "fk-0fbc7818": {
   "e": 0,
   "r": 1,
   "d": 0,
   "retried": false
  },
  "fk-97c9b1d2": {
   "e": 2,
   "r": 0,
   "d": 0,
   "retried": false
  },
  "fk-8a3bdb30": {
   "e": 0,
   "r": 0,
   "d": 0,
   "retried": false
  }
 },
 "findings": [
  {
   "id": "CR-1",
   "f": "F-01",
   "rubricId": "CODE-C2",
   "sev": "MEDIUM",
   "loc": "src/clamp.ts:3",
   "status": "open"
  }
 ],
 "tickets": [
  {
   "id": "T-1",
   "f": "plan",
   "sha": "e76778fc7c43024452aee5497468e2784ed8765380ba753bc669ea5eaee78a22",
   "nonce": "52b3af982d90f93f",
   "tree": "65718c7a07ec2fe16964a35d81e54f15555b8e11",
   "routedType": "planner",
   "model": "opus",
   "used": true,
   "toolUseId": "toolu_fixture_1",
   "agentId": "a-fixture-1",
   "attested": true
  },
  {
   "id": "T-2",
   "f": "F-02",
   "sha": "35c6ec91302f0cf241ce5f31373d14119f6d93f7b1ac6704098e35a5f2d558ea",
   "nonce": "348fdd326a148efa",
   "tree": "0b251e6c1e020c9d50c3296fdd6bf8362227ed34",
   "routedType": "tdd-guide",
   "model": "sonnet",
   "used": true,
   "kind": "red",
   "toolUseId": "toolu_fixture_2",
   "agentId": "a-fixture-2"
  },
  {
   "id": "T-3",
   "f": "F-02",
   "sha": "718c71adb749df7c53bac59d677fd3c3a75836f621d5df1777c8696f79de42cc",
   "nonce": "df2748ae639cd0ab",
   "tree": "0b251e6c1e020c9d50c3296fdd6bf8362227ed34",
   "routedType": "tdd-guide",
   "model": "sonnet",
   "used": true,
   "kind": "red",
   "toolUseId": "toolu_fixture_3",
   "agentId": "a-fixture-3"
  },
  {
   "id": "T-4",
   "f": "F-02",
   "sha": "eef681c070ab2d7885f176b76425dfff0b8c5de8ed37762335f9c69117fccc79",
   "nonce": "4b30478a76a72961",
   "tree": "0b251e6c1e020c9d50c3296fdd6bf8362227ed34",
   "routedType": "tdd-guide",
   "model": "sonnet",
   "used": false,
   "kind": "red"
  }
 ],
 "seals": [
  {
   "f": "F-01",
   "tree": "0b251e6c1e020c9d50c3296fdd6bf8362227ed34",
   "evalIds": [
    "AC-001",
    "AC-002"
   ],
   "tickets": 3,
   "findings": {
    "LOW": 0,
    "MEDIUM": 1,
    "HIGH": 0,
    "CRITICAL": 0
   },
   "followups": [
    "CR-1"
   ]
  }
 ],
 "redTestHash": {
  "F-01": "7cc04ea9fc26977d22eb0a6eca86b36ca753536f1322911e9e248dd8fa686d0c"
 },
 "setup": {
  "stack": "typescript",
  "commands": [
   {
    "id": "test",
    "argv": [
     "npm",
     "test"
    ],
    "runner": "vitest",
    "mode": "must-pass"
   },
   {
    "id": "typecheck",
    "argv": [
     "npm",
     "run",
     "typecheck"
    ],
    "runner": "tsc",
    "mode": "must-pass"
   },
   {
    "id": "lint",
    "argv": [
     "npm",
     "run",
     "lint"
    ],
    "runner": "eslint",
    "mode": "no-new-failures"
   }
  ],
  "allowTools": [
   "Read",
   "Glob",
   "Grep",
   "Edit",
   "Write",
   "MultiEdit",
   "NotebookEdit",
   "Bash",
   "Agent",
   "Task",
   "Skill",
   "TodoWrite",
   "ToolSearch",
   "AskUserQuestion"
  ],
  "allowMcp": [],
  "journalDir": ".snagon/journal",
  "remote": "origin",
  "branch": "main",
  "pluginProject": false,
  "caps": {
   "plan": {
    "e": 3,
    "r": 0,
    "d": 0
   },
   "feature": {
    "e": 3,
    "r": 3,
    "d": 4
   },
   "verify": {
    "e": 2,
    "r": 0,
    "d": 3
   }
  },
  "sessionCap": 15
 },
 "spent": 3.7726475000000024,
 "spendBy": {
  "setup": 0.2327267999999999,
  "plan": 0.8432998000000002,
  "build/F-01": 1.1965299000000014,
  "build/F-02": 1.5000910000000012
 },
 "features": [
  {
   "id": "F-01",
   "key": "fk-0fbc7818",
   "files": [
    "src/clamp.ts",
    "tests/clamp.test.ts"
   ]
  },
  {
   "id": "F-02",
   "key": "fk-97c9b1d2",
   "files": [
    "src/sum.ts",
    "tests/sum.test.ts"
   ]
  },
  {
   "id": "F-03",
   "key": "fk-8a3bdb30",
   "files": [
    "src/stats.ts",
    "tests/stats.test.ts"
   ]
  }
 ],
 "flowCap": 11,
 "assumptions": {
  "F-01": [
   "`NaN` is not specified, so `NaN` for `lo` or `hi` does not throw (`lo > hi` is false for `NaN`), and `NaN` for any argument gives `NaN`. I did not add validation because no AC asks for it.",
   "The `RangeError` message wording is mine; the ACs only require the error type.",
   "I followed the existing style: no semicolons, single quotes, a JSDoc line on the export, and a named function declaration as in `src/stats.ts`.",
   "The unrelated `src/legacy.ts` lint error and the `console.log` in `src/stats.ts` were already there and are out of scope."
  ]
 },
 "judge": {
  "tree": "0b251e6c1e020c9d50c3296fdd6bf8362227ed34",
  "green": true,
  "task": "B3",
  "f": "F-01",
  "at": 1792259344208
 },
 "feature": "F-02",
 "lastIds": {
  "CR": 1
 }
} as unknown as FlowRecord

export const PLAN_053 = "## Acceptance\n- AC-001 (Required): `clamp(x, lo, hi)` exported from `src/clamp.ts` limits `x` to the range `[lo, hi]`: `clamp(-5, 0, 10)` is 0, `clamp(15, 0, 10)` is 10 and `clamp(5, 0, 10)` is 5. Verification: test \"clamps x below lo to lo, above hi to hi, and keeps x inside the range\" in tests/clamp.test.ts\n- AC-002 (Required): `clamp` throws a `RangeError` when `lo > hi` (`clamp(1, 10, 0)` throws), while `lo` equal to `hi` is accepted (`clamp(7, 3, 3)` is 3). Verification: test \"throws a RangeError when lo is greater than hi\" in tests/clamp.test.ts\n- AC-003 (Required): `sum` in `src/sum.ts` adds negative numbers instead of dropping them: `sum([1, -2, 3])` is 2. Verification: test \"sums a list that mixes positive and negative numbers\" in tests/sum.test.ts\n- AC-004 (Required): `sum([-5])` is -5. Verification: test \"sums a list holding only a negative number\" in tests/sum.test.ts\n- AC-005 (Required): `median(xs)` exported from `src/stats.ts` returns the middle value of the sorted list for an odd count (`median([3, 1, 2])` is 2) and throws a `RangeError` for an empty list (`median([])` throws). Verification: tests \"median of an odd-count list is the middle sorted value\" and \"median of an empty list throws a RangeError\" in tests/stats.test.ts\n- AC-006 (Optional): `median` of an even-count list returns the mean of the two middle values of the sorted list: `median([4, 1, 3, 2])` is 2.5. Verification: test \"median of an even-count list is the mean of the two middle values\" in tests/stats.test.ts\n## Features\n### F-01: Add clamp module that limits a number to a range\n- ACs: AC-001, AC-002\n- Files: src/clamp.ts (new), tests/clamp.test.ts (new)\n- Security: no\n### F-02: Fix sum so it adds negative numbers\n- ACs: AC-003, AC-004\n- Files: src/sum.ts, tests/sum.test.ts\n- Security: yes\n### F-03: Add median export to the stats module\n- ACs: AC-005, AC-006\n- Files: src/stats.ts, tests/stats.test.ts\n- Security: no\n"
