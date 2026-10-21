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

  test('the echo names the git the mod runs and the PATH entries it skips (NK-02)', async () => {
    const w = world({ pathDropped: [`${ROOT}/node_modules/.bin`, '.'] })
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect(out.draft.git).toBe('/usr/local/bin/git')
    expect(out.draft.pathDropped).toEqual([`${ROOT}/node_modules/.bin`, '.'])
    const lines = setupEcho(w.host, out.draft).lines.join('\n')
    expect(lines).toContain('git: /usr/local/bin/git')
    expect(lines).toContain(`${ROOT}/node_modules/.bin, .`)
    expect(lines).toContain('PATH of the mod\'s own programs and of the judge: /usr/bin:/bin')
    expect(out.draft.path).toBe('/usr/bin:/bin')
    expect(setupEcho(world().host, { ...out.draft, pathDropped: [] }).lines.join('\n')).not.toContain('leave out')
  })

  test('a git that resolves into the project, a temp folder or a settings write place is refused, naming where it lands (NK-02)', async () => {
    const merged = { permissions: { additionalDirectories: ['~/shared'] } }
    for (const target of [`${ROOT}/bin/git`, '/private/tmp/g/git', `${HOME}/shared/git`]) {
      const out = await detectSetup(world({ links: { '/usr/local/bin/git': target }, files: { [target]: '#!/bin/sh\n' }, settings: { merged } }).host, ARGS)
      expect(out.ok).toBe(false)
      expect(out.ok ? '' : out.refusals.join('\n')).toContain(target)
    }
  })

  test('no git on the filtered PATH is refused, naming that PATH (NK-02)', async () => {
    const out = await detectSetup(world({ missing: ['git'] }).host, ARGS)
    expect(out.ok ? '' : out.refusals.join('\n')).toContain('no git on the PATH the mod uses (/usr/bin:/bin)')
  })

  test('a dependency or build folder git tracks, or with files git neither tracks nor ignores, is refused; ignored or absent passes (NK-05)', async () => {
    const ls = (d: string): string => `ls-files -t -c -o --exclude-standard --directory --no-empty-directory -- ${d}`
    const out = await detectSetup(world({ gitOut: { [ls('node_modules')]: '? node_modules/\n', [ls('dist')]: 'H dist/a.js\n' } }).host, ARGS)
    const text = out.ok ? '' : out.refusals.join('\n')
    expect(text).toContain('node_modules holds files git neither tracks nor ignores')
    expect(text).toContain('dist is tracked by git')
    expect(text).not.toContain('build holds')
    expect(text).not.toContain('coverage')
    expect((await detectSetup(world().host, ARGS)).ok).toBe(true)
  })

  test('a repository config or hooks folder that cannot be read refuses S1 with the reason (GAP-054-11)', async () => {
    const out = await detectSetup(world({ gitOut: { 'config --type=path --get core.hooksPath': { exitCode: 2, stdout: '', stderr: 'bad config', isStdoutTruncated: false } } }).host, ARGS)
    expect(out.ok ? '' : out.refusals.join('\n')).toContain('the repository config and git hooks could not be read (git config core.hooksPath failed: bad config)')
  })

  test('an override sets a command, none drops one, and tools=+ and mcp=+ extend the lists', async () => {
    const out = await detectSetup(world().host, { overrides: { test: 'npx jest --ci', lint: 'none' }, tools: ['WebFetch'], mcp: ['mcp__gh__search'] })
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect(out.draft.commands.map(c => [c.id, c.argv.join(' '), c.runner])).toEqual([['test', 'npx jest --ci', 'jest'], ['typecheck', 'npm run typecheck', 'tsc']])
    expect(out.draft.allowTools).toContain('WebFetch')
    expect(out.draft.allowMcp).toEqual(['mcp__gh__search'])
  })

  test('a repo with package.json and pyproject.toml lists both stacks and is refused until stack=<id> picks one (AC-STK-15, GAP-R2-11)', async () => {
    const both = { [`${ROOT}/pyproject.toml`]: '[project]\nname = "x"\n' }
    const out = await detectSetup(world({ files: both }).host, ARGS)
    expect(out.ok ? [] : out.refusals).toContain('several stacks match here (typescript, python); pick one with /flow-setup stack=<id>, for example stack=typescript')
    const py = await detectSetup(world({ files: both }).host, { ...ARGS, stack: 'python' })
    if (!py.ok) throw new Error(py.refusals.join('\n'))
    expect([py.draft.stack, py.draft.stacks, py.draft.commands.map(c => c.argv.join(' '))]).toEqual(['python', ['typescript', 'python'], ['.venv/bin/pytest']])
    expect(setupEcho(world().host, py.draft).lines[0]).toBe('Stack: python, picked with stack=python; also found here: typescript')
    const ts = await detectSetup(world({ files: both }).host, { ...ARGS, stack: 'typescript' })
    expect(ts.ok && [ts.draft.stack, ts.draft.commands[0]?.argv.join(' ')]).toEqual(['typescript', 'npm test'])
  })

  test('stack=<id> names a stack flow knows that this project matches; one stack found shows alone (AC-STK-15)', async () => {
    const unknown = await detectSetup(world().host, { ...ARGS, stack: 'rust' })
    expect(unknown.ok ? [] : unknown.refusals).toContain('stack=rust is not a stack flow knows (typescript, python)')
    const absent = await detectSetup(world().host, { ...ARGS, stack: 'python' })
    expect(absent.ok ? [] : absent.refusals).toContain('stack=python does not match this project (Python needs pyproject.toml, setup.py, setup.cfg, requirements*.txt or Pipfile); stacks found here: typescript')
    const one = await detectSetup(world().host, { ...ARGS, stack: 'typescript' })
    if (!one.ok) throw new Error(one.refusals.join('\n'))
    expect([one.draft.stacks, setupEcho(world().host, one.draft).lines[0]]).toEqual([['typescript'], 'Stack: typescript'])
  })

  test('each command says where its results come from: a per-test report, or its exit code and output only (§4.5, AC-STK-12)', async () => {
    const out = await detectSetup(world().host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    const none = '  results: its exit code and output only (no per-test report, so it proves no eval criterion)'
    expect(setupEcho(world().host, out.draft).lines.slice(0, 10)).toEqual([
      'Stack: typescript',
      'test: npm test (runner vitest)', '  script: vitest run', '  results: one per test, from its JSON report',
      'typecheck: npm run typecheck (runner tsc)', '  script: tsc --noEmit', none,
      'lint: npm run lint (runner eslint)', '  script: eslint .', none,
    ])
  })

  test('a setting that makes the git common dir writable is refused when the dir lies outside the project, as a worktree\'s does (S-12)', async () => {
    const common = `${HOME}/main/.git`, settings = { user: { sandbox: { filesystem: { allowWrite: ['~/main'] } } } }
    const worktree = (argv: readonly string[]) => (argv.includes('rev-parse') ? { exitCode: 0, stdout: `${ROOT}\n${common}\n${common}/worktrees/r\n${common}/worktrees/r/index\n`, stderr: '', isStdoutTruncated: false } : undefined)
    const out = await detectSetup(world({ run: worktree, settings }).host, ARGS)
    expect(out.ok ? '' : out.refusals.join('\n')).toContain('the user settings hold sandbox.filesystem.allowWrite "~/main": it gives write access to a protected folder')
    expect((await detectSetup(world({ settings }).host, ARGS)).ok).toBe(true)
  })

  test('with two stacks and stack=typescript, Python credentials still refuse and its credential files stay hidden (AC-STK-10, AC-STK-15, security review r2)', async () => {
    const files = { [`${ROOT}/pyproject.toml`]: '[project]\nname = "x"\n', [`${ROOT}/.pypirc`]: '[pypi]\npassword = p\n' }
    const out = await detectSetup(world({ files, envText: 'PATH=/usr/bin\nPIP_INDEX_URL=https://u:s3cret@pypi.corp/simple\n' }).host, { ...ARGS, stack: 'typescript' })
    const text = out.ok ? '' : out.refusals.join('\n')
    expect(text).toContain('registry credentials are set in the environment: PIP_INDEX_URL; unset them for this session')
    expect(text).toContain('.pypirc holds a registry credential; move it to your user config')
    const clean = await detectSetup(world({ files: { [`${ROOT}/pyproject.toml`]: '[project]\nname = "x"\n' } }).host, { ...ARGS, stack: 'typescript' })
    if (!clean.ok) throw new Error(clean.refusals.join('\n'))
    expect(clean.draft.block.filesystem.denyRead).toEqual(expect.arrayContaining(['~/.npmrc', '~/.config/pip', '~/.config/uv']))
    expect(clean.draft.block.network.allowedDomains).toEqual(['registry.npmjs.org'])
  })

  test('an unknown stack= still shows what is wrong with the stacks here: none, or several (code review r3)', async () => {
    forgetFlowCaches()
    const bare = await detectSetup(fakeHost({ gitOut: GIT }).host, { ...ARGS, stack: 'rust' })
    const text = bare.ok ? '' : bare.refusals.join('\n')
    expect(text).toContain('stack=rust is not a stack flow knows (typescript, python)')
    expect(text).toContain('no supported stack here (TypeScript needs package.json or tsconfig.json; Python needs')
    const both = await detectSetup(world({ files: { [`${ROOT}/pyproject.toml`]: '[project]\nname = "x"\n' } }).host, { ...ARGS, stack: 'rust' })
    expect(both.ok ? '' : both.refusals.join('\n')).toContain('several stacks match here (typescript, python)')
  })

  test('a variable name with characters outside [A-Za-z0-9_], as npm\'s per-registry token, is listed and refused (security review r3)', async () => {
    const out = await detectSetup(world({ envText: 'PATH=/usr/bin\nnpm_config_//registry.npmjs.org/:_authToken=x\n' }).host, ARGS)
    expect(out.ok ? [] : out.refusals).toContain('registry credentials are set in the environment: npm_config_//registry.npmjs.org/:_authToken; unset them for this session')
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
    expect(text).toContain('Rounds: plan edit 3; each feature edit 3, review 3, debug 4; verify edit 2, debug 3')
    expect(text).not.toMatch(/cost cap/i) // the setup echo names no session cost cap (owner decision 2026-10-20)
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
