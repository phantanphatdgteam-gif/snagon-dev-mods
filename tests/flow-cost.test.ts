import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { flowCard, flowStatus } from '../hooks/flow-turn'
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

  test('the usage line names both caps and the phase spend', async () => {
    const { w } = await atB3()
    await turnEnd(w.host)
    w.setUsd(4)
    await turnEnd(w.host)
    // one planned feature: flow cap (2 × 1 + 1.2) × 1.5 → $5; build's notice 2 × 1 × 1.2 (plan §9, step 13)
    expect(await flowUsageLine(w.host)).toBe('flow: session $4.00 / cap $15.00; flow $3.00 / cap $5.00; phase build $3.00 (notice at $2.40)')
  })
})

describe('flow cost caps (plan §3.2 cost, §6 usage)', () => {
  test('at the flow cap: blocked for the owner at once, no ticket; /flow-retry cost raises the cap by half, once', async () => {
    const { w } = await atB3()
    editRecord(w, r => ({ ...r, flowCap: 60 })) // the cap of a larger plan, so the retry below unblocks the $65 spent
    // five sessions of $13 each (a session stops at its own $15 cap); the fifth reaches the flow cap within 5 minutes of
    // the last write, so only the cap makes it write at once
    for (let i = 1; i <= 5; i += 1) {
      const s = w.session().value
      if (s) w.setSession({ ...s, spend: null })
      w.setUsd(1)
      await turnEnd(w.host)
      w.setUsd(14)
      w.setNow(T0 + Math.min(i, 4) * 5 * MIN)
      await turnEnd(w.host)
    }
    expect(latest(w)?.spent).toBe(65)
    expect(JSON.parse(await flowStatus(w.host)).next).toContain('Blocked, NOT done: cost')
    expect(await flowCard(w.host)).toContain('the flow cost cap of $60.00 was reached')
    const tickets = latest(w)?.tickets.length
    await flowCheck(w.host)
    expect(latest(w)?.tickets.length).toBe(tickets)
    expect((await run(w, 'flow-retry cost')).text).toContain('The flow cost cap is now $90.00')
    expect(latest(w)?.flowCap).toBe(90)
    expect(JSON.parse(await flowStatus(w.host)).next).not.toContain('Blocked')
    for (let i = 6; i <= 8; i += 1) {
      const s = w.session().value
      if (s) w.setSession({ ...s, spend: null })
      w.setUsd(1)
      await turnEnd(w.host)
      w.setUsd(14)
      w.setNow(T0 + i * 5 * MIN)
      await turnEnd(w.host)
    }
    expect(latest(w)?.spent).toBe(104)
    expect((await run(w, 'flow-retry cost')).text).toContain('cost already had its one retry')
  })

  test('the session cap stops this session only: /flow-retry cost raises it once here, and a new session starts free', async () => {
    const { w } = await atB3()
    w.setUsd(16)
    expect(await flowCard(w.host)).toContain('the session cost cap of $15.00 was reached')
    expect((await run(w, 'flow-retry cost')).text).toContain('The session cost cap is now $22.50')
    expect(JSON.parse(await flowStatus(w.host)).next).not.toContain('Blocked')
    w.setUsd(23)
    expect((await run(w, 'flow-retry cost')).text).toContain('cost already had its one retry')
    const s = w.session().value
    if (s) w.setSession({ ...s, spend: null, costBoost: false })
    w.setUsd(1)
    expect(JSON.parse(await flowStatus(w.host)).next).not.toContain('Blocked')
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

  test('a spend that cannot be read counts as the cap reached', async () => {
    const { w } = await atB3()
    w.setUsd(undefined)
    expect(await flowCard(w.host)).toContain('the session cost cap of $15.00 was reached')
  })

  test('/flow-build at a cap starts no feature', async () => {
    const d: DriveOpts = { gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } } }
    const w = world(d)
    await toB1(w)
    const before = lastTicket(w)?.id
    w.setUsd(16)
    await run(w, 'flow-build')
    expect(lastTicket(w)?.id).toBe(before)
  })
})

describe('flow card: the runner line (F30)', () => {
  test('a runner whose code was not found at setup is named on the card', async () => {
    const { w } = await atB3()
    expect(latest(w)?.frozen.runner).toBe('absent')
    expect(await flowCard(w.host)).toContain('The test runner\'s code is not pinned')
  })
})
