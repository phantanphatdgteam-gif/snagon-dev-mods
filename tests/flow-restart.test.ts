import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { ROOT } from './flow-fakes'
import { added, agentRun, atB3, AUTHOR_TREE, diffKey, ended, GREEN_REPORT, HEAD, lastTicket, latest, NEW_FAILED, NEW_PASSED, OLD, reportOf, run, SRC, START, TEST_FILE, toB1, toS3, world, type DriveOpts, type W } from './flow-drive'

const HIGH = 'FINDING | CODE-C2 | HIGH | src/add.ts:1 | evidence: `a + b` with no check | scenario: add(NaN, 1) → NaN | expected: reject NaN'
/** A new session: this session's state (and so every ticket text) is gone; the record stays. */
const restart = (w: W): void => { const s = w.session().value; if (s) w.setSession({ ...s, tickets: {} }) }
const counter = (w: W, key?: string) => { const r = latest(w); return r?.counters[key ?? r?.features?.[0]?.key ?? ''] }

const green = (): DriveOpts => ({ gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } }, run: argv => (argv.includes('grep') && argv.includes('AC-[0-9]{3}') ? { exitCode: 0, stdout: 'tests/add.test.ts\0', stderr: '' } : undefined) })
async function atB1(): Promise<{ w: W; d: DriveOpts }> {
  const d = green()
  const w = world(d)
  await toB1(w)
  await run(w, 'flow-build')
  return { w, d }
}

describe('flow restart: ticket texts and lost tickets (plan line 223, H5)', () => {
  test('a ticket\'s text leaves the session when its agent starts', async () => {
    const { w } = await atB3()
    const t = lastTicket(w)
    expect(w.session().value?.tickets[t?.id ?? '']).toContain('## CONTRACT')
    await agentRun(w, t?.id ?? '', ended('NO-FINDINGS'))
    expect(w.session().value?.tickets[t?.id ?? '']).toBeUndefined()
  })

  test('the RED ticket lost in a restart is closed and issued again at no cost', async () => {
    const { w } = await atB1()
    const lost = lastTicket(w)
    expect(lost).toMatchObject({ kind: 'red', used: false })
    restart(w)
    await flowCheck(w.host)
    const r = latest(w)
    expect(r?.tickets.find(t => t.id === lost?.id)).toMatchObject({ used: true })
    expect(r?.tickets.find(t => t.id === lost?.id)?.toolUseId).toBeUndefined()
    expect(lastTicket(w)).toMatchObject({ kind: 'red', used: false })
    expect(lastTicket(w)?.id).not.toBe(lost?.id)
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toBeDefined()
    expect(counter(w)?.e).toBe(0)
  })

  test('a lost review ticket is rebuilt with no review round used', async () => {
    const { w } = await atB3()
    const lost = lastTicket(w)
    restart(w)
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'review', used: false })
    expect(lastTicket(w)?.id).not.toBe(lost?.id)
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain('## CONTRACT')
    expect(latest(w)?.round?.tickets).toEqual([lastTicket(w)?.id])
    expect(counter(w)?.r).toBe(1)
  })

  test('a lost debug ticket: the judge runs again and its new debug ticket takes no debug round', async () => {
    const { w } = await atB3({ exit: 1, tests: [OLD, NEW_FAILED] })
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(counter(w)?.d).toBe(1)
    restart(w)
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(counter(w)?.d).toBe(1)
  })

  test('a lost debug ticket gives no other round for free: green on the next judge, the review round is counted', async () => {
    const { w, d } = await atB3({ exit: 1, tests: [OLD, NEW_FAILED] })
    restart(w)
    d.judge = { test: { exit: 0, report: reportOf([OLD, NEW_PASSED]) } }
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'review', used: false })
    expect(counter(w)?.r).toBe(1)
  })

  test('a lost fix ticket is issued again with no edit round used', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false })
    const e = counter(w)?.e
    restart(w)
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false })
    expect(counter(w)?.e).toBe(e)
  })

  test('a lost planner ticket is issued again with no plan round used', async () => {
    const w = world(green())
    await toS3(w)
    await flowCheck(w.host)
    await run(w, 'flow-plan add a sum function')
    expect(counter(w, 'plan')?.e).toBe(1)
    restart(w)
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ f: 'plan', used: false })
    expect(counter(w, 'plan')?.e).toBe(1)
  })
})

describe('flow restart: attestations live in the record', () => {
  test('an attested review round survives a restart: the gate passes and nothing is issued again', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended('NO-FINDINGS'))
    const s = w.session().value
    if (s) w.setSession({ ...s, tickets: {}, runs: {} })
    await flowCheck(w.host)
    expect(latest(w)?.seals.map(x => x.f)).toEqual(['F-01'])
    expect(counter(w)?.r ?? 1).toBe(1)
  })
})

describe('flow restart: review rounds rebuilt, and a tree that moved during review', () => {
  test('an unattested delta run is rebuilt with the change since the review round', async () => {
    const FIX_TREE = 'd'.repeat(40), FIXED = 'export const add = (a: number, b: number): number => {\n  return a + b\n}\n'
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const gitOut = d.gitOut ?? {}
    gitOut[diffKey(AUTHOR_TREE, FIX_TREE)] = ['diff --git a/src/add.ts b/src/add.ts', '--- a/src/add.ts', '+++ b/src/add.ts', '@@ -1 +1,3 @@', `-${SRC.trim()}`, ...FIXED.trim().split('\n').map(l => `+${l}`), ''].join('\n')
    gitOut[diffKey(START, FIX_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', FIXED)
    await agentRun(w, lastTicket(w)?.id ?? '', ended('FIX CR-1 | src/add.ts:1-3'), () => { w.setTree(FIX_TREE); w.files.set(`${ROOT}/src/add.ts`, FIXED) })
    await flowCheck(w.host)
    const delta = lastTicket(w)
    expect(delta?.kind).toBe('delta')
    await agentRun(w, delta?.id ?? '', () => 'RESOLVED CR-1')
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'delta', used: false })
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain('+  return a + b')
    expect(counter(w)?.r).toBe(3) // the delta run that did not report back took a review round
  })

  test('files changed during review with no fix ticket: judged, and lines outside any FIX range are a floor finding', async () => {
    const MOVED = '9'.repeat(40), EDITED = 'export const add = (a: number, b: number): number => a - b\n'
    const { w, d } = await atB3()
    const gitOut = d.gitOut ?? {}
    gitOut[diffKey(AUTHOR_TREE, MOVED)] = ['diff --git a/src/add.ts b/src/add.ts', '--- a/src/add.ts', '+++ b/src/add.ts', '@@ -1 +1 @@', `-${SRC.trim()}`, `+${EDITED.trim()}`, ''].join('\n')
    gitOut[diffKey(START, MOVED)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', EDITED)
    await agentRun(w, lastTicket(w)?.id ?? '', ended('NO-FINDINGS'), () => { w.setTree(MOVED); w.files.set(`${ROOT}/src/add.ts`, EDITED) })
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'floor', vars: { rule: 'fix-scope', location: 'src/add.ts:1' } })
    expect(latest(w)?.seals).toEqual([])
  })
})
