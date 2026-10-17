import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { flowStatus } from '../hooks/flow-turn'
import { sha256 } from '../hooks/flow-review'
import { METHOD_HEAD, ROOT } from './flow-fakes'
import { added, agentRun, atB3, AUTHOR_TREE, diffKey, duringJudge, editRecord, ended, lastTicket, latest, NEW_FAILED, OLD, PLAN_TEXT, reportOf, run, SRC, TEST_FILE, toV1 } from './flow-drive'

const BASE = 'a'.repeat(40)
const VERIFY = `${ROOT}/docs/flow/verify.md`

describe('flow-verify: V1 to V8', () => {
  test('all green: the report is written in the owner\'s language, the verified tree and report hash frozen, and the flow waits for /flow-ship', async () => {
    const { w } = await toV1()
    expect((await run(w, 'flow-verify')).text).toContain('Verify starts')
    expect(latest(w)?.awaiting).toBeUndefined()
    expect(w.submitted.at(-1)).toContain('flow_check')
    await flowCheck(w.host)
    const r = latest(w), text = w.files.get(VERIFY) ?? ''
    expect(text).toContain('# Verify report')
    expect(text).toContain('- F-01: sealed')
    expect(text).toContain('- AC-001: passed')
    expect(text).toContain('- test: passed')
    expect(r).toMatchObject({ phase: 'ship', task: 'H0', awaiting: '/flow-ship', verifiedTree: AUTHOR_TREE })
    expect(r?.verifyMdHash).toBe(await sha256(text))
    expect(JSON.parse(await flowStatus(w.host)).next).toContain('/flow-ship')
  })

  test('a decision recorded while verify runs its commands is kept (the report write rebuilds the findings from the newest record)', async () => {
    const { w, d } = await toV1()
    await run(w, 'flow-verify')
    const before = d.run
    let once = false
    d.run = argv => {
      if (!once && argv.includes('/usr/bin/sandbox-exec')) {
        once = true
        const [path, text] = [...w.files.entries()].filter(([k, v]) => /\.v\d+\.json$/.test(k) && v.trim()).sort((x, y) => Number(/\.v(\d+)\.json$/.exec(y[0])?.[1]) - Number(/\.v(\d+)\.json$/.exec(x[0])?.[1]))[0] ?? ['', '']
        const r = JSON.parse(text) as { findings: unknown[] }
        w.files.set(path, JSON.stringify({ ...r, findings: [...r.findings, { id: 'CR-9', f: 'F-01', rubricId: 'CODE-C2', sev: 'MEDIUM', loc: 'src/add.ts:1', status: 'accepted-follow-up' }] }))
      }
      return before?.(argv)
    }
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('H0')
    expect(latest(w)?.findings.find(x => x.id === 'CR-9')?.status).toBe('accepted-follow-up')
  })

  test('verify junk numbers go on from the highest number given, also one a seal dropped', async () => {
    const { w, d } = await toV1()
    ;(d.gitOut ?? {})[diffKey(BASE, AUTHOR_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', SRC) + added('src/debug.ts', "console.log('x')\n")
    editRecord(w, r => ({ ...r, lastIds: { J: 4 } }))
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    expect(latest(w)?.findings.filter(x => x.f === 'verify').map(x => x.id)).toEqual(['J-5'])
  })

  test('junk waived while verify runs its commands gets no fix ticket', async () => {
    const { w, d } = await toV1()
    ;(d.gitOut ?? {})[diffKey(BASE, AUTHOR_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', SRC) + added('src/debug.ts', "console.log('x')\n")
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    const fix = lastTicket(w)
    expect(fix).toMatchObject({ f: 'verify', kind: 'fix' })
    await agentRun(w, fix?.id ?? '', ended('done'))
    duringJudge(d, () => editRecord(w, r => ({ ...r, findings: r.findings.map(x => (x.f === 'verify' ? { ...x, status: 'waived' } : x)) })))
    await flowCheck(w.host)
    expect(lastTicket(w)?.id).toBe(fix?.id)
    expect(latest(w)?.task).toBe('H0')
  })

  test('a feature finding settled while verify runs is not raised again as verify junk', async () => {
    const { w, d } = await toV1()
    ;(d.gitOut ?? {})[diffKey(BASE, AUTHOR_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', SRC) + added('src/debug.ts', "console.log('x')\n")
    await run(w, 'flow-verify')
    duringJudge(d, () => editRecord(w, r => ({ ...r, findings: [...r.findings, { id: 'J-7', f: 'F-01', rubricId: 'debug-leftover', sev: 'HIGH', loc: 'src/debug.ts:1', status: 'waived' }] })))
    await flowCheck(w.host)
    expect(latest(w)?.findings.filter(x => x.f === 'verify')).toEqual([])
    expect(latest(w)?.task).toBe('H0')
  })

  test('a check waived while verify runs its commands gets no debug ticket', async () => {
    const { w, d } = await toV1()
    await run(w, 'flow-verify')
    d.judge = { test: { exit: 1, report: reportOf([OLD, NEW_FAILED]) } }
    await flowCheck(w.host)
    const debug = lastTicket(w)
    await agentRun(w, debug?.id ?? '', ended('REPRODUCE: test\nLOCALIZE: src/add.ts:1\nHYPOTHESIS: x\nFIX: src/add.ts:1-1\nGUARD: AC-001 adds'))
    duringJudge(d, () => editRecord(w, r => ({ ...r, frozen: { ...r.frozen, 'waive:check:test': 'yes' } })))
    await flowCheck(w.host)
    expect(lastTicket(w)?.id).toBe(debug?.id)
    expect(latest(w)?.task).toBe('H0')
  })

  test('a red command gets a verify debug ticket; at the debug cap it waits for a waiver, which the report then names', async () => {
    const { w, d } = await toV1()
    await run(w, 'flow-verify')
    d.judge = { test: { exit: 1, report: reportOf([OLD, NEW_FAILED]) } }
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ f: 'verify', kind: 'debug', used: false })
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain(`${METHOD_HEAD}\n\n---\nname: debugging-and-error-recovery`)
    for (let i = 0; i < 3; i += 1) {
      await agentRun(w, lastTicket(w)?.id ?? '', ended('REPRODUCE: test\nLOCALIZE: src/add.ts:1\nHYPOTHESIS: x\nFIX: src/add.ts:1-1\nGUARD: AC-001 adds'))
      await flowCheck(w.host)
    }
    expect(latest(w)?.blocked).toEqual({ reason: 'redCheck', vars: { command: 'test', cmdId: 'test' } })
    await run(w, 'flow-waive check:test the flaky machine clock')
    await run(w, `flow-approve waive ${w.session().value?.pending.waive?.hash.slice(0, 8) ?? ''}`)
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('H0')
    expect(w.files.get(VERIFY)).toContain('check:test: the flaky machine clock')
    expect(w.files.get(VERIFY)).toContain('- AC-001: waived')
    expect(w.files.get(VERIFY)).toContain('Blocks the agent caused: 0')
  })

  test('a Required eval id the tests no longer prove makes the run red', async () => {
    const { w, d } = await toV1()
    await run(w, 'flow-verify')
    d.judge = { test: { exit: 0, report: reportOf([OLD]) } }
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ f: 'verify', kind: 'debug' })
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain('AC-001')
  })

  test('an optional criterion is listed, not required; /flow-verify before V1 only shows the card', async () => {
    const plan = PLAN_TEXT.replace('## Features', '- AC-002 (Optional): big numbers stay exact. Verification: tests/add.test.ts\n\n## Features')
    const { w } = await toV1({ plan })
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('H0')
    expect(w.files.get(VERIFY)).toContain('- AC-002: optional, not required')
    const early = await atB3()
    await run(early.w, 'flow-verify')
    expect(latest(early.w)?.task).toBe('B4')
  })

  test('a plan changed after approval blocks verify', async () => {
    const { w } = await toV1()
    await run(w, 'flow-verify')
    w.files.set(`${ROOT}/docs/flow/plan.md`, `${PLAN_TEXT}\n- note\n`)
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toEqual({ reason: 'frozenChanged', vars: { what: 'docs/flow/plan.md' } })
  })

  test('junk no feature settled gets verify fix tickets, then waits for a waiver', async () => {
    const { w, d } = await toV1()
    ;(d.gitOut ?? {})[diffKey(BASE, AUTHOR_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', SRC) + added('src/debug.ts', "console.log('x')\n")
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ f: 'verify', kind: 'fix', used: false })
    expect(latest(w)?.findings.find(x => x.f === 'verify')).toMatchObject({ rubricId: 'debug-leftover', loc: 'src/debug.ts:1', status: 'open' })
    for (let i = 0; i < 2; i += 1) {
      await agentRun(w, lastTicket(w)?.id ?? '', ended('done'))
      await flowCheck(w.host)
    }
    expect(latest(w)?.blocked).toMatchObject({ reason: 'junk', vars: { rule: 'debug-leftover', location: 'src/debug.ts:1' } })
  })

  test('junk waived in its feature is not raised again; the report lists the waiver', async () => {
    const { w } = await toV1({ src: `${SRC}console.log('here')\n` }, 'the log is the output')
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('H0')
    expect(w.files.get(VERIFY)).toContain('- J-1: the log is the output (waived by the project owner)')
    expect(w.files.get(VERIFY)).toContain('Blocks the agent caused: 1')
  })

  test('the authors\' assumptions are listed per feature', async () => {
    const { w } = await toV1({ assumptions: '\n- inputs are finite' })
    expect(latest(w)?.assumptions).toEqual({ 'F-01': ['inputs are finite'] })
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    expect(w.files.get(VERIFY)).toContain('## Assumptions\n- F-01: inputs are finite')
    expect(w.files.get(VERIFY)).toContain('Blocks the agent caused: 0')
  })

  test('a secret that would reach the report: the redacted report is written and the flow is blocked for the owner, who can verify again', async () => {
    const { w } = await toV1({ src: `${SRC}console.log('here')\n` }, 'the log is the output')
    w.files.set(`${ROOT}/.snagon/flow/waivers.md`, `# Waivers\n- J-1: key ghp_${'k'.repeat(36)}\n`)
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    const r = latest(w), text = w.files.get(VERIFY) ?? ''
    expect(r?.blocked).toEqual({ reason: 'publish', vars: { detail: 'docs/flow/verify.md' } })
    expect(text).toContain('[secret removed')
    expect(text).not.toContain('kkkkkkkk')
    expect(r?.verifiedTree).toBeUndefined()
    expect(JSON.parse(await flowStatus(w.host)).next).toContain('/flow-verify')
    w.files.set(`${ROOT}/.snagon/flow/waivers.md`, '# Waivers\n- J-1: the log is the output\n')
    await run(w, 'flow-verify')
    expect(latest(w)?.blocked).toBeUndefined()
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('H0')
  })
})
