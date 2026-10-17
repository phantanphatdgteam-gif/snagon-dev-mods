import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { hashOf } from '../hooks/session'
import { ROOT } from './flow-fakes'
import { atB3, latest, PKG, PLAN_TEXT, run, START, toV1, type DriveOpts, type W } from './flow-drive'

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

  test('a source that changed before the feature started is CMD-SRC (its start-tree text is not what was frozen)', async () => {
    const { w } = await atB3({ plan: PLAN, git: { ...SOURCES, [`cat-file blob ${START}:package.json`]: '{"edited":"before"}' }, before: edits(PKG_DEPS, LOCK_DEPS) })
    expect(latest(w)?.blocked).toEqual({ reason: 'cmdSrc', vars: { file: 'package.json' } })
  })
})
