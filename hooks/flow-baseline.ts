// S3 and S4 (plan v7.1 §3, §5.1): the baseline. Every approved command runs once in the judge sandbox at HEAD; what it
// did (exit, failures, the report's passed tests, counts) goes to a side file next to the record, its sha256 and HEAD into
// the frozen hashes, and the baseline echo into the boundary view (GAP-step9-7). A red command waits for the owner (S4),
// who accepts it as no-new-failures; one whose failures cannot be read can only be fixed or dropped.
import { fill } from '../flow/data/templates'
import type { Stack } from '../flow/data/types'
import { counts, failures, type Report } from '../flow/parse'
import { afterPass, type Next } from './flow'
import { git, gitPaths, ignoredSet } from './flow-git'
import { reportSignatures, runErrorsOf, testKey, MAX_RUN_MS, type Baseline, type RunOutput } from './flow-judge'
import { makeEcho, showEcho, type EchoContent, type Origin } from './flow-owner'
import { viewText } from './flow-pack'
import { sha256 } from './flow-review'
import { activeView, blockFlow, dropView, mutateSession, type FlowHost } from './flow-host'
import { flowDir, updateRecord, type Approval, type FlowCommand, type FlowRecord, type UpdateResult } from './flow-state'
import { judgedBlock, judgedRun } from './flow-run'
import { writeView } from './flow-setup'
import { stackOf } from './stacks/index'

/** unreadable: failing with no failure the stack can read, or a report that was asked for and is missing. */
export type BaseState = 'green' | 'red' | 'unreadable'
export type BaseEntry = Baseline & { ms: number; state: BaseState }
export type BaselineFile = { baseSha: string; commands: Record<string, BaseEntry> }
export const baselinePath = (home: string, flowId: string): string => `${flowDir(home)}/${flowId}.baseline.json`
export const BOUNDARY_S3 = '.snagon/flow/boundary-S3.md'
const SHOWN_SIGS = 5
/** What the ignored-file set leaves out (§5.3): the stack's dependency and build output folders and globs. */
export const ignoredSkip = (stack: Stack): { dirs: string[]; globs: string[] } => ({
  dirs: [...stack.dependencyDirs, ...stack.buildOutputs.filter(x => x.endsWith('/'))],
  globs: stack.buildOutputs.filter(x => x.startsWith('*')),
})

const pointerOf = (next: Next): Partial<FlowRecord> => {
  if ('done' in next) throw new Error('flow: the setup cannot finish the flow')
  return { phase: next.pointer.phase, task: next.pointer.task, ...('awaiting' in next ? { awaiting: next.awaiting } : {}) }
}
const settled = (out: UpdateResult): void => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`) }

function entryOf(stack: Stack, cmd: FlowCommand, run: RunOutput, report: Report | null | undefined): BaseEntry {
  const sigs = report ? reportSignatures(report, cmd.runner) : report === null ? null : failures(run.output, stack, cmd.runner)
  const state: BaseState = report === null || (run.exitCode !== 0 && !sigs?.length && !report) ? 'unreadable' : run.exitCode === 0 && !sigs?.length ? 'green' : 'red'
  return {
    signatures: sigs ?? [], counts: report ? report.counts : counts(run.output, stack, cmd.runner), exitCode: run.exitCode, ms: run.ms, state,
    ...(report ? { passed: report.tests.filter(t => t.status === 'passed').map(testKey), runErrors: runErrorsOf(run.output) + (report.runtimeErrors ?? 0) } : {}),
  }
}

/** The baseline echo (§2.5): per command its exit, failures (the first few) and counts, and what S4 would make of it. */
export function baselineEcho(h: Pick<FlowHost, 'language' | 'address'>, base: BaselineFile, sha: string): EchoContent {
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => fill(h.language, key, vars)
  const lines = Object.entries(base.commands).flatMap(([id, c]) => [
    t('echo.base.cmd', { id, exit: c.exitCode, failed: c.signatures.length, count: c.counts ? t('echo.base.count', { passed: c.counts.passed, skipped: c.counts.skipped }) : '—' }),
    ...c.signatures.slice(0, SHOWN_SIGS).map(s => t('echo.base.sig', { where: [s.file, s.id].filter(Boolean).join(' > '), message: s.message.slice(0, 160) })),
    ...(c.signatures.length > SHOWN_SIGS ? [t('echo.base.more', { n: c.signatures.length - SHOWN_SIGS })] : []),
    ...(c.state === 'red' ? [t('echo.base.mode', { mode: 'no-new-failures' })] : c.state === 'unreadable' ? [t('echo.base.noParser', { id })] : []),
  ])
  return { kind: 'baseline', title: t('echo.baseline', { address: h.address }), lines: viewText(lines.join('\n')).text.split('\n'), fields: { baseSha: base.baseSha }, files: { baseline: sha } }
}

/** S3 (flow_check): every command judged at HEAD; the side file, the frozen hashes, the boundary view, then S4 or P1. */
export async function runBaseline(h: FlowHost, r: FlowRecord): Promise<void> {
  const commands: Record<string, BaseEntry> = {}, stack = stackOf(r).data
  for (const cmd of r.setup?.commands ?? []) {
    const out = await judgedRun(h, r, cmd, MAX_RUN_MS)
    if (!out.ok) return void (await blockFlow(h, r.flowId, judgedBlock(cmd, out, `${MAX_RUN_MS / 60_000} min`)))
    commands[cmd.id] = entryOf(stack, cmd, out.run, out.report)
  }
  const head = (await git(h.io, r.root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout.trim()
  const base: BaselineFile = { baseSha: /^[0-9a-f]{40,64}$/.test(head) ? head : 'none', commands }
  const text = `${JSON.stringify(base, null, 1)}\n`, sha = await sha256(text)
  const ignored = (await ignoredSet(h.io, await gitPaths(h.io, r.root), ignoredSkip(stack))).hash
  await h.io.write(baselinePath(h.home, r.flowId), text)
  const echo = baselineEcho(h, base, sha)
  await writeView(h, BOUNDARY_S3, [echo.title, ...echo.lines].join('\n'))
  const next = afterPass({ phase: 'setup', task: 'S3' }, { features: [], baselineRed: Object.values(commands).some(c => c.state !== 'green') })
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, frozen: { ...x.frozen, baseline: sha, baseSha: base.baseSha, ignored }, ...pointerOf(next) })))
}

/** The baseline as frozen: the side file, only when it still hashes to what S3 froze (else the flow is blocked). */
export async function frozenBaseline(h: FlowHost, r: FlowRecord): Promise<{ base: BaselineFile; sha: string } | null> {
  const text = await h.io.read(baselinePath(h.home, r.flowId)).catch(() => '')
  const sha = await sha256(text)
  if (text && sha === r.frozen.baseline) return { base: JSON.parse(text) as BaselineFile, sha }
  await blockFlow(h, r.flowId, { reason: 'tampered', vars: { file: baselinePath(h.home, r.flowId) } })
  return null
}

/** /flow-status in S4: the baseline echo in the focused pane. Null when the flow does not wait at S4. */
export async function showBaseline(h: FlowHost, r: FlowRecord, origin: Origin): Promise<string | null> {
  if (r.task !== 'S4' || r.awaiting !== '/flow-status') return null
  const held = await frozenBaseline(h, r)
  if (!held) return null
  const echo = await makeEcho(baselineEcho(h, held.base, held.sha))
  const s = await mutateSession(h, x => ({ ...x, pending: { ...x.pending, baseline: echo }, shown: 'baseline' }))
  return (await showEcho(h, s?.pending ?? {}, echo, origin)).shown ? fill(h.language, 'echo.shown', { address: h.address }) : fill(h.language, 'blocked.noSurface', {})
}

/** The baseline echo rebuilt from the frozen side file: its hash, or undefined. */
export async function baselineHash(h: FlowHost): Promise<string | undefined> {
  const view = await activeView(h)
  const held = view.mode === 'on' && view.record.task === 'S4' ? await frozenBaseline(h, view.record) : null
  return held ? (await makeEcho(baselineEcho(h, held.base, held.sha))).hash : undefined
}

/** S4: red commands become no-new-failures and the flow waits for /flow-plan; a red command that cannot be read stops it. */
export async function applyBaseline(h: FlowHost, a: Approval): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  const r = view.record, held = await frozenBaseline(h, r)
  if (!held) return fill(h.language, 'blocked.tampered', { file: baselinePath(h.home, r.flowId) })
  const unreadable = Object.entries(held.base.commands).filter(([, c]) => c.state === 'unreadable').map(([id]) => id)
  if (unreadable.length) return fill(h.language, 'base.unreadable', { ids: unreadable.join(', ') })
  const red = new Set(Object.entries(held.base.commands).filter(([, c]) => c.state === 'red').map(([id]) => id))
  const next = pointerOf(afterPass({ phase: 'setup', task: 'S4' }, { features: [], baselineRed: true }))
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({
    ...x, ...next, approvals: [...x.approvals, a],
    ...(x.setup ? { setup: { ...x.setup, commands: x.setup.commands.map(c => (red.has(c.id) ? { ...c, mode: 'no-new-failures' as const } : c)) } } : {}),
  })))
  return fill(h.language, 'base.accepted', {})
}
