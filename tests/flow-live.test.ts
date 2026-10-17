import { describe, expect, test } from 'claude-code/testing'
import { checkVerdict, forgetModes, liveCall, noteMode } from '../hooks/flow-live'
import { emptySession, forgetFlowCaches, pluginRoots } from '../hooks/flow-host'
import { pluginRootRefusals } from '../hooks/flow-sandbox'
import { parseRecord, versionPath } from '../hooks/flow-state'
import { sha256 } from '../hooks/flow-review'
import { activeRecord, fakeHost, recordFile, FLOW_ID, HOME, ROOT, type FakeOpts } from './flow-fakes'

const SETTINGS = `${ROOT}/.claude/settings.local.json`
const PRE = '{"permissions":{}}\n'
const POST = '{\n  "permissions": {},\n  "sandbox": {\n    "enabled": true\n  }\n}\n'
/** A fresh world with an active flow of this repository (unless `flow` is false); the main loop reported `mode` (unless
 * undefined). */
function world(o: FakeOpts & { flow?: boolean; record?: Parameters<typeof activeRecord>[0]; mode?: string | null } = {}) {
  forgetFlowCaches()
  forgetModes()
  if (o.mode !== null) noteMode(undefined, o.mode ?? 'default')
  return fakeHost({ ...o, files: { [`${ROOT}/src/a.ts`]: 'a', [`${ROOT}/README.md`]: 'r', ...(o.flow === false ? {} : recordFile(activeRecord(o.record))), ...o.files } })
}
const check = (h: ReturnType<typeof world>['host'], tool: string, input: Record<string, unknown>, agentId?: string) => checkVerdict(h, { tool, input, ...(agentId ? { agentId } : {}) })

describe('flow-live: tool.check', () => {
  test('outside flow every call passes and no git runs', async () => {
    const w = world({ flow: false })
    expect(await check(w.host, 'Write', { file_path: `${HOME}/.gitconfig`, content: 'x' })).toBeNull()
    expect(await check(w.host, 'Bash', { command: 'git push', dangerouslyDisableSandbox: true })).toBeNull()
    expect(w.runs.some(r => r.includes('rev-parse'))).toBe(false)
  })

  test('a flow of another repository leaves this one alone', async () => {
    const w = world({ record: { repoKey: 'ffffffff' } })
    expect(await check(w.host, 'Write', { file_path: `${HOME}/.gitconfig`, content: 'x' })).toBeNull()
  })

  test('in flow a write outside the project is denied and one inside it passes', async () => {
    const w = world()
    expect(await check(w.host, 'Write', { file_path: `${HOME}/.gitconfig`, content: 'x' })).toContain('outside the project')
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toBeNull()
    expect(await check(w.host, 'WebFetch', { url: 'https://example.com' })).toContain('not on the flow allow-list')
  })

  test('the mod\'s own tools pass in flow', async () => {
    const w = world()
    expect(await check(w.host, 'mcp__snagon-dev-mods__flow_status', {})).toBeNull()
    expect(await check(w.host, 'mcp__other__tool', {})).toContain('not on the flow MCP list')
  })

  test('before any loop reported its permission mode only reads pass', async () => {
    const w = world({ mode: null })
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toContain('was not reported')
    expect(await check(w.host, 'Read', { file_path: `${ROOT}/src/a.ts` })).toBeNull()
  })

  test('a subagent runs under its own reported mode, else under the main loop\'s', async () => {
    const w = world()
    noteMode('agent-1', 'bypassPermissions')
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' }, 'agent-1')).toContain('bypassPermissions')
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' }, 'agent-2')).toBeNull()
    noteMode(undefined, 'bypassPermissions')
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' }, 'agent-2')).toContain('bypassPermissions')
  })

  test('an unreadable record makes the repository read-only', async () => {
    const w = world({ files: { [versionPath(HOME, 'deadbeef', 1)]: '{not json' } })
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toContain('cannot be read')
    expect(await check(w.host, 'Read', { file_path: `${ROOT}/src/a.ts` })).toBeNull()
  })

  test('git that cannot name a repository with a .git folder is unknown, not off', async () => {
    const w = world({ git: false })
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toContain('git could not name')
  })

  test('bypassPermissions gets reads only', async () => {
    const w = world({ mode: 'bypassPermissions' })
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toContain('bypassPermissions')
    expect(await check(w.host, 'Read', { file_path: `${ROOT}/src/a.ts` })).toBeNull()
  })

  test('a Grep without a path searches from the session\'s cwd (Bash cd moves it)', async () => {
    const w = world({ files: { [`${HOME}/.claude/projects/p/s.jsonl`]: '' } })
    expect(await check(w.host, 'Grep', { pattern: 'x' })).toBeNull()
    w.cd(`${HOME}/.claude`)
    expect(await check(w.host, 'Grep', { pattern: 'x' })).toContain('flow data or transcripts')
  })

  test('CLAUDE_CONFIG_DIR moves the transcripts the guard hides (F41)', async () => {
    const w = world({ claudeDir: `${HOME}/cfg`, files: { [`${HOME}/cfg/projects/p/s.jsonl`]: '' } })
    expect(await check(w.host, 'Read', { file_path: `${HOME}/cfg/projects/p/s.jsonl` })).toContain('flow data or transcripts')
  })

  test('the journal folder frozen at S2 takes *.md files; the rest of .snagon stays protected (F44-A)', async () => {
    const w = world()
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/.snagon/journal/2026-10-17.md`, content: 'x' })).toBeNull()
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/.snagon/flow/x.md`, content: 'x' })).toContain('protected')
  })

  test('after a red judge only the feature\'s Files change; a green one or another feature\'s does not narrow', async () => {
    const red = world({ record: { judge: { tree: 't', green: false, task: 'B3', f: 'F-01', at: 1 } } })
    expect(await check(red.host, 'Write', { file_path: `${ROOT}/README.md`, content: 'x' })).toContain('only this feature\'s Files')
    expect(await check(red.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toBeNull()
    const green = world({ record: { judge: { tree: 't', green: true, task: 'B3', f: 'F-01', at: 1 } } })
    expect(await check(green.host, 'Write', { file_path: `${ROOT}/README.md`, content: 'x' })).toBeNull()
    const older = world({ record: { judge: { tree: 't', green: false, task: 'B3', f: 'F-00', at: 1 } } })
    expect(await check(older.host, 'Write', { file_path: `${ROOT}/README.md`, content: 'x' })).toBeNull()
    const verify = world({ record: { phase: 'verify', task: 'V1', judge: { tree: 't', green: false, task: 'V1', at: 1 } } })
    expect(await check(verify.host, 'Write', { file_path: `${ROOT}/README.md`, content: 'x' })).toContain('only this feature\'s Files')
    expect(await check(verify.host, 'Write', { file_path: `${ROOT}/tests/a.test.ts`, content: 'x' })).toBeNull()
  })

  test('an installed plugin\'s root is never written, even inside the project', async () => {
    const plugins = JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'project', installPath: `${ROOT}/vendor/p` }] } })
    const w = world({ files: { [`${HOME}/.claude/plugins/installed_plugins.json`]: plugins, [`${ROOT}/vendor/p/x.ts`]: '' } })
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/vendor/p/x.ts`, content: 'x' })).toContain(`inside ${ROOT}/vendor/p`)
    const dirs = world({ pluginDirs: `${ROOT}/lib/q`, files: { [`${ROOT}/lib/q/y.ts`]: '' } })
    expect(await check(dirs.host, 'Write', { file_path: `${ROOT}/lib/q/y.ts`, content: 'x' })).toContain(`inside ${ROOT}/lib/q`)
  })

  test('the engine\'s mods folder is a plugin root (plugin-authoring starts hot reload there), also where CLAUDE_CONFIG_DIR moves it', async () => {
    const roots = await pluginRoots(world().host)
    expect(roots).toContain(`${HOME}/.claude/dev-mods`)
    // whether the engine moves its mods folder with CLAUDE_CONFIG_DIR is not known: both spellings are protected
    expect(await pluginRoots(world({ claudeDir: '/cfg' }).host)).toEqual(expect.arrayContaining(['/cfg/dev-mods', `${HOME}/.claude/dev-mods`]))
    // a folder not made yet is placed through its linked parent (the guard compares realpaths)
    expect(await pluginRoots(world({ claudeDir: '/cfg', links: { '/cfg': '/real/cfg' }, files: { '/real/cfg/settings.json': '{}' } }).host)).toContain('/real/cfg/dev-mods')
    // /flow-setup refuses a project inside it, as inside any plugin root
    expect(pluginRootRefusals(roots, { root: `${HOME}/.claude/dev-mods/s-1/my-mod`, allowWrite: [], tempDirs: [] }).map(r => r.root)).toEqual([`${HOME}/.claude/dev-mods`])
  })

  test('Skill passes only what a ticket loads: plugin-authoring in a plugin project; vendored method names (ticket text) are refused', async () => {
    const setup = activeRecord().setup
    if (!setup) throw new Error('fixture has no setup')
    const plugin = world({ record: { setup: { ...setup, pluginProject: true } } })
    expect(await check(plugin.host, 'Skill', { skill: 'plugin-authoring' })).toBeNull()
    expect(await check(plugin.host, 'Skill', { skill: 'code-review-and-quality' })).toContain('not on the flow list')
    const app = world()
    for (const skill of ['plugin-authoring', 'debugging-and-error-recovery']) expect([skill, await check(app.host, 'Skill', { skill })]).toEqual([skill, expect.stringContaining('not on the flow list')])
  })

  test('a file with a second name (hard link) is not written', async () => {
    const w = world({ linkCount: { [`${ROOT}/src/a.ts`]: 2 } })
    expect(await check(w.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toContain('hard link')
  })

  test('Linux compares paths by case; macOS folds them', async () => {
    const linux = world({ os: 'Linux' })
    expect(await check(linux.host, 'Write', { file_path: `${ROOT}/.Claude/x.json`, content: 'x' })).toBeNull()
    expect(await check(linux.host, 'Write', { file_path: `${ROOT}/src/a.ts`, content: 'x' })).toBeNull()
    expect(linux.runs.some(r => r.join(' ') === `/usr/bin/stat -c %h ${ROOT}/src/a.ts`)).toBe(true)
    const mac = world()
    expect(await check(mac.host, 'Write', { file_path: `${ROOT}/.Claude/x.json`, content: 'x' })).toContain('protected')
  })

  test('the S2b window passes the exact Write once and closes on the first call naming the file', async () => {
    const w = world({ files: { [SETTINGS]: PRE } })
    w.setSession({ ...emptySession(), s2b: { path: SETTINGS, post: POST, preHash: await sha256(PRE) } })
    const [a, b] = await Promise.all([check(w.host, 'Write', { file_path: SETTINGS, content: POST }), check(w.host, 'Write', { file_path: SETTINGS, content: POST })])
    expect([a, b].filter(x => x === null)).toHaveLength(1)
    expect(w.session().value?.s2b).toBeNull()
    expect(await check(w.host, 'Write', { file_path: SETTINGS, content: POST })).toContain('protected')
  })

  test('an Edit of the settings file is refused and still closes the window', async () => {
    const w = world({ files: { [SETTINGS]: PRE } })
    w.setSession({ ...emptySession(), s2b: { path: SETTINGS, post: POST, preHash: await sha256(PRE) } })
    expect(await check(w.host, 'Edit', { file_path: SETTINGS, old_string: '{', new_string: '[' })).toContain('never an edit')
    expect(w.session().value?.s2b).toBeNull()
  })
})

describe('flow-live: tool.call', () => {
  test('outside flow the call goes on unchanged and nothing is checked after it', async () => {
    const w = world({ flow: false })
    const live = await liveCall(w.host, { tool: 'Bash', command: 'ls', dangerouslyDisableSandbox: true })
    expect(live.e.dangerouslyDisableSandbox).toBe(true)
    expect(await live.after({ result: 'ok' })).toBeNull()
  })

  test('in flow the sandbox switch is turned off before the call and still denied by the check', async () => {
    const w = world()
    const live = await liveCall(w.host, { tool: 'Bash', command: 'ls', dangerouslyDisableSandbox: true })
    expect(live.e.dangerouslyDisableSandbox).toBe(false)
    expect(await check(w.host, 'Bash', { command: 'ls', dangerouslyDisableSandbox: true })).toContain('sandbox')
  })

  test('a Write whose file holds other text after the call is withheld and blocks the flow as tampered', async () => {
    const w = world()
    const live = await liveCall(w.host, { tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'mine' })
    w.files.set(`${ROOT}/src/a.ts`, 'someone else')
    const reason = await live.after({ result: { type: 'update' } })
    expect(reason).toContain('does not hold the written text')
    const v2 = parseRecord(w.files.get(versionPath(HOME, FLOW_ID, 2)) ?? '')
    expect(v2.blocked?.reason).toBe('tampered')
    expect(v2.blocked?.vars.file).toContain('src/a.ts')
  })

  test('a Write that holds its text after the call goes through', async () => {
    const w = world()
    const live = await liveCall(w.host, { tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'mine' })
    w.files.set(`${ROOT}/src/a.ts`, 'mine')
    expect(await live.after({ result: { type: 'update' } })).toBeNull()
    expect(w.files.has(versionPath(HOME, FLOW_ID, 2))).toBe(false)
  })

  test('a Read whose path became a link into hidden data during the call is withheld', async () => {
    const w = world({ files: { [`${HOME}/.snagon/flow/x.json`]: '{}' } })
    const live = await liveCall(w.host, { tool: 'Read', file_path: `${ROOT}/README.md` })
    w.files.delete(`${ROOT}/README.md`)
    w.links.set(`${ROOT}/README.md`, `${HOME}/.snagon/flow/x.json`)
    expect(await live.after({ result: { type: 'text' } })).toContain('flow data or transcripts')
  })

  test('a denied or failed call is not checked again', async () => {
    const w = world()
    const live = await liveCall(w.host, { tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'mine' })
    expect(await live.after({ deny: 'no' })).toBeNull()
    expect(await live.after({ isError: true, result: 'boom' })).toBeNull()
  })
})
