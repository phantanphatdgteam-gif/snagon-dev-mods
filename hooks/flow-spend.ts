// Spend, caps and the heartbeat (plan v7.1 §6 turn.complete and usage, line 233, F7). Each main turn's spend since the
// last one waits in $.state and reaches the record with the heartbeat at most every 5 minutes, and at once when the flow
// cap is reached; the 60-second timer and every judge run write the heartbeat the same way. A cap reached blocks the
// flow for the owner at once (whereNow), so no ticket starts; /flow-retry cost raises it by half, once (the flow cap once
// per flow, the session cap once per session).
import { fill } from '../flow/data/templates'
import type { Phase } from '../flow/data/types'
import { costCapHit, flowCostLine, type Cost } from './flow'
import { activeView, dropView, holderOf, mutateSession, session, type FlowHost } from './flow-host'
import { heartbeat, lockStatus, updateRecord, HEARTBEAT_PERSIST_MS, type FlowRecord } from './flow-state'

/** The caps before the plan is approved (plan §9, step 13): the session cap at 1.5× the largest session the dry run saw
 * ($9.10, run 7 with its extra rounds), the flow cap until P3 freezes the planned one. */
export const PROVISIONAL_USD = { session: 15, flow: 60 } as const
/** The dry run's spend model (plan §9, step 13, run 11 on the 3-feature fixture): the per-feature cost at its measured
 * maximum with one extra round ($2.02), the fixed part setup + plan + verify ($0.20 + $0.81 + $0.17), each phase's
 * expected spend; the factors are the plan's. */
export const USD_MODEL = { perFeature: 2, fixed: 1.2, factor: 1.5, noticeFactor: 1.2, phase: { setup: 0.2, plan: 0.8, build: 2, verify: 0.2, ship: 0.3 } } as const
/** The flow cap frozen at P3: (per feature × planned features + setup/plan/verify) × 1.5, whole dollars up. */
export const flowCapFor = (features: number): number => Math.ceil((USD_MODEL.perFeature * features + USD_MODEL.fixed) * USD_MODEL.factor)
/** The phase notice of the usage line: 1.2× the phase's expected spend, build's per planned feature. */
export const phaseNoticeFor = (phase: Phase, features: number): number =>
  Math.round((phase === 'build' ? USD_MODEL.phase.build * Math.max(1, features) : USD_MODEL.phase[phase]) * USD_MODEL.noticeFactor * 100) / 100
/** /flow-retry cost: the cap reached grows by half, once. */
const COST_RETRY = 1.5
const fmt = (n: number): string => n.toFixed(2)
const settled = (out: Awaited<ReturnType<typeof updateRecord>>): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const keyOf = (r: FlowRecord): string => (r.feature ? `${r.phase}/${r.feature}` : r.phase)

/** The spend against the caps: the session's cost, and the flow's (the record plus what this session has not written). */
export async function costOf(h: FlowHost, r: FlowRecord): Promise<Cost> {
  const s = (await session(h)).value
  return { session: (await h.usd()) ?? Number.NaN, sessionCap: (r.setup?.sessionCap ?? PROVISIONAL_USD.session) * (s.costBoost ? COST_RETRY : 1), flow: (r.spent ?? 0) + (s.spend?.pending ?? 0), flowCap: r.flowCap ?? PROVISIONAL_USD.flow }
}
/** The cap reached as the blocked cause names it (`blocked.cost`), or null. A spend that cannot be read counts as reached. */
export async function costBlock(h: FlowHost, r: FlowRecord): Promise<{ kind: 'session' | 'flow'; cap: string } | null> {
  const c = await costOf(h, r), hit = costCapHit(c)
  return hit ? { kind: hit, cap: fmt(hit === 'session' ? c.sessionCap : c.flowCap) } : null
}

/** The heartbeat and the spend not yet in the record, written when 5 minutes passed since the last write, or `force`d.
 * Only the lock holder writes. The spend leaves the session in the same step that checks the time, so two writers at
 * once (the timer and a turn end) add it once; a failed record write puts it back. */
async function persist(h: FlowHost, r: FlowRecord, now: number, force: boolean): Promise<void> {
  const me = await holderOf(h)
  if (lockStatus(r, me, now) !== 'mine') return
  const usd = await h.usd(), box: { taken?: { pending: number; by: Record<string, number> } } = {}
  await mutateSession(h, x => {
    box.taken = undefined // a retried change starts over: only the attempt that is written takes the spend
    const cur = x.spend ?? { seen: usd ?? 0, pending: 0, by: {}, at: now }
    if (!force && now - cur.at < HEARTBEAT_PERSIST_MS) return null
    box.taken = { pending: cur.pending, by: cur.by }
    return { ...x, spend: { ...cur, pending: 0, by: {}, at: now } }
  })
  const t = box.taken
  if (!t) return
  try {
    settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...heartbeat(me, now)(x), spent: (x.spent ?? 0) + t.pending, spendBy: addBy(x.spendBy, t.by) })))
  } catch (err) {
    await mutateSession(h, x => (x.spend ? { ...x, spend: { ...x.spend, pending: x.spend.pending + t.pending, by: addBy(x.spend.by, t.by) } } : x))
    throw err
  }
}
const addBy = (a: Readonly<Record<string, number>> = {}, b: Readonly<Record<string, number>>): Record<string, number> =>
  Object.entries(b).reduce<Record<string, number>>((acc, [k, v]) => ({ ...acc, [k]: (acc[k] ?? 0) + v }), { ...a })

/** turn.complete of the main loop: the spend since the last turn (the session's cost now minus the one last seen) joins
 * the pending spend under the phase (and feature); the heartbeat and the spend reach the record when due, at once when
 * the flow cap is reached. A session that does not hold the lock spends nothing on the flow. */
export async function turnEnd(h: FlowHost): Promise<void> {
  const view = await activeView(h)
  if (view.mode !== 'on') return
  const r = view.record, now = await h.io.now(), usd = await h.usd(), key = keyOf(r)
  const mine = lockStatus(r, await holderOf(h), now) === 'mine'
  await mutateSession(h, x => {
    const sp = x.spend ?? { seen: usd ?? 0, pending: 0, by: {}, at: now }
    // without the lock `seen` still moves, so spend outside the flow is never charged to it later
    const delta = !mine || usd === undefined ? 0 : Math.max(0, usd - sp.seen)
    return { ...x, spend: { seen: usd ?? sp.seen, pending: sp.pending + delta, by: delta ? { ...sp.by, [key]: (sp.by[key] ?? 0) + delta } : sp.by, at: sp.at } }
  })
  if (!mine) return
  const c = await costOf(h, r)
  await persist(h, r, now, !(c.flow < c.flowCap))
}

/** F7's 60-second timer, and before and after every judge run (`force`): the heartbeat with the spend, when due. */
export async function beat(h: FlowHost, force = false): Promise<void> {
  const view = await activeView(h)
  if (view.mode === 'on') await persist(h, view.record, await h.io.now(), force)
}

/** §6 usage line in flow (the status line): both caps and the phase's spend; null outside flow. */
export async function flowUsageLine(h: FlowHost): Promise<string | null> {
  const view = await activeView(h)
  if (view.mode !== 'on') return null
  const r = view.record, c = await costOf(h, r), s = (await session(h)).value
  const inPhase = (by: Readonly<Record<string, number>> = {}): number => Object.entries(by).filter(([k]) => k === r.phase || k.startsWith(`${r.phase}/`)).reduce((n, [, v]) => n + v, 0)
  return flowCostLine({ ...c, session: Number.isFinite(c.session) ? c.session : 0, phase: r.phase, phaseUsd: inPhase(r.spendBy) + inPhase(s.spend?.by), noticeAt: phaseNoticeFor(r.phase, r.features?.length ?? 0) })
}

/** /flow-retry cost: the cap reached grows by half, once; the owner's answer, or null when no cap is reached. */
export async function retryCost(h: FlowHost, r: FlowRecord): Promise<string | null> {
  const hit = await costBlock(h, r)
  if (!hit) return null
  const used = fill(h.language, 'retry.costUsed', {})
  if (hit.kind === 'session') {
    if ((await session(h)).value.costBoost) return used
    await mutateSession(h, x => ({ ...x, costBoost: true }))
    return fill(h.language, 'retry.cost', { kind: fill(h.language, 'kind.session', {}), cap: fmt((r.setup?.sessionCap ?? PROVISIONAL_USD.session) * COST_RETRY) })
  }
  if (r.counters.cost?.retried) return used
  const after = settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, flowCap: (x.flowCap ?? PROVISIONAL_USD.flow) * COST_RETRY, counters: { ...x.counters, cost: { e: 0, r: 0, d: 0, retried: true } } })))
  return fill(h.language, 'retry.cost', { kind: fill(h.language, 'kind.flow', {}), cap: fmt(after.flowCap ?? 0) })
}
