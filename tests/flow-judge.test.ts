import { describe, expect, test } from 'claude-code/testing'
import type { Io, RunResult } from '../hooks/session'
import { readReport, type Signature } from '../flow/parse'
import { parseDiff } from '../hooks/flow-scan'
import { TYPESCRIPT } from '../flow/data/stacks/typescript'
import { TYPESCRIPT_STACK } from '../hooks/stacks/typescript'
import { addedTests, declChanges, importsOf, securityForced } from '../hooks/stacks/typescript-tests'
import { judgedArgv } from '../hooks/stacks/typescript-commands'
import { VITEST } from './fixtures/runners'
import { VITEST_REPORT } from './fixtures/reports'
import {
  timeoutFor, runJudged, judgeRun, redCheck, outOfScope, pluginIntegrity, newFailures,
} from '../hooks/flow-judge'

const sig = (file: string, id: string, message = 'AssertionError: expected 1 to be 2', collection = false): Signature => ({ runner: 'vitest', file, id, message, collection })
const fakeRun = (answer: RunResult | Error, ms: number) => {
  let now = 0
  return { now: async () => now, run: async () => { now += ms; if (answer instanceof Error) throw answer; return answer } } as unknown as Io
}
const vitest = { id: 'test', runner: 'vitest', mode: 'no-new-failures' as const }

describe('flow judge: running a command', () => {
  test('the timeout is three times the baseline, at least baseline + 60 s, at most 10 minutes', () => {
    expect([timeoutFor(10_000), timeoutFor(60_000), timeoutFor(400_000)]).toEqual([70_000, 180_000, 600_000])
  })

  test('a run that ends is read whole; killed at its timeout is too slow; not started, or either stream cut at 4 MiB, could not run', async () => {
    // stdout is kept apart as well: pytest's summary must be its last line (R2 step 3)
    expect(await runJudged(fakeRun({ exitCode: 1, stdout: 'out', stderr: 'err' }, 500), ['x'], '/r', 70_000)).toEqual({ ok: true, run: { exitCode: 1, output: 'out\nerr', ms: 500, stdout: 'out' } })
    expect(await runJudged(fakeRun(new Error('killed: timed out'), 70_000), ['x'], '/r', 70_000)).toMatchObject({ ok: false, reason: 'tooSlow' })
    expect(await runJudged(fakeRun(new Error('ENOENT'), 5), ['x'], '/r', 70_000)).toMatchObject({ ok: false, reason: 'couldNotRun' })
    expect(await runJudged(fakeRun({ exitCode: 0, stdout: 'x', stderr: '', isStdoutTruncated: true }, 5), ['x'], '/r', 70_000)).toMatchObject({ ok: false, reason: 'couldNotRun' })
    expect(await runJudged(fakeRun({ exitCode: 1, stdout: '', stderr: 'x', isStderrTruncated: true }, 5), ['x'], '/r', 70_000)).toMatchObject({ ok: false, reason: 'couldNotRun' })
  })

  test('the judged command asks for a JSON report in the run folder and turns caches off, for the runner itself or a one-command script', () => {
    expect(judgedArgv(['npx', 'vitest', 'run'], 'vitest', '/t/r')).toEqual({ argv: ['npx', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=/t/r/report.json'], reportFile: '/t/r/report.json' })
    expect(judgedArgv(['npx', 'jest'], 'jest', '/t/r')).toEqual({ argv: ['npx', 'jest', '--json', '--outputFile=/t/r/report.json', '--no-cache'], reportFile: '/t/r/report.json' })
    expect(judgedArgv(['npx', 'eslint', '.', '--cache'], 'eslint', '/t/r')).toEqual({ argv: ['npx', 'eslint', '.', '--cache', '--cache-location=/t/r/eslintcache'], reportFile: null })
    expect(judgedArgv(['npx', 'tsc', '--noEmit'], 'tsc', '/t/r').argv).toEqual(['npx', 'tsc', '--noEmit', '--incremental', 'false', '--composite', 'false'])
    expect(judgedArgv(['npx', 'tsc', '-b'], 'tsc', '/t/r').argv).toEqual(['npx', 'tsc', '-b', '--force'])
    expect(judgedArgv(['npm', 'test'], 'vitest', '/t/r', 'vitest run').argv).toEqual(['npm', 'test', '--', '--reporter=default', '--reporter=json', '--outputFile.json=/t/r/report.json'])
    expect(judgedArgv(['npm', 'run', 'test'], 'jest', '/t/r', 'jest --ci').argv.slice(3, 5)).toEqual(['--', '--json'])
    expect(judgedArgv(['npm', 'test', '--', '--run'], 'vitest', '/t/r', 'vitest').argv).toEqual(['npm', 'test', '--', '--run', '--reporter=default', '--reporter=json', '--outputFile.json=/t/r/report.json'])
    for (const pm of [['pnpm', 'test'], ['yarn', 'run', 'test'], ['bun', 'run', 'test']]) expect(judgedArgv(pm, 'vitest', '/t/r', 'vitest run').argv).toEqual([...pm, '--reporter=default', '--reporter=json', '--outputFile.json=/t/r/report.json'])
    for (const [argv, body] of [[['npm', 'test'], 'vitest run && tsc'], [['npm', 'test'], 'node scripts/test.js'], [['bun', 'test'], 'vitest run'], [['npx', 'playwright', 'test'], undefined]] as const) expect(judgedArgv([...argv], 'vitest', '/t/r', body)).toEqual({ argv: [...argv], reportFile: null })
  })
})

describe('flow judge: pass modes and eval ids', () => {
  test('no-new-failures: a red baseline passes while nothing new fails; failures are a multiset; volatile parts of a message do not count', () => {
    const base = { signatures: [sig('tests/a.test.ts', 'old one')], counts: null, exitCode: 1 }
    const out = ' FAIL  tests/a.test.ts > old one\nAssertionError: expected 1 to be 2\n'
    expect(judgeRun(vitest, { exitCode: 1, output: out, ms: 1 }, base, TYPESCRIPT, [], new Map()).pass).toBe(true)
    expect(judgeRun(vitest, { exitCode: 1, output: `${out}${out}`, ms: 1 }, base, TYPESCRIPT, [], new Map()).newFailures).toHaveLength(1)
    expect(newFailures([sig('a', 'x', 'expected 1728555123456 to be 0 (12ms) at /private/var/folders/ab/T/run-8f3a2b1c9d/x.ts')], [sig('a', 'x', 'expected 1728555999999 to be 0 (40ms) at /private/var/folders/ab/T/run-11aa22bb33/x.ts')])).toEqual([])
    expect(newFailures([sig('a', 'x', 'expected 1234567 to be 0')], [sig('a', 'x', 'expected 7654321 to be 0')])).toEqual([])
    expect(newFailures([sig('a', 'x', 'expected 3 to be 4')], [sig('a', 'x', 'expected 3 to be 5')])).toHaveLength(1)
  })

  test('with a report, an eval id needs a test that ran and passed; skipped or absent is "not run"; the report decides failures', () => {
    const report = readReport(VITEST_REPORT, '/p')
    const present = new Map([['AC-001', ['tests/add.test.ts']]])
    const v = judgeRun(vitest, { exitCode: 1, output: '', ms: 1 }, { signatures: [], counts: null, exitCode: 1 }, TYPESCRIPT, ['AC-001', 'AC-002', 'AC-004', 'AC-009'], present, report)
    expect(v.evalProblems).toEqual(['AC-002 failed', 'AC-004 not run', 'AC-009 not run'])
    expect(v.newFailures.map(s => s.id).sort()).toEqual(['', 'AC-003 top level', 'AC-006 subtract', 'add > AC-002 adds negatives'])
    expect(judgeRun(vitest, { exitCode: 1, output: '', ms: 1 }, null, TYPESCRIPT, [], present, null)).toMatchObject({ pass: false, note: 'report missing or unreadable' })
    expect(judgeRun({ ...vitest, mode: 'must-pass' }, { exitCode: 0, output: '', ms: 1 }, null, TYPESCRIPT, [], present, null).pass).toBe(false)
    expect(judgeRun({ ...vitest, mode: 'must-pass' }, { exitCode: 0, output: '', ms: 1 }, null, TYPESCRIPT, [], present, report).pass).toBe(false)
    const clean = { tests: [{ file: 'tests/a.test.ts', id: 'AC-0011 x', title: 'AC-0011 x', status: 'passed' as const, message: '' }, { file: 'tests/a.test.ts', id: 'AC-001 > y', title: 'y', status: 'passed' as const, message: '' }], collection: [], fileErrors: [], counts: { passed: 2, failed: 0, skipped: 0 } }
    expect(judgeRun({ ...vitest, mode: 'must-pass' }, { exitCode: 0, output: '', ms: 1 }, null, TYPESCRIPT, [], present, clean).pass).toBe(true)
    expect(judgeRun(vitest, { exitCode: 0, output: '', ms: 1 }, null, TYPESCRIPT, ['AC-001'], present, clean).evalProblems).toEqual(['AC-001 not run'])
  })

  test('with a report, a test that passed at baseline and is now skipped or gone is a new failure; a report the console contradicts never passes', () => {
    const report = readReport(VITEST_REPORT, '/p')
    const base = { signatures: report ? report.tests.filter(t => t.status === 'failed').map(t => sig(t.file, t.id, t.message)).concat([sig('tests/missing.test.ts', '', report.collection[0]?.message ?? '', true)]) : [], counts: null, exitCode: 1, passed: ['tests/add.test.ts\u0000AC-001 adds', 'tests/fail.test.ts\u0000AC-004 skipped', 'tests/gone.test.ts\u0000AC-005 gone'] }
    const v = judgeRun(vitest, { exitCode: 1, output: '', ms: 1 }, base, TYPESCRIPT, [], new Map(), report)
    expect(v.newFailures.map(s => `${s.file} ${s.id}`)).toEqual(['tests/fail.test.ts AC-004 skipped', 'tests/gone.test.ts AC-005 gone'])
    const clean = report ? { ...report, tests: report.tests.map(t => ({ ...t, file: `pkg/${t.file}` })) } : report
    expect(judgeRun(vitest, { exitCode: 1, output: ' FAIL  tests/fail.test.ts > AC-003 top level\nAssertionError: x\n', ms: 1 }, null, TYPESCRIPT, [], new Map(), clean).note).not.toBe('the report and the console disagree')
    const lying = judgeRun(vitest, { exitCode: 1, output: ' FAIL  tests/add.test.ts > AC-001 adds\nAssertionError: x\n', ms: 1 }, base, TYPESCRIPT, [], new Map(), report)
    expect(lying).toMatchObject({ pass: false, note: 'the report and the console disagree' })
    const must = judgeRun({ ...vitest, mode: 'must-pass' }, { exitCode: 0, output: '', ms: 1 }, { ...base, signatures: [] }, TYPESCRIPT, ['AC-001'], new Map(), { tests: [{ file: 'tests/add.test.ts', id: 'AC-001 adds', title: 'AC-001 adds', status: 'skipped' as const, message: '' }], collection: [], fileErrors: [], counts: { passed: 0, failed: 0, skipped: 1 } })
    expect([must.pass, must.evalProblems, must.newFailures.map(s => s.id)]).toEqual([false, ['AC-001 not run'], ['AC-001 adds', 'AC-004 skipped', 'AC-005 gone']])
  })

  test('the console and the report agree on suite failures and files that failed outside their tests; jest runtime errors count', () => {
    const suite = { tests: [{ file: 'tests/a.test.ts', id: 'suite > S1', title: 'S1', status: 'skipped' as const, message: '' }], collection: [], fileErrors: [{ file: 'tests/a.test.ts', message: 'Error: setup broke' }], runtimeErrors: 0, counts: { passed: 0, failed: 0, skipped: 1 } }
    expect(judgeRun(vitest, { exitCode: 1, output: ' FAIL  tests/a.test.ts > suite\nError: setup broke\n', ms: 1 }, null, TYPESCRIPT, [], new Map(), suite).note).not.toBe('the report and the console disagree')
    const mixedSuite = { ...suite, fileErrors: [], tests: [...suite.tests, { file: 'tests/a.test.ts', id: 'other', title: 'other', status: 'failed' as const, message: 'AssertionError: x' }] }
    expect(judgeRun(vitest, { exitCode: 1, output: ' FAIL  tests/a.test.ts > suite\nError: setup broke\n', ms: 1 }, null, TYPESCRIPT, [], new Map(), mixedSuite).note).not.toBe('the report and the console disagree')
    expect(judgeRun(vitest, { exitCode: 1, output: ' FAIL  tests/a.test.ts > nothing\nError: x\n', ms: 1 }, null, TYPESCRIPT, [], new Map(), mixedSuite).note).toBe('the report and the console disagree')
    const jestRun = 'FAIL __tests__/mixed.test.js\n  ● T1 fails\n\n    expect(received).toBe(expected)\n\n  ● Test suite failed to run\n\n    teardown broke\n'
    const mixed = { tests: [{ file: '__tests__/mixed.test.js', id: 'T1 fails', title: 'T1 fails', status: 'failed' as const, message: 'expect(received).toBe(expected)' }], collection: [], fileErrors: [{ file: '__tests__/mixed.test.js', message: 'teardown broke' }], runtimeErrors: 1, counts: { passed: 0, failed: 1, skipped: 0 } }
    const jestCmd = { id: 'test', runner: 'jest', mode: 'no-new-failures' as const }
    expect(judgeRun(jestCmd, { exitCode: 1, output: jestRun, ms: 1 }, null, TYPESCRIPT, [], new Map(), mixed).note).not.toBe('the report and the console disagree')
    expect(judgeRun(jestCmd, { exitCode: 1, output: jestRun, ms: 1 }, null, TYPESCRIPT, [], new Map(), { ...mixed, fileErrors: [] }).note).toBe('the report and the console disagree')
    const base = { signatures: [{ runner: 'jest', file: '__tests__/mixed.test.js', id: 'T1 fails', message: 'expect(received).toBe(expected)', collection: false }], counts: null, exitCode: 1, runErrors: 0 }
    expect(judgeRun(jestCmd, { exitCode: 1, output: '', ms: 1 }, base, TYPESCRIPT, [], new Map(), { ...mixed, fileErrors: [] }).newFailures.map(s => s.id)).toEqual(['(run)'])
  })

  test('a renamed or deleted test (its declaration removed in the diff) is not a regression; one hidden or skipped is', () => {
    const report = { tests: [{ file: 'tests/a.test.ts', id: 'adds two numbers', title: 'adds two numbers', status: 'passed' as const, message: '' }], collection: [], fileErrors: [], counts: { passed: 1, failed: 0, skipped: 0 } }
    const base = { signatures: [], counts: null, exitCode: 0, passed: ['tests/a.test.ts\u0000adds'] }
    const files = parseDiff("diff --git a/tests/a.test.ts b/tests/a.test.ts\n--- a/tests/a.test.ts\n+++ b/tests/a.test.ts\n@@ -1,1 +1,1 @@\n-it('adds', () => {\n+it('adds two numbers', () => {")
    const changes = declChanges(files, ['tests/a.test.ts'])
    expect(changes).toEqual({ removedTitles: ['adds'], addedTitles: ['adds two numbers'], removedSuites: [], addedSuites: [] })
    const run = { exitCode: 0, output: '', ms: 1 }
    expect(judgeRun(vitest, run, base, TYPESCRIPT, [], new Map(), report, changes).pass).toBe(true)
    expect(judgeRun(vitest, run, base, TYPESCRIPT, [], new Map(), report).newFailures.map(s => s.id)).toEqual(['adds'])
    const skipped = { ...report, tests: [{ file: 'tests/a.test.ts', id: 'adds', title: 'adds', status: 'skipped' as const, message: '' }] }
    expect(judgeRun(vitest, run, base, TYPESCRIPT, [], new Map(), skipped, changes).newFailures.map(s => s.id)).toEqual(['adds'])
    // Declared again (gated by an if): hidden, not renamed.
    expect(judgeRun(vitest, run, base, TYPESCRIPT, [], new Map(), report, { removedTitles: ['adds'], addedTitles: ['adds'] }).newFailures.map(s => s.id)).toEqual(['adds'])
    // A renamed describe: the same tests pass under the new name.
    const suiteBase = { ...base, passed: ['tests/a.test.ts\u0000cart > adds'] }
    const renamed = { ...report, tests: [{ file: 'tests/a.test.ts', id: 'Cart service > adds', title: 'adds', status: 'passed' as const, message: '' }] }
    expect(judgeRun(vitest, run, suiteBase, TYPESCRIPT, [], new Map(), renamed, { removedSuites: ['cart'], addedSuites: ['Cart service'] }).pass).toBe(true)
    expect(judgeRun(vitest, run, suiteBase, TYPESCRIPT, [], new Map(), renamed).pass).toBe(false)
    // A table title removed: its rows are gone with it.
    const rowBase = { ...base, passed: ['tests/a.test.ts\u0000adds 1', 'tests/a.test.ts\u0000adds 2'] }
    expect(judgeRun(vitest, run, rowBase, TYPESCRIPT, [], new Map(), report, { removedTitles: ['adds %i'] }).pass).toBe(true)
  })

  test('a decoy test does not prove an eval id; a file that fails outside its tests and new unhandled errors are failures', () => {
    const decoy = { tests: [{ file: 'tests/a.test.ts', id: 'AC-001 ok', title: 'AC-001 ok', status: 'passed' as const, message: '' }, { file: 'tests/a.test.ts', id: 'AC-001 real', title: 'AC-001 real', status: 'skipped' as const, message: '' }], collection: [], fileErrors: [], counts: { passed: 1, failed: 0, skipped: 1 } }
    expect(judgeRun(vitest, { exitCode: 0, output: '', ms: 1 }, null, TYPESCRIPT, ['AC-001'], new Map(), decoy).evalProblems).toEqual(['AC-001 not run'])
    const teardown = { ...decoy, tests: [decoy.tests[0]].filter(x => x !== undefined), fileErrors: [{ file: 'tests/a.test.ts', message: 'Error: teardown broke' }] }
    expect(judgeRun(vitest, { exitCode: 1, output: '', ms: 1 }, null, TYPESCRIPT, [], new Map(), teardown).newFailures.map(s => `${s.file} ${s.id}`)).toEqual(['tests/a.test.ts (file)'])
    const late = { ...decoy, tests: [decoy.tests[0]].filter(x => x !== undefined) }
    const summary = '      Tests  1 passed (1)\n     Errors  1 error\n'
    expect(judgeRun(vitest, { exitCode: 1, output: summary, ms: 1 }, { signatures: [], counts: null, exitCode: 0, runErrors: 0 }, TYPESCRIPT, [], new Map(), late).newFailures.map(s => s.id)).toEqual(['(run)'])
    expect(judgeRun(vitest, { exitCode: 1, output: summary, ms: 1 }, { signatures: [], counts: null, exitCode: 1, runErrors: 1 }, TYPESCRIPT, [], new Map(), late).pass).toBe(true)
  })

  test('without a report an eval id is never proven to pass; must-pass needs exit 0; unreadable output never passes', () => {
    const present = new Map([['AC-001', ['tests/a.test.ts']], ['AC-002', ['tests/a.test.ts']]])
    const v = judgeRun(vitest, { exitCode: 1, output: VITEST, ms: 1 }, { signatures: [], counts: null, exitCode: 1 }, TYPESCRIPT, ['AC-001', 'AC-002', 'AC-009'], present)
    expect([v.pass, v.evalProblems]).toEqual([false, ['AC-001 not proven (no runner report)', 'AC-002 failed', 'AC-009 has no test']])
    expect(judgeRun({ id: 'lint', runner: 'eslint', mode: 'must-pass' }, { exitCode: 0, output: '', ms: 1 }, null, TYPESCRIPT, [], new Map()).pass).toBe(true)
    expect(judgeRun(vitest, { exitCode: 1, output: 'Error: failed to load config from vitest.config.ts', ms: 1 }, null, TYPESCRIPT, [], new Map())).toMatchObject({ pass: false, note: 'failed without a failure the stack can read' })
    expect(judgeRun({ id: 'build', runner: 'build', mode: 'no-new-failures' }, { exitCode: 1, output: 'boom', ms: 1 }, null, TYPESCRIPT, [], new Map())).toMatchObject({ pass: false, note: 'output not readable' })
  })
})

describe('flow judge: the RED rule', () => {
  const testDiff = (lines: string[]) => parseDiff([`diff --git a/tests/add.test.ts b/tests/add.test.ts`, 'new file mode 100644', '--- /dev/null', '+++ b/tests/add.test.ts', `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n'))
  const files = testDiff(["import { add, sub as minus } from '../src/add'", "import { mul } from '../src/mul'", "describe('add', () => {", "  it('AC-001 adds', () => { expect(add(1, 2)).toBe(3) })", '})', "it('AC-002 subtracts', () => { expect(minus(2, 1)).toBe(1) })"])
  // inStart: never asked for TypeScript (its errors name no module; a package import resolves to null)
  const base = { fTestFiles: ['tests/add.test.ts'], fAcs: ['AC-001', 'AC-002'], newFiles: ['src/add.ts'], stack: TYPESCRIPT_STACK, inStart: async () => { throw new Error('inStart asked for TypeScript') } }
  const absent = async () => true, present = async () => false

  test('added tests (also when the opener wraps to the next line) and imports are read from the diff', () => {
    expect(addedTests(files, ['tests/add.test.ts'])).toEqual([{ file: 'tests/add.test.ts', name: 'AC-001 adds' }, { file: 'tests/add.test.ts', name: 'AC-002 subtracts' }])
    expect(addedTests(testDiff(['it(', "  'AC-003 a long name that prettier wrapped',", '  () => {})', "expect(/^a/.test('abc')).toBe(true)"]), ['tests/add.test.ts'])).toEqual([{ file: 'tests/add.test.ts', name: 'AC-003 a long name that prettier wrapped' }])
    expect(importsOf(files[0]?.lines.map(l => l.text) ?? [])).toEqual(new Map([['add', { spec: '../src/add', name: 'add' }], ['minus', { spec: '../src/add', name: 'sub' }], ['mul', { spec: '../src/mul', name: 'mul' }]]))
  })

  test('RED holds when every added test fails by an assertion or by a module or export that does not exist yet', async () => {
    expect(await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds'), sig('tests/add.test.ts', 'AC-002 subtracts', 'TypeError: (0 , minus) is not a function')], absentAtStart: absent })).toEqual({ ok: true, problems: [] })
    expect((await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds'), sig('tests/add.test.ts', 'AC-002 subtracts', 'TypeError: __vite_ssr_import_0__.sub is not a function')], absentAtStart: absent })).ok).toBe(true)
    expect((await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', '', "Error: Cannot find module '../src/add' imported from '/p/tests/add.test.ts'", true)], absentAtStart: absent })).ok).toBe(true)
  })

  test('RED fails: a passing test, a test whose name is only a prefix of a failing one, a wrong reason, an existing export, a module not marked new, an AC without a test', async () => {
    expect((await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds')], absentAtStart: absent })).problems).toEqual(['an added test passes: AC-002 subtracts'])
    const prefix = testDiff(["it('AC-001', () => {})", "it('AC-001 stub', () => { expect(f()).toBe(1) })"])
    expect((await redCheck({ ...base, fAcs: ['AC-001'], files: prefix, failures: [sig('tests/add.test.ts', 'AC-001 stub')], absentAtStart: absent })).problems).toEqual(['an added test passes: AC-001'])
    expect((await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds', 'ReferenceError: helper is not defined'), sig('tests/add.test.ts', 'AC-002 subtracts')], absentAtStart: absent })).problems).toEqual(['AC-001 adds fails for another reason (ReferenceError: helper is not defined)'])
    expect((await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds'), sig('tests/add.test.ts', 'AC-002 subtracts', 'TypeError: (0 , minus) is not a function')], absentAtStart: present })).problems).toEqual(['AC-002 subtracts fails on minus, which src/add already exports'])
    expect((await redCheck({ ...base, newFiles: [], files, failures: [sig('tests/add.test.ts', '', "Error: Cannot find module '../src/add'", true)], absentAtStart: absent })).problems).toEqual(['tests/add.test.ts cannot load ../src/add, which the plan does not mark (new)'])
    expect((await redCheck({ ...base, files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds'), sig('tests/add.test.ts', 'AC-002 subtracts'), sig('tests/other.test.ts', '', "Error: Cannot find module '../src/add'", true)], absentAtStart: absent })).problems).toEqual(["tests/other.test.ts failed to load, outside the feature's test files"])
    expect((await redCheck({ ...base, fAcs: ['AC-001', 'AC-002', 'AC-003'], files, failures: [sig('tests/add.test.ts', 'add > AC-001 adds'), sig('tests/add.test.ts', 'AC-002 subtracts')], absentAtStart: absent })).problems).toEqual(['no added test names AC-003'])
  })

  test('table tests (each with rows or a tagged template) are added tests; every row must fail', async () => {
    const table = testDiff(["it.each([[1, 2], [2, 3]])('AC-001 adds %i', (a, b) => { expect(add(a, 1)).toBe(b) })", 'test.each`a | b`(\'AC-002 subtracts $a\', ({ a }) => {})'])
    expect(addedTests(table, ['tests/add.test.ts']).map(t => t.name)).toEqual(['AC-001 adds %i', 'AC-002 subtracts $a'])
    expect(addedTests(testDiff(['test', "  .each([[1, 2]])('AC-004 rows %i', (a) => {})", "it .only('AC-005 spaced', () => {})"]), ['tests/add.test.ts']).map(t => t.name)).toEqual(['AC-004 rows %i', 'AC-005 spaced'])
    expect(addedTests(testDiff(["// it('AC-009 later', () => {})", " * test('AC-008 in a doc comment')"]), ['tests/add.test.ts'])).toEqual([])
    const rows = [sig('tests/add.test.ts', 'AC-001 adds 1'), sig('tests/add.test.ts', 'AC-001 adds 2'), sig('tests/add.test.ts', 'AC-002 subtracts 5')]
    expect(await redCheck({ ...base, files: table, failures: rows, absentAtStart: absent })).toEqual({ ok: true, problems: [] })
    const wrongRow = [rows[0], sig('tests/add.test.ts', 'AC-001 adds 2', 'ReferenceError: helper is not defined'), rows[2]].filter(x => x !== undefined)
    expect((await redCheck({ ...base, files: table, failures: wrongRow, absentAtStart: absent })).problems).toEqual(['AC-001 adds %i fails for another reason (ReferenceError: helper is not defined)'])
    const report = { tests: [{ file: 'tests/add.test.ts', id: 'AC-001 adds 1', title: 'AC-001 adds 1', status: 'failed' as const, message: 'AssertionError: x' }, { file: 'tests/add.test.ts', id: 'AC-001 adds 2', title: 'AC-001 adds 2', status: 'passed' as const, message: '' }, { file: 'tests/add.test.ts', id: 'AC-002 subtracts 5', title: 'AC-002 subtracts 5', status: 'failed' as const, message: 'AssertionError: x' }], collection: [], fileErrors: [], counts: { passed: 1, failed: 2, skipped: 0 } }
    expect((await redCheck({ ...base, files: table, failures: [rows[0], rows[2]].filter(x => x !== undefined), report, absentAtStart: absent })).problems).toEqual(['an added test passes: AC-001 adds %i'])
  })

  test('with a report, an added test that was skipped or never ran is named as such', async () => {
    const report = { tests: [{ file: 'tests/add.test.ts', id: 'add > AC-001 adds', title: 'AC-001 adds', status: 'skipped' as const, message: '' }], collection: [], fileErrors: [], counts: { passed: 0, failed: 0, skipped: 1 } }
    expect((await redCheck({ ...base, files, failures: [], report, absentAtStart: absent })).problems).toEqual(['an added test is skipped: AC-001 adds', 'an added test did not run: AC-002 subtracts'])
  })
})

describe('flow judge: security, scope, plugin integrity', () => {
  test('security is forced by sensitive code in any code file, test files too, and by removed lines; files outside the feature are out of scope', () => {
    const d = (path: string, line: string) => parseDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n${line}`)
    expect(securityForced(d('src/a.ts', '+const k = process.env.KEY'), TYPESCRIPT)).toBe(true)
    expect(securityForced(d('tests/a.test.ts', "+writeFileSync('node_modules/.bin/vitest', x)"), TYPESCRIPT)).toBe(true)
    expect(securityForced(d('src/auth.ts', '-  if (!jwt.verify(token, key)) throw new Error()'), TYPESCRIPT)).toBe(true)
    expect(securityForced(d('src/a.ts', "+const cp = await import('node:child_process')"), TYPESCRIPT)).toBe(true)
    expect(securityForced(d('src/a.ts', '+export const add = (a, b) => a + b'), TYPESCRIPT)).toBe(false)
    for (const l of ['+const p = process; p.exit(0)', '+const f = require(`fs`)', "+const m = await import(name)", '+globalThis.it = () => {}', "+Reflect.set(x, 'y', 1)"]) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, true])
    expect(securityForced(d('src/cli.ts', '+const args = process.argv.slice(2)'), TYPESCRIPT)).toBe(false)
    for (const l of ["+const g = [].constructor.constructor('return this')()", "+p['ex' + 'it'](0)", '+global.fetch = vi.fn()', '+const m = module.require']) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, true])
    for (const l of ["+const q = /'/; const g = globalThis; g.process.stdout.write = () => true; const z = ''", "+const q = /'/; const p = process; p.exit(0); const z = ''", "+const F = Object.getPrototypeOf(f)[['con', 'structor'].join('')]('return this')()", '+const k = String.fromCharCode(112, 114)', '+const t = obj[`${a}${b}`]', '+const c = f[k][k]("return this")()', '+const v = `${process.exit(0)}`']) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, true])
    for (const l of ["+const m = await vi.importActual('node:child_process')", "+const fs = jest.requireActual('fs')", "+const cp = 'node:child_process'"]) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, true])
    const two = parseDiff('diff --git a/tests/a.test.ts b/tests/a.test.ts\n--- a/tests/a.test.ts\n+++ b/tests/a.test.ts\n@@ -1,0 +1,2 @@\n+const t = `a\n+`; process.stdout.write = () => true')
    expect(securityForced(two, TYPESCRIPT)).toBe(true)
    // Only the state carried from the line above sees this one (a comment holding a quote); only reading from inside a
    // template sees a hunk that starts mid-template.
    const inComment = parseDiff("diff --git a/tests/a.test.ts b/tests/a.test.ts\n--- a/tests/a.test.ts\n+++ b/tests/a.test.ts\n@@ -1,0 +1,2 @@\n+/*\n+ it's fine */ process.exit(0)")
    expect(securityForced(inComment, TYPESCRIPT)).toBe(true)
    expect(securityForced(d('tests/a.test.ts', '+`; process.stdout.write = () => true'), TYPESCRIPT)).toBe(true)
    expect(securityForced(d('tests/a.test.ts', "+if (ok) /'/.test(s); process.on('exit', f); const z = 'x'"), TYPESCRIPT)).toBe(true)
    for (const l of ["+const x = await vi.importActual('../src/x')", '+expect(err.constructor).toBe(ValidationError)', "+expect(ids).toEqual(['user-' + 1])"]) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, false])
    for (const l of ["+const s = items.map(x => x.name).join('')", "+const { cfg } = await import('@/config')", "+const u = await import('~/lib/util')", '+expect(calc[op](1, 2)).toBe(3)', '+const v = grid[i][j]']) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, false])
    for (const l of ["+it('should process a refund', () => {})", "+const { add } = await import('../src/add')", '+// the process ends here']) expect([l, securityForced(d('tests/a.test.ts', l), TYPESCRIPT)]).toEqual([l, false])
    expect(outOfScope([...d('src/a.ts', '+x'), ...d('src/b.ts', '+y'), ...d('docs/flow/verify.md', '+z')], ['src/a.ts', 'tests/a.test.ts'])).toEqual(['src/b.ts'])
  })

  test('plugin integrity covers every file except the generated types and the git folder', async () => {
    const tree: Record<string, string | null> = { '/m': null, '/m/hooks': null, '/m/hooks/a.ts': 'a', '/m/.claude-plugin': null, '/m/.claude-plugin/plugin.json': '{}', '/m/.claude-plugin/types': null, '/m/.claude-plugin/types/x.d.ts': 't', '/m/.git': null, '/m/.git/HEAD': 'h' }
    const io = (files: Record<string, string | null>) => ({
      read: async (p: string) => files[p] ?? '', exists: async (p: string) => p in files,
      list: async (d: string) => Object.keys(files).filter(p => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/')).map(p => ({ name: p.slice(d.length + 1), kind: files[p] === null ? 'dir' : 'file', size: 0, mtimeMs: 0 })),
    }) as unknown as Io
    const h = await pluginIntegrity(io(tree), '/m')
    expect(await pluginIntegrity(io({ ...tree, '/m/.claude-plugin/types/x.d.ts': 'changed', '/m/.git/HEAD': 'moved' }), '/m')).toBe(h)
    expect(await pluginIntegrity(io({ ...tree, '/m/hooks/a.ts': 'changed' }), '/m')).not.toBe(h)
    expect(await pluginIntegrity(io({ ...tree, '/m/hooks/b.ts': 'new' }), '/m')).not.toBe(h)
  })
})
