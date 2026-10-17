import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { SCAN_DIFF_ARGS } from '../hooks/flow-scan'
import { sha256 } from '../hooks/flow-review'
import { canonical } from '../hooks/flow-owner'
import { HOME, METHOD_HEAD, MOD_ROOT, ROOT } from './flow-fakes'
import { agentRun, duringJudge, ended, GREEN_REPORT, HEAD, lastTicket, latest, run, toB1, world, type DriveOpts, type W } from './flow-drive'

const START = 'f'.repeat(40), RED_TREE = 'b'.repeat(40)
const TEST_DIFF = [
  'diff --git a/tests/add.test.ts b/tests/add.test.ts', 'new file mode 100644', '--- /dev/null', '+++ b/tests/add.test.ts', '@@ -0,0 +1,4 @@',
  "+import { expect, it } from 'vitest'", "+it('AC-001 adds', () => {", '+  expect(1 + 1).toBe(3)', '+})', '',
].join('\n')
const STRAY_DIFF = `${TEST_DIFF}diff --git a/src/other.ts b/src/other.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/other.ts\n@@ -0,0 +1 @@\n+export const x = 1\n`
const report = (status: 'passed' | 'failed') => ({ testResults: [{ name: `${ROOT}/tests/add.test.ts`, status, message: '', assertionResults: [{ title: 'AC-001 adds', ancestorTitles: [], status, failureMessages: status === 'failed' ? ['AssertionError: expected 2 to be 3'] : [] }] }] })
const diffKey = (from: string, to: string): string => [...SCAN_DIFF_ARGS, from, to].join(' ')

async function atB1(): Promise<{ w: W; o: DriveOpts }> {
  const o: DriveOpts = { gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } } }
  const w = world(o)
  await toB1(w)
  return { w, o }
}
/** The RED agent writes the tests: the worktree's flow tree moves and the judge sees the RED run. */
async function redRun(w: W, o: DriveOpts, diff: string, status: 'passed' | 'failed'): Promise<void> {
  ;(o.gitOut ?? {})[diffKey(START, RED_TREE)] = diff
  o.judge = { test: { exit: status === 'failed' ? 1 : 0, report: report(status) } }
  await agentRun(w, lastTicket(w)?.id ?? '', ended('Tests written.'), () => w.setTree(RED_TREE))
  await flowCheck(w.host)
}

describe('flow-build: B1, the RED ticket', () => {
  test('/flow-build starts F-01: its start tree is frozen and the RED ticket carries the feature pack only', async () => {
    const { w } = await atB1()
    expect(latest(w)).toMatchObject({ phase: 'build', task: 'B1', feature: 'F-01', awaiting: '/flow-build' })
    expect((await run(w, 'flow-build')).text).toContain('F-01')
    const r = latest(w), t = lastTicket(w)
    expect(r?.awaiting).toBeUndefined()
    expect(r?.frozen['start:F-01']).toBe(START)
    expect(t).toMatchObject({ f: 'F-01', kind: 'red', routedType: 'tdd-guide', model: 'sonnet', used: false })
    const text = w.session().value?.tickets[t?.id ?? ''] ?? ''
    expect(text).toContain('## RED F-01')
    expect(text).toContain('F-01: Add numbers')
    expect(text).toContain('AC-001 (Required): adding two numbers returns their sum')
    expect(text).toContain('Definition of Done')
    // B1's testing text (plan §8, §8.1): the cited testing-patterns sections only, after the pack
    expect(text.indexOf(METHOD_HEAD)).toBeGreaterThan(text.indexOf('## PACK'))
    for (const s of ['STRUCTURE', 'NAMING', 'BOUNDARIES', 'ANTI', 'Write only the files this ticket names']) expect(text).toContain(s)
    expect(text).not.toContain('NOT SENT')
    expect(w.submitted.at(-1)).toContain('flow_status')
  })

  test('a RED run that passes the RED rule freezes the RED tests and starts the author at once', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    await redRun(w, o, TEST_DIFF, 'failed')
    const r = latest(w)
    expect(r).toMatchObject({ task: 'B2', feature: 'F-01' })
    const red = JSON.parse(w.files.get(`${HOME}/.snagon/flow/${r?.flowId}.red.json`) ?? '{}') as Record<string, unknown>
    expect(Object.keys(red)).toEqual(['F-01'])
    expect(r?.redTestHash['F-01']).toBe(await sha256(canonical(red['F-01'])))
    const t = lastTicket(w)
    expect(t).toMatchObject({ f: 'F-01', kind: 'author', used: false })
    expect(w.session().value?.tickets[t?.id ?? '']).toContain('## IMPLEMENT F-01')
    expect(w.session().value?.tickets[t?.id ?? '']).toContain(`${METHOD_HEAD}\n\n---\nname: incremental-implementation\n---\nMETHOD incremental-implementation`)
  })

  test('an author method that cannot be read stops the step before anything is frozen: no RED file, no author ticket', async () => {
    const o: DriveOpts = { gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } } }
    const w = world(o)
    w.files.delete(`${MOD_ROOT}/flow/vendor/agent-skills/skills/incremental-implementation/SKILL.md`)
    await toB1(w)
    await run(w, 'flow-build')
    await expect(redRun(w, o, TEST_DIFF, 'failed')).rejects.toThrow('incremental-implementation/SKILL.md')
    const r = latest(w)
    expect(r).toMatchObject({ task: 'B1', feature: 'F-01' })
    expect(r?.redTestHash['F-01']).toBeUndefined()
    expect(w.files.has(`${HOME}/.snagon/flow/${r?.flowId}.red.json`)).toBe(false)
    expect(lastTicket(w)?.kind).toBe('red')
  })

  test('a baseline changed while the RED run is judged: blocked, nothing frozen, no author ticket', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    duringJudge(o, () => { for (const [k, v] of w.files) if (k.endsWith('.baseline.json')) w.files.set(k, `${v} `) })
    await redRun(w, o, TEST_DIFF, 'failed')
    const r = latest(w)
    expect(r?.blocked).toMatchObject({ reason: 'tampered' })
    expect(r?.task).toBe('B1')
    expect(r?.redTestHash['F-01']).toBeUndefined()
    expect(lastTicket(w)?.kind).toBe('red')
  })

  test('a test that already passes is not RED: a new RED ticket names the problem and uses an edit round', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    const key = latest(w)?.features?.[0]?.key ?? ''
    await redRun(w, o, TEST_DIFF, 'passed')
    const r = latest(w), t = lastTicket(w)
    expect(r?.task).toBe('B1')
    expect(t?.kind).toBe('red')
    expect(w.session().value?.tickets[t?.id ?? '']).toContain('an added test passes: AC-001 adds')
    expect(r?.counters[key]?.e).toBe(1)
    expect(r?.frozen['start:F-01']).toBe(START)
  })

  test('a RED run without the nonce line is not judged: a new RED ticket says why', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    ;(o.gitOut ?? {})[diffKey(START, RED_TREE)] = TEST_DIFF
    await agentRun(w, lastTicket(w)?.id ?? '', () => 'Tests written.', () => w.setTree(RED_TREE))
    await flowCheck(w.host)
    expect(w.runs.filter(x => x.includes('/usr/bin/sandbox-exec')).length).toBe(2)
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain('the RED run was not attested')
  })

  test('a RED run that changes a file outside the test files and new stubs is refused', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    await redRun(w, o, STRAY_DIFF, 'failed')
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain('changed outside the RED scope (the feature\'s test files and new stubs): src/other.ts')
  })

  test('RED retries stop at the feature edit cap', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    for (let i = 0; i < 4; i += 1) await redRun(w, o, TEST_DIFF, 'passed')
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'edit' } })
  })

  test('a plan file changed after its approval blocks the build', async () => {
    const { w } = await atB1()
    w.files.set(`${ROOT}/docs/flow/plan.md`, (w.files.get(`${ROOT}/docs/flow/plan.md`) ?? '').replace('Add numbers', 'Add numbers quickly'))
    await run(w, 'flow-build')
    expect(latest(w)?.blocked).toEqual({ reason: 'frozenChanged', vars: { what: 'docs/flow/plan.md' } })
  })
})

describe('flow-build: B2, the author ticket', () => {
  test('an attested author run hands the feature to the judge (B3)', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    await redRun(w, o, TEST_DIFF, 'failed')
    await agentRun(w, lastTicket(w)?.id ?? '', ended('Done.\nASSUMPTIONS: none'))
    o.judge = { test: { exit: 0, report: report('passed') } }
    await flowCheck(w.host)
    expect(latest(w)?.task).not.toBe('B2')
  })

  test('an author run without the nonce line gets a new author ticket (an edit round)', async () => {
    const { w, o } = await atB1()
    await run(w, 'flow-build')
    await redRun(w, o, TEST_DIFF, 'failed')
    const first = lastTicket(w)?.id
    await agentRun(w, first ?? '', () => 'Done.')
    await flowCheck(w.host)
    const r = latest(w)
    expect(r?.task).toBe('B2')
    expect(lastTicket(w)).toMatchObject({ kind: 'author', used: false })
    expect(lastTicket(w)?.id).not.toBe(first)
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.e).toBe(1)
  })
})
