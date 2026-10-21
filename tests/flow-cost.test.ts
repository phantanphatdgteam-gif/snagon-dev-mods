import { describe, expect, test } from 'claude-code/testing'
import { flowCard, flowStatus, flowStop, whereNow } from '../hooks/flow-turn'
import { beat, flowUsageLine, turnEnd } from '../hooks/flow-spend'
import { dropView } from '../hooks/flow-host'
import { atB3, editRecord, GREEN_REPORT, HEAD, lastTicket, latest, run, toB1, world, type DriveOpts } from './flow-drive'

const MIN = 60_000
const T0 = 1_000_000

describe('flow spend and heartbeat at the end of each main turn (plan §6, line 233)', () => {
  test('the spend since the last turn waits in the session; the record gets it with the heartbeat at most every 5 minutes', async () => {
    const { w } = await atB3()
    await turnEnd(w.host)
    w.setUsd(3)
    await turnEnd(w.host)
    expect(latest(w)?.spent ?? 0).toBe(0)
    expect(w.session().value?.spend).toMatchObject({ seen: 3, pending: 2 })
    w.setNow(T0 + 5 * MIN)
    w.setUsd(4)
    await turnEnd(w.host)
    const r = latest(w)
    expect(r?.spent).toBe(3)
    expect(r?.spendBy).toEqual({ 'build/F-01': 3 })
    expect(r?.lock?.heartbeatAt).toBe(T0 + 5 * MIN)
    expect(w.session().value?.spend).toMatchObject({ pending: 0, at: T0 + 5 * MIN })
  })

  test('a turn end and the timer at the same moment add the pending spend once', async () => {
    const { w } = await atB3()
    await turnEnd(w.host)
    w.setUsd(5)
    w.setNow(T0 + 6 * MIN)
    await Promise.all([turnEnd(w.host), beat(w.host), beat(w.host)])
    expect(latest(w)?.spent).toBe(4)
    expect(w.session().value?.spend?.pending).toBe(0)
  })

  test('the timer writes the heartbeat when 5 minutes passed, and only then', async () => {
    const { w } = await atB3()
    await turnEnd(w.host)
    const version = latest(w)?.version
    w.setNow(T0 + 4 * MIN)
    await beat(w.host)
    expect(latest(w)?.version).toBe(version)
    w.setNow(T0 + 6 * MIN)
    await beat(w.host)
    expect(latest(w)?.lock?.heartbeatAt).toBe(T0 + 6 * MIN)
  })

  test('the usage line shows the session, flow and phase spend, with no cap and no notice', async () => {
    const { w } = await atB3()
    await turnEnd(w.host)
    w.setUsd(4)
    await turnEnd(w.host)
    expect(await flowUsageLine(w.host)).toBe('flow: session $4.00; flow $3.00; phase build $3.00')
  })
})

describe('no cost caps (owner decision 2026-10-20): spend is measured and shown only', () => {
  test('a flow far past the old caps (flow $100, session $100) is not blocked; the card shows the spend with no cap', async () => {
    const { w } = await atB3()
    editRecord(w, r => ({ ...r, spent: 100, flowCap: 5 })) // an older record may still hold flowCap: it is not read
    w.setUsd(100)
    const r = latest(w), s = w.session().value
    if (!r || !s) throw new Error('no record or session')
    expect((await whereNow(w.host, r, s)).kind).not.toBe('blocked')
    expect(JSON.parse(await flowStatus(w.host)).next).not.toContain('Blocked')
    const card = await flowCard(w.host) ?? ''
    expect(card).toContain('Cost: session $100.00; flow $100.00')
    expect(card).not.toMatch(/cap|notice| of \$/i)
    expect((await flowStop(w.host, { message: 'ok', stopHookActive: false }))?.block).toContain('call flow_status') // the push to go on stays
    expect(await flowUsageLine(w.host)).toBe('flow: session $100.00; flow $100.00; phase build $0.00')
  })

  test('the spend reaches the record when due only: no forced write at the old flow cap', async () => {
    const { w } = await atB3()
    await turnEnd(w.host)
    w.setUsd(200)
    await turnEnd(w.host)
    expect(latest(w)?.spent ?? 0).toBe(0)
    expect(w.session().value?.spend).toMatchObject({ seen: 200, pending: 199 })
  })

  test('/flow-retry cost answers "nothing waits": no counter marked retried, no block released, nothing submitted', async () => {
    const { w } = await atB3()
    const counters = latest(w)?.counters, sent = w.submitted.length // (an owner command may take the lock: the record version moves, the rest does not)
    expect((await run(w, 'flow-retry cost')).text).toBe('Nothing waits for /flow-retry cost now.')
    expect(latest(w)?.counters).toEqual(counters)
    expect(latest(w)?.counters.cost).toBeUndefined()
    expect(w.submitted.length).toBe(sent)
    // an older record that stored the `cost` block is let go (it could never clear otherwise), with no counter marked
    editRecord(w, r => ({ ...r, blocked: { reason: 'cost', vars: { kind: 'flow', cap: '5.00' } } }))
    expect((await run(w, 'flow-retry cost')).text).toBe('There is no cost cap any more; the old cost block is let go.')
    expect(latest(w)?.blocked ?? null).toBeNull()
    expect(latest(w)?.counters).toEqual(counters)
    expect(w.submitted.length).toBe(sent + 1)
  })

  test('a session that does not hold the lock spends nothing on the flow', async () => {
    const { w } = await atB3()
    const [path, text] = [...w.files.entries()].filter(([k, v]) => /\.v\d+\.json$/.test(k) && v.trim()).sort((x, y) => Number(/\.v(\d+)\.json$/.exec(y[0])?.[1]) - Number(/\.v(\d+)\.json$/.exec(x[0])?.[1]))[0] ?? ['', '']
    const r = JSON.parse(text) as { lock: { sessionId: string } }
    w.files.set(path, JSON.stringify({ ...r, lock: { ...r.lock, sessionId: 'sess-other' } }))
    dropView()
    await turnEnd(w.host)
    w.setUsd(5)
    await turnEnd(w.host)
    expect(w.session().value?.spend?.pending ?? 0).toBe(0)
    // the lock back: what was spent without it is not the flow's
    w.files.set(path, JSON.stringify(r))
    dropView()
    w.setUsd(6)
    await turnEnd(w.host)
    expect(w.session().value?.spend?.pending).toBe(1)
  })

  test('a spend that cannot be read shows as ? on the card and the status line (not $0.00) and blocks nothing', async () => {
    const { w } = await atB3()
    w.setUsd(undefined)
    expect(await flowCard(w.host)).toContain('Cost: session $?;')
    expect(await flowUsageLine(w.host)).toMatch(/^flow: session \$\?; flow \$\d+\.\d\d; phase build \$\d+\.\d\d$/)
    expect(JSON.parse(await flowStatus(w.host)).next).not.toContain('Blocked')
  })

  test('/flow-build at B1 with the spend far past the old caps still starts the feature', async () => {
    const d: DriveOpts = { gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } } }
    const w = world(d)
    await toB1(w)
    const before = lastTicket(w)?.id
    editRecord(w, r => ({ ...r, spent: 100 }))
    w.setUsd(100)
    await run(w, 'flow-build')
    expect(lastTicket(w)?.id).not.toBe(before)
  })
})

describe('flow card: the runner line (F30)', () => {
  test('a runner whose code was not found at setup is named on the card', async () => {
    const { w } = await atB3()
    expect(latest(w)?.frozen['runner:v2']).toBe('absent')
    expect(await flowCard(w.host)).toContain('The test runner\'s code is not pinned')
  })
})
