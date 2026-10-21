// Owner's decision (Anh Phát, 2026-10-20): no cost caps, neither per session nor per flow; spend is measured and shown
// only. Each main turn's spend since the last one waits in $.state and reaches the record with the heartbeat at most
// every 5 minutes; the 60-second timer and every judge run write the heartbeat the same way (plan v7.1 §6 turn.complete
// and usage, line 233, F7).
import { flowCostLine, type Cost } from './flow'
import { activeView, dropView, holderOf, mutateSession, session, type FlowHost } from './flow-host'
import { heartbeat, lockStatus, updateRecord, HEARTBEAT_PERSIST_MS, type FlowRecord } from './flow-state'

const settled = (out: Awaited<ReturnType<typeof updateRecord>>): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const keyOf = (r: FlowRecord): string => (r.feature ? `${r.phase}/${r.feature}` : r.phase)

/** The spend: the session's cost (NaN when it cannot be read), and the flow's (the record plus what this session has not written). */
export async function costOf(h: FlowHost, r: FlowRecord): Promise<Cost> {
  const s = (await session(h)).value
  return { session: (await h.usd()) ?? Number.NaN, flow: (r.spent ?? 0) + (s.spend?.pending ?? 0) }
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
 * the spend is due. A session that does not hold the lock spends nothing on the flow. */
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
  await persist(h, r, now, false)
}

/** F7's 60-second timer, and before and after every judge run (`force`): the heartbeat with the spend, when due. */
export async function beat(h: FlowHost, force = false): Promise<void> {
  const view = await activeView(h)
  if (view.mode === 'on') await persist(h, view.record, await h.io.now(), force)
}

/** §6 usage line in flow (the status line): the session's, the flow's and the phase's spend; null outside flow. */
export async function flowUsageLine(h: FlowHost): Promise<string | null> {
  const view = await activeView(h)
  if (view.mode !== 'on') return null
  const r = view.record, c = await costOf(h, r), s = (await session(h)).value
  const inPhase = (by: Readonly<Record<string, number>> = {}): number => Object.entries(by).filter(([k]) => k === r.phase || k.startsWith(`${r.phase}/`)).reduce((n, [, v]) => n + v, 0)
  return flowCostLine({ ...c, phase: r.phase, phaseUsd: inPhase(r.spendBy) + inPhase(s.spend?.by) })
}
