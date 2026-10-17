// Drives a fake project through flow as the engine would: owner commands, main's S2b Write through the guard, the
// sandbox probe, and judged runs answered from a table (each by the approved command it runs).
import { ownerCommand } from '../hooks/flow-cmd'
import { takeCode } from '../hooks/flow-owner'
import { dropView, forgetFlowCaches } from '../hooks/flow-host'
import { checkVerdict, forgetModes, liveCall, noteMode } from '../hooks/flow-live'
import { flowCheck } from '../hooks/flow-check'
import { afterAgentTurn, forgetAgents, noteSpawned, spawnHook } from '../hooks/flow-ticket'
import { onReply } from '../hooks/flow-reviewing'
import { PROBE_COMMAND } from '../hooks/flow-sandbox'
import type { FlowRecord } from '../hooks/flow-state'
import type { RunResult } from '../hooks/session'
import { fakeHost, gitArgs, HOME, ROOT, type FakeOpts } from './flow-fakes'
import { SCAN_DIFF_ARGS } from '../hooks/flow-scan'

export const PKG = JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } })
export const GIT = { 'config --get branch.main.remote': 'origin\n', 'remote get-url --push origin': 'https://github.com/o/r.git\n' }
export const LOCAL = `${ROOT}/.claude/settings.local.json`
export const RUN = '/private/var/folders/t/flow-run.abc123'
export const REFUSED = { isError: true, result: 'Exit code 56\n' }
const COMPOSER = { kind: 'composer' } as const

/** How the judge answers a command: its exit code, console text and the JSON report it writes (when asked for one). */
export type JudgeSpec = { exit: number; out?: string; report?: unknown }
/** gitOut is used as given (a test may add answers to it later); GIT fills the keys it lacks. */
export type DriveOpts = FakeOpts & { judge?: Partial<Record<'test' | 'lint', JudgeSpec>> }

export function world(o: DriveOpts = {}) {
  forgetFlowCaches()
  forgetModes()
  forgetAgents()
  takeCode(undefined) // a code left by an earlier test
  const gitOut = o.gitOut ?? {}
  for (const [k, v] of Object.entries(GIT)) if (!(k in gitOut)) gitOut[k] = v
  const opts: FakeOpts = { ...o, gitOut, files: { [`${ROOT}/package.json`]: PKG, [`${ROOT}/package-lock.json`]: '{}', ...o.files } }
  const w = fakeHost(opts)
  opts.run = argv => o.run?.(argv) ?? judged(w.files, o.judge ?? {}, argv)
  return w
}
export type W = ReturnType<typeof world>

function judged(files: Map<string, string>, judge: NonNullable<DriveOpts['judge']>, argv: string[]): RunResult | undefined {
  if (argv[0] === '/bin/sh' && (argv[2] ?? '').includes('mktemp')) return { exitCode: 0, stdout: `${RUN}\n`, stderr: '' }
  if (argv[0] !== '/usr/bin/env' || !argv.includes('/usr/bin/sandbox-exec')) return undefined
  const cmd = argv.slice(argv.indexOf('-p') + 2)
  const spec = judge[cmd.includes('lint') ? 'lint' : 'test'] ?? { exit: 0 }
  const report = cmd.find(a => a.startsWith('--outputFile.json=') || a.startsWith('--outputFile='))?.split('=')[1]
  if (report && spec.report !== undefined) files.set(report, JSON.stringify(spec.report))
  return { exitCode: spec.exit, stdout: spec.out ?? '', stderr: '' }
}

export const run = async (w: W, line: string) => {
  const [command = '', ...rest] = line.split(' ')
  return ownerCommand(w.host, { command, args: rest.join(' '), origin: COMPOSER })
}
export const records = (w: W): FlowRecord[] =>
  [...w.files.entries()].filter(([k, v]) => k.startsWith(`${HOME}/.snagon/flow/`) && /\.v\d+\.json$/.test(k) && v.trim()).map(([, v]) => JSON.parse(v) as FlowRecord)
export const latest = (w: W): FlowRecord | undefined => records(w).sort((a, b) => b.version - a.version)[0]

/** /flow-setup, then its approval. */
export async function approved(w: W): Promise<string> {
  await run(w, 'flow-setup')
  const hash8 = w.session().value?.pending.setup?.hash.slice(0, 8) ?? ''
  return (await run(w, `flow-approve setup ${hash8}`)).text
}
/** The Write main makes in S2b, through the guard as the engine runs it (tool.check, then the call, then the check after). */
export async function writeLocal(w: W, content: string): Promise<{ deny: string | null; withheld: string | null }> {
  noteMode(undefined, 'default')
  const deny = await checkVerdict(w.host, { tool: 'Write', input: { file_path: LOCAL, content } })
  if (deny) return { deny, withheld: null }
  const live = await liveCall(w.host, { tool: 'Write', file_path: LOCAL, content })
  w.files.set(LOCAL, content)
  return { deny, withheld: await live.after({ result: { type: 'create', filePath: LOCAL, content } }) }
}
export const probe = async (w: W, out: unknown) => (await liveCall(w.host, { tool: 'Bash', command: PROBE_COMMAND })).after(out)
/** S1 to S3: setup approved, the settings written, the probe refused by the sandbox. */
export async function toS3(w: W): Promise<FlowRecord | undefined> {
  await approved(w)
  await writeLocal(w, w.session().value?.s2b?.post ?? '')
  await probe(w, REFUSED)
  return latest(w)
}

/** A ticket run as the engine does it: the spawn hook rewrites `TICKET <id>`, the agent works (`work`), its reply comes back. */
export async function agentRun(w: W, id: string, reply: (nonce: string) => string, work?: () => void): Promise<void> {
  const decision = await spawnHook(w.host, { tool_use_id: `tu-${id}`, prompt: `TICKET ${id}`, description: 'ticket', subagentType: 'general-purpose' })
  if (!decision || !('rewrite' in decision)) throw new Error(`spawn refused: ${JSON.stringify(decision)}`)
  await noteSpawned(w.host, decision.ticketId, `tu-${id}`, `ag-${id}`)
  work?.()
  const nonce = latest(w)?.tickets.find(t => t.id === id)?.nonce ?? ''
  const live = await liveCall(w.host, { tool: 'Agent', tool_use_id: `tu-${id}`, prompt: `TICKET ${id}`, subagent_type: 'general-purpose' })
  await live.after({ result: { status: 'completed', agentId: `ag-${id}`, content: [{ type: 'text', text: reply(nonce) }] } })
}
export const ended = (text: string) => (nonce: string): string => `${text}\nREVIEW-END ${nonce}`
/** The Agent tool's answer on 2.1.302 (D4): the launch of a background run; the run's answer comes at its turn end. */
export const LAUNCH = (id: string) => ({ ref: 1, result: { isAsync: true, status: 'async_launched', agentId: `ag-${id}`, description: 'ticket', resolvedModel: 'claude-sonnet-5-5', prompt: `TICKET ${id}` } })
/** A ticket started as the engine does on 2.1.302: spawn, launch answered at once; the agent is still running. */
export async function agentLaunch(w: W, id: string): Promise<string> {
  const decision = await spawnHook(w.host, { tool_use_id: `tu-${id}`, prompt: `TICKET ${id}`, description: 'ticket', subagentType: 'general-purpose' })
  if (!decision || !('rewrite' in decision)) throw new Error(`spawn refused: ${JSON.stringify(decision)}`)
  await noteSpawned(w.host, decision.ticketId, `tu-${id}`, `ag-${id}`)
  const live = await liveCall(w.host, { tool: 'Agent', tool_use_id: `tu-${id}`, prompt: `TICKET ${id}`, subagent_type: 'general-purpose' })
  await live.after(LAUNCH(id))
  return latest(w)?.tickets.find(t => t.id === id)?.nonce ?? ''
}
/** The agent's turn ends with `reply` (the wiring then runs onReply for an attested run). */
export async function agentEnds(w: W, id: string, reply: string, reason = 'answer'): Promise<void> {
  const done = await afterAgentTurn(w.host, `ag-${id}`, reply, reason)
  if (done) await onReply(w.host, done.t, done.text)
}
export const lastTicket = (w: W) => latest(w)?.tickets.at(-1)

export const GREEN_REPORT = { testResults: [{ name: `${ROOT}/tests/a.test.ts`, status: 'passed', message: '', assertionResults: [{ title: 'adds', ancestorTitles: [], status: 'passed', failureMessages: [] }] }] }
export const HEAD = { 'rev-parse --verify -q HEAD^{commit}': `${'a'.repeat(40)}\n` }
export const PLAN_TEXT = [
  '## Acceptance', '- AC-001 (Required): adding two numbers returns their sum. Verification: tests/add.test.ts', '',
  '## Features', '### F-01: Add numbers', '- ACs: AC-001', '- Files: src/add.ts (new), tests/add.test.ts (new)', '- Security: no', '',
].join('\n')
/** S1 to B1 of F-01: a green baseline, the plan written by the planner and approved; the flow waits for /flow-build. */
export async function toB1(w: W, plan = PLAN_TEXT): Promise<void> {
  await toS3(w)
  await flowCheck(w.host)
  await run(w, 'flow-plan add a sum function')
  await agentRun(w, lastTicket(w)?.id ?? '', ended('Plan written.'), () => w.files.set(`${ROOT}/docs/flow/plan.md`, plan))
  await flowCheck(w.host)
  await run(w, 'flow-plan')
  await run(w, `flow-approve plan ${w.session().value?.pending.plan?.hash.slice(0, 8) ?? ''}`)
}

// B1 to B3 of F-01: the RED tests, the author's change, the judge (shared by the judge and review tests).
export const START = 'f'.repeat(40), RED_TREE = 'b'.repeat(40), AUTHOR_TREE = 'c'.repeat(40)
export const TEST_FILE = "import { expect, it } from 'vitest'\nit('AC-001 adds', () => {\n  expect(1 + 1).toBe(3)\n})\n"
export const added = (path: string, text: string): string => {
  const lines = text.replace(/\n$/, '').split('\n')
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`), ''].join('\n')
}
export const SRC = 'export const add = (a: number, b: number): number => a + b\n'
export type T = { file: string; title: string; status: 'passed' | 'failed' }
export const reportOf = (tests: readonly T[]) => ({
  testResults: [...new Set(tests.map(t => t.file))].map(file => ({
    name: `${ROOT}/${file}`, status: tests.some(t => t.file === file && t.status === 'failed') ? 'failed' : 'passed', message: '',
    assertionResults: tests.filter(t => t.file === file).map(t => ({ title: t.title, ancestorTitles: [], status: t.status, failureMessages: t.status === 'failed' ? ['AssertionError: expected 2 to be 3'] : [] })),
  })),
})
export const OLD: T = { file: 'tests/a.test.ts', title: 'adds', status: 'passed' }
export const NEW_PASSED: T = { file: 'tests/add.test.ts', title: 'AC-001 adds', status: 'passed' }
export const NEW_FAILED: T = { ...NEW_PASSED, status: 'failed' }
export const diffKey = (from: string, to: string): string => [...SCAN_DIFF_ARGS, from, to].join(' ')
export const judgedRuns = (w: W): number => w.runs.filter(a => a.includes('/usr/bin/sandbox-exec')).length

/** B1 and B2 done: RED tests frozen, the author wrote `src` (and `test`, the RED test file as it is now); flow_check judges. */
export async function atB3(o: { src?: string; test?: string; tests?: readonly T[]; exit?: number; out?: string; extra?: string; plan?: string; assumptions?: string; git?: Record<string, string>; before?: (d: DriveOpts, w: W) => void; start?: (w: W) => void } = {}): Promise<{ w: W; d: DriveOpts }> {
  const d: DriveOpts = {
    gitOut: { ...HEAD, ...o.git }, judge: { test: { exit: 0, report: GREEN_REPORT } },
    run: argv => (argv.includes('grep') && argv.includes('AC-[0-9]{3}') ? { exitCode: 0, stdout: 'tests/add.test.ts\0', stderr: '' } : undefined),
  }
  const w = world(d)
  o.start?.(w) // before setup freezes the plugin's files (a later change there is `tampered`)
  await toB1(w, o.plan)
  await run(w, 'flow-build')
  const gitOut = d.gitOut ?? {}
  gitOut[diffKey(START, RED_TREE)] = added('tests/add.test.ts', TEST_FILE)
  d.judge = { test: { exit: 1, report: reportOf([OLD, NEW_FAILED]) } }
  await agentRun(w, lastTicket(w)?.id ?? '', ended('Tests written.'), () => { w.setTree(RED_TREE); w.files.set(`${ROOT}/tests/add.test.ts`, TEST_FILE) })
  await flowCheck(w.host)
  const test = o.test ?? TEST_FILE
  gitOut[diffKey(START, AUTHOR_TREE)] = added('tests/add.test.ts', test) + added('src/add.ts', o.src ?? SRC) + (o.extra ?? '')
  o.before?.(d, w)
  d.judge = { test: { exit: o.exit ?? 0, out: o.out ?? '', report: reportOf(o.tests ?? [OLD, NEW_PASSED]) } }
  await agentRun(w, lastTicket(w)?.id ?? '', ended(`Done.\nASSUMPTIONS: ${o.assumptions ?? 'none'}`), () => { w.setTree(AUTHOR_TREE); w.files.set(`${ROOT}/tests/add.test.ts`, test); w.files.set(`${ROOT}/src/add.ts`, o.src ?? SRC) })
  await flowCheck(w.host)
  return { w, d }
}


// B4 to H2: the review passes, verify, ship.
/** F-01 built, reviewed and sealed; the flow waits for /flow-verify. `src` is the author's code. */
export async function toV1(o: Parameters<typeof atB3>[0] = {}, waive?: string): Promise<{ w: W; d: DriveOpts }> {
  const ctx = await atB3(o)
  const { w, d } = ctx
  ;(d.gitOut ?? {})[diffKey('a'.repeat(40), AUTHOR_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', o?.src ?? SRC)
  if (waive) {
    await run(w, `flow-waive J-1 ${waive}`)
    await run(w, `flow-approve waive ${w.session().value?.pending.waive?.hash.slice(0, 8) ?? ''}`)
    await flowCheck(w.host)
  }
  await agentRun(w, lastTicket(w)?.id ?? '', ended('NO-FINDINGS'))
  await flowCheck(w.host)
  if (latest(w)?.task !== 'V1' || latest(w)?.awaiting !== '/flow-verify') throw new Error(`toV1: the flow is at ${latest(w)?.task ?? 'nothing'}`)
  return ctx
}

/** Verified: the report written, the flow waits for /flow-ship. */
export async function toH0(o: Parameters<typeof atB3>[0] = {}): Promise<{ w: W; d: DriveOpts }> {
  const ctx = await toV1(o)
  await run(ctx.w, 'flow-verify')
  await flowCheck(ctx.w.host)
  if (latest(ctx.w)?.task !== 'H0') throw new Error(`toH0: the flow is at ${latest(ctx.w)?.task ?? 'nothing'}`)
  return ctx
}

/** The remote as release sees it: the commit to publish, the remote branch's tip (null: not there yet), whether this
 * repository has that tip, the push's answer, and what the publish scan reads. A push that succeeds moves the tip. */
export type Remote = { head: string; tip: string | null; tipHere?: boolean; push?: RunResult; names?: string; log?: string; down?: boolean; count?: number; subjects?: string; mergeBase?: string; descends?: boolean; configFiles?: string; pushes: number }
export function remoteGit(rm: Remote): (argv: string[]) => RunResult | undefined {
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
  return argv => {
    const g = gitArgs(argv)
    if (!g) return undefined
    if (g.join(' ') === 'rev-parse --verify HEAD^{commit}') return ok(`${rm.head}\n`)
    if (g[0] === 'config' && g.includes('--show-origin')) return ok(rm.configFiles ?? '')
    if (g[0] === 'merge-base') return g[1] === '--is-ancestor' ? (rm.descends === false ? { exitCode: 1, stdout: '', stderr: '' } : ok()) : ok(`${rm.mergeBase ?? rm.tip ?? ''}\n`)
    if (g[0] === 'ls-remote' && rm.down) return { exitCode: 128, stdout: '', stderr: 'fatal: unable to access the remote' }
    if (g[0] === 'ls-remote') return ok(g[1] === '--' && rm.tip ? `${rm.tip}\trefs/heads/main\n` : '')
    if (g[0] === 'cat-file') return ok(rm.tip && rm.tipHere ? `${rm.tip} commit\n` : '')
    if (g[0] === 'rev-list') return ok(g[1] === '--count' ? `${rm.count ?? 1}\n` : `${rm.head}\n`)
    if (g[0] === 'log' && g.includes('--format=%h %s')) return ok(rm.subjects ?? `${rm.head.slice(0, 7)} add numbers\n`)
    if (g[0] === 'log') return ok(g.includes('--name-only') ? rm.names ?? 'src/add.ts\0' : rm.log ?? '')
    if (g[0] === 'ls-tree') return ok(rm.names ?? 'src/add.ts\0')
    if (g[0] !== 'push') return undefined
    rm.pushes += 1
    const answer = rm.push ?? ok()
    if (answer.exitCode === 0) rm.tip = rm.head
    return answer
  }
}

/** Changes the newest record version in place (another session or the owner writing while a step runs). */
export function editRecord(w: W, change: (r: FlowRecord) => FlowRecord): void {
  const [path, text] = [...w.files.entries()].filter(([k, v]) => /\.v\d+\.json$/.test(k) && v.trim()).sort((x, y) => Number(/\.v(\d+)\.json$/.exec(y[0])?.[1]) - Number(/\.v(\d+)\.json$/.exec(x[0])?.[1]))[0] ?? ['', '']
  w.files.set(path, JSON.stringify(change(JSON.parse(text) as FlowRecord)))
  dropView()
}
/** `act` runs once, during the first judged run (sandbox-exec) from now on. */
export function duringJudge(d: DriveOpts, act: () => void): void {
  const before = d.run
  let once = false
  d.run = argv => { if (!once && argv.includes('/usr/bin/sandbox-exec')) { once = true; act() } return before?.(argv) }
}
