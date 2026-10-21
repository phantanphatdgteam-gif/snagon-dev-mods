import { describe, expect, test } from 'claude-code/testing'
import { TASKS, SOURCES, DERIVED, CAPS, RETRY, BLOCKED_REASONS, judgeRunBound, capsTable } from '../flow/data/phases'
import { ROUTING, routedAgent, dispatchType, STACK_SHARE } from '../flow/data/routing'
import { TYPESCRIPT } from '../flow/data/stacks/typescript'
import { COMMON_DENY_READ } from '../flow/data/common'
import { RUBRICS, SEVERITY, SEVERITY_ORDER } from '../flow/data/rubrics'
import { DOD, NOT_CHECKED } from '../flow/data/dod'
import { TEXTS, ADDRESS_FALLBACK, placeholders, fill } from '../flow/data/templates'
import type { Role } from '../flow/data/types'
import { failures, counts, redErrors, stripAnsi, touchesSecurity, classify, readReport } from '../flow/parse'
import { VITEST_REPORT, JEST_REPORT } from './fixtures/reports'
import { VITEST, JEST, TSC, TSC_PRETTY, ESLINT_STYLISH } from './fixtures/runners'

const PHASE_ORDER = ['setup', 'plan', 'build', 'verify', 'ship']

describe('flow data', () => {
  test('tasks are unique, in phase order, and every read comes from an earlier write, a source or a pack of earlier writes', () => {
    expect(new Set(TASKS.map(t => t.id)).size).toBe(TASKS.length)
    const order = TASKS.map(t => PHASE_ORDER.indexOf(t.phase))
    expect(order.every((p, i) => p >= 0 && (i === 0 || p >= (order[i - 1] ?? 0)))).toBe(true)
    const written = new Set<string>(SOURCES)
    for (const task of TASKS) {
      for (const read of task.reads) {
        const pack = DERIVED[read]
        const ok = pack ? pack.every(input => written.has(input)) : written.has(read)
        if (!ok) throw new Error(`${task.id} reads ${read} before it is written`)
      }
      for (const w of task.writes) written.add(w)
    }
  })

  test('agent tasks name a role and a cap scope; owner and mod tasks name no role', () => {
    for (const t of TASKS) {
      if (t.actor === 'agent') { expect(t.role).toBeDefined(); expect(t.scope).toBeDefined() }
      else expect(t.role).toBeUndefined()
    }
    expect(TASKS.filter(t => t.actor === 'owner').map(t => t.id)).toEqual(['S2', 'S4', 'P3', 'H1'])
    const used = new Set(TASKS.flatMap(t => [t.role, ...(t.extraRoles ?? [])]).filter(Boolean))
    expect([...used].sort()).toEqual(Object.keys(ROUTING.agents).sort())
  })

  test('caps bound the judge runs of every scope, and the docs table is generated from them', () => {
    expect(judgeRunBound(CAPS.feature)).toBe(1 + 3 + 3 + 2 * 4)
    expect(judgeRunBound(CAPS.plan)).toBe(4)
    expect(judgeRunBound(CAPS.verify)).toBe(9)
    expect(RETRY.feature).toEqual({ e: 1, r: 1, d: 2 })
    const table = capsTable().split('\n')
    expect(table.length).toBe(2 + Object.keys(CAPS).length)
    expect(table.slice(2)).toEqual(['| plan | 3 | — | — | 4 | +1 e |', '| feature | 3 | 3 | 4 | 15 | +1 e, +1 r, +2 d |', '| verify | 2 | — | 3 | 9 | +1 e, +2 d |'])
  })

  test('routing: every role has an agent, its skills and references are vendored, and the MVP set is the approved one', () => {
    const roles = Object.keys(ROUTING.agents) as Role[]
    expect(roles.sort()).toEqual(['author', 'buildFixer', 'debugger', 'planner', 'red', 'reviewer', 'securityReviewer'])
    for (const r of roles) {
      for (const s of ROUTING.skills[r]) expect(ROUTING.vendored.skills).toContain(s)
      for (const ref of ROUTING.references[r]) expect(ROUTING.vendored.references).toContain(ref)
    }
    expect([...new Set(roles.flatMap(r => ROUTING.skills[r]))].sort()).toEqual(['code-review-and-quality', 'debugging-and-error-recovery', 'incremental-implementation', 'planning-and-task-breakdown', 'security-and-hardening'])
    expect([ROUTING.vendored.skills.length, ROUTING.vendored.agents.length, ROUTING.vendored.references.length]).toEqual([14, 3, 7])
    expect(ROUTING.pluginProjectSkills).toEqual(['plugin-authoring'])
    for (const tool of ['WebFetch', 'WebSearch', 'Monitor', 'SendMessage', 'Workflow']) expect(ROUTING.allowTools).not.toContain(tool)
    expect(STACK_SHARE).toBe(0.7)
    expect(routedAgent('reviewer', 0.7, TYPESCRIPT.routing)).toBe('typescript-reviewer')
    expect(routedAgent('reviewer', 0.69, TYPESCRIPT.routing)).toBe('code-reviewer')
    expect(routedAgent('buildFixer', 1, TYPESCRIPT.routing)).toBe('build-error-resolver')
    // the Agent tool and a spawn rewrite name a plugin's agent `<plugin>:<name>` exactly; a bare name is refused (2.1.302)
    for (const r of roles) for (const share of [0, 1]) expect(dispatchType(routedAgent(r, share, TYPESCRIPT.routing))).toBe(`snagon-dev-mods:${routedAgent(r, share, TYPESCRIPT.routing)}`)
    expect(ROUTING.references.red).toEqual(['testing-patterns'])
  })

  test('vitest output: one signature per failed test, the collection error, the counts and the RED errors', () => {
    const sig = failures(VITEST, TYPESCRIPT, 'vitest') ?? []
    expect(sig.map(x => [x.file, x.id, x.collection])).toEqual([
      ['tests/missing.test.ts', '', true],
      ['tests/export.test.ts', 'AC-006 subtract', false],
      ['tests/fail.test.ts', 'add > AC-002 adds negatives', false],
      ['tests/fail.test.ts', 'AC-003 top level', false],
    ])
    expect(sig.map(x => x.message.split(' ')[0])).toEqual(['Error:', 'TypeError:', 'AssertionError:', 'AssertionError:'])
    expect(counts(VITEST, TYPESCRIPT, 'vitest')).toEqual({ passed: 1, failed: 3, skipped: 1 })
    const red = redErrors(VITEST, TYPESCRIPT)
    expect(red.assertion).toBe(true)
    expect(red.modules).toEqual(['../src/b'])
    expect(red.symbols).toEqual(['subtract'])
  })

  test('jest output: the file comes from its header, a suite that failed to run is a collection error, counts read in any order', () => {
    const sig = failures(JEST, TYPESCRIPT, 'jest') ?? []
    expect(sig.map(x => [x.file, x.id, x.collection])).toEqual([
      ['__tests__/missing.test.js', '', true],
      ['__tests__/a.test.js', 'add › AC-002 adds negatives', false],
      ['__tests__/a.test.js', 'AC-003 top level', false],
      ['__tests__/a.test.js', 'AC-006 subtract', false],
    ])
    expect(sig.map(x => x.message.slice(0, 24))).toEqual(["Cannot find module '../s", 'expect(received).toBe(ex', 'expect(received).toBe(ex', 'TypeError: subtract is n'])
    expect(counts(JEST, TYPESCRIPT, 'jest')).toEqual({ passed: 1, failed: 3, skipped: 1 })
    const variants = 'FAIL src/a.test.ts (5.123 s)\n  ● slow one\n\n    boom\nFAIL  proj  src/b.test.ts\n  ● named\n\nSummary of all failing tests\nFAIL src/a.test.ts\n  ● slow one\n'
    expect((failures(variants, TYPESCRIPT, 'jest') ?? []).map(x => [x.file, x.id])).toEqual([['src/a.test.ts', 'slow one'], ['src/b.test.ts', 'named']])
    const red = redErrors(JEST, TYPESCRIPT)
    expect([red.assertion, red.modules, red.symbols]).toEqual([true, ['../src/b'], ['subtract']])
  })

  test('tsc output in plain and pretty (coloured) form, with location-less errors and both missing-export codes', () => {
    const plain = failures(TSC, TYPESCRIPT, 'tsc') ?? []
    expect(plain.map(x => x.id)).toEqual(['TS2304', 'TS2304', 'TS2304', 'TS2305', 'TS2724', 'TS5083'])
    expect(plain[3]).toEqual({ runner: 'tsc', file: 'src/a.ts', id: 'TS2305', message: "Module '\"./b\"' has no exported member 'foo'.", collection: false })
    expect(plain[5]?.file).toBe('')
    expect(redErrors(TSC, TYPESCRIPT).symbols.sort()).toEqual(['foo', 'sum'])
    expect(TSC_PRETTY.includes('\u001b[')).toBe(true)
    expect(stripAnsi(TSC_PRETTY).includes('\u001b')).toBe(false)
    const routeGroup = failures("app/(shop)/page.tsx(3,10): error TS2322: Type 'string' is not assignable to type 'number'.", TYPESCRIPT, 'tsc') ?? []
    expect(routeGroup.map(x => [x.file, x.id])).toEqual([['app/(shop)/page.tsx', 'TS2322']])
    const pretty = failures(TSC_PRETTY, TYPESCRIPT, 'tsc') ?? []
    expect(pretty.map(x => [x.file, x.id])).toEqual([['node_modules/@vitest/spy/dist/index.d.ts', 'TS2304'], ['node_modules/@vitest/utils/dist/index.d.ts', 'TS2304']])
  })

  test('eslint stylish output (the default) and the unix form give file, rule and message without line numbers', () => {
    const sig = failures(ESLINT_STYLISH, TYPESCRIPT, 'eslint') ?? []
    expect(sig.map(x => [x.file, x.id, x.message])).toEqual([
      ['/p/src/lint.ts', '@typescript-eslint/no-unused-vars', "'x' is assigned a value but never used"],
      ['/p/src/lint.ts', '@typescript-eslint/no-explicit-any', 'Unexpected any. Specify a different type'],
    ])
    const unix = failures("/p/src/a.ts:4:7: 'x' is assigned a value but never used. [Error/@typescript-eslint/no-unused-vars]\n/p/src/b.ts:1:7: Parsing error: ';' expected [Error]", TYPESCRIPT, 'eslint') ?? []
    expect(unix.map(x => [x.file, x.id])).toEqual([['/p/src/a.ts', '@typescript-eslint/no-unused-vars'], ['/p/src/b.ts', '']])
    const parsing = failures("/p/src/c.ts\n  1:7  error  Parsing error: ';' expected\n", TYPESCRIPT, 'eslint') ?? []
    expect(parsing.map(x => [x.file, x.id, x.message])).toEqual([['/p/src/c.ts', '', "Parsing error: ';' expected"]])
  })

  test('passing output gives no failures and no RED errors; a thrown runtime error is not an assertion', () => {
    const passing = ' ✓ tests/add.test.ts (1 test) 1ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n'
    expect(failures(passing, TYPESCRIPT, 'vitest')).toEqual([])
    expect(failures('error: something', TYPESCRIPT, 'build')).toBeNull()
    for (const a of ['expect(received).not.toBe(expected)', 'expect(jest.fn()).toHaveBeenCalledWith(...expected)', 'expect(received).resolves.toEqual()']) expect(redErrors(a, TYPESCRIPT).assertion).toBe(true)
    expect(redErrors('TypeError: __vite_ssr_import_0__.sum is not a function', TYPESCRIPT).symbols).toEqual(['sum'])
    expect(counts(passing, TYPESCRIPT, 'vitest')).toEqual({ passed: 1, failed: 0, skipped: 0 })
    expect(redErrors(passing, TYPESCRIPT)).toEqual({ assertion: false, modules: [], symbols: [] })
    expect(redErrors('TypeError: expected a string to be given', TYPESCRIPT).assertion).toBe(false)
    expect(counts('no summary here', TYPESCRIPT, 'vitest')).toBeNull()
  })

  test('security forcing catches file, process, network, auth and database code, and leaves plain logic alone', () => {
    const hits = [
      "import { writeFile } from 'node:fs/promises'", 'await fs.promises.writeFile(p, b)', 'fs.writeFileSync(p, b)', 'http.get(url, cb)',
      'net.connect(80, host)', 'const ws = new WebSocket(u)', "import axios from 'axios'", "import { execa } from 'execa'", 'await execa(cmd)',
      'Bun.spawn([cmd])', "import { jwtVerify } from 'jose'", "import session from 'express-session'", "import { Pool } from 'pg'",
      'const key = process.env.API_KEY', 'eval(code)', 'fs.readFileSync(path.join(root, q))', 'fs.createWriteStream(p)', 'symlinkSync(a, b)', "const { exec } = require('child_process')", 'await fetch(url)',
    ]
    for (const h of hits) expect([h, touchesSecurity(h, TYPESCRIPT)]).toEqual([h, true])
    const misses = ['export const add = (a: number, b: number) => a + b', 'const total = items.reduce((s, x) => s + x, 0)', '// we fetch the user later', "describe('session timeout', () => {})"]
    for (const m of misses) expect([m, touchesSecurity(m, TYPESCRIPT)]).toEqual([m, false])
  })

  test('package managers give the sandbox domains and caches; publishing is described by tool and subcommand', () => {
    expect(TYPESCRIPT.packageManagers.map(p => p.id)).toEqual(['npm', 'pnpm', 'yarn', 'bun'])
    expect(TYPESCRIPT.packageManagers.find(p => p.id === 'yarn')?.domains).toContain('registry.yarnpkg.com')
    for (const p of TYPESCRIPT.packageManagers) expect(p.cacheDirs.length).toBeGreaterThan(0)
    for (const v of ['publish', 'unpublish', 'dist-tag']) expect(TYPESCRIPT.publish.subcommands).toContain(v)
    expect(TYPESCRIPT.publish.releaseTools).toContain('changeset')
    expect(TYPESCRIPT.publish.prefixes.yarn).toEqual(['npm'])
    expect(TYPESCRIPT.publish.valueOptions).toContain('--workspace')
    expect(TYPESCRIPT.packageManagers.find(p => p.id === 'pnpm')?.cacheDirs).toContain('~/Library/Caches/pnpm')
    expect(TYPESCRIPT.sandbox.denyRead).toContain('~/.npmrc')
    for (const f of ['~/.ssh', '~/.config/gh', '~/.netrc']) expect(COMMON_DENY_READ).toContain(f)
  })

  test('rubric ids are unique, severities valid, and the mod-judged criteria are marked det', () => {
    const all = RUBRICS.flatMap(r => r.criteria)
    expect(new Set(all.map(c => c.id)).size).toBe(all.length)
    for (const c of all) expect(SEVERITY_ORDER).toContain(c.max)
    expect(Object.keys(SEVERITY).sort()).toEqual([...SEVERITY_ORDER].sort())
    expect(all.filter(c => c.kind === 'det').map(c => c.id)).toEqual(['CODE-D1', 'CODE-D2', 'CODE-D3', 'CODE-D4'])
  })

  test('every task-level Definition of Done row names a check; a row without one says so and never passes', () => {
    expect(new Set(DOD.map(r => r.id)).size).toBe(DOD.length)
    for (const r of DOD) expect(r.check.length).toBeGreaterThan(0)
    expect(DOD.filter(r => r.level === 'task').some(r => r.check === NOT_CHECKED)).toBe(false)
    expect(DOD.filter(r => r.check === NOT_CHECKED).map(r => r.id)).toEqual(['DOD-F2', 'DOD-F3', 'DOD-R2', 'DOD-R3'])
  })

  test('texts exist in both languages with the same placeholders, never call the owner by a bare pronoun, and fill fails loudly', () => {
    expect(Object.keys(TEXTS.vi).sort()).toEqual(Object.keys(TEXTS.en).sort())
    for (const key of Object.keys(TEXTS.en)) expect(placeholders(TEXTS.vi[key] ?? '').sort()).toEqual(placeholders(TEXTS.en[key] ?? '').sort())
    for (const text of Object.values(TEXTS.vi)) expect([text, /(^|[^\p{L}])(anh|chị|em|bạn|ông|bà|cậu|mình)(?=[^\p{L}]|$)/iu.test(text)]).toEqual([text, false])
    for (const reason of BLOCKED_REASONS) expect(TEXTS.en[`blocked.${reason}`]).toBeDefined()
    expect(fill('vi', 'card.blocked', { cause: 'x' })).toBe('Đang bị chặn, CHƯA xong: x')
    expect(fill('en', 'escalate.head', { address: ADDRESS_FALLBACK.en, scope: 'F-01', kind: fill('en', 'kind.review', {}) })).toBe('F-01 reached its review cap; the project owner decides what happens next.')
    expect(fill('vi', 'blocked.cap', { scope: 'F-01', kind: fill('vi', 'kind.edit', {}) })).toBe('F-01 đã dùng hết số vòng sửa')
    expect(fill('vi', 'escalate.head', { scope: 'F-01', kind: fill('vi', 'kind.edit', {}), address: ADDRESS_FALLBACK.vi })).toBe('F-01 đã dùng hết số vòng sửa; Chủ dự án quyết định bước tiếp theo.')
    expect(() => fill('vi', 'card.next', { step: 'x' })).toThrow()
    expect(() => fill('en', 'no.such.key', {})).toThrow()
  })

  test('the reminder printed when a flow ends names the reinstall step of both stacks, in both languages', () => {
    for (const lang of ['en', 'vi'] as const) {
      const text = fill(lang, 'end.careful', {})
      expect([lang, text.includes('npm ci'), text.includes('pyproject.toml'), text.includes('.venv')]).toEqual([lang, true, true, true])
    }
  })

  test('vitest: a shared error after several FAIL lines goes to each of them (F16); a project label before the file is read (F17)', () => {
    const shared = ' FAIL  tests/a.test.ts > one\n FAIL  tests/a.test.ts > two\nTypeError: (0 , sum) is not a function\n'
    expect((failures(shared, TYPESCRIPT, 'vitest') ?? []).map(x => [x.id, x.message])).toEqual([['one', 'TypeError: (0 , sum) is not a function'], ['two', 'TypeError: (0 , sum) is not a function']])
    const labelled = ' FAIL  |unit| tests/a.test.ts > adds\nAssertionError: expected 1 to be 2\n FAIL   unit  tests/b.test.ts > subs\nAssertionError: x\n FAIL  |unit| tests/c.test.ts [ tests/c.test.ts ]\nError: Cannot find module \x27../src/c\x27\n'
    expect((failures(labelled, TYPESCRIPT, 'vitest') ?? []).map(x => [x.file, x.id, x.collection])).toEqual([['tests/a.test.ts', 'adds', false], ['tests/b.test.ts', 'subs', false], ['tests/c.test.ts', '', true]])
  })

  test('each failure message is classified for RED: assertion, a missing module, a missing export, or other (F20)', () => {
    expect(classify('AssertionError: expected 1 to be 2', TYPESCRIPT)).toEqual({ kind: 'assertion' })
    expect(classify('expect(received).toBe(expected) // Object.is equality', TYPESCRIPT)).toEqual({ kind: 'assertion' })
    expect(classify("Error: Cannot find module '../src/b' imported from '/p/tests/x.test.ts'", TYPESCRIPT)).toEqual({ kind: 'moduleNotFound', module: '../src/b' })
    expect(classify('TypeError: (0 , subtract) is not a function', TYPESCRIPT)).toEqual({ kind: 'missingExport', symbol: 'subtract' })
    expect(classify("Module '\"./b\"' has no exported member 'foo'.", TYPESCRIPT)).toEqual({ kind: 'missingExport', symbol: 'foo' })
    expect(classify('ReferenceError: helper is not defined', TYPESCRIPT)).toEqual({ kind: 'other' })
    expect(classify('TypeError: expected a string to be given', TYPESCRIPT)).toEqual({ kind: 'other' })
  })

  test('security forcing also catches call sites that need no new import (F18)', () => {
    for (const h of ['el.innerHTML = html', '<div dangerouslySetInnerHTML={{ __html: x }} />', 'document.write(s)', 'http.createServer(app)', 'await axios.get(u)', 'await got(u)', 'jwt.verify(t, k)', 'await bcrypt.compare(p, h)', 'db.query(`SELECT * FROM t WHERE id = ${id}`)', 'prisma.$queryRawUnsafe(q)']) expect([h, touchesSecurity(h, TYPESCRIPT)]).toEqual([h, true])
    for (const m of ['el.textContent = text', 'const query = parse(input)', 'db.query(sql, [id])']) expect([m, touchesSecurity(m, TYPESCRIPT)]).toEqual([m, false])
  })

  test('a runner report (JSON) gives every test with its status, the files that failed to load, and the counts', () => {
    const v = readReport(VITEST_REPORT, '/p')
    expect(v?.tests.map(t => [t.file, t.id, t.status])).toEqual([
      ['tests/add.test.ts', 'AC-001 adds', 'passed'], ['tests/export.test.ts', 'AC-006 subtract', 'failed'],
      ['tests/fail.test.ts', 'add > AC-002 adds negatives', 'failed'], ['tests/fail.test.ts', 'AC-003 top level', 'failed'], ['tests/fail.test.ts', 'AC-004 skipped', 'skipped'],
    ])
    expect(v?.collection.map(c => [c.file, c.message.slice(0, 26)])).toEqual([['tests/missing.test.ts', "Cannot find module '../src"]])
    expect(v?.counts).toEqual({ passed: 1, failed: 3, skipped: 1 })
    const j = readReport(JEST_REPORT, '/p')
    expect(j?.tests.filter(t => t.status !== 'passed').map(t => [t.id, t.status, t.message.slice(0, 24)])).toEqual([
      ['add > AC-002 adds negatives', 'failed', 'Error: expect(received).'], ['AC-003 top level', 'failed', 'Error: expect(received).'],
      ['AC-006 subtract', 'failed', 'TypeError: subtract is n'], ['AC-004 skipped', 'skipped', ''], ['AC-007 later', 'skipped', ''],
    ])
    expect(j?.collection.map(c => [c.file, c.message.slice(0, 26)])).toEqual([['__tests__/missing.test.js', "Cannot find module '../src"]])
    const teardown = JSON.stringify({ testResults: [{ name: '/p/tests/after.test.ts', status: 'failed', message: 'teardown broke', assertionResults: [{ ancestorTitles: [], title: 'AC-010 ok', status: 'passed', failureMessages: [] }] }] })
    expect(readReport(teardown, '/p')?.fileErrors).toEqual([{ file: 'tests/after.test.ts', message: 'teardown broke' }])
    const jestMixed = JSON.stringify({ numRuntimeErrorTestSuites: 1, testResults: [{ name: '/p/__tests__/mixed.test.js', status: 'failed', message: '  ● T1 fails\n\n    expect(received).toBe(expected)\n\n  ● Test suite failed to run\n\n    teardown broke\n', assertionResults: [{ ancestorTitles: [], title: 'T1 fails', status: 'failed', failureMessages: ['Error: expect(received).toBe(expected)'] }, { ancestorTitles: [], title: 'T2 ok', status: 'passed', failureMessages: [] }] }, { name: '/p/__tests__/only.test.js', status: 'failed', message: '  ● only fails\n\n    boom\n', assertionResults: [{ ancestorTitles: [], title: 'only fails', status: 'failed', failureMessages: ['boom'] }] }] })
    expect([readReport(jestMixed, '/p')?.fileErrors, readReport(jestMixed, '/p')?.runtimeErrors]).toEqual([[{ file: '__tests__/mixed.test.js', message: 'teardown broke' }], 1])
    expect(readReport('not json', '/p')).toBeNull()
    expect(readReport('{"testResults": 3}', '/p')).toBeNull()
  })

  test('jest console: the buffered "● Console" heading under a failed file is not a failure', () => {
    const out = 'FAIL src/a.test.js\n  ● Console\n\n    console.log\n      hi\n\n  ● add › fails\n\n    expect(received).toBe(expected)\n'
    expect(failures(out, TYPESCRIPT, 'jest')?.map(f => f.id)).toEqual(['add › fails'])
  })

  test('console counts take the last summary, so a test that prints a fake summary first does not hide fewer tests', () => {
    const fake = '      Tests  999 passed (999)\n FAIL  tests/a.test.ts > x\nAssertionError: y\n      Tests  1 failed | 2 passed (3)\n'
    expect(counts(fake, TYPESCRIPT, 'vitest')).toEqual({ passed: 2, failed: 1, skipped: 0 })
  })
})
