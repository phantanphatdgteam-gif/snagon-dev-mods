// The build's first two tasks (plan v7.1 §3 B1-B2, §3.3, §7, F45): /flow-build starts a feature with its RED ticket; the
// flow_check after the RED run judges every command and checks the RED rule and the RED scope, then freezes the RED tests
// and issues the author ticket; an attested author run hands the feature to the judge (B3). Tickets carry the feature
// pack, sized to the room their frame leaves; a feature that does not fit one ticket is blocked as split.
import { fill } from '../flow/data/templates'
import { TYPESCRIPT } from '../flow/data/stacks'
import { CAPS, RETRY } from '../flow/data/phases'
import { DOD } from '../flow/data/dod'
import type { CapScope } from '../flow/data/types'
import { failures, type Report, type Signature } from '../flow/parse'
import { git, flowTree, gitPaths, type GitPaths } from './flow-git'
import { parseDiff, SCAN_DIFF_ARGS, type DiffFile } from './flow-scan'
import { outOfScope, redCheck, reportSignatures, symbolAbsent, timeoutFor, MAX_RUN_MS } from './flow-judge'
import { redShape } from './flow-red'
import { globRe, type FeatureRow, type Plan } from './flow-plan'
import { featurePack, roomLeft } from './flow-pack'
import { authorTicketText, changedHunks, newNonce, redTicketText, sha256 } from './flow-review'
import { canonical } from './flow-owner'
import { loadRules } from './instructions'
import { activeView, blockFlow, dropView, session, type FlowHost } from './flow-host'
import { flowDir, updateRecord, type Blocked, type FlowRecord, type TicketKind, type UpdateResult } from './flow-state'
import { issueTicket, lostReissue } from './flow-ticket'
import { methodText } from './flow-method'
import { costBlock } from './flow-spend'
import { lintNow, PLAN_FILE } from './flow-planning'
import { frozenBaseline } from './flow-baseline'
import { judgedRun } from './flow-run'
import { flowCard } from './flow-turn'

export const redFile = (home: string, flowId: string): string => `${flowDir(home)}/${flowId}.red.json`
const FLOW_RULES = ['Definition of Done for this task:', ...DOD.filter(d => d.level === 'task').map(d => `- ${d.text}`)].join('\n')
const START_PROMPT = 'flow: a ticket is ready. Call flow_status and start the agent exactly as it says.'
const TESTS = TYPESCRIPT.testFiles.map(globRe)
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const isBlocked = (x: unknown): x is Blocked => typeof x === 'object' && x !== null && 'reason' in x && 'vars' in x

/** The feature as it stands: the approved plan (still at its frozen hash), its row and counter key, the diff since its start. */
export type FeatureNow = { plan: Plan; f: FeatureRow; key: string; p: GitPaths; start: string; now: string; diffText: string; files: DiffFile[]; tests: string[]; fresh: string[] }
export async function featureNow(h: FlowHost, r: FlowRecord): Promise<FeatureNow | Blocked> {
  const { lint } = await lintNow(h, r)
  if (lint.hash !== r.frozen.plan) return { reason: 'frozenChanged', vars: { what: PLAN_FILE } }
  const f = lint.plan.features.find(x => x.id === r.feature)
  const key = r.features?.find(x => x.id === r.feature)?.key
  if (!f || !key) throw new Error(`flow: ${r.feature ?? 'no feature'} is not in the approved plan`)
  const p = await gitPaths(h.io, r.root), now = await flowTree(h.io, p, 'worktree', newNonce()), start = r.frozen[`start:${f.id}`] ?? now
  const d = start === now ? null : await git(h.io, p.top, [...SCAN_DIFF_ARGS, start, now])
  if (d && (d.exitCode !== 0 || d.isStdoutTruncated)) throw new Error(`flow: git diff failed: ${d.stderr.trim().slice(0, 200)}`)
  const paths = f.files.map(x => x.path)
  return { plan: lint.plan, f, key, p, start, now, diffText: d?.stdout ?? '', files: parseDiff(d?.stdout ?? ''), tests: paths.filter(x => TESTS.some(t => t.test(x))), fresh: f.files.filter(x => x.isNew).map(x => x.path) }
}

/** F45: the feature pack sized to the room the ticket's frame leaves; null frame or a split pack blocks the feature. */
async function packed(h: FlowHost, r: FlowRecord, fn: FeatureNow, frame: string | null): Promise<string | Blocked> {
  const split: Blocked = { reason: 'split', vars: { id: fn.f.id } }
  if (frame === null) return split
  const files = (await Promise.all(fn.f.files.map(async x => ({ path: x.path, text: await h.io.read(`${r.root}/${x.path}`).catch(() => null) })))).flatMap(x => (x.text === null ? [] : [{ path: x.path, text: x.text }]))
  const pack = featurePack({ f: fn.f.id, plan: fn.plan, flowRules: FLOW_RULES, stack: TYPESCRIPT.id, rules: await loadRules(h.io), files, hunks: changedHunks(fn.files) }, roomLeft(frame))
  return pack.ok ? pack.text : split
}
/** A ticket for the feature with its pack (the frame built with an empty pack and a nonce of the same length). */
export async function featureTicket(h: FlowHost, r: FlowRecord, fn: FeatureNow, o: { role: 'red' | 'author' | 'debugger'; kind: TicketKind; build: (nonce: string, pack: string) => string | null; also?: (x: FlowRecord) => FlowRecord }): Promise<Blocked | null> {
  const pack = await packed(h, r, fn, o.build('0'.repeat(16), ''))
  if (isBlocked(pack)) return pack
  const id = await issueTicket(h, r, { role: o.role, f: fn.f.id, kind: o.kind, build: nonce => o.build(nonce, pack), ...(o.also ? { also: o.also } : {}) })
  if (id === null) return { reason: 'split', vars: { id: fn.f.id } }
  await h.submit(START_PROMPT)
  return null
}

/** One more round of `kind` for the feature, or the cap blocked with the scope and kind (a retry adds its share). */
export function capRound(r: FlowRecord, key: string, scope: CapScope, f: string, kind: 'e' | 'r' | 'd'): { ok: true; also: (x: FlowRecord) => FlowRecord } | { ok: false; blocked: Blocked } {
  // the re-issue of a ticket lost in a restart takes no round (plan line 223)
  if (lostReissue(r, f, kind)) return { ok: true, also: x => x }
  const used = r.counters[key] ?? { e: 0, r: 0, d: 0, retried: false }
  const cap = (r.setup?.caps[scope] ?? CAPS[scope])[kind] + (used.retried ? RETRY[scope][kind] : 0)
  if (used[kind] >= cap) return { ok: false, blocked: { reason: 'cap', vars: { scope: f, kind: kind === 'e' ? 'edit' : kind === 'r' ? 'review' : 'debug' } } }
  return { ok: true, also: x => ({ ...x, counters: { ...x.counters, [key]: { ...(x.counters[key] ?? used), [kind]: (x.counters[key] ?? used)[kind] + 1 } } }) }
}

async function block(h: FlowHost, r: FlowRecord, why: Blocked): Promise<void> { await blockFlow(h, r.flowId, why) }

/** B1: the RED ticket, round 0 the first time (its start tree frozen then), an edit round after a failed RED check. */
async function redTicket(h: FlowHost, r: FlowRecord, fn: FeatureNow, problems: readonly string[]): Promise<void> {
  const round = problems.length ? capRound(r, fn.key, 'feature', fn.f.id, 'e') : { ok: true as const, also: (x: FlowRecord) => x }
  if (!round.ok) return block(h, r, round.blocked)
  const startKey = `start:${fn.f.id}`
  const also = (x: FlowRecord): FlowRecord => { const { awaiting: _a, ...rest } = round.also(x); return { ...rest, task: 'B1', frozen: { ...x.frozen, [startKey]: x.frozen[startKey] ?? fn.now } } }
  const pluginProject = r.setup?.pluginProject ?? false, method = await methodText(h.io, 'red')
  const why = await featureTicket(h, r, fn, { role: 'red', kind: 'red', build: (nonce, pack) => redTicketText({ f: fn.f.id, nonce, pluginProject, pack, problems, method }), also })
  if (why) await block(h, r, why)
}

/** The pointer's feature starts (after /flow-build, or right after the previous feature's seal): its RED ticket. */
export async function startFeature(h: FlowHost, r: FlowRecord): Promise<void> {
  const fn = await featureNow(h, r)
  if (isBlocked(fn)) return block(h, r, fn)
  await redTicket(h, r, fn, [])
}

/** /flow-build: at B1 waiting for it, the feature's RED ticket; anywhere else the card. */
export async function buildCommand(h: FlowHost): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  const r = view.record
  if (r.task !== 'B1' || r.awaiting !== '/flow-build' || (await costBlock(h, r))) return (await flowCard(h)) ?? ''
  const fn = await featureNow(h, r)
  if (isBlocked(fn)) { await block(h, r, fn); return (await flowCard(h)) ?? '' }
  await redTicket(h, r, fn, [])
  return fill(h.language, 'build.started', { id: fn.f.id })
}

/** Every approved command judged at the worktree: the failures (report or console) and the first report, or a block. */
/** null: the frozen baseline did not hold, before or after the runs, and frozenBaseline has blocked the flow already. */
async function judgeAll(h: FlowHost, r: FlowRecord): Promise<{ sigs: Signature[]; report?: Report } | Blocked | null> {
  const held = await frozenBaseline(h, r)
  if (!held) return null
  const sigs: Signature[] = []
  let report: Report | undefined
  for (const cmd of r.setup?.commands ?? []) {
    const ms = held.base.commands[cmd.id]?.ms
    const out = await judgedRun(h, r, cmd, ms === undefined ? MAX_RUN_MS : timeoutFor(ms))
    if (!out.ok) return out.reason === 'tooSlow' ? { reason: 'tooSlow', vars: { command: cmd.id, limit: 'its time limit' } } : { reason: 'couldNotRun', vars: { detail: `${cmd.id}: ${out.detail}` } }
    sigs.push(...(out.report ? reportSignatures(out.report, cmd.runner) : failures(out.run.output, TYPESCRIPT, cmd.runner) ?? []))
    report ??= out.report ?? undefined
  }
  if (!(await frozenBaseline(h, r))) return null
  return { sigs, ...(report ? { report } : {}) }
}

const lastOf = (r: FlowRecord, f: string, kind: TicketKind) => [...r.tickets].reverse().find(t => t.f === f && t.kind === kind)

/** flow_check at B1 after the RED run: the RED rule and scope; then the RED tests frozen and the author ticket. */
export async function redStep(h: FlowHost, r: FlowRecord): Promise<void> {
  const t = r.feature ? lastOf(r, r.feature, 'red') : undefined
  if (!t?.used) return
  const fn = await featureNow(h, r)
  if (isBlocked(fn)) return block(h, r, fn)
  if (!t.attested) return redTicket(h, r, fn, ['the RED run was not attested (it did not complete or did not end with the nonce line)'])
  const judged = await judgeAll(h, r)
  if (judged === null) return
  if (isBlocked(judged)) return block(h, r, judged)
  const scope = outOfScope(fn.files, [...fn.tests, ...fn.fresh]).map(x => `changed outside the RED scope (the feature's test files and new stubs): ${x}`)
  const red = await redCheck({ files: fn.files, failures: judged.sigs, fTestFiles: fn.tests, fAcs: fn.f.acs, newFiles: fn.fresh, stack: TYPESCRIPT, ...(judged.report ? { report: judged.report } : {}), absentAtStart: (m, name) => symbolAbsent(h.io, fn.p, fn.start, m, name) })
  if (scope.length || !red.ok) return redTicket(h, r, fn, [...scope, ...red.problems])
  // the author's method is read before the RED tests are frozen: a file that cannot be read leaves nothing half done
  const method = await methodText(h.io, 'author')
  const shapes = redShape(fn.files, fn.tests)
  const old: unknown = JSON.parse(await h.io.read(redFile(h.home, r.flowId)).catch(() => '{}'))
  await h.io.write(redFile(h.home, r.flowId), `${JSON.stringify({ ...(typeof old === 'object' && old !== null ? old : {}), [fn.f.id]: shapes })}\n`)
  const redHash = await sha256(canonical(shapes)), pluginProject = r.setup?.pluginProject ?? false
  const why = await featureTicket(h, r, fn, {
    role: 'author', kind: 'author', build: (nonce, pack) => authorTicketText({ f: fn.f.id, nonce, pluginProject, pack, method }),
    also: x => ({ ...x, task: 'B2', redTestHash: { ...x.redTestHash, [fn.f.id]: redHash }, frozen: { ...x.frozen, [`red:${fn.f.id}`]: fn.now } }),
  })
  if (why) await block(h, r, why)
}

/** flow_check at B2 after the author's run: attested, the feature goes to the judge (B3); not attested, the author again. */
export async function authorStep(h: FlowHost, r: FlowRecord): Promise<boolean> {
  const t = r.feature ? lastOf(r, r.feature, 'author') : undefined
  if (!t?.used) return false
  if (t.attested) {
    settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, task: 'B3' })))
    return true
  }
  const fn = await featureNow(h, r)
  if (isBlocked(fn)) { await block(h, r, fn); return false }
  const round = capRound(r, fn.key, 'feature', fn.f.id, 'e')
  if (!round.ok) { await block(h, r, round.blocked); return false }
  const pluginProject = r.setup?.pluginProject ?? false, method = await methodText(h.io, 'author')
  const why = await featureTicket(h, r, fn, { role: 'author', kind: 'author', build: (nonce, pack) => authorTicketText({ f: fn.f.id, nonce, pluginProject, pack, method }), also: round.also })
  if (why) await block(h, r, why)
  return false
}
