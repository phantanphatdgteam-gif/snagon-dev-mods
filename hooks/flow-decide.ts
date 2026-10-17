// The owner's decisions (plan v7.1 §3.2): /flow-decide settles a finding (reject, follow-up, or fix with one more edit and
// review round); /flow-retry gives a scope at its cap one more set of rounds, once, or lets a check that could not run
// run again; /flow-waive shows a waiver in the pane, and its approval closes the floor or junk finding (or red check) with
// the owner's reason, which a view keeps for the verify report.
import { fill } from '../flow/data/templates'
import { makeEcho, showEcho, type EchoContent, type Origin } from './flow-owner'
import { activeView, dropView, mutateSession, session, type FlowHost } from './flow-host'
import { CLOSED, updateRecord, type Approval, type FlowRecord, type UpdateResult } from './flow-state'
import { writeView } from './flow-setup'
import { retryCost } from './flow-spend'

const WAIVERS = '.snagon/flow/waivers.md'
const GO_ON = 'flow: the project owner decided. Call flow_check.'
const STATUS: Readonly<Record<'reject' | 'followup' | 'fix', string>> = { reject: 'owner-rejected', followup: 'accepted-follow-up', fix: 'open' }
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const none = (h: FlowHost): string => fill(h.language, 'status.none', { address: h.address })
/** The block a decision on `id` ends: one that names it, or the cap or dispute it was waiting on. */
const clears = (r: FlowRecord, id: string): boolean => !!r.blocked && (r.blocked.vars.id === id || r.blocked.reason === 'cap' || r.blocked.reason === 'dispute')
const withoutBlock = (r: FlowRecord, drop: boolean): FlowRecord => { if (!drop) return r; const { blocked: _b, ...rest } = r; return rest }
const keyOf = (r: FlowRecord, f: string): string => r.features?.find(x => x.id === f)?.key ?? f

/** /flow-decide <X-n> fix|reject|followup. */
export async function decideCommand(h: FlowHost, id: string, choice: 'fix' | 'reject' | 'followup'): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return none(h)
  const r = view.record, x = r.findings.find(y => y.id === id && !CLOSED.has(y.status))
  if (!x) return fill(h.language, 'decide.unknown', { id })
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, y => {
    const key = keyOf(y, x.f), c = y.counters[key]
    // §3.2: `fix` grants one more edit and one more review round for that finding
    const counters = choice === 'fix' && c ? { ...y.counters, [key]: { ...c, e: Math.max(0, c.e - 1), r: Math.max(0, c.r - 1) } } : y.counters
    return { ...withoutBlock(y, clears(y, id)), counters, findings: y.findings.map(z => (z.id === id ? { ...z, status: STATUS[choice] } : z)) }
  }))
  await h.submit(GO_ON)
  return fill(h.language, 'decide.done', { id, choice })
}

/** /flow-retry plan|F-NN|verify|check|cost. */
export async function retryCommand(h: FlowHost, scope: string): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return none(h)
  const r = view.record, b = r.blocked
  if (scope === 'check') {
    if (b?.reason !== 'couldNotRun') return fill(h.language, 'retry.none', { scope })
    settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, y => withoutBlock(y, true)))
    await h.submit(GO_ON)
    return fill(h.language, 'retry.check', {})
  }
  if (scope === 'cost') {
    const said = await retryCost(h, r)
    if (said === null) return fill(h.language, 'retry.none', { scope })
    await h.submit(GO_ON)
    return said
  }
  const key = scope === 'plan' || scope === 'verify' ? scope : keyOf(r, scope), c = r.counters[key]
  if (c?.retried) return fill(h.language, 'retry.used', { scope })
  const waiting = b?.reason === 'cap' ? b.vars.scope === scope : scope === 'plan' && b?.reason === 'planLint'
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, y => ({ ...withoutBlock(y, waiting), counters: { ...y.counters, [key]: { ...(y.counters[key] ?? { e: 0, r: 0, d: 0 }), retried: true } } })))
  await h.submit(GO_ON)
  return fill(h.language, 'retry.done', { scope })
}

/** The waiver echo of `target` with the owner's reason, or null when there is nothing to waive by that name. */
function waiveEcho(h: FlowHost, r: FlowRecord, target: string, reason: string): EchoContent | null {
  const t = (key: string, vars: Readonly<Record<string, string>> = {}): string => fill(h.language, key, vars)
  const x = /^(?:FL|J)-\d+$/.test(target) ? r.findings.find(y => y.id === target && !CLOSED.has(y.status)) : undefined
  const check = /^check:([\w-]+)$/.exec(target)?.[1]
  const red = check !== undefined && r.blocked?.reason === 'redCheck' && r.blocked.vars.cmdId === check
  if (!x && !red) return null
  const what = x ? t('echo.waive.finding', { id: x.id, sev: x.sev, rule: x.rubricId, location: x.loc }) : t('echo.waive.check', { cmdId: check ?? '' })
  return { kind: 'waive', title: t('echo.waive', { address: h.address }), lines: [what, t('echo.waive.reason', { reason })], fields: { target, reason }, files: {} }
}

/** /flow-waive <target> <reason>: the waiver in the focused pane (one waits at a time: a new one replaces it). */
export async function waiveCommand(h: FlowHost, target: string, reason: string, origin: Origin): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return none(h)
  const content = waiveEcho(h, view.record, target, reason)
  if (!content) return fill(h.language, 'waive.unknown', { target })
  const echo = await makeEcho(content)
  const s = await mutateSession(h, x => ({ ...x, pending: { ...x.pending, waive: echo }, shown: 'waive', waive: { target, reason } }))
  return (await showEcho(h, s?.pending ?? {}, echo, origin)).shown ? fill(h.language, 'echo.shown', { address: h.address }) : fill(h.language, 'blocked.noSurface', {})
}

/** The waiver echo rebuilt from the session's waiver and the record now: its hash, or undefined. */
export async function waiveHash(h: FlowHost): Promise<string | undefined> {
  const view = await activeView(h), w = (await session(h)).value.waive
  const content = view.mode === 'on' && w ? waiveEcho(h, view.record, w.target, w.reason) : null
  return content ? (await makeEcho(content)).hash : undefined
}

/** The approved waiver: the finding closed as waived (or the red check let through), its reason in the waivers view. */
export async function applyWaive(h: FlowHost, a: Approval): Promise<string> {
  const view = await activeView(h), w = (await session(h)).value.waive
  if (view.mode !== 'on' || !w) return none(h)
  const r = view.record
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, y => ({
    ...withoutBlock(y, y.blocked?.vars.id === w.target || (w.target.startsWith('check:') && y.blocked?.reason === 'redCheck')),
    findings: y.findings.map(z => (z.id === w.target ? { ...z, status: 'waived' } : z)), approvals: [...y.approvals, a],
    ...(w.target.startsWith('check:') ? { frozen: { ...y.frozen, [`waive:${w.target}`]: 'yes' } } : {}),
  })))
  const old = await h.io.read(`${r.root}/${WAIVERS}`).catch(() => '# Waivers\n')
  await writeView(h, WAIVERS, `${old}- ${w.target}: ${w.reason}\n`)
  await mutateSession(h, s => ({ ...s, waive: null }))
  await h.submit(GO_ON)
  return fill(h.language, 'waive.done', { target: w.target })
}
