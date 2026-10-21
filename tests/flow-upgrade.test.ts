import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { MOD_ROOT, ROOT, recordFile } from './flow-fakes'
import { approved, editRecord, GREEN_REPORT, HEAD, latest, LOCAL, probe, REFUSED, run, toS3, world, writeLocal } from './flow-drive'
import { PLAN_053, RECORD_053 } from './fixtures/record-053'

const PLUGIN_060 = '{"name":"snagon-dev-mods","version":"0.6.0"}'
/** The settings file as the owner approved it in that run: the sandbox block alone (it hashes to frozen.post). */
const SETTINGS_053 = `${JSON.stringify({ sandbox: (JSON.parse(RECORD_053.frozen.sandbox ?? '{}') as { sandbox: unknown }).sandbox }, null, 2)}\n`
const upgraded = (record = RECORD_053) => world({ files: { ...recordFile(record), [LOCAL]: SETTINGS_053, [`${ROOT}/docs/flow/plan.md`]: PLAN_053, [`${MOD_ROOT}/.claude-plugin/plugin.json`]: PLUGIN_060 } })

describe('a 0.5.3 flow after the update to 0.6.0 (R2 AC-CORE-3, AC-CORE-5)', () => {
  test('the record loads; the update blocks as tampered with the version line; after /flow-setup the build goes on at B1', async () => {
    const w = upgraded()
    // the new session's probe passes: the settings are as approved
    expect(await probe(w, REFUSED)).toBeNull()
    await flowCheck(w.host)
    const b = latest(w)?.blocked
    expect(b?.reason).toBe('tampered')
    expect(b?.vars.file).toContain('→ 0.6.0')
    expect(b?.vars.file).toContain('/flow-setup')
    // the owner re-freezes: same pointer, the block cleared, the new version frozen, the stack still TypeScript
    await approved(w)
    const r = latest(w)
    expect(r).toMatchObject({ phase: 'build', task: 'B1', feature: 'F-02' })
    expect(r?.blocked).toBeUndefined()
    expect(r?.frozen['plugin.version']).toBe('0.6.0')
    expect(r?.setup?.stack).toBe('typescript')
    // S2b and the probe, then the next flow_check works through the registry: the RED ticket the old session lost is
    // issued again (H5)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    expect(await probe(w, REFUSED)).toBeNull()
    const lost = r?.tickets.at(-1)
    w.setTree(RECORD_053.frozen['start:F-02'] ?? '') // the worktree as F-02's RED ticket left it: nothing changed yet
    await flowCheck(w.host)
    const now = latest(w)
    expect(now?.blocked).toBeUndefined()
    expect(now?.tickets.at(-1)).toMatchObject({ kind: 'red', f: 'F-02', used: false })
    expect(now?.tickets.at(-1)?.id).not.toBe(lost?.id)
  })

  test('a stack id this mod does not know blocks flow_check as couldNotRun naming it, before anything reads it (AC-CORE-5)', async () => {
    const w = world({ gitOut: { ...HEAD } })
    expect((await toS3(w))?.task).toBe('S3')
    editRecord(w, r => ({ ...r, setup: r.setup ? { ...r.setup, stack: 'cobol' } : r.setup }))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toEqual({ reason: 'couldNotRun', vars: { detail: 'the record names the stack "cobol", which this version of the mod does not know' } })
    expect(w.runs.filter(a => a.includes('/usr/bin/sandbox-exec'))).toEqual([])
  })

  test('an owner command on such a record fails loudly and leaves the record as it was (AC-CORE-5)', async () => {
    const w = world({ gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } } })
    await toS3(w)
    await flowCheck(w.host)
    expect(latest(w)).toMatchObject({ task: 'P1', awaiting: '/flow-plan' })
    editRecord(w, r => ({ ...r, setup: r.setup ? { ...r.setup, stack: 'cobol' } : r.setup }))
    const before = latest(w)
    let failed = ''
    try { await run(w, 'flow-plan add numbers') } catch (err) { failed = String(err) }
    expect(failed).toContain('the record names the stack "cobol"')
    // an owner command takes the lock first (§2.4), a new version; with the test clock fixed nothing else moves, and no
    // ticket is issued
    expect({ ...latest(w), version: 0 }).toEqual({ ...before, version: 0 })
  })
})
