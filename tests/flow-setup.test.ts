import { describe, expect, test } from 'claude-code/testing'
import { detectSetup, setupEcho, writeDraftView } from '../hooks/flow-setup'
import { forgetFlowCaches } from '../hooks/flow-host'
import { echoHash } from '../hooks/flow-owner'
import { fakeHost, HOME, ROOT, type FakeOpts } from './flow-fakes'

const PKG = JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } })
const GIT = {
  'config --get branch.main.remote': 'origin\n',
  'remote get-url --push origin': 'https://github.com/o/r.git\n',
}
function world(o: FakeOpts = {}) {
  forgetFlowCaches()
  return fakeHost({ ...o, gitOut: { ...GIT, ...o.gitOut }, files: { [`${ROOT}/package.json`]: PKG, [`${ROOT}/package-lock.json`]: '{}', ...o.files } })
}
const ARGS = { overrides: {}, tools: [], mcp: [] }

describe('flow-setup: S1 detect', () => {
  test('a TypeScript project gets its commands, the sandbox block, the remote and the default tool list', async () => {
    const w = world({ envText: 'PATH=/usr/bin\nGITHUB_TOKEN=ghp_x\nHOME=/Users/u\n' })
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    const d = out.draft
    expect(d.commands).toEqual([
      { id: 'test', argv: ['npm', 'test'], runner: 'vitest', mode: 'must-pass' },
      { id: 'typecheck', argv: ['npm', 'run', 'typecheck'], runner: 'tsc', mode: 'must-pass' },
      { id: 'lint', argv: ['npm', 'run', 'lint'], runner: 'eslint', mode: 'must-pass' },
    ])
    expect(d.block.network.allowedDomains).toEqual(['registry.npmjs.org'])
    expect(d.block.filesystem.denyRead).toEqual(expect.arrayContaining(['~/.claude/projects', '~/.snagon/flow', '~/.npmrc']))
    expect(JSON.parse(d.post).sandbox.enabled).toBe(true)
    expect(d.remote).toBe('origin')
    expect(d.facts.url).toBe('https://github.com/o/r.git')
    expect(d.branch).toBe('main')
    expect(d.allowTools).toContain('Bash')
    expect(d.secretNames).toEqual(['GITHUB_TOKEN'])
    expect(d.writeYourself).toBe(false)
  })

  test('CLAUDE_CONFIG_DIR moves the transcripts the block hides (F41)', async () => {
    const out = await detectSetup(world({ claudeDir: `${HOME}/cfg` }).host, ARGS)
    expect(out.ok && out.draft.block.filesystem.denyRead).toEqual(expect.arrayContaining([`${HOME}/cfg/projects`]))
    expect(out.ok && out.draft.block.filesystem.denyRead).not.toContain('~/.claude/projects')
  })

  test('an override sets a command, none drops one, and tools=+ and mcp=+ extend the lists', async () => {
    const out = await detectSetup(world().host, { overrides: { test: 'npx jest --ci', lint: 'none' }, tools: ['WebFetch'], mcp: ['mcp__gh__search'] })
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect(out.draft.commands.map(c => [c.id, c.argv.join(' '), c.runner])).toEqual([['test', 'npx jest --ci', 'jest'], ['typecheck', 'npm run typecheck', 'tsc']])
    expect(out.draft.allowTools).toContain('WebFetch')
    expect(out.draft.allowMcp).toEqual(['mcp__gh__search'])
  })

  test('every refusal is listed at once, in the owner\'s words', async () => {
    const w = world({
      branch: '', envText: 'PATH=/usr/bin\nNPM_TOKEN=x\n', journalDir: '.snagon/flow',
      files: { [`${ROOT}/.npmrc`]: '//registry.npmjs.org/:_authToken=abc\n' },
      settings: { user: { sandbox: { excludedCommands: ['docker'] } } },
    })
    const out = await detectSetup(w.host, { overrides: {}, tools: [], mcp: ['mcp__computer-use__screenshot'] })
    expect(out.ok).toBe(false)
    const text = out.ok ? '' : out.refusals.join('\n')
    expect(text).toContain('HEAD is detached')
    expect(text).toContain('registry credentials are set in the environment: NPM_TOKEN')
    expect(text).toContain('.npmrc holds a registry credential')
    expect(text).toContain('mcp__computer-use__screenshot could read the screen')
    expect(text).toContain('the journal folder .snagon/flow holds the mod\'s own data')
    expect(text).toContain('the user settings hold sandbox.excludedCommands')
  })

  test('a journal folder outside .snagon must be ignored by git; .snagon and .snagon/handoff are refused', async () => {
    const out = await detectSetup(world({ journalDir: 'notes/journal' }).host, ARGS)
    expect(out.ok ? '' : out.refusals.join('\n')).toContain('must be under .snagon/ or ignored by git')
    const ignored = await detectSetup(world({ journalDir: 'notes/journal', gitOut: { 'check-ignore -q -- notes/journal': '' } }).host, ARGS)
    expect(ignored.ok).toBe(true)
    for (const dir of ['.snagon', '.snagon/handoff']) expect((await detectSetup(world({ journalDir: dir }).host, ARGS)).ok).toBe(false)
  })

  test('no test command, no remote, or a runner that cannot be found refuses', async () => {
    const noTest = await detectSetup(world({ files: { [`${ROOT}/package.json`]: '{"scripts":{}}' } }).host, ARGS)
    expect(noTest.ok ? '' : noTest.refusals.join('\n')).toContain('no test command')
    const noRemote = await detectSetup(world({ gitOut: { 'config --get branch.main.remote': { exitCode: 1, stdout: '', stderr: '' }, 'remote get-url --push origin': { exitCode: 2, stdout: '', stderr: 'no such remote' } } }).host, ARGS)
    expect(noRemote.ok ? '' : noRemote.refusals.join('\n')).toContain('no remote to release to')
    const missing = await detectSetup(world({ missing: ['npm'] }).host, ARGS)
    expect(missing.ok ? '' : missing.refusals.join('\n')).toContain('"npm test" cannot be run')
  })

  test('a token in the settings file means the owner pastes the block', async () => {
    const pre = JSON.stringify({ env: { API_TOKEN: `ghp_${'a'.repeat(36)}` } })
    const out = await detectSetup(world({ files: { [`${ROOT}/.claude/settings.local.json`]: pre } }).host, ARGS)
    expect(out.ok && out.draft.writeYourself).toBe(true)
  })
})

describe('flow-setup: the echo and the draft view', () => {
  test('the echo shows the commands, the block with both hashes, the lists, the remote and the caps; it hashes the same twice', async () => {
    const w = world()
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    const echo = setupEcho(w.host, out.draft)
    const text = [echo.title, ...echo.lines].join('\n')
    expect(echo.title).toBe('Setup for the project owner to approve')
    expect(text).toContain('test: npm test (runner vitest)')
    expect(text).toContain('  script: vitest run')
    expect(text).toMatch(/Sandbox block for \.claude\/settings\.local\.json \(before absent, after [0-9a-f]{8}\):/)
    expect(text).toContain('"allowUnsandboxedCommands": false')
    expect(text).toContain('A release goes to https://github.com/o/r.git, branch main')
    expect(text).toContain('Rounds: plan edit 3; each feature edit 3, review 3, debug 4; verify edit 2, debug 3. Session cost cap $15')
    const again = await detectSetup(w.host, ARGS)
    expect(again.ok && (await echoHash(setupEcho(w.host, again.draft)))).toBe(await echoHash(echo))
  })

  test('a weakening flag in a script is named', async () => {
    const out = await detectSetup(world({ files: { [`${ROOT}/package.json`]: JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests || true' } }) } }).host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect(setupEcho(world().host, out.draft).lines.join('\n')).toContain('weakens the check: --passWithNoTests, || true')
  })

  test('a secret in a script body is removed from the echo lines', async () => {
    const out = await detectSetup(world({ files: { [`${ROOT}/package.json`]: JSON.stringify({ scripts: { test: `GH=ghp_${'c'.repeat(36)} vitest run` } }) } }).host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    const lines = setupEcho(world().host, out.draft).lines.join('\n')
    expect(lines).toContain('[secret removed')
    expect(lines).not.toContain('cccccccc')
  })

  test('the draft view is written redacted under .snagon/flow', async () => {
    const w = world()
    await writeDraftView(w.host, 'Setup\nkey ghp_' + 'b'.repeat(36))
    const view = w.files.get(`${ROOT}/.snagon/flow/setup-draft.md`) ?? ''
    expect(view).toContain('[secret removed')
    expect(view).not.toContain('bbbbbbbb')
  })
})
