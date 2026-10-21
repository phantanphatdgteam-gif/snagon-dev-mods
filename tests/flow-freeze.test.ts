import { describe, expect, test } from 'claude-code/testing'
import { ownerCommand } from '../hooks/flow-cmd'
import { applySetup, sandboxProblems, setupHash } from '../hooks/flow-freeze'
import { emptySession, forgetFlowCaches } from '../hooks/flow-host'
import { checkVerdict, forgetModes, liveCall, noteMode } from '../hooks/flow-live'
import { flowCard, flowStatus } from '../hooks/flow-turn'
import { effectiveOf, PROBE_COMMAND } from '../hooks/flow-sandbox'
import { canonical } from '../hooks/flow-owner'
import { sha256 } from '../hooks/flow-review'
import { spawnHook } from '../hooks/flow-ticket'
import type { FlowRecord } from '../hooks/flow-state'
import { activeRecord, fakeHost, recordFile, HOME, MOD_ROOT, ROOT, SESSION_ID, type FakeOpts } from './flow-fakes'

const PKG = JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } })
const GIT = { 'config --get branch.main.remote': 'origin\n', 'remote get-url --push origin': 'https://github.com/o/r.git\n' }
const LOCAL = `${ROOT}/.claude/settings.local.json`
const COMPOSER = { kind: 'composer' } as const
function world(o: FakeOpts = {}) {
  forgetFlowCaches()
  forgetModes()
  return fakeHost({ ...o, gitOut: { ...GIT, ...o.gitOut }, files: { [`${ROOT}/package.json`]: PKG, [`${ROOT}/package-lock.json`]: '{}', ...o.files } })
}
type W = ReturnType<typeof world>
const run = async (w: W, line: string) => {
  const [command = '', ...rest] = line.split(' ')
  return ownerCommand(w.host, { command, args: rest.join(' '), origin: COMPOSER })
}
const records = (w: W): FlowRecord[] =>
  [...w.files.entries()].filter(([k, v]) => k.startsWith(`${HOME}/.snagon/flow/`) && /\.v\d+\.json$/.test(k) && v.trim()).map(([, v]) => JSON.parse(v) as FlowRecord)
const latest = (w: W): FlowRecord | undefined => records(w).sort((a, b) => b.version - a.version)[0]
async function approved(w: W): Promise<string> {
  await run(w, 'flow-setup')
  const hash8 = w.session().value?.pending.setup?.hash.slice(0, 8) ?? ''
  return (await run(w, `flow-approve setup ${hash8}`)).text
}
/** The Write main makes in S2b, through the guard as the engine runs it (tool.check, then the call, then the check after). */
async function writeLocal(w: W, content: string): Promise<{ deny: string | null; withheld: string | null }> {
  noteMode(undefined, 'default')
  const deny = await checkVerdict(w.host, { tool: 'Write', input: { file_path: LOCAL, content } })
  if (deny) return { deny, withheld: null }
  const live = await liveCall(w.host, { tool: 'Write', file_path: LOCAL, content })
  w.files.set(LOCAL, content)
  return { deny, withheld: await live.after({ result: { type: 'create', filePath: LOCAL, content } }) }
}
const probe = async (w: W, out: unknown) => (await liveCall(w.host, { tool: 'Bash', command: PROBE_COMMAND })).after(out)
const REFUSED = { isError: true, result: 'Exit code 56\n' }

describe('flow-freeze: /flow-setup shows the echo', () => {
  test('the echo goes to the pane, the session keeps it with the arguments, and the draft view is written', async () => {
    const w = world()
    const out = await run(w, 'flow-setup lint=none')
    expect(out.text).toContain('Shown in the flow pane for the project owner to check.')
    expect(w.panes).toEqual([{ id: 'flow-echo', title: 'Setup for the project owner to approve' }])
    const s = w.session().value
    expect(s?.pending.setup?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(s?.shown).toBe('setup')
    expect(s?.setupArgs).toEqual({ overrides: { lint: 'none' }, tools: [], mcp: [] })
    expect(w.files.get(`${ROOT}/.snagon/flow/setup-draft.md`)).toContain('test: npm test (runner vitest)')
  })

  test('refusals come back as one list and nothing waits for approval', async () => {
    const w = world({ branch: '' })
    const out = await run(w, 'flow-setup')
    expect(out.text.split('\n')[0]).toBe('flow cannot start here yet:')
    expect(out.text).toContain('- HEAD is detached')
    expect(w.session().value?.pending.setup).toBeUndefined()
    expect(w.panes).toEqual([])
  })

  test('with no surface to draw the pane the echo is dropped and the owner is told', async () => {
    const w = world({ placed: false })
    expect((await run(w, 'flow-setup')).text).toContain('no pane can be shown here')
    expect(w.session().value?.pending.setup).toBeUndefined()
  })
})

describe('flow-freeze: S2 approval', () => {
  test('a new flow: the record holds the setup, the frozen hashes and the approval; the S2b window opens and main gets the exact text', async () => {
    const w = world()
    expect(await approved(w)).toContain('Approved. The agent now writes .claude/settings.local.json')
    const r = latest(w)
    expect(r).toMatchObject({ phase: 'setup', task: 'S2b', lifecycle: 'active', root: ROOT, branch: 'main', setup: { remote: 'origin', branch: 'main', journalDir: '.snagon/journal' } })
    expect(r?.setup?.commands.map(c => c.id)).toEqual(['test', 'lint'])
    expect(r?.approvals.map(a => [a.kind, a.origin])).toEqual([['setup', 'composer']])
    expect(Object.keys(r?.frozen ?? {})).toEqual(expect.arrayContaining(['post', 'plugin', 'runner:v2', 'runner:v2.facts', 'runner:v2.load', 'remote.url', 'remote.rules', 'remote.global', 'env.PATH']))
    expect(r?.frozen['env.PATH']).toBe('/usr/bin:/bin') // the approved draft's filtered PATH (NK-02)
    expect(r?.frozen.sandbox).toBeUndefined()
    expect(r?.lock?.sessionId).toBe(SESSION_ID)
    const s = w.session().value
    expect(s?.pending.setup).toBeUndefined()
    expect(s?.s2b).toMatchObject({ path: LOCAL, preHash: null })
    expect(JSON.parse(s?.s2b?.post ?? '{}').sandbox.allowUnsandboxedCommands).toBe(false)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain(`file_path ${LOCAL}`)
    expect(w.submitted[0]).toContain(s?.s2b?.post ?? '-')
    expect(await flowCard(w.host)).toContain('Next: the agent writes .claude/settings.local.json exactly as approved. Command: Write')
    expect(JSON.parse(await flowStatus(w.host)).next).toContain(s?.s2b?.post ?? '-')
  })

  test('an echo shown for stack=python in a project with two stacks is rebuilt with it at approval and freezes python (AC-STK-15)', async () => {
    const w = world({ files: { [`${ROOT}/pyproject.toml`]: '[project]\nname = "x"\n' } })
    expect((await run(w, 'flow-setup')).text).toContain('several stacks match here (typescript, python)')
    await run(w, 'flow-setup stack=python')
    expect(w.session().value?.setupArgs).toEqual({ overrides: {}, tools: [], mcp: [], stack: 'python' })
    const hash8 = w.session().value?.pending.setup?.hash.slice(0, 8) ?? ''
    expect((await run(w, `flow-approve setup ${hash8}`)).text).toContain('Approved.')
    expect([latest(w)?.setup?.stack, latest(w)?.setup?.commands.map(c => c.argv.join(' '))]).toEqual(['python', ['.venv/bin/pytest']])
  })

  test('the recheck of S1\'s sandbox refusals (probe, flow_check) protects a git common dir outside the project too (S-12, security review r4)', async () => {
    const common = `${HOME}/main/.git`, settings = { user: { sandbox: { filesystem: { allowWrite: ['~/main'] } } } }
    const worktree = (argv: readonly string[]) => (argv.includes('rev-parse') ? { exitCode: 0, stdout: `${ROOT}\n${common}\n${common}/worktrees/r\n${common}/worktrees/r/index\n`, stderr: '', isStdoutTruncated: false } : undefined)
    expect(await sandboxProblems(world({ run: worktree, settings }).host, activeRecord())).toContain('user:filesystem.allowWrite')
    expect(await sandboxProblems(world({ settings }).host, activeRecord())).not.toContain('user:filesystem.allowWrite')
  })

  test('settings that already hold the block skip the Write: main runs the probe at once', async () => {
    const first = world()
    await approved(first)
    const w = world({ files: { [LOCAL]: first.session().value?.s2b?.post ?? '' } })
    expect(await approved(w)).toContain('Approved. The settings already hold the block')
    expect(w.session().value?.s2b).toBeNull()
    expect(w.submitted).toEqual([expect.stringContaining(PROBE_COMMAND)])
  })

  test('an approval of another echo than the one just rebuilt freezes nothing', async () => {
    const w = world()
    await run(w, 'flow-setup')
    expect(await setupHash(w.host)).toBe(w.session().value?.pending.setup?.hash)
    expect(await applySetup(w.host, { kind: 'setup', echoHash: 'f'.repeat(64), at: 1, origin: 'composer' })).toContain('This changed after it was shown')
    expect(records(w)).toEqual([])
  })

  test('a file that changed after the echo makes the approval fail', async () => {
    const w = world()
    await run(w, 'flow-setup')
    const hash8 = w.session().value?.pending.setup?.hash.slice(0, 8) ?? ''
    w.files.set(`${ROOT}/package.json`, JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }))
    expect((await run(w, `flow-approve setup ${hash8}`)).text).toContain('This changed after it was shown. Run /flow-setup again')
    expect(records(w)).toEqual([])
  })

  test('a secret in the settings file: no window, the owner pastes the block and /flow-status checks it', async () => {
    const env = { API_TOKEN: `ghp_${'a'.repeat(36)}` }
    const w = world({ files: { [LOCAL]: `${JSON.stringify({ env }, null, 2)}\n` } })
    expect(await approved(w)).toContain('Paste the block into .claude/settings.local.json yourself, then run /flow-status')
    expect(latest(w)?.awaiting).toBe('/flow-status')
    expect(w.session().value?.s2b).toBeNull()
    expect(w.submitted).toEqual([])
    expect((await run(w, 'flow-status')).text).toContain('does not hold the approved block yet')
    const block = { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ['registry.npmjs.org'] }, filesystem: { allowWrite: ['~/.npm'], denyRead: JSON.parse(w.files.get(`${ROOT}/.snagon/flow/setup-draft.md`)?.match(/"denyRead": (\[[^\]]*\])/)?.[1] ?? '[]') } }
    w.files.set(LOCAL, JSON.stringify({ env, sandbox: block }))
    await run(w, 'flow-status')
    expect(latest(w)?.awaiting).toBeUndefined()
    expect(w.submitted.at(-1)).toContain(PROBE_COMMAND)
  })
})

describe('flow-freeze: S2b and the sandbox probe', () => {
  test('the exact Write passes the guard once, closes the window and asks main for the probe', async () => {
    const w = world()
    await approved(w)
    const post = w.session().value?.s2b?.post ?? ''
    expect(await writeLocal(w, post)).toEqual({ deny: null, withheld: null })
    expect(w.session().value?.s2b).toBeNull()
    expect(w.submitted.at(-1)).toContain(PROBE_COMMAND)
    expect(await flowCard(w.host)).toContain('Next: the agent runs the sandbox check. Command: Bash')
    expect((await writeLocal(w, post)).deny).toContain('protected')
  })

  test('a settings file that does not hold what was written blocks the flow as tampered, with no probe', async () => {
    const w = world()
    await approved(w)
    const post = w.session().value?.s2b?.post ?? ''
    noteMode(undefined, 'default')
    expect(await checkVerdict(w.host, { tool: 'Write', input: { file_path: LOCAL, content: post } })).toBeNull()
    const live = await liveCall(w.host, { tool: 'Write', file_path: LOCAL, content: post })
    w.files.set(LOCAL, '{"sandbox":{"enabled":false}}\n')
    await live.after({ result: { type: 'create', filePath: LOCAL, content: post } })
    expect(latest(w)?.blocked?.reason).toBe('tampered')
    expect(w.submitted.some(t => t.includes(PROBE_COMMAND))).toBe(false)
  })

  test('a Write of other text is denied and closes the window', async () => {
    const w = world()
    await approved(w)
    expect((await writeLocal(w, '{}\n')).deny).toContain('not exactly the approved settings text')
    expect(w.session().value?.s2b).toBeNull()
  })

  test('a probe the sandbox refuses turns the sandbox on, freezes it and moves setup to the baseline', async () => {
    const w = world()
    await approved(w)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    expect(await probe(w, REFUSED)).toBeNull()
    const r = latest(w)
    expect(r?.task).toBe('S3')
    expect(JSON.parse(r?.frozen.sandbox ?? '{}').sandbox.enabled).toBe(true)
    expect(r?.frozen.hCfg).toMatch(/^[0-9a-f]{16}$/)
    expect(w.session().value?.sandbox).toBe('on')
    expect(w.submitted.at(-1)).toContain('flow_check')
  })

  test('a probe that reached the network blocks the flow: the sandbox is not on', async () => {
    const w = world()
    await approved(w)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    await probe(w, { result: { stdout: '200', stderr: '', interrupted: false } })
    expect(latest(w)?.blocked).toEqual({ reason: 'sandboxMismatch', vars: {} })
    expect(w.session().value?.sandbox).toBeNull()
  })

  test('settings that loosen the sandbox in another layer block at the probe', async () => {
    const w = world()
    await approved(w)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    const merged = JSON.parse(w.files.get(LOCAL) ?? '{}') as { sandbox: Record<string, unknown> }
    const loose = world({ settings: { user: { sandbox: { network: { allowLocalBinding: true } } }, merged: { sandbox: { ...merged.sandbox, network: { allowLocalBinding: true } } } } })
    loose.files.clear()
    for (const [k, v] of w.files) loose.files.set(k, v)
    loose.setSession(w.session().value ?? emptySession())
    await probe(loose, REFUSED)
    expect(latest(loose)?.blocked?.reason).toBe('sandboxMismatch')
  })

  test('a later session runs the probe before anything else; drift from the frozen sandbox blocks', async () => {
    const block = { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ['registry.npmjs.org'] }, filesystem: { allowWrite: ['~/.npm'], denyRead: ['~/.npmrc'] } }
    const frozen = { post: await sha256(canonical({ sandbox: block })), sandbox: canonical(effectiveOf({ sandbox: block })) }
    const w = world({ files: { ...recordFile(activeRecord({ frozen })), [LOCAL]: `${JSON.stringify({ sandbox: block }, null, 2)}\n` } })
    expect(await flowCard(w.host)).toContain('Command: Bash')
    expect(JSON.parse(await flowStatus(w.host)).next).toContain(PROBE_COMMAND)
    await probe(w, REFUSED)
    expect(w.session().value?.sandbox).toBe('on')
    expect(latest(w)?.task).toBe('B2')
    const local = world({ files: { ...recordFile(activeRecord({ frozen })), [LOCAL]: JSON.stringify({ sandbox: block, env: { X: '1' } }) } })
    await probe(local, REFUSED)
    expect(latest(local)?.blocked?.reason).toBe('sandboxMismatch')
    const merged = { sandbox: { ...block, network: { allowedDomains: ['registry.npmjs.org', 'evil.example'] } } }
    const drift = world({ files: { ...recordFile(activeRecord({ frozen })), [LOCAL]: JSON.stringify({ sandbox: block }) }, settings: { user: { sandbox: { network: { allowedDomains: ['evil.example'] } } }, merged } })
    await probe(drift, REFUSED)
    expect(latest(drift)?.blocked?.reason).toBe('sandboxMismatch')
  })

  test('a re-freeze keeps the phase and task, clears the block and the frozen sandbox, and approvals add up', async () => {
    const w = world({ files: recordFile(activeRecord({ blocked: { reason: 'sandboxMismatch', vars: {} }, frozen: { sandbox: '{}', post: 'old', 'dep:F-01': 'yes', 'dep:F-00': 'rebased', 'rebase:F-00': 'a>b' }, approvals: [{ kind: 'plan', echoHash: 'h', at: 1, origin: 'composer' }] })) })
    await approved(w)
    const r = latest(w)
    expect(r).toMatchObject({ phase: 'build', task: 'B2', feature: 'F-01' })
    // AC-RI-3: the new freeze takes the runner hash again, so a token not used yet is used up; the history stays
    expect([r?.frozen['dep:F-01'], r?.frozen['dep:F-00'], r?.frozen['rebase:F-00']]).toEqual(['rebased', 'rebased', 'a>b'])
    expect(r?.blocked).toBeUndefined()
    expect(r?.frozen.sandbox).toBeUndefined()
    expect(r?.approvals.map(a => a.kind)).toEqual(['plan', 'setup'])
  })

  test('a hook planted between the setup approval and the probe blocks as tampered instead of being frozen (GAP-054-9)', async () => {
    const w = world({ gitOut: { 'config --type=path --get core.hooksPath': '.husky/_\n' }, files: { [`${ROOT}/.husky/_/h`]: '#!/bin/sh\n' } })
    await approved(w)
    w.files.set(`${ROOT}/.husky/_/h`, '#!/bin/sh\necho planted\n')
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    await probe(w, REFUSED)
    const r = latest(w)
    expect(r?.blocked?.reason).toBe('tampered')
    expect(r?.blocked?.vars.file).toContain('changed after the setup was approved')
    expect(r?.frozen.hCfg).toBeUndefined()
  })

  test('a 0.5.3 flow blocked by the mod update: /flow-setup freezes the new version, the probe freezes H_cfg again with the hooks path (NK-04, NK-01)', async () => {
    const old = activeRecord({ blocked: { reason: 'tampered', vars: { file: MOD_ROOT } }, frozen: { plugin: 'old', post: 'old', sandbox: '{}', hCfg: 'old' } })
    const w = world({ files: { ...recordFile(old), [`${MOD_ROOT}/.claude-plugin/plugin.json`]: '{"version":"0.5.4"}' }, gitOut: { 'config --type=path --get core.hooksPath': '.husky/_\n' } })
    await approved(w)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.frozen['plugin.version']).toBe('0.5.4')
    expect(latest(w)?.frozen.plugin).not.toBe('old')
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    expect(await probe(w, REFUSED)).toBeNull()
    const r = latest(w)
    expect(r?.blocked).toBeUndefined()
    expect(r?.frozen.hCfg).toMatch(/^[0-9a-f]{16}$/)
    expect(r?.frozen['cfg:core.hooksPath']).toBe('.husky/_')
    expect(r?.frozen[`cfg:${ROOT}/.husky/_`]).toBe('absent')
  })
})

describe('flow-freeze: the probe control and the probe-first rule (step 13 reviews)', () => {
  test('S13-7: main\'s refused probe with no network outside the sandbox either blocks as inconclusive, not as a mismatch', async () => {
    const w = world()
    await approved(w)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    const io = w.host.io, realRun = io.run
    // the direct route fails while a proxied one would pass: the control takes the probe's own route, so still inconclusive (S13-11)
    io.run = async (argv, init) => (argv[0] !== '/usr/bin/curl' ? realRun(argv, init)
      : argv.includes('--noproxy') ? { exitCode: 6, stdout: '', stderr: 'curl: (6) Could not resolve host', isStdoutTruncated: false } : { exitCode: 0, stdout: '200', stderr: '', isStdoutTruncated: false })
    await probe(w, REFUSED)
    io.run = realRun
    expect(latest(w)?.blocked).toEqual({ reason: 'probeInconclusive', vars: {} })
    expect(w.session().value?.sandbox).toBeNull()
  })

  test('GAP-step13-11: until the probe passed, main\'s Bash runs only the probe command', async () => {
    const w = world()
    await approved(w)
    await writeLocal(w, w.session().value?.s2b?.post ?? '')
    expect(await checkVerdict(w.host, { tool: 'Bash', input: { command: 'ls' } })).toContain("nothing but main's probe")
    expect(await checkVerdict(w.host, { tool: 'Bash', input: { command: PROBE_COMMAND } })).toBeNull()
    // SEC13R3-1: no subagent Bash (the probe command included) and no spawn, free ones included, before the probe passed
    expect(await checkVerdict(w.host, { tool: 'Bash', input: { command: PROBE_COMMAND }, agentId: 'ag-free' })).toContain("nothing but main's probe")
    expect(await spawnHook(w.host, { tool_use_id: 'tu-free', prompt: 'look around', description: 'p', subagentType: 'Explore' })).toEqual({ deny: expect.stringContaining('no agent starts') })
    await probe(w, REFUSED)
    expect(w.session().value?.sandbox).toBe('on')
    expect(await checkVerdict(w.host, { tool: 'Bash', input: { command: 'ls' } })).toBeNull()
    forgetModes()
  })
})
