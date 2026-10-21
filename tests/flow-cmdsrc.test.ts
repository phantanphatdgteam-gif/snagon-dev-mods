import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { hashOf } from '../hooks/session'
import { ROOT } from './flow-fakes'
import { flowCard } from '../hooks/flow-turn'
import { runnerVerdict } from '../hooks/flow-check'
import { activeRecord } from './flow-fakes'
import { atB3, latest, nodeModules, PKG, PLAN_TEXT, run, START, toV1, type DriveOpts, type W } from './flow-drive'

const PLAN = PLAN_TEXT.replace('- Files: src/add.ts (new), tests/add.test.ts (new)', '- Files: src/add.ts (new), tests/add.test.ts (new), package.json, package-lock.json')
const LOCK = '{}'
const SOURCES = { 'ls-files -z -co --exclude-standard': 'package.json\0package-lock.json\0', [`cat-file blob ${START}:package.json`]: PKG, [`cat-file blob ${START}:package-lock.json`]: LOCK }
const PKG_DEPS = JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { b: '^2.0.0' } })
const LOCK_DEPS = `${LOCK}\n"node_modules/b": {\n  "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz"\n}\n`
/** The author also edits package.json and its lockfile. */
const edits = (pkg: string, lock = LOCK) => (_d: DriveOpts, w: W): void => { w.files.set(`${ROOT}/package.json`, pkg); w.files.set(`${ROOT}/package-lock.json`, lock) }

describe('flow command sources at every flow_check (plan §3.2, step-5 verdict)', () => {
  test('a dependency-only edit the feature lists is not CMD-SRC: frozen again, and verify notes it', async () => {
    const o = { plan: PLAN, git: SOURCES, before: edits(PKG_DEPS, LOCK_DEPS) }
    const { w } = await atB3(o)
    const r = latest(w)
    expect(r?.blocked).toBeUndefined()
    expect(r?.task).toBe('B4')
    expect(r?.frozen['src:package.json']).toBe(hashOf(PKG_DEPS))
    expect(r?.frozen['src:package-lock.json']).toBe(hashOf(LOCK_DEPS))
    expect(r?.frozen['dep:F-01']).toBe('yes')
    const v = await toV1(o)
    await run(v.w, 'flow-verify')
    await flowCheck(v.w.host)
    expect(v.w.files.get(`${ROOT}/docs/flow/verify.md`)).toContain('- dependency change in F-01')
  })

  test('a scripts edit is CMD-SRC even when the feature lists package.json', async () => {
    const { w } = await atB3({ plan: PLAN, git: SOURCES, before: edits(JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests', lint: 'eslint .' } })) })
    expect(latest(w)?.blocked).toEqual({ reason: 'cmdSrc', vars: { file: 'package.json' } })
  })

  test('a dependency edit the feature does not list is CMD-SRC', async () => {
    const { w } = await atB3({ git: SOURCES, before: edits(PKG_DEPS, LOCK_DEPS) })
    expect(latest(w)?.blocked?.reason).toBe('cmdSrc')
  })

  test('AC-RI-3: installing an accepted dependency-only edit re-baselines the runner hash once; the record keeps both, the card says so', async () => {
    const t = { hash: 'a'.repeat(64) }
    const { w } = await atB3({ plan: PLAN, git: SOURCES, run: nodeModules(t), before: (d, x) => { edits(PKG_DEPS, LOCK_DEPS)(d, x); t.hash = 'b'.repeat(64) } })
    const r = latest(w)
    expect(r?.blocked).toBeUndefined()
    expect([r?.frozen['runner:v2'], r?.frozen['rebase:F-01'], r?.frozen['dep:F-01']]).toEqual(['b'.repeat(64), `${'a'.repeat(64)}>${'b'.repeat(64)}`, 'rebased'])
    expect(await flowCard(w.host)).toContain('Dependencies changed at F-01: the runner integrity hash was taken again.')
  })

  test('AC-STK-9: a runner change with no accepted dependency edit, or with one the feature does not list, blocks tampered', async () => {
    for (const plan of [undefined, PLAN]) {
      const t = { hash: 'a'.repeat(64) }
      const { w } = await atB3({ ...(plan ? { plan } : {}), git: SOURCES, run: nodeModules(t), before: (d, x) => { if (!plan) edits(PKG_DEPS, LOCK_DEPS)(d, x); t.hash = 'b'.repeat(64) } })
      expect(latest(w)?.blocked).toEqual({ reason: 'tampered', vars: { file: 'node_modules' } })
      expect(latest(w)?.frozen['runner:v2']).toBe('a'.repeat(64))
    }
  })

  test('runnerVerdict (AC-RI-3, AC-STK-9): a token is used once; absent, an old record, an error or what the stack refuses never re-baselines', () => {
    const f = { id: 'F-01', files: [] as string[] } as unknown as Parameters<typeof runnerVerdict>[2]
    const rec = (frozen: Record<string, string>, stack = 'typescript') => { const r = activeRecord(); return { ...r, setup: r.setup ? { ...r.setup, stack } : r.setup, frozen: { ...r.frozen, ...frozen } } }
    const now = (hash: string, facts = '') => ({ changed: true, state: { hash, facts, load: [], problems: [] } })
    const was = { 'runner:v2': 'a'.repeat(64) }
    expect(runnerVerdict(rec({ ...was, 'dep:F-01': 'yes' }), now('b'.repeat(64)), f, false)).toEqual({ frozen: { 'runner:v2': 'b'.repeat(64), 'runner:v2.facts': '', 'runner:v2.load': '', 'dep:F-01': 'rebased', 'rebase:F-01': `${'a'.repeat(64)}>${'b'.repeat(64)}` } })
    for (const [why, r, d, depNow] of [
      ['token used', rec({ ...was, 'dep:F-01': 'rebased' }), now('b'.repeat(64)), false],
      ['no token', rec(was), now('b'.repeat(64)), false],
      ['from absent', rec({ 'runner:v2': 'absent', 'dep:F-01': 'yes' }), now('b'.repeat(64)), false],
      ['to absent', rec({ ...was, 'dep:F-01': 'yes' }), now('absent'), true],
      ['old record', rec({ 'dep:F-01': 'yes' }), { changed: true }, true],
    ] as const) expect([why, runnerVerdict(r, d, f, depNow)]).toEqual([why, { block: { reason: 'tampered', vars: { file: 'node_modules' } } }])
    expect(runnerVerdict(rec(was), { changed: true, error: '/x (read)' }, f, true)).toEqual({ block: { reason: 'tampered', vars: { file: '/x (read)' } } })
    expect(runnerVerdict(rec(was), now('b'.repeat(64)), undefined, true)).toEqual({ block: { reason: 'tampered', vars: { file: 'node_modules' } } })
    const facts = (pth: string) => JSON.stringify({ interp: {}, start: { 'site/a.pth': pth }, pytest11: [] })
    expect(runnerVerdict(rec({ ...was, 'runner:v2.facts': facts('p'), 'dep:F-01': 'yes' }, 'python'), now('b'.repeat(64), facts('p2')), f, false)).toEqual({ block: { reason: 'tampered', vars: { file: 'site/a.pth' } } })
  })

  test('a source that changed before the feature started is CMD-SRC (its start-tree text is not what was frozen)', async () => {
    const { w } = await atB3({ plan: PLAN, git: { ...SOURCES, [`cat-file blob ${START}:package.json`]: '{"edited":"before"}' }, before: edits(PKG_DEPS, LOCK_DEPS) })
    expect(latest(w)?.blocked).toEqual({ reason: 'cmdSrc', vars: { file: 'package.json' } })
  })
})
