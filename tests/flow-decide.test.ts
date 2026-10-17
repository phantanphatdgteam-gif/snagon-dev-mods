import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { ROOT } from './flow-fakes'
import { agentRun, atB3, ended, lastTicket, latest, run, SRC } from './flow-drive'

const HIGH = 'FINDING | CODE-C2 | HIGH | src/add.ts:1 | evidence: `a + b` with no check | scenario: add(NaN, 1) → NaN | expected: reject NaN'

describe('flow-decide: /flow-waive and its approval', () => {
  test('a junk finding is waived through the pane; the block clears, the reason is kept in a view, and the judge goes on', async () => {
    const { w } = await atB3({ src: `${SRC}console.log('here')\n` })
    expect(latest(w)?.blocked?.reason).toBe('junk')
    expect((await run(w, 'flow-waive J-1 the log is the feature output')).text).toContain('Shown in the flow pane')
    const echo = w.session().value?.pending.waive
    expect(echo?.title).toBe('Waiver for the project owner to approve')
    expect(echo?.lines.join('\n')).toContain('J-1 HIGH debug-leftover at src/add.ts:2')
    expect(echo?.lines.join('\n')).toContain('the log is the feature output')
    expect((await run(w, `flow-approve waive ${echo?.hash.slice(0, 8) ?? ''}`)).text).toContain('Waived J-1')
    const r = latest(w)
    expect(r?.findings.find(x => x.id === 'J-1')?.status).toBe('waived')
    expect(r?.blocked).toBeUndefined()
    expect(w.files.get(`${ROOT}/.snagon/flow/waivers.md`)).toContain('J-1: the log is the feature output')
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('B4')
    expect((await run(w, 'flow-waive J-1 again')).text).toContain('There is no open finding or red check J-1 to waive')
  })

  test('only an open floor or junk finding (or a red check) can be waived', async () => {
    const { w } = await atB3()
    expect((await run(w, 'flow-waive J-7 why not')).text).toContain('There is no open finding or red check J-7 to waive')
    expect(w.session().value?.pending.waive).toBeUndefined()
  })
})

describe('flow-decide: /flow-decide', () => {
  async function disputed() {
    const ctx = await atB3()
    const { w } = ctx
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await agentRun(w, lastTicket(w)?.id ?? '', ended('DISPUTE CR-1 | callers check the input'))
    await flowCheck(w.host)
    await agentRun(w, lastTicket(w)?.id ?? '', ended('UPHOLD CR-1'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toEqual({ reason: 'dispute', vars: { id: 'CR-1' } })
    return ctx
  }

  test('reject: the finding is closed as the owner\'s call, the block clears and the gate can pass', async () => {
    const { w } = await disputed()
    expect((await run(w, 'flow-decide CR-1 reject')).text).toContain('Decided CR-1: reject')
    expect(latest(w)?.findings.find(x => x.id === 'CR-1')?.status).toBe('owner-rejected')
    expect(latest(w)?.blocked).toBeUndefined()
    expect(w.submitted.at(-1)).toContain('flow_check')
    await flowCheck(w.host)
    expect(latest(w)?.seals.map(s => s.f)).toEqual(['F-01'])
  })

  test('followup: closed now, listed as a follow-up in the seal', async () => {
    const { w } = await disputed()
    await run(w, 'flow-decide CR-1 followup')
    await flowCheck(w.host)
    expect(latest(w)?.seals[0]?.followups).toEqual(['CR-1'])
  })

  test('fix: the finding opens again with one more edit and review round, so a fix ticket follows', async () => {
    const { w } = await disputed()
    const key = latest(w)?.features?.[0]?.key ?? ''
    const before = latest(w)?.counters[key]
    await run(w, 'flow-decide CR-1 fix')
    const r = latest(w)
    expect(r?.findings.find(x => x.id === 'CR-1')?.status).toBe('open')
    expect(r?.counters[key]).toMatchObject({ e: (before?.e ?? 0) - 1, r: (before?.r ?? 0) - 1 })
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false })
  })

  test('a finding that does not exist, or is closed, is refused; /flow-retry check waits only on a check that could not run', async () => {
    const { w } = await disputed()
    expect((await run(w, 'flow-decide CR-9 reject')).text).toContain('There is no open finding CR-9')
    expect((await run(w, 'flow-retry check')).text).toContain('Nothing waits for /flow-retry check now')
    expect(latest(w)?.blocked?.reason).toBe('dispute')
    await run(w, 'flow-decide CR-1 reject')
    expect((await run(w, 'flow-decide CR-1 fix')).text).toContain('There is no open finding CR-1')
  })
})

describe('flow-decide: /flow-retry', () => {
  test('a scope at its cap gets one more set of rounds, once', async () => {
    const { w } = await atB3({ exit: 1, tests: [{ file: 'tests/a.test.ts', title: 'adds', status: 'passed' }, { file: 'tests/add.test.ts', title: 'AC-001 adds', status: 'failed' }] })
    for (let i = 0; i < 4; i += 1) {
      await agentRun(w, lastTicket(w)?.id ?? '', ended('REPRODUCE: test\nLOCALIZE: src/add.ts:1\nHYPOTHESIS: x\nFIX: src/add.ts:1-1\nGUARD: AC-001 adds'))
      await flowCheck(w.host)
    }
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'debug' } })
    expect((await run(w, 'flow-retry F-01')).text).toContain('One more set of rounds for F-01')
    const r = latest(w)
    expect(r?.blocked).toBeUndefined()
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.retried).toBe(true)
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect((await run(w, 'flow-retry F-01')).text).toContain('F-01 already had its one retry')
  })

  test('check: a check that could not run is cleared to run again, with no round used', async () => {
    const { w } = await atB3({ before: d => { d.run = argv => (argv.includes('/usr/bin/sandbox-exec') ? { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: true } : argv.includes('grep') && argv.includes('AC-[0-9]{3}') ? { exitCode: 0, stdout: 'tests/add.test.ts\0', stderr: '' } : undefined) } })
    expect(latest(w)?.blocked?.reason).toBe('couldNotRun')
    expect((await run(w, 'flow-retry check')).text).toContain('The check runs again')
    expect(latest(w)?.blocked).toBeUndefined()
  })
})
