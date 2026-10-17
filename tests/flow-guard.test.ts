import { describe, expect, test } from 'claude-code/testing'
import { checkCall, placeEdit, stripCall, recheck, recheckRead, viewOf, activeLookup, guardUnknown, screenMcpRefusals, type GuardCtx, type GuardFs, type Verdict } from '../hooks/flow-guard'
import { sha256 } from '../hooks/flow-review'
import { ROUTING } from '../flow/data/routing'
import { TYPESCRIPT } from '../flow/data/stacks'
import type { FlowRecord, ListResult } from '../hooks/flow-state'

const HOME = '/Users/u'
const ROOT = `${HOME}/proj`
const PLUGIN = `${HOME}/.claude/plugins/cache/m/snagon-dev-mods/0.5.2`
const SETTINGS = `${ROOT}/.claude/settings.local.json`
const PRE = '{"permissions":{}}\n'

type Entry = { link: string } | { text: string; links?: number }
/** A file tree keyed by real path (folders implied); links hold absolute targets; names compare as APFS does (checked on
 * macOS: NFC, full case folding, so ſ is s, ß is ss, ς is σ, but the dotless ı stays apart from i) unless fold is off; a
 * realpath keeps the spelling asked, as a case alias does. `fail`: stat throws on paths containing it. */
function fakeFs(entries: Record<string, Entry>, opts: { fold?: boolean; fail?: string } = {}): GuardFs {
  const f = (s: string) => (opts.fold === false ? s : s.normalize('NFC').replace(/[^ı]+/g, x => x.toLowerCase().toUpperCase().toLowerCase()).normalize('NFC'))
  const nodes = new Map<string, Entry | 'dir'>()
  for (const [path, e] of Object.entries(entries)) {
    nodes.set(f(path), e)
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i += 1) { const dir = f(parts.slice(0, i).join('/')); if (!nodes.has(dir)) nodes.set(dir, 'dir') }
  }
  /** The real path; null when missing (ENOENT); undefined when the last part is a link that leads nowhere. */
  const resolve = (path: string, depth = 0): string | null | undefined => {
    let cur = ''
    const parts = path.split('/').filter(Boolean)
    for (const [i, part] of parts.entries()) {
      const node = nodes.get(f(`${cur}/${part}`))
      if (node === undefined) return null
      if (node !== 'dir' && 'link' in node) {
        const to = depth > 8 ? undefined : resolve(node.link, depth + 1)
        if (typeof to !== 'string') return i === parts.length - 1 ? undefined : null
        cur = to
      } else cur = `${cur}/${part}`
    }
    return cur || '/'
  }
  const fileAt = (path: string) => { const n = nodes.get(f(path)); return n && n !== 'dir' && 'text' in n ? n : undefined }
  return {
    async stat(path) {
      if (opts.fail && path.includes(opts.fail)) throw new Error('EIO: device error')
      const r = resolve(path)
      return r === null ? null : r === undefined ? {} : { realPath: r }
    },
    async links(path) { const n = fileAt(path); if (!n) throw new Error(`ENOENT: ${path}`); return n.links ?? 1 },
    async read(path) { const r = resolve(path); return r ? fileAt(r)?.text ?? null : null },
  }
}

const TREE: Record<string, Entry> = {
  [`${ROOT}/src/b.ts`]: { text: 'b' },
  [`${ROOT}/src/h.ts`]: { text: 'h', links: 2 },
  [`${ROOT}/packages/lib/x.ts`]: { text: 'x' },
  [`${ROOT}/lib`]: { link: `${ROOT}/packages/lib` },
  [`${ROOT}/out`]: { link: '/private/tmp/x' },
  ['/private/tmp/x/keep']: { text: '' },
  ['/private/tmp/proj/src/a.ts']: { text: '' },
  ['/tmp']: { link: '/private/tmp' },
  [`${ROOT}/ghost`]: { link: '/nowhere/x' },
  [`${ROOT}/rec`]: { link: `${HOME}/.snagon/flow` },
  [`${HOME}/.snagon/flow/abcd1234.v1.json`]: { text: '{}' },
  [`${HOME}/.snagon/config.json`]: { text: '{}' },
  [`${HOME}/.claude/projects/p/s.jsonl`]: { text: '' },
  [`${HOME}/.gitconfig`]: { text: '' },
  [SETTINGS]: { text: PRE },
  [`${PLUGIN}/hooks/register.ts`]: { text: '' },
  ['/etc']: { link: '/private/etc' },
  ['/private/etc/hosts']: { text: '' },
  [`${HOME}/.snagon/flow2/a.json`]: { text: '' },
  [`${ROOT}/.snagon/flow/setup-draft.md`]: { text: '' },
  [`/System/Volumes/Data${ROOT}/src/b.ts`]: { text: 'b' }, // a firmlink spelling: a path of its own, not a link
  ['/.vol/16777220/2']: { text: '{}' }, // file-id spellings of hidden files: they exist and keep their own spelling
  [`/.nofollow${HOME}/.claude/projects/p/s.jsonl`]: { text: '' },
}

const ctxOf = (over: Partial<GuardCtx> = {}): GuardCtx => ({
  root: ROOT, rootAliases: [ROOT], cwd: ROOT, home: HOME, caseFold: true,
  allowTools: ROUTING.allowTools, allowMcp: ['mcp__github__get_issue', 'mcp__computer-use__screenshot', 'mcp__playwright__browser_take_screenshot'],
  modTools: ['mcp__snagon-dev-mods__flow_status'], skills: ['code-review-and-quality', 'snagon-dev-mods:code-review-and-quality'],
  freeSpawn: ROUTING.freeSpawn, protectedRoots: [PLUGIN, `${ROOT}/vendor/plug`], publish: TYPESCRIPT.publish, fs: fakeFs(TREE), ...over,
})
const verdict = (tool: string, input: unknown, over: Partial<GuardCtx> = {}, agentId?: string): Promise<Verdict> =>
  checkCall({ tool, input, ...(agentId ? { agentId } : {}) }, ctxOf(over))
const decided = async (tool: string, input: unknown, over: Partial<GuardCtx> = {}): Promise<string> => (await verdict(tool, input, over)).decision
const reasonOf = (v: Verdict): string => (v.decision === 'deny' ? v.reason : '')
const short = (v: Verdict): [string, boolean] => [v.decision, v.closeS2b === true]
const write = (file_path: string, over: Partial<GuardCtx> = {}) => decided('Write', { file_path, content: 'x' }, over)

describe('flow guard: Edit-family writes (plan §2.3)', () => {
  test('writes land only under the root and outside the protected set, by any spelling', async () => {
    for (const p of [`${ROOT}/src/a.ts`, `${ROOT}/src/new/deep/a.ts`, `${ROOT}/pkg/docs/flow/verify.md`, `${ROOT}/.gıt/x.ts`]) expect([p, await write(p)]).toEqual([p, 'pass']) // APFS keeps ı apart: .gıt is not .git
    // a relative path lands where Bash last cd'ed (perhaps .git), not where the guard would place it
    for (const p of ['src/a.ts', 'hooks/pre-commit', './x.ts']) expect([p, await write(p)]).toEqual([p, 'deny'])
    expect(reasonOf(await verdict('Write', { file_path: 'hooks/pre-commit', content: '' }))).toContain('absolute path')
    expect(await decided('Edit', { file_path: `${ROOT}/src/b.ts`, old_string: 'b', new_string: 'c' })).toBe('pass')
    expect(await decided('NotebookEdit', { notebook_path: `${ROOT}/n.ipynb`, new_source: '' })).toBe('pass')
    const denied = [
      `${ROOT}/.Claude/settings.json`, `${ROOT}/.claude/agents/x.md`, `${ROOT}/pkg/.git/config`, `${ROOT}/.git`, `${ROOT}/.config/git/ignore`,
      `${ROOT}/.snagon/flow/setup-draft.md`, `${ROOT}/docs/flow/verify.md`, `${ROOT}/DOCS/Flow/Verify.md`, `${ROOT}/a/.bashrc`, `${ROOT}/.mcp.json`,
      `${ROOT}/.husky/pre-commit`, `${ROOT}/vendor/plug/x.ts`, `${PLUGIN}/hooks/register.ts`, `${HOME}/.gitconfig`, '~/.gitconfig', '~/.ssh/config',
      `${HOME}/.snagon/flow/abcd1234.v2.json`, '~/.snagon/flow/abcd1234.v2.json', '/private/tmp/x/keep', '~other/x', '/.vol/16777220/2',
      `${ROOT}/.huſky/pre-commit`, `${ROOT}/.CLAUDE/settings.json`, `/System/Volumes/Data${ROOT}/src/a.ts`, `${ROOT}/src/a\u0000.ts`,
    ]
    for (const p of denied) expect([p, await write(p)]).toEqual([p, 'deny'])
    expect(await decided('NotebookEdit', { notebook_path: `${ROOT}/.claude/x.ipynb`, new_source: '' })).toBe('deny')
    expect(await decided('MultiEdit', { file_path: `${ROOT}/.git/config`, edits: [] })).toBe('deny')
  })

  test('NFD and case spellings of the root and of protected names are one place on macOS; Linux compares exactly', async () => {
    const vi = `${HOME}/Dự án`, nfd = vi.normalize('NFD')
    const tree = { [`${vi}/src/a.ts`]: { text: '' }, [`${vi}/plug/p.ts`]: { text: '' } }
    const mac = { root: vi, rootAliases: [vi], cwd: vi, protectedRoots: [`${vi}/plug`], fs: fakeFs(tree) }
    expect(await write(`${nfd}/src/a.ts`, mac)).toBe('pass')
    expect(await write(`${nfd}/.CLAUDE/x.json`, mac)).toBe('deny')
    expect(await write(`${nfd}/PLUG/p.ts`, mac)).toBe('deny')
    expect(await write(`${nfd}/src/a.ts`, { ...mac, caseFold: false, fs: fakeFs(tree, { fold: false }) })).toBe('deny')
    // APFS keeps the dotless ı apart from i: `kıt` is another folder than the root `kit`, whether or not it exists
    const kit = `${HOME}/dev/kit`, other = `${HOME}/dev/kıt`
    const kitCtx = { root: kit, rootAliases: [kit], cwd: kit, fs: fakeFs({ [`${kit}/a.ts`]: { text: '' } }) }
    expect(await write(`${kit}/b.ts`, kitCtx)).toBe('pass')
    expect(await write(`${other}/b.ts`, kitCtx)).toBe('deny')
    expect(await write(`${other}/b.ts`, { ...kitCtx, fs: fakeFs({ [`${kit}/a.ts`]: { text: '' }, [`${other}/a.ts`]: { text: '' } }) })).toBe('deny')
    // a case-sensitive APFS volume: the guard folds, the disk does not, so `kit` is not the root `Kit` (not there as written)
    const upper = `${HOME}/dev/Kit`
    const sensitive = { root: upper, rootAliases: [upper], cwd: upper, fs: fakeFs({ [`${upper}/a.ts`]: { text: '' } }, { fold: false }) }
    expect(await write(`${upper}/b.ts`, sensitive)).toBe('pass')
    expect(await write(`${HOME}/dev/kit/b.ts`, sensitive)).toBe('deny')
    const sibling = fakeFs({ [`${upper}/a.ts`]: { text: '' }, [`${HOME}/dev/kit/a.ts`]: { text: '' } }, { fold: false }) // another folder, there
    expect(await write(`${HOME}/dev/kit/b.ts`, { ...sensitive, fs: sibling })).toBe('deny')
  })

  test('a path through a link is refused (under the root it names the real path); a broken link leads nowhere; odd spellings and hard links are refused', async () => {
    const viaLink = await verdict('Write', { file_path: `${ROOT}/lib/y.ts`, content: '' })
    expect([viaLink.decision, reasonOf(viaLink).includes(`${ROOT}/packages/lib/y.ts`)]).toEqual(['deny', true])
    for (const p of [`${ROOT}/out/keep`, `${ROOT}/rec/abcd1234.v2.json`, `${ROOT}/ghost`, `${ROOT}/ghost/x.ts`]) expect([p, await write(p)]).toEqual([p, 'deny'])
    const tmp = { root: '/private/tmp/proj', rootAliases: ['/private/tmp/proj', '/tmp/proj'], cwd: '/tmp/proj' } // /tmp → /private/tmp
    for (const p of ['/tmp/proj/src/a.ts', '/private/tmp/proj/src/c.ts']) expect([p, await write(p, tmp)]).toEqual([p, 'pass'])
    // a root spelling that is itself a link Bash could re-point (not a system link) is not trusted
    const w = fakeFs({ ...TREE, ['/private/tmp/w']: { link: ROOT } })
    expect(await write('/private/tmp/w/src/a.ts', { rootAliases: [ROOT, '/private/tmp/w'], fs: w })).toBe('deny')
    for (const p of [`${ROOT}/src/../.claude/x`, `${ROOT}/src/../x.ts`, `${ROOT}/./src/a.ts`, `${ROOT}//src/a.ts`, `${ROOT}/src/`, '//srv/share/a', ''])
      expect([p, await write(p)]).toEqual([p, 'deny'])
    expect(reasonOf(await verdict('Write', { file_path: `${ROOT}//src/a.ts`, content: '' }))).toContain('empty, "." or ".."')
    expect(reasonOf(await verdict('Write', { file_path: ROOT, content: '' }))).toContain('outside the project')
    expect(await decided('Edit', { file_path: `${ROOT}/src/h.ts`, old_string: 'h', new_string: 'i' })).toBe('deny') // another name may be protected
    expect(await decided('Write', { content: 'x' })).toBe('deny')
  })

  test('S2b: one Write of exactly the approved text while the file still holds pre; every call to that path closes the window', async () => {
    const post = '{\n  "permissions": {},\n  "sandbox": {\n    "enabled": true\n  }\n}\n'
    const s2b = { path: SETTINGS, post, preHash: await sha256(PRE) }
    expect(await verdict('Write', { file_path: SETTINGS, content: post }, { s2b })).toEqual({ decision: 'pass', closeS2b: true })
    expect(short(await verdict('Write', { file_path: `${ROOT}/.CLAUDE/settings.local.json`, content: post }, { s2b }))).toEqual(['pass', true])
    const hooks = post.replace('"sandbox"', '"hooks": {},\n  "sandbox"')
    expect(short(await verdict('Write', { file_path: SETTINGS, content: hooks }, { s2b }))).toEqual(['deny', true])
    expect(short(await verdict('Write', { file_path: SETTINGS, content: post, extra: 1 }, { s2b }))).toEqual(['deny', true])
    expect(short(await verdict('Edit', { file_path: SETTINGS, old_string: '{', new_string: '{' }, { s2b }))).toEqual(['deny', true])
    expect(short(await verdict('MultiEdit', { file_path: SETTINGS, edits: [] }, { s2b }))).toEqual(['deny', true])
    expect(short(await verdict('Edit', { file_path: SETTINGS, content: post }, { s2b }))).toEqual(['deny', true])
    const dangling = fakeFs({ ...TREE, [SETTINGS]: { link: '/nowhere/settings.json' } }) // cannot be placed, yet named by its path
    expect(short(await verdict('Write', { file_path: SETTINGS, content: post }, { fs: dangling, s2b }))).toEqual(['deny', true])
    expect(short(await verdict('Write', { file_path: SETTINGS, content: post }, { s2b: { ...s2b, preHash: await sha256('{}') } }))).toEqual(['deny', true])
    const absent = fakeFs({ [`${ROOT}/src/b.ts`]: { text: '' } })
    expect(short(await verdict('Write', { file_path: SETTINGS, content: post }, { fs: absent, s2b: { ...s2b, preHash: null } }))).toEqual(['pass', true])
    expect(short(await verdict('Write', { file_path: SETTINGS, content: post }))).toEqual(['deny', false]) // window closed: a second Write
    expect(short(await verdict('Write', { file_path: `${ROOT}/src/a.ts`, content: '' }, { s2b }))).toEqual(['pass', false])
  })

  test('red scope: while the last B3 is red, only that feature\'s Files may change', async () => {
    const red = { redScope: ['src/a.ts', 'tests/a.test.ts'] }
    expect(await write(`${ROOT}/src/a.ts`, red)).toBe('pass')
    expect(await decided('Edit', { file_path: `${ROOT}/SRC/A.ts`, old_string: 'a', new_string: 'b' }, red)).toBe('pass')
    expect(await decided('Edit', { file_path: `${ROOT}/src/b.ts`, old_string: 'b', new_string: 'c' }, red)).toBe('deny')
  })

  test('F44-A: *.md files directly inside the frozen journalDir may change; every other .snagon path stays protected', async () => {
    const J = `${ROOT}/.snagon/journal`
    const fs = fakeFs({
      ...TREE, [`${J}/2026-10-16.md`]: { text: '' }, [`${J}/h.md`]: { text: '', links: 2 }, [`${J}/l.md`]: { link: `${ROOT}/src/b.ts` },
      [`${ROOT}/notes/x.md`]: { text: '' }, [`${ROOT}/.snagon/j2`]: { link: `${ROOT}/notes` },
    })
    const jc = (over: Partial<GuardCtx> = {}): Partial<GuardCtx> => ({ journalDir: '.snagon/journal', fs, ...over })
    for (const p of [`${J}/2026-10-17.md`, `${J}/2026-10-16.md`, `${ROOT}/.SNAGON/Journal/x.MD`]) expect([p, await write(p, jc())]).toEqual([p, 'pass'])
    expect(await decided('Edit', { file_path: `${J}/2026-10-16.md`, old_string: 'a', new_string: 'b' }, jc())).toBe('pass')
    expect(await decided('MultiEdit', { file_path: `${J}/2026-10-16.md`, edits: [] }, jc())).toBe('pass')
    expect(await write(`${J}/2026-10-17.md`, jc({ redScope: ['src/a.ts'] }))).toBe('pass') // the journal is not the work (it is outside the tree)
    const refused = [
      `${J}/sub/x.md`, `${J}/x.txt`, `${J}/x.md.bak`, `${J}/.md`, J, `${ROOT}/.snagon/x.md`, `${ROOT}/.snagon/flow/setup-draft.md`, `${ROOT}/.snagon/handoff/x.md`,
      `${J}/h.md`, `${J}/l.md`, `${ROOT}/.snagon/j2/x.md`, `${J}/./x.md`, `${ROOT}/.snagon/x/../journal/x.md`, `${ROOT}/.snagon//journal/x.md`, `${ROOT}/x/.snagon/journal/x.md`,
    ]
    for (const p of refused) expect([p, await write(p, jc())]).toEqual([p, 'deny'])
    expect(await write(`${ROOT}/.snagon/j2/x.md`, jc({ journalDir: '.snagon/j2' }))).toBe('deny') // a journalDir that is a link
    expect(await write(`${J}/x.md`)).toBe('deny') // no journalDir: nothing in .snagon changes
    // only the .snagon protection gives way: a journalDir in or under another protected name stays protected
    for (const [journalDir, p] of [['.snagon/.git', `${ROOT}/.snagon/.git/x.md`], ['.snagon/.husky', `${ROOT}/.snagon/.husky/x.md`], ['.claude/journal', `${ROOT}/.claude/journal/x.md`], ['docs/flow', `${ROOT}/docs/flow/verify.md`]] as const)
      expect([journalDir, await write(p, jc({ journalDir }))]).toEqual([journalDir, 'deny'])
    // a journalDir that is not a plain root-relative path frees nothing
    for (const journalDir of ['', '/.snagon/journal', '.snagon/journal/', '.snagon//journal', './.snagon/journal', '.snagon/x/../journal', `${ROOT}/.snagon/journal`])
      expect([journalDir, await write(`${J}/x.md`, jc({ journalDir }))]).toEqual([journalDir, 'deny'])
    expect(reasonOf(await verdict('Write', { file_path: `${J}/sub/x.md`, content: '' }, jc()))).toContain('protected (.snagon)')
    expect(await write(`${ROOT}/notes/y.md`, jc({ journalDir: 'notes', redScope: ['src/a.ts'] }))).toBe('pass') // a gitignored journalDir outside .snagon
    expect(await write(`${ROOT}/notes/y.ts`, jc({ journalDir: 'notes', redScope: ['src/a.ts'] }))).toBe('deny')
    expect(await write(`${ROOT}/ab.md`, jc({ journalDir: 'ab.m', redScope: ['src/a.ts'] }))).toBe('deny') // a file at the root is in no folder
  })

  test('tool.call places the target again after the call: a new link, another place or a second name is a change', async () => {
    const before = await placeEdit(`${ROOT}/src/a.ts`, ctxOf())
    if (typeof before === 'string') throw new Error(before)
    const made = ctxOf({ fs: fakeFs({ ...TREE, [`${ROOT}/src/a.ts`]: { text: 'new' } }) })
    expect(await recheck(before, made)).toBeNull() // the Write made it
    expect(await recheck(before, made, 'new')).toBeNull()
    expect(await recheck(before, made, 'other')).toContain('written text')
    expect(await recheck(before, ctxOf())).toContain('gone') // written through a link swapped in, then removed
    const swapped = fakeFs({ [`${ROOT}/src`]: { link: `${HOME}/.snagon/flow` }, [`${HOME}/.snagon/flow/x`]: { text: '' } })
    expect(await recheck(before, ctxOf({ fs: swapped }))).toContain(`${ROOT}/src/a.ts`)
    expect(await recheck(before, ctxOf({ fs: fakeFs({ ...TREE, [`${ROOT}/src/a.ts`]: { text: 'hook', links: 2 } }) }))).toContain('second name')
    expect(await recheck(before, ctxOf({ fs: fakeFs(TREE, { fail: '/src' }) }))).toContain('could not be checked')
    expect(await recheck({ ...before, real: `${HOME}/.snagon/flow/a.ts` }, ctxOf())).toContain(`${HOME}/.snagon/flow/a.ts`)
  })
})

describe('flow guard: tools, MCP, Bash, Agent and Skill', () => {
  test('a tool not on the list is refused with the way to add it; the proposed extras and the mod\'s own tools pass', async () => {
    for (const tool of ['WebFetch', 'WebSearch', 'SendMessage', 'CronCreate', 'EnterWorktree', 'Artifact', 'Workflow', 'LSP', 'RemoteTrigger']) {
      const v = await verdict(tool, {})
      expect([tool, v.decision, reasonOf(v).includes(`/flow-setup tools=+${tool}`)]).toEqual([tool, 'deny', true])
    }
    for (const tool of ['TodoWrite', 'ToolSearch', 'AskUserQuestion', 'mcp__snagon-dev-mods__flow_status']) expect([tool, await decided(tool, {})]).toEqual([tool, 'pass'])
    expect(await decided('WebFetch', { url: 'https://example.com' }, { allowTools: [...ROUTING.allowTools, 'WebFetch'] })).toBe('pass')
  })

  test('MCP tools need their exact name on the list; screen tools are refused even when listed (F39); inputs naming flow data are refused (F21)', async () => {
    expect(await decided('mcp__github__get_issue', { owner: 'o', repo: 'r', issue_number: 1 })).toBe('pass')
    for (const tool of ['mcp__github__push_files', 'mcp__github__get_issue_x', 'mcp__GitHub__get_issue', 'mcp__computer-use__screenshot', 'mcp__playwright__browser_take_screenshot'])
      expect([tool, await decided(tool, {})]).toEqual([tool, 'deny'])
    const named = [
      '~/.snagon/flow/a.v2.json', `${ROOT}/.snagon/memory/memory.jsonl`, `${HOME}/.claude/projects/p/s.jsonl`, 'C:\\Users\\u\\.snagon\\flow\\a.json',
      '~/.ſnagon/flow/x.json', '~/.claude/./projects/a', '~/.claude/x/../projects/a', 'file:///Users/u/%2Esnagon/flow/a', '~/.Claude/Projects/a',
      'C:\\Users\\u\\.claude\\projects\\a.jsonl',
    ]
    for (const path of named) expect([path, await decided('mcp__github__get_issue', { body: { nested: [path] } })]).toEqual([path, 'deny'])
    expect(await decided('mcp__github__get_issue', { body: 'a .snagonrc file and %E0 text' })).toBe('pass')
    expect(await decided('mcp__github__get_issue', { body: { '~/.snagon/flow/a.json': 'x' } })).toBe('deny') // a key names it
    for (const cmd of ['tar czf /tmp/x.tgz ~/.snagon && cat /tmp/x.tgz', '--dir=.snagon/flow', 'cd ~/.snagon; cat flow/a.json'])
      expect([cmd, await decided('mcp__github__get_issue', { cmd })]).toEqual([cmd, 'deny'])
    // a path above a hidden folder lets a file-system server walk into it
    for (const path of [`${HOME}/.claude`, '~', '/', `/System/Volumes/Data${HOME}`]) expect([path, await decided('mcp__github__get_issue', { path })]).toEqual([path, 'deny'])
    expect(await decided('mcp__github__get_issue', { path: `${HOME}/cc` }, { claudeDir: `${HOME}/cc` })).toBe('deny') // CLAUDE_CONFIG_DIR
    for (const path of [`${ROOT}/src`, 'src/x.ts', 'README.md']) expect([path, await decided('mcp__github__get_issue', { path })]).toEqual([path, 'pass'])
    expect(screenMcpRefusals(['mcp__github__get_issue', 'mcp__computer-use__left_click', 'mcp__x__take_screenshot', 'mcp__remote-devices__computer_batch', 'mcp__x__screencast_start']))
      .toEqual(['mcp__computer-use__left_click', 'mcp__x__take_screenshot', 'mcp__remote-devices__computer_batch', 'mcp__x__screencast_start'])
  })

  test('Bash: only its four keys (the sandbox stays on); no git publishing, publish verbs or screen capture; plain work passes', async () => {
    const bash = (command: string, extra: Record<string, unknown> = {}) => decided('Bash', { command, ...extra })
    for (const c of ['npm test', 'npx vitest run', 'npm install', 'npm run build', 'git status', 'git commit -m "fix: guard"', 'git log --oneline -5', 'ls -la src', 'npm run publish-docs', 'npm install publish'])
      expect([c, await bash(c)]).toEqual([c, 'pass'])
    expect(await bash('ls', { description: 'List', timeout: 1000, run_in_background: false, dangerouslyDisableSandbox: false })).toBe('pass')
    for (const extra of [{ dangerouslyDisableSandbox: true }, { allowedDomains: ['evil.example'] }, { sandbox: false }]) expect([extra, await bash('ls', extra)]).toEqual([extra, 'deny'])
    const denied = [
      'git push', 'A=1 git push origin main', 'git -c alias.p=push p origin main', 'GIT_CONFIG_COUNT=1 git p', 'git p origin main', 'git subtree push --prefix lib origin main',
      'sh -c "git push origin main"', 'git -C ../other commit -m x', 'git lfs ls-files',
      'npm publish', 'pnpm --filter pkg publish', 'yarn npm publish', 'npm --workspace pkg publish --tag next', 'npx changeset publish', 'bunx semantic-release',
      "sh -c 'npm publish'", 'n\\pm publish', 'npm dist-tag add pkg@1.0.0 latest', 'cd pkg && npm publish', 'NPM_CONFIG_X=1 npm publish',
      'screencapture -x /tmp/s.png', '/usr/sbin/screencapture /tmp/s.png', "osascript -e 'tell application \"Terminal\" to get contents'", 'sh -c "screencapture x"', "s'c'reencapture x",
      'echo x|npm publish', 'echo $(screencapture -x /tmp/a.png)',
    ]
    for (const c of denied) expect([c, await bash(c)]).toEqual([c, 'deny'])
    expect(await decided('Bash', {})).toBe('deny')
  })

  test('stripCall turns dangerouslyDisableSandbox off before the engine sees a Bash call; other calls are untouched', () => {
    expect(stripCall({ tool: 'Bash', command: 'ls', dangerouslyDisableSandbox: true })).toEqual({ tool: 'Bash', command: 'ls', dangerouslyDisableSandbox: false })
    const plain = { tool: 'Bash', command: 'ls' }
    expect(stripCall(plain)).toBe(plain)
    const other = { tool: 'Read', file_path: '/x', dangerouslyDisableSandbox: true }
    expect(stripCall(other)).toBe(other)
  })

  test('Agent: a subagent starts nothing; a ticket line or a free type passes; name, isolation, team, mode and a ticket\'s effort are refused', async () => {
    expect(await decided('Agent', { prompt: 'TICKET T-1', description: 'r', subagent_type: 'general-purpose' })).toBe('pass')
    expect(await decided('Agent', { prompt: 'map the code', description: 'm', subagent_type: 'Explore', effort: 'low' })).toBe('pass')
    expect(await decided('Task', { prompt: 'TICKET T-2', description: 'r' })).toBe('pass')
    expect((await verdict('Agent', { prompt: 'TICKET T-1', description: 'r' }, {}, 'agent-7')).decision).toBe('deny')
    for (const extra of [{ name: 'x' }, { isolation: 'remote' }, { isolation: 'worktree' }, { team_name: 't' }, { mode: 'bypassPermissions' }, { effort: 'low' }, { cwd: '/tmp' }])
      expect([extra, await decided('Agent', { prompt: 'TICKET T-1', description: 'r', ...extra })]).toEqual([extra, 'deny'])
    const others = [
      { prompt: 'map it', description: 'm' }, { prompt: 'x', description: 'f', subagent_type: 'fork' },
      { prompt: 'please run TICKET T-1', description: 'r', subagent_type: 'Explore' }, { prompt: 'x', description: 'c', subagent_type: 'code-reviewer' },
    ]
    for (const input of others) expect([input, await decided('Agent', input)]).toEqual([input, 'deny'])
  })

  test('Skill: only listed names; flow-* commands are the owner\'s in every spelling, even when listed', async () => {
    expect(await decided('Skill', { skill: 'code-review-and-quality' })).toBe('pass')
    expect(await decided('Skill', { skill: 'snagon-dev-mods:code-review-and-quality', args: 'x' })).toBe('pass')
    for (const skill of ['flow-approve', 'snagon-dev-mods:flow-approve', '/flow-ship', 'FLOW-Approve', 'plugin-authoring', '', 42])
      expect([skill, await decided('Skill', { skill })]).toEqual([skill, 'deny'])
    for (const skill of ['flow-approve', 'snagon-dev-mods:flow-approve', '/flow-ship']) expect([skill, await decided('Skill', { skill }, { skills: [skill] })]).toEqual([skill, 'deny'])
  })
})

describe('flow guard: reads, the flow state and failures', () => {
  test('Read, Glob and Grep never reach the transcripts or the flow record, by any spelling', async () => {
    const open = [
      `${ROOT}/src/b.ts`, '/etc/hosts', `${HOME}/.snagon/config.json`, '~/.snagon/config.json', `${HOME}/.snagon/flow2/a.json`, `${ROOT}/.snagon/flow/setup-draft.md`,
      `/System/Volumes/Data${ROOT}/src/b.ts`, HOME, '/tmp/proj/src/a.ts',
    ]
    for (const p of open) expect([p, await decided('Read', { file_path: p })]).toEqual([p, 'pass'])
    const hidden = [
      `${HOME}/.claude/projects/p/s.jsonl`, '~/.snagon/flow/abcd1234.v1.json', `${ROOT}/../.snagon/flow/abcd1234.v1.json`, `${ROOT}/rec/abcd1234.v1.json`,
      `${HOME}/.Snagon/FLOW/x.json`, `${HOME}/.claude/projects`, '//srv/share/a', 42, '/.vol/16777220/2', `/System/Volumes/Data${HOME}/.snagon/flow/abcd1234.v1.json`,
      `/system/volumes/data${HOME}/.claude/projects/p/s.jsonl`, `${HOME}/.claude/projectſ/p/s.jsonl`, '~/.ſnagon/flow/x.json',
      'src/b.ts', `/.nofollow${HOME}/.claude/projects/p/s.jsonl`, `/.resolve/1${HOME}/.snagon/flow/abcd1234.v1.json`, `${ROOT}/lib/x.ts`,
      `${ROOT}/missing.ts`, `${ROOT}/src/./b.ts`, `${ROOT}/src/../src/b.ts`, `${ROOT}//src/b.ts`, // not there yet (a link may appear), or odd parts
    ]
    for (const p of hidden) expect([p, await decided('Read', { file_path: p })]).toEqual([p, 'deny'])
    expect(await decided('Read', { file_path: `${HOME}/.snagon/flow/abcd1234.v1.json` }, { home: `/System/Volumes/Data${HOME}` })).toBe('deny')
    expect(await decided('Read', { file_path: '~/.claude/projects/p/s.jsonl' }, { home: `${HOME}/` })).toBe('deny')
    expect(await decided('Read', { file_path: '~/.snagon/config.json' }, { home: `${HOME}/` })).toBe('pass')
    expect(await decided('Read', { file_path: `${HOME}/cc/projects/p/s.jsonl` }, { claudeDir: `${HOME}/cc` })).toBe('deny') // CLAUDE_CONFIG_DIR
    expect(reasonOf(await verdict('Read', { file_path: '~/a\u0000b' }))).toContain('NUL')
    expect(await decided('Read', { file_path: `${ROOT}/ghost` })).toBe('deny')
    expect(reasonOf(await verdict('Read', { file_path: '~/.snagon/flow/none.v9.json' }))).toContain('flow data') // not "does not exist"
    expect(reasonOf(await verdict('Read', { file_path: `${ROOT}/src/./b.ts` }))).toContain('empty, "." or ".."')
    // a link can be re-pointed by background Bash between the check and the read: read by the real path instead
    expect(reasonOf(await verdict('Read', { file_path: `${ROOT}/lib/x.ts` }))).toContain(`${ROOT}/packages/lib/x.ts`)
    expect(await decided('Glob', { pattern: '**/*.ts' })).toBe('pass')
    expect(await decided('Grep', { pattern: 'x', path: ROOT })).toBe('pass')
    expect(await decided('Grep', { pattern: 'x', path: `${ROOT}/src` })).toBe('pass')
    expect(await decided('Grep', { pattern: 'x', path: `${ROOT}/src/` })).toBe('pass')
    expect(await decided('Glob', { pattern: `${ROOT}/src/*.ts` })).toBe('pass')
    // a search goes below where it starts (the session folder when no path is given): never at or above a hidden folder
    const searches: Array<[string, Record<string, unknown>]> = [
      ['Glob', { pattern: `${HOME}/.snagon/flow/*.json` }], ['Glob', { pattern: '*.json', path: '~/.snagon/flow' }], ['Grep', { pattern: 'a', path: `${HOME}/.claude/projects` }],
      ['Grep', { pattern: 'approv', path: HOME }], ['Grep', { pattern: 'x', path: `${HOME}/.snagon` }], ['Grep', { pattern: 'x', path: '/' }],
      ['Glob', { pattern: '**/*.jsonl', path: `${HOME}/.claude` }], ['Glob', { pattern: `${HOME}/.snag*/flow/*.json` }], ['Glob', { pattern: '../../.snagon/flow/*' }],
      ['Grep', { pattern: 'x', path: `/System/Volumes/Data${HOME}` }], ['Grep', { pattern: 'x', path: '/System/Volumes/Data' }], ['Grep', { pattern: 'x', path: '/System/Volumes' }],
      ['Grep', { pattern: 'x', path: '/System' }], ['Glob', { pattern: '/System/Volumes/D*/Users/*/.claude/projects/**' }], ['Grep', { pattern: 'x', path: 'src' }],
      ['Grep', { pattern: 'x', path: `${ROOT}/lib` }],
    ]
    for (const [tool, input] of searches) expect([tool, input, await decided(tool, input)]).toEqual([tool, input, 'deny'])
    // no path: the search starts where the session stands now (Bash cd moves it)
    expect(await decided('Grep', { pattern: 'x' }, { cwd: HOME })).toBe('deny')
    expect(await decided('Glob', { pattern: '**/*.json' }, { cwd: `${HOME}/.snagon` })).toBe('deny')
  })

  test('after a read, its start is checked again: a link that appeared during the call withholds the result', async () => {
    const before = { ...TREE, [`${ROOT}/d/s.jsonl`]: { text: '' } }
    const call = { tool: 'Read', input: { file_path: `${ROOT}/d/s.jsonl` } }
    expect(await decided('Read', call.input, { fs: fakeFs(before) })).toBe('pass')
    expect(await recheckRead(call, ctxOf({ fs: fakeFs(before) }))).toBeNull()
    const after = fakeFs({ ...TREE, [`${ROOT}/d`]: { link: `${HOME}/.claude/projects/p` }, [`${HOME}/.claude/projects/p/s.jsonl`]: { text: 'secret' } })
    expect(await recheckRead(call, ctxOf({ fs: after }))).toContain('transcripts')
    expect(await recheckRead({ tool: 'Grep', input: { pattern: 'x', path: `${ROOT}/d` } }, ctxOf({ fs: after }))).toContain('transcripts')
    expect(await recheckRead(call, ctxOf({ fs: fakeFs(TREE, { fail: '/d' }) }))).toContain('EIO')
  })

  test('F47-A: nothing runs in the background while flow is active: run_in_background, a & that backgrounds, the background wrappers', async () => {
    const bash = (command: string, extra: Record<string, unknown> = {}) => verdict('Bash', { command, ...extra })
    for (const on of [true, 'true', 1]) {
      const v = await bash('npm test', { run_in_background: on })
      expect([on, v.decision, reasonOf(v).includes('F47-A')]).toEqual([on, 'deny', true])
    }
    const denied = [
      'npm run dev &', 'npm run dev & npx vitest run', 'perl -e 1 >/dev/null 2>&1 &', 'npm run dev&', '(npm run dev &)', 'x=$(npm run dev &)',
      'echo `npm run dev &`', 'echo "$(npm run dev &)"', 'curl http://h/?a=1&b=2', 'ls\nnpm run dev &', 'coproc npm run dev', 'setsid npm run dev',
      'setsid -f npm run dev', '/usr/bin/setsid -f npm run dev', 'nohup npm test &', 'tmux new -d npm run dev', 'screen -dm npm run dev', 'echo "a \\\\" & b', 'echo $\'a\' & b',
      "true # don't wait\nnpm run dev &", 'true # say "hi\nnpm run dev &', "echo $'\\''; npm run dev &", "true a\\ #x ; npm run dev &", 'perl -e 1 \\>& true',
      "echo \\$'a\\' & npm run dev & echo 'b'", "eval 'npm run dev &'", 'bash -c "npm run dev &"', "/bin/zsh -c 'npm run dev &'", "sh <<'X'\nnpm run dev &\nX",
      "find . -exec sh -c 'npm run dev &' \;", 'xargs setsid -f npm run dev', 'sudo -u bob setsid -f npm run dev', 'find . -exec tmux new -d x \;',
      'if true; then setsid -f npm run dev; fi', 'NODE_ENV=x setsid -f npm run dev', 'time setsid -f npm run dev',
      'echo $(true)#x; npm run dev &', "eval 'a \\>& b'", "eval 'a \\&>x'", 'echo $((1))#x; npm run dev &', 'x="$(cd "/tmp"; npm run dev >/dev/null 2>&1 &)"',
      'echo "$(echo "" & npm run dev >/dev/null & echo "")"', '>/dev/null tmux new -d x', 'X="a b" screen -dm x', '/usr/bin/time tmux new -d x',
      'arch -arm64 tmux new -d x', 'script -q /dev/null screen -dm x', 'time -p tmux new -d x', "$'tmux' new -d x",
      "eval npm run dev \\>/dev/null 2\\>\\&1 \\&", "bash -c npm\\ run\\ dev\\ \\&", "eval 'a &\\& b'", "trap 'npm run dev &' EXIT; true",
      ". /dev/stdin <<< 'npm run dev &'", "echo 'npm run dev &' | source /dev/stdin", "alias x='npm run dev &'", "watch -n1 'npm run dev &'", "echo $$'a\\' & npm run dev &\necho 'b'", "true # don't\nnpm run dev & # it's", "echo 'abc\nnpm run dev &", 'echo "abc\nnpm run dev &',
    ]
    for (const c of denied) {
      const v = await bash(c)
      expect([c, v.decision, reasonOf(v).includes('F47-A')]).toEqual([c, 'deny', true])
    }
    const passed = [
      'npm test && npm run build', 'npm test 2>&1 | tail -5', 'npm test &>/dev/null', 'npm test |& tee out.log', 'git commit -m "fix A & B"', "echo 'a & b'",
      'cat <<EOF\na & b\nEOF', 'echo a\\&b', '[[ -f a && -f b ]]', 'ls >&2', 'exec 3<&0', 'echo "a \\" & b"x',
      'nohup npm test', "echo 'it''s & fine'",
      'npm test # a & b', "echo $'a\\'b & c'", 'bash -c "npm test && npm run build"', 'echo ${#x} && ls', 'cat <<EOF > notes.md\nA & B\nEOF', 'echo $# && ls', "echo $$$'a\\' & b'",
    ]
    for (const c of passed) expect([c, (await bash(c)).decision]).toEqual([c, 'pass'])
    // accepted false alarms: a background program named as text; the reason says how to go on
    for (const c of ['grep -rn screen src/', 'rg "tmux" docs', 'git commit -m "fix login screen"', 'ls build/screen']) {
      const v = await bash(c)
      expect([c, v.decision, reasonOf(v).includes('Grep tool')]).toEqual([c, 'deny', true])
    }
  })

  test('F42-A: every Monitor call is refused while flow is active, listed or not; LSP files keep the read rules', async () => {
    const extra = { allowTools: [...ROUTING.allowTools, 'Monitor', 'LSP'] }
    const monitors = [{ description: 'd', timeout_ms: 1000, command: 'tail -f build.log' }, { description: 'd', timeout_ms: 1000, command: 'git push' },
      { description: 'd', timeout_ms: 1000, ws: { url: 'wss://example.com' } }, { description: 'd', timeout_ms: 1000 }, {}]
    for (const over of [extra, {}]) {
      for (const input of monitors) {
        const v = await verdict('Monitor', input, over)
        expect([input, v.decision, reasonOf(v).includes('sandbox'), reasonOf(v).includes('tools=+'), reasonOf(v).includes('run_in_background')]).toEqual([input, 'deny', true, false, false])
      }
    }
    const lsp = (filePath: string) => decided('LSP', { operation: 'documentSymbol', filePath, line: 1, character: 1 }, extra)
    expect(await lsp(`${ROOT}/src/b.ts`)).toBe('pass')
    for (const p of ['~/.claude/projects/p/s.jsonl', 'src/b.ts']) expect([p, await lsp(p)]).toEqual([p, 'deny'])
  })

  test('fail-closed: a thrown error and an input that is not an object deny; bypassPermissions lets only reading through (F26)', async () => {
    const v = await verdict('Write', { file_path: `${ROOT}/src/a.ts`, content: '' }, { fs: fakeFs(TREE, { fail: '/src' }) })
    expect([v.decision, reasonOf(v).includes('EIO')]).toEqual(['deny', true])
    expect(await decided('Bash', 'ls')).toBe('deny')
    expect(await decided('Read', null)).toBe('deny')
    expect(await decided('TodoWrite', null)).toBe('deny')
    const bypass = { permissionMode: 'bypassPermissions' }
    for (const [tool, input, want] of [
      ['Bash', { command: 'ls' }, 'deny'], ['Write', { file_path: `${ROOT}/src/a.ts`, content: '' }, 'deny'], ['Read', { file_path: `${ROOT}/src/b.ts` }, 'pass'],
      ['Read', { file_path: '~/.snagon/flow/abcd1234.v1.json' }, 'deny'], ['mcp__snagon-dev-mods__flow_status', {}, 'pass'], ['TodoWrite', {}, 'pass'],
    ] as const) expect([tool, await decided(tool, input, bypass)]).toEqual([tool, want])
    expect(await decided('Bash', { command: 'ls' }, { permissionMode: 'acceptEdits' })).toBe('pass')
  })

  test('the active flow is looked up through a 5 s cache (F14); an unreadable record or two active flows leave only reading', async () => {
    const rec = { flowId: 'abcd1234' } as FlowRecord
    expect(viewOf({ ok: true, active: [], invalid: [] })).toEqual({ mode: 'off' })
    expect(viewOf({ ok: true, active: [rec], invalid: [] })).toEqual({ mode: 'on', record: rec })
    const unclear: ListResult[] = [{ ok: true, active: [rec, rec], invalid: [] }, { ok: true, active: [], invalid: ['bad00000'] }, { ok: false, reason: 'io' }]
    for (const list of unclear) expect(viewOf(list).mode).toBe('unknown')
    let loads = 0
    const lookup = activeLookup(async () => { loads += 1; if (loads === 3) throw new Error('EIO'); return { mode: 'off' } })
    await lookup.get(1000)
    await lookup.get(5999)
    expect(loads).toBe(1)
    await lookup.get(6000)
    expect(loads).toBe(2)
    lookup.drop()
    expect((await lookup.get(6001)).mode).toBe('unknown')
    expect(loads).toBe(3)
    const unknown = async (tool: string, input: unknown) => (await guardUnknown({ tool, input }, ctxOf(), 'two active flows')).decision
    expect(await unknown('Read', { file_path: `${ROOT}/src/b.ts` })).toBe('pass')
    expect(await unknown('Read', { file_path: '~/.snagon/flow/abcd1234.v1.json' })).toBe('deny')
    expect(await unknown('mcp__snagon-dev-mods__flow_status', {})).toBe('pass')
    for (const tool of ['Write', 'Bash', 'Agent', 'mcp__github__get_issue']) expect([tool, await unknown(tool, {})]).toEqual([tool, 'deny'])
  })
})
