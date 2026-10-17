import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { PROBE_COMMAND } from '../hooks/flow-sandbox'
import { sha256 } from '../hooks/flow-review'
import { HOME, MOD_ROOT, ROOT } from './flow-fakes'
import { approved, latest, LOCAL, run, RUN, toS3, world, writeLocal, type W } from './flow-drive'

const SHA = 'a'.repeat(40)
const HEAD = { 'rev-parse --verify -q HEAD^{commit}': `${SHA}\n` }
const GREEN = { testResults: [{ name: `${ROOT}/tests/a.test.ts`, status: 'passed', message: '', assertionResults: [{ title: 'adds', ancestorTitles: ['math'], status: 'passed', failureMessages: [] }] }] }
const LINT_RED = { exit: 1, out: `${ROOT}/src/a.ts\n  1:1  error  'x' is defined but never used  no-unused-vars\n\n✖ 1 problem\n` }
const judgedRuns = (w: W): string[][] => w.runs.filter(a => a.includes('/usr/bin/sandbox-exec'))
const check = async (w: W) => JSON.parse(await flowCheck(w.host)) as { next: string }

describe('flow-baseline: S3 through flow_check', () => {
  test('all green: each command runs in the judge sandbox, the baseline is saved and frozen, and the flow waits for /flow-plan', async () => {
    const w = world({ gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN } }, files: { [`${ROOT}/node_modules/.cache/x`]: 'c' } })
    expect((await toS3(w))?.task).toBe('S3')
    expect((await check(w)).next).toContain('/flow-plan')
    const r = latest(w)
    expect(r).toMatchObject({ phase: 'plan', task: 'P1', awaiting: '/flow-plan' })
    expect(r?.frozen.baseSha).toBe(SHA)
    const file = w.files.get(`${HOME}/.snagon/flow/${r?.flowId}.baseline.json`) ?? ''
    expect(r?.frozen.baseline).toBe(await sha256(file))
    expect(JSON.parse(file).commands.test).toMatchObject({ exitCode: 0, state: 'green', passed: ['tests/a.test.ts\u0000math > adds'] })
    const [t = [], l = []] = judgedRuns(w)
    expect(judgedRuns(w)).toHaveLength(2)
    expect(t.slice(0, 5)).toEqual(['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${HOME}`, `TMPDIR=${RUN}`])
    expect(t.slice(t.indexOf('-p') + 2)).toEqual(['npm', 'test', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${RUN}/report.json`])
    expect(l.slice(l.indexOf('-p') + 2)).toEqual(['npm', 'run', 'lint', '--', `--cache-location=${RUN}/eslintcache`])
    const profile = t[t.indexOf('-p') + 1] ?? ''
    expect(profile).toContain(`(allow file-write* (subpath "${ROOT}") (subpath "${RUN}")`)
    expect(profile).toContain(`(subpath "${HOME}/.npmrc")`)
    expect(w.files.has(`${ROOT}/node_modules/.cache/x`)).toBe(false)
    expect(w.runs).toContainEqual(['/bin/rm', '-rf', RUN])
    expect(w.files.get(`${ROOT}/.snagon/flow/boundary-S3.md`)).toContain('test: exit 0, 0 failures')
  })

  test('a red command that can be read: S4 waits for the owner, /flow-status shows it, and the approval makes it no-new-failures', async () => {
    const w = world({ gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN }, lint: LINT_RED } })
    await toS3(w)
    await check(w)
    expect(latest(w)).toMatchObject({ phase: 'setup', task: 'S4', awaiting: '/flow-status' })
    expect((await run(w, 'flow-status')).text).toContain('Shown in the flow pane')
    expect(w.panes.at(-1)?.title).toBe('Baseline for the project owner to accept')
    const echo = w.session().value?.pending.baseline
    expect(echo?.lines).toEqual(expect.arrayContaining(['lint: exit 1, 1 failures, —', '  proposed: no-new-failures']))
    expect((await run(w, `flow-approve baseline ${echo?.hash.slice(0, 8) ?? ''}`)).text).toContain('/flow-plan')
    const r = latest(w)
    expect(r?.setup?.commands.map(c => [c.id, c.mode])).toEqual([['test', 'must-pass'], ['lint', 'no-new-failures']])
    expect(r).toMatchObject({ phase: 'plan', task: 'P1', awaiting: '/flow-plan' })
    expect(r?.approvals.map(a => a.kind)).toEqual(['setup', 'baseline'])
  })

  test('a red command whose failures cannot be read cannot be accepted', async () => {
    const w = world({ gitOut: { ...HEAD }, judge: { test: { exit: 1, out: 'Segmentation fault' } } })
    await toS3(w)
    await check(w)
    await run(w, 'flow-status')
    const echo = w.session().value?.pending.baseline
    expect(echo?.lines.join('\n')).toContain('its failures cannot be read: fix it, or drop it with /flow-setup test=none')
    expect((await run(w, `flow-approve baseline ${echo?.hash.slice(0, 8) ?? ''}`)).text).toContain('cannot be read')
    expect(latest(w)).toMatchObject({ task: 'S4' })
  })

  test('a baseline file changed after S3 is not shown: the flow is blocked as tampered', async () => {
    const w = world({ gitOut: { ...HEAD }, judge: { lint: LINT_RED } })
    await toS3(w)
    await check(w)
    const file = `${HOME}/.snagon/flow/${latest(w)?.flowId}.baseline.json`
    w.files.set(file, (w.files.get(file) ?? '').replace('"exitCode": 1', '"exitCode": 0'))
    expect((await run(w, 'flow-status')).text).not.toContain('Shown in the flow pane')
    expect(latest(w)?.blocked).toEqual({ reason: 'tampered', vars: { file } })
    expect(w.session().value?.pending.baseline).toBeUndefined()
  })
})

describe('flow-baseline: what every flow_check checks first', () => {
  test('a changed command source blocks before anything runs', async () => {
    const gitOut: Record<string, string> = { ...HEAD }
    const w = world({ gitOut })
    await toS3(w)
    gitOut['config --null --get-regexp ^(filter|alias|remote|push|url)\\.'] = 'alias.t\nrm -rf .\0'
    await check(w)
    expect(latest(w)?.blocked).toEqual({ reason: 'cmdSrc', vars: { file: 'git:config' } })
    expect(judgedRuns(w)).toEqual([])
  })

  test('a changed runner package blocks before anything runs', async () => {
    let installed = false
    const w = world({
      gitOut: { ...HEAD },
      run: argv => {
        if (!installed || argv[0] !== '/bin/sh') return undefined
        if ((argv[2] ?? '').startsWith('for d in')) return { exitCode: 0, stdout: argv.slice(4).map(d => (d.endsWith('/node_modules/vitest') ? d : '')).join('\n'), stderr: '' }
        return (argv[2] ?? '').includes('shasum') ? { exitCode: 0, stdout: 'f00d  -\n', stderr: '' } : undefined
      },
    })
    await toS3(w)
    installed = true
    await check(w)
    expect(latest(w)?.blocked).toEqual({ reason: 'cmdSrc', vars: { file: 'runner' } })
    expect(judgedRuns(w)).toEqual([])
  })

  test('changed plugin files block as tampered', async () => {
    const w = world({ gitOut: { ...HEAD } })
    await toS3(w)
    w.files.set(`${MOD_ROOT}/hooks/register.ts`, 'changed')
    await check(w)
    expect(latest(w)?.blocked?.reason).toBe('tampered')
    expect(judgedRuns(w)).toEqual([])
  })

  test('sandbox drift blocks and marks the sandbox changed', async () => {
    const w = world({ gitOut: { ...HEAD } })
    await toS3(w)
    w.files.set(LOCAL, JSON.stringify({ sandbox: { enabled: false } }))
    await check(w)
    expect(latest(w)?.blocked?.reason).toBe('sandboxMismatch')
    expect(w.session().value?.sandbox).toBe('changed')
  })

  test('before the probe flow_check runs nothing and asks for the probe', async () => {
    const w = world({ gitOut: { ...HEAD } })
    await approved(w)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    expect((await check(w)).next).toContain(PROBE_COMMAND)
    expect(judgedRuns(w)).toEqual([])
  })

  test('where the judge sandbox cannot run (Linux) the flow is blocked with the reason', async () => {
    const w = world({ gitOut: { ...HEAD }, os: 'Linux' })
    await toS3(w)
    await check(w)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'couldNotRun', vars: { detail: expect.stringContaining('macOS') } })
  })
})
