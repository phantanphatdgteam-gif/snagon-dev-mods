import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { WORKER_SCRIPT } from '../hooks/handoff'
import { INSTALL_SCRIPT } from '../hooks/install'
import { repoKeyOf, versionPath, type FlowRecord } from '../hooks/flow-state'
import { activeRecord, FLOW_ID, gitArgs } from './flow-fakes'
import { sha256 } from '../hooks/flow-review'
import { hashOf, type Io } from '../hooks/session'
import { cfgHash } from '../hooks/flow-git'
import { ENV_LIST_ARGV } from '../hooks/engine-io'

const ROOT = '/host'
const HOME = '/home/u'
const SESSION = { surface: 'terminal', isInteractive: false, cwd: ROOT } as const
const FAKE_TOKEN = 'ghp_' + 'c'.repeat(36)

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ok = (stdout = '', exitCode = 0): Run => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** A small engine: host files under /host, the user's files under /home/u, plugin files keyed from /instructions/, processes scripted. */
function world(on: On, opts: { files?: Record<string, string>; exempt?: boolean; git?: Record<string, string>; tools?: string[]; install?: string; flow?: boolean; record?: Partial<FlowRecord>; calls?: Record<string, unknown>[]; flowGit?: (args: string[]) => Run | undefined; mockClock?: boolean; env?: Record<string, string>; settingsFail?: boolean } = {}) {
  const flowRecord = opts.flow ? { [versionPath(HOME, FLOW_ID, 1)]: JSON.stringify(activeRecord({ root: ROOT, repoKey: repoKeyOf(`${ROOT}/.git`), ...opts.record })), [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n' } : {}
  const files = new Map<string, string>(Object.entries({ ...opts.files, ...flowRecord }))
  const mtimes = new Map<string, number>()
  let clock = 1_000_000
  const appended: string[] = []
  const spawns: string[][] = []
  const toasts: string[] = []
  const logs: string[] = []
  const envs: Array<Record<string, string> | undefined> = []
  const argvs: string[][] = []
  const touch = (p: string) => { clock += 1000; mtimes.set(p, clock) }
  for (const k of files.keys()) touch(k)
  const norm = (p: string) => {
    if (p.startsWith(ROOT) || p.startsWith(HOME)) return p.replace(/\/$/, '')
    for (const mark of ['/local', '/instructions', '/skills']) { const i = p.indexOf(mark); if (i > 0) return p.slice(i).replace(/\/$/, '') }
    return p.replace(/\/$/, '')
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.Stop', () => ({}))
  on('classic.PreCompact', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('session.root', () => ({ value: ROOT as never }))
  on('session.cwd', () => ({ value: ROOT as never }))
  on('env.get', ($, e) => { const name = (e as { name?: string }).name ?? ''; return { value: (name === 'HOME' ? HOME : opts.env?.[name]) as never } })
  on('session.id', () => ({ value: 'sess-1234abcd' as never }))
  on('settings.read', () => (opts.settingsFail ? { deny: 'EACCES: settings' } : { value: {} as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 10 }, rateLimits: [], cost: { usd: 1 } } as never }))
  if (!opts.mockClock) on('clock.now', () => { clock += 1; return { value: clock as never } }) // else the test's mock.clock answers it
  on('ui.log', ($, e) => { logs.push(String((e as { text?: string }).text)); return { value: undefined as never } })
  on('ui.status', () => ({ value: undefined as never }))
  on('ui.toast', ($, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined as never } })
  on('tool.register', ($, e) => { opts.tools?.push(e.name); return { value: { tool: `mcp__snagon-dev-mods__${e.name}` } as never } })
  on('fs.exists', ($, e) => { const p = norm(e.path); return { value: (files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`))) as never } })
  on('fs.read', ($, e) => { const t = files.get(norm(e.path)); return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t as never } })
  on('fs.stat', ($, e) => {
    const p = norm(e.path), dir = [...files.keys()].some(k => k.startsWith(`${p}/`))
    return files.has(p) || dir ? { value: { kind: dir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false, realPath: p } as never } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', ($, e) => { files.set(e.path, e.text); touch(e.path); return { value: undefined as never } })
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    const items = new Map<string, { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }>()
    for (const k of files.keys()) {
      if (!k.startsWith(`${dir}/`)) continue
      const rest = k.slice(dir.length + 1)
      const name = rest.split('/')[0] ?? rest
      const isDir = rest.includes('/')
      items.set(name, { name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : (files.get(k) ?? '').length, mtimeMs: isDir ? 0 : mtimes.get(k) ?? 0, isLink: false })
    }
    return items.size ? { value: [...items.values()] as never } : { deny: `ENOENT: ${e.path}` }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('process.run', ($, e) => {
    envs.push(e.init?.env); argvs.push([...e.argv])
    // the names of this world's environment (engine-io.ts lists them once, for the BASH_FUNC reset)
    if (e.argv.join('\0') === ENV_LIST_ARGV.join('\0')) return { value: ok(`${['HOME', ...Object.keys(opts.env ?? {})].join('\n')}\n=\n`) as never }
    const flowGit = opts.flowGit ? gitArgs(e.argv) : null, answered = flowGit ? opts.flowGit?.(flowGit) : undefined
    if (answered) return { value: answered as never }
    // a bare program name reaches the engine as `/usr/bin/env <name> …` (NK-02); answer it as the name
    const [cmd, ...rest] = e.argv[0] === '/usr/bin/env' && e.argv[1] && !e.argv[1].startsWith('-') ? e.argv.slice(1) : e.argv
    const script = rest[1] ?? ''
    if (cmd === '/bin/sh' && script.startsWith('printf')) return { value: ok(opts.exempt ? 'builder||' : '||') as never }
    if (cmd === '/bin/sh' && script.includes('cat >> "$1"')) {
      const file = rest[3] ?? ''
      files.set(file, (files.get(file) ?? '') + String(e.init?.stdin ?? ''))
      touch(file)
      appended.push(file)
      return { value: ok() as never }
    }
    if (cmd === '/bin/sh' && script === INSTALL_SCRIPT) return { value: ok(`${opts.install ?? 'none'}\n`) as never }
    if (cmd === '/bin/sh' && script === WORKER_SCRIPT) { spawns.push(rest.slice(3)); return { value: ok() as never } }
    if (cmd === '/bin/date') return { value: ok('2026-10-11 21:07\n') as never }
    if (cmd === '/usr/bin/uname') return { value: ok('Darwin\n') as never }
    if (cmd === '/usr/bin/stat') return { value: (rest.includes('%HT') ? { ...ok(''), exitCode: 1, stderr: `stat: ${rest.at(-1) ?? ''}: stat: No such file or directory` } : ok('1\n')) as never } // %HT: as a missing file
    if (opts.flow && e.argv.includes('rev-parse')) return { value: ok(`${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n${ROOT}/.git/index\n`) as never }
    if (opts.flow && e.argv.includes('symbolic-ref')) return { value: ok('main\n') as never }
    if (cmd === 'sqlite3') return { deny: 'ENOENT: sqlite3' }
    if (cmd === '/usr/bin/tail') {
      const text = files.get(rest[2] ?? '') ?? ''
      if (rest[0] === '-n') return { value: ok(text.split('\n').slice(-Number(rest[1]) - 1).join('\n')) as never }
      return { value: ok(text.slice(Number((rest[1] ?? '+1').slice(1)) - 1)) as never }
    }
    // the flow's kept trees (A1): git (hardened, behind /usr/bin/env -u) has every object asked for
    if (e.argv.includes('cat-file') && e.argv.some(a => a.startsWith('--batch-check'))) return { value: ok(String(e.init?.stdin ?? '').split('\n').filter(Boolean).map(o => `${o} tree\n`).join('')) as never }
    if (cmd === 'git') {
      const key = (rest[0] === '-c' ? rest.slice(2) : rest).join(' ')
      return { value: ok(opts.git?.[key] ?? '', opts.git && key in opts.git ? 0 : 1) as never }
    }
    return { value: ok() as never }
  })
  on('session.append', ($, e, next) => {
    for (const block of e.message.content) if (block.type === 'text' && typeof block.text === 'string') appended.push(`APPEND:${block.text}`)
    return next(e)
  })
  on('tool.call', ($, e) => { opts.calls?.push(e as unknown as Record<string, unknown>); return { result: 'ran' as never } })
  on('tool.check', () => ({ decision: 'allow' }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks, ...(e.instructionFiles ? { instructionFiles: e.instructionFiles } : {}) }))
  return { files, appended, spawns, toasts, logs, envs, argvs }
}

const PLUGIN_FILES = {
  '/instructions/always/common.md': '<!-- note -->\n# Common\nCANARY-ALWAYS\n',
  '/skills/flow-loop/SKILL.md': '---\nname: flow-loop\ndescription: rules\n---\n# flow-loop\nCANARY-FLOW-LOOP\n',
  '/instructions/paths/python/style.md': '---\npaths:\n  - "**/*.py"\n---\n# Python\nCANARY-PY\n',
  '/home/u/.snagon/instructions/owner.md': '# Owner\nCANARY-LOCAL\n',
}
const BLOCKS = [{ name: 'claudeMd', text: 'host rules' }]
const HOST_FILE = { path: '/host/CLAUDE.md', kind: 'project', content: 'host rules\n' } as const

describe('register', () => {
  test('session start registers the memory tools, flow_status and the thirteen owner commands', async ($, on) => {
    const names: string[] = [], commands: string[] = []
    world(on, { files: PLUGIN_FILES, tools: names })
    on('command.register', ($, e) => { commands.push(e.name); return { value: { command: e.name } as never } })
    await $.session.start(SESSION)
    expect(names.sort()).toEqual(['flow_check', 'flow_status', 'memory_get', 'memory_save', 'memory_search'])
    expect(commands.sort()).toEqual(['flow-allow', 'flow-approve', 'flow-build', 'flow-decide', 'flow-off', 'flow-plan', 'flow-reject', 'flow-retry', 'flow-setup', 'flow-ship', 'flow-status', 'flow-verify', 'flow-waive'])
  })

  test('every process the mod starts gets the filtered PATH: entries in the project, a temp folder or relative are dropped (NK-02)', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES, env: { PATH: `${ROOT}/node_modules/.bin:/usr/local/bin:.:/private/tmp/x/bin:/usr/bin`, TMPDIR: '/private/var/folders/t' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Read', file_path: '/host/README.md' } as never)
    expect(w.envs.length).toBeGreaterThan(0)
    expect(w.envs.map(e => e?.PATH)).toEqual(w.envs.map(() => '/usr/local/bin:/usr/bin'))
  })

  test('a bare program name runs through env with the filtered PATH, so the engine\'s own lookup never decides (NK-02)', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES, env: { PATH: `${ROOT}/bin:/usr/bin` } })
    await $.session.start(SESSION)
    await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    const at = w.argvs.findIndex(a => a[1] === 'sqlite3')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(w.argvs[at]?.[0]).toBe('/usr/bin/env')
    expect(w.envs[at]?.PATH).toBe('/usr/bin')
  })

  test('every process the mod starts gets each BASH_FUNC_<name>%% of the host empty; the names are listed once, by a child that is no shell (owner decision, after step 11)', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES, env: { PATH: '/usr/bin', 'BASH_FUNC_cd%%': '() { echo forged; }', 'BASH_FUNC_find%%': '() { :; }' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Read', file_path: '/host/README.md' } as never)
    const rest = w.envs.filter((_, i) => w.argvs[i]?.[0] !== '/usr/bin/awk')
    expect(w.argvs.filter(a => a[0] === '/usr/bin/awk')).toEqual([[...ENV_LIST_ARGV]])
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every(e => e?.['BASH_FUNC_cd%%'] === '' && e?.['BASH_FUNC_find%%'] === '' && e?.PATH === '/usr/bin')).toBe(true)
  })

  test('settings that cannot be read leave the system folders, never the host PATH (NK-02)', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES, settingsFail: true, env: { PATH: `${ROOT}/bin:/usr/local/bin:/usr/bin` } })
    await $.session.start(SESSION)
    expect(w.envs.length).toBeGreaterThan(0)
    expect(w.envs.every(e => e?.PATH === '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true)
  })

  test('prompt.context adds the shared and local instructions, the memory digest and the latest handoff', async ($, on) => {
    const entry = { id: 'm1', ts: '2026-10-11T10:00:00.000Z', kind: 'decision', title: 'Use SQLite', body: '', tags: [], source: 'x' }
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/memory/memory.jsonl': `${JSON.stringify(entry)}\n`, '/host/.snagon/handoff/2026-10-10.md': 'old handoff', '/host/.snagon/handoff/2026-10-11.md': 'HANDOFF-CANARY' } })
    await $.session.start(SESSION)
    const out = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    const files = out.instructionFiles ?? []
    expect(files[0]).toEqual(HOST_FILE)
    const text = files.map(f => f.content).join('\n')
    expect(text).toContain('CANARY-ALWAYS')
    expect(text).not.toContain('<!-- note -->')
    expect(text).toContain('CANARY-LOCAL')
    expect(text).toContain('[decision] Use SQLite (id m1)')
    expect(text).toContain('sqlite3 not found')
    expect(text).toContain('HANDOFF-CANARY')
    expect(text).not.toContain('old handoff')
    expect(files.filter(f => f.kind === 'memory').length).toBe(2)
  })

  test('prompt.context adds the flow-loop rules right after the shared instructions, without their frontmatter', async ($, on) => {
    // every agent of a ticket reads them too: a subagent gets main's instruction files (checked live, 2.1.302)
    world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    const files = (await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })).instructionFiles ?? []
    const at = (end: string): number => files.findIndex(f => f.path.endsWith(end))
    expect([at('/host/CLAUDE.md'), at('/instructions/always/common.md'), at('/skills/flow-loop/SKILL.md'), at('/home/u/.snagon/instructions/owner.md')]).toEqual([0, 1, 2, 3])
    expect(files[2]?.content).toBe('# flow-loop\nCANARY-FLOW-LOOP\n')
  })

  test('a Read of a .py file appends the python rule once per session', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Read', file_path: '/host/README.md' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/host/src/a.py' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/host/src/b.py' } as never)
    const rules = w.appended.filter(a => a.startsWith('APPEND:'))
    expect(rules.length).toBe(1)
    expect(rules[0]).toContain('CANARY-PY')
  })

  test('the first Bash command is refused once; hook-bypass flags always', async ($, on) => {
    world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    const first = await $.tool.call({ tool: 'Bash', command: 'ls src' } as never)
    expect(String((first as { deny?: string }).deny)).toContain('Before the first Bash command this session')
    expect(await $.tool.call({ tool: 'Bash', command: 'ls src' } as never)).toMatchObject({ result: 'ran' })
    for (let i = 0; i < 2; i += 1) {
      const bypass = await $.tool.call({ tool: 'Bash', command: 'git commit --no-verify -m x' } as never)
      expect(String((bypass as { deny?: string }).deny)).toContain('BLOCKED')
    }
  })

  test('a commit that would add a token or a private file is refused, naming the file but not the value', async ($, on) => {
    const diff = ['diff --git a/app.py b/app.py', '--- a/app.py', '+++ b/app.py', '@@ -0,0 +1 @@', `+KEY = "${FAKE_TOKEN}"`].join('\n')
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': 'app.py\0.snagon/memory/memory.jsonl\0', 'diff --cached -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/': diff } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never) // the first-Bash gate
    const out = await $.tool.call({ tool: 'Bash', command: 'git commit -m "add app"' } as never)
    const deny = String((out as { deny?: string }).deny)
    expect(deny).toContain('[git guard]')
    expect(deny).toContain('private path: .snagon/memory/memory.jsonl')
    expect(deny).toContain('possible secret in app.py: GitHub token')
    expect(deny).not.toContain('cccc')
  })

  test('a clean commit goes through', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': 'app.py\0', 'diff --cached -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/': '+++ b/app.py\n+print(1)' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(await $.tool.call({ tool: 'Bash', command: 'git commit -m ok' } as never)).toMatchObject({ result: 'ran' })
  })

  test('memory_save appends one JSON line, refuses secrets; memory_search finds it without sqlite3', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    const saved = await $.tool.call({ tool: 'mcp__snagon-dev-mods__memory_save', kind: 'decision', title: 'Dùng SQLite cho bộ nhớ', body: 'vì có FTS5' } as never)
    expect(String((saved as { result?: string }).result)).toContain('Saved memory')
    const line = JSON.parse((w.files.get('/host/.snagon/memory/memory.jsonl') ?? '').trim())
    expect(line).toMatchObject({ kind: 'decision', title: 'Dùng SQLite cho bộ nhớ', source: 'memory_save' })
    expect(w.files.get('/host/.snagon/.gitignore')).toContain('*')
    const refused = await $.tool.call({ tool: 'mcp__snagon-dev-mods__memory_save', kind: 'fact', title: 'token', body: FAKE_TOKEN } as never)
    expect(String((refused as { deny?: string }).deny)).toContain('looks like it contains a secret')
    const found = await $.tool.call({ tool: 'mcp__snagon-dev-mods__memory_search', query: 'sqlite' } as never)
    expect(String((found as { result?: string }).result)).toContain('[decision] Dùng SQLite cho bộ nhớ')
  })

  test('a stop after an unjournaled edit is held once with the real clock; exempt sessions pass', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '# journal\n' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never) // gate
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    const held = await $.classic.Stop({ stop_hook_active: false })
    expect(String(held.block)).toContain('src/a.py')
    expect(String(held.block)).toContain('## 21:07 · <topic>')
    const again = await $.classic.Stop({ stop_hook_active: true })
    expect(again.block).toBeUndefined()
  })

  test('exempt sessions are never held', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '# journal\n' }, exempt: true })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  })

  test('session end copies journal decisions into memory and lets go of one handoff worker; unchanged journal: none', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '## 21:00 · Work\n- Decision: keep the gate.\n- Lesson: none.\n' } })
    await $.session.start(SESSION)
    await $.session.end({ reason: 'other', sessionId: 'sess-1234abcd', resume: {} } as never)
    const mem = w.files.get('/host/.snagon/memory/memory.jsonl') ?? ''
    expect(mem).toContain('"title":"keep the gate."')
    expect(mem.trim().split('\n').length).toBe(1)
    expect(w.spawns.length).toBe(1)
    expect(w.spawns[0]?.[1]).toBe('/host/.snagon/handoff/prompt-1234abcd.md')
    expect(w.files.get('/host/.snagon/handoff/prompt-1234abcd.md')).toContain('keep the gate.')
    await $.session.end({ reason: 'other', sessionId: 'sess-1234abcd', resume: {} } as never)
    expect(w.spawns.length).toBe(1)
    expect((w.files.get('/host/.snagon/memory/memory.jsonl') ?? '').trim().split('\n').length).toBe(1)
  })

  test('before a compaction the journal gets an entry with the real clock', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '# journal\n' } })
    await $.session.start(SESSION)
    await $.classic.PreCompact({ trigger: 'auto', session_id: 'abcd-1122ffee' } as never)
    expect(w.files.get('/host/.snagon/journal/2026-10-11.md')).toContain('## 21:07 · Context compaction (automatic; written by a hook)')
  })

  test('staging and committing in one command is refused before anything runs', async ($, on) => {
    world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m x' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('stages files and commits in the same call')
  })

  test('a commit naming paths is checked against all tracked changes', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: { 'rev-parse --verify --quiet HEAD': 'abc', 'diff HEAD --name-only -z --diff-filter=d': '.env.local\0', 'diff HEAD -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/': '' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git commit -m x .env.local' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('private path: .env.local')
  })

  test('a push is checked against every unpushed commit; deleting a private file is allowed', async ($, on) => {
    const range = 'HEAD --branches feature --not --remotes --max-count=500'
    world(on, { files: PLUGIN_FILES, git: { 'rev-list --count HEAD --branches feature --not --remotes': '3\n', [`log -z --name-only --format= --diff-filter=d --diff-merges=first-parent ${range}`]: 'app.py\0', [`log -p -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ --diff-merges=first-parent --format= ${range}`]: ['diff --git a/app.py b/app.py', '+++ b/app.py', '@@ -1 +1 @@', `+K = "${FAKE_TOKEN}"`].join('\n') } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const pushed = await $.tool.call({ tool: 'Bash', command: 'git push origin feature' } as never)
    expect(String((pushed as { deny?: string }).deny)).toContain('possible secret in app.py: GitHub token')
  })

  test('removing a tracked private file can be committed (deletions are not listed)', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': '', 'diff --cached -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/': 'diff --git a/.env b/.env\n--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-SECRET=1' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(await $.tool.call({ tool: 'Bash', command: 'git commit -m "remove .env"' } as never)).toMatchObject({ result: 'ran' })
  })

  test('session end skips journal lines that look like secrets; the handoff state is written after the worker started', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': `## 21:00 · Work\n- Decision: token is ${FAKE_TOKEN}\n- Decision: keep it simple.\n` } })
    await $.session.start(SESSION)
    await $.session.end({ reason: 'other', sessionId: 'sess-1234abcd', resume: {} } as never)
    const mem = w.files.get('/host/.snagon/memory/memory.jsonl') ?? ''
    expect(mem).toContain('keep it simple.')
    expect(mem).not.toContain('ghp_')
    expect(w.spawns.length).toBe(1)
    expect(w.files.get('/host/.snagon/handoff/state.json')).toContain('journalMtime')
    expect(w.files.get('/host/.snagon/handoff/prompt-1234abcd.md')).not.toContain('ghp_')
  })

  test('the journal folder named in local config is used when the project has it', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/home/u/.snagon/config.json': '{"journalDir":"notes/journal"}', '/host/notes/journal/2026-10-10.md': '# old\n' } })
    await $.session.start(SESSION)
    await $.classic.PreCompact({ trigger: 'manual', session_id: 's' } as never)
    expect(w.files.get('/host/notes/journal/2026-10-11.md')).toContain('Context compaction (manual /compact')
  })

  test('a git failure refuses the commit instead of letting it through unchecked', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: {} })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('Could not check what this would publish')
  })

  test('before the first commit, commit -a is checked against the index', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': 'id_ed25519\0', 'diff --cached -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/': '' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git commit -am first' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('private path: id_ed25519')
  })

  const CERT = ['-----BEGIN CERTIFICATE-----', 'MIIB'.repeat(16), 'AA==', '-----END CERTIFICATE-----']
  const stagedPem = (path: string, lines: string[]) => ({
    'diff --cached --name-only -z --diff-filter=d': `${path}\0`,
    'diff --cached -U0 --text --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/': [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n'),
  })

  test('a staged .pem of certificates alone may be committed (535 trial, M-10)', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: stagedPem('tests/fixtures/ca.pem', CERT) })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m ca' } as never) as { deny?: string }).deny).toBeUndefined()
  })

  test('a staged .pem that also holds a private key may not be committed (535 trial, M-10)', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: stagedPem('tests/fixtures/k.pem', [...CERT, '-----BEGIN ' + 'PRIVATE KEY-----', 'MIIE'.repeat(16), '-----END ' + 'PRIVATE KEY-----']) })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const keyed = String((await $.tool.call({ tool: 'Bash', command: 'git commit -m k' } as never) as { deny?: string }).deny)
    expect(keyed).toContain('private path: tests/fixtures/k.pem')
    expect(keyed).toContain('possible secret in tests/fixtures/k.pem')
  })

  test('git inside a wrapper or after cd is refused with a reason', async ($, on) => {
    world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(String(((await $.tool.call({ tool: 'Bash', command: "sh -c 'git push'" } as never)) as { deny?: string }).deny)).toContain('plain commands')
    expect(String(((await $.tool.call({ tool: 'Bash', command: 'cd /tmp/x && git commit -m y' } as never)) as { deny?: string }).deny)).toContain('without cd')
  })

  test('after a compaction the journal tail comes back as context; exempt sessions get nothing', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '## 21:00 · Work\n- Decision: tail canary\n' } })
    await $.session.start(SESSION)
    const out = await $.classic.SessionStart({ source: 'compact', session_id: 's' } as never)
    expect(JSON.stringify(out)).toContain('tail canary')
  })

  test('an exempt (worker) session starts no handoff and imports nothing', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '- Decision: keep.\n' }, exempt: true })
    await $.session.start(SESSION)
    await $.session.end({ reason: 'other', sessionId: 'sess-1234abcd', resume: {} } as never)
    expect(w.spawns.length).toBe(0)
    expect(w.files.get('/host/.snagon/memory/memory.jsonl')).toBeUndefined()
  })

  test('a push with more unpushed commits than the guard checks is refused', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: { 'rev-list --count HEAD --branches --not --remotes': '501\n' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('501 local commits are not on any remote')
  })

  test('a missing sqlite3 is reported to the user once at session start; exempt sessions skip the check', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    expect(w.logs.filter(l => l.includes('missing sqlite3'))).toHaveLength(1)
    expect(w.files.get('/host/.snagon/install.json')).toContain('lastAttempt')
  })

  test('an exempt session never runs the sqlite3 check', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES, exempt: true })
    await $.session.start(SESSION)
    expect(w.logs.some(l => l.includes('sqlite3'))).toBe(false)
    expect(w.files.has('/host/.snagon/install.json')).toBe(false)
  })

  test('the handoff uses the project addendum before the user addendum', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/home/u/.snagon/handoff-prompt.md': 'USER-ADDENDUM', '/host/.snagon/handoff-prompt.md': 'PROJECT-ADDENDUM', '/host/.snagon/journal/2026-10-11.md': '- Decision: x.\n' } })
    await $.session.start(SESSION)
    await $.session.end({ reason: 'other', sessionId: 'sess-1234abcd', resume: {} } as never)
    const prompt = w.files.get('/host/.snagon/handoff/prompt-1234abcd.md') ?? ''
    expect(prompt).toContain('PROJECT-ADDENDUM')
    expect(prompt).not.toContain('USER-ADDENDUM')
  })

  test('an empty project addendum falls back to the user addendum', async ($, on) => {
    const w = world(on, { files: { ...PLUGIN_FILES, '/home/u/.snagon/handoff-prompt.md': 'USER-ADDENDUM', '/host/.snagon/handoff-prompt.md': '  \n', '/host/.snagon/journal/2026-10-11.md': '- Decision: x.\n' } })
    await $.session.start(SESSION)
    await $.session.end({ reason: 'other', sessionId: 'sess-1234abcd', resume: {} } as never)
    expect(w.files.get('/host/.snagon/handoff/prompt-1234abcd.md') ?? '').toContain('USER-ADDENDUM')
  })

  test('a personal .snagon/CLAUDE.md from /snagon-setup is loaded as an instruction file', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/CLAUDE.md': '# Mine\nPERSONAL-CANARY\n' } })
    await $.session.start(SESSION)
    const out = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    const mine = (out.instructionFiles ?? []).find(x => x.path === '/host/.snagon/CLAUDE.md')
    expect(mine?.content).toContain('PERSONAL-CANARY')
    expect(mine?.kind).toBe('project')
  })

  test('on Linux without a way to install, the agent is told to pass on what is missing and the exact command', async ($, on) => {
    world(on, { files: PLUGIN_FILES, install: 'none dnf Linux missing' })
    await $.session.start(SESSION)
    const out = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    const notice = (out.instructionFiles ?? []).find(x => x.path === '/host/.snagon/install-notice.md')
    expect(notice?.content).toContain('sudo dnf install -y sqlite')
    expect(notice?.content).toContain('At the start of your next reply')
  })

  test('no agent notice when sqlite3 is being installed or the session is exempt', async ($, on) => {
    world(on, { files: PLUGIN_FILES, install: 'brew' })
    await $.session.start(SESSION)
    const out = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    expect((out.instructionFiles ?? []).some(x => x.path.endsWith('install-notice.md'))).toBe(false)
  })

  test('files in the project .snagon folder need no facts before a first write; other files still do', async ($, on) => {
    world(on, { files: PLUGIN_FILES })
    await $.session.start(SESSION)
    expect(await $.tool.call({ tool: 'Write', file_path: '/host/.snagon/CLAUDE.md', content: 'x' } as never)).toMatchObject({ result: 'ran' })
    expect(await $.tool.call({ tool: 'Write', file_path: '/host/.snagon/config.json', content: '{}' } as never)).toMatchObject({ result: 'ran' })
    expect(String(((await $.tool.call({ tool: 'Write', file_path: '/host/src/a.py', content: 'x' } as never)) as { deny?: string }).deny)).toContain('Fact-Forcing Gate')
  })

  test('a second session the same day gets no agent notice', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/install.json': JSON.stringify({ lastAttempt: 999_999, method: 'none', command: 'sudo dnf install -y sqlite' }) }, install: 'none dnf Linux missing' })
    await $.session.start(SESSION)
    const out = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    expect((out.instructionFiles ?? []).some(x => x.path.endsWith('install-notice.md'))).toBe(false)
  })
  test('D13: the mod drops its own ticket prompt once no unstarted ticket waits for it, and leaves other prompts alone', async ($, on) => {
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    const ticket = { id: 'T-1', f: 'F-01', sha: 's', nonce: 'n', tree: 't', routedType: 'tdd-guide', model: 'sonnet', used: true }
    world(on, { files: PLUGIN_FILES, flow: true, record: { tickets: [ticket] } })
    await $.session.start(SESSION)
    const plugin = { kind: 'plugin', name: 'snagon-dev-mods', asUser: true }
    const ready = 'flow: a ticket is ready. Call flow_status and start the agent exactly as it says.'
    expect(await $.prompt.submit({ text: ready, wait: false, origin: plugin } as never)).toEqual({ drop: 'flow: no unstarted ticket waits for this prompt' })
    expect(await $.prompt.submit({ text: 'flow: the project owner decided. Call flow_check.', wait: false, origin: plugin } as never)).toMatchObject({ text: 'flow: the project owner decided. Call flow_check.' })
    expect(await $.prompt.submit({ text: ready, wait: false, origin: { kind: 'composer' } } as never)).toMatchObject({ text: ready })
  })

  test('a reply with a bare pronoun gets a one-time reminder with the next prompt (prompt.submit, every turn); the full form does not', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/config.json': JSON.stringify({ address: 'anh Minh' }) } })
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start(SESSION)
    const reminderIn = async (text: string) => {
      const r = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never) as { context?: readonly string[] }
      return (r.context ?? []).some(c => c.includes('"anh Minh" every time'))
    }
    expect(await reminderIn('turn 1')).toBe(false)
    await $.classic.Stop({ last_assistant_message: 'Xong rồi, anh Minh. Hoặc anh tự chạy lệnh đó.', stop_hook_active: false, session_id: 's' } as never)
    expect(await reminderIn('turn 2')).toBe(true)
    expect(await reminderIn('turn 3')).toBe(false)
    await $.classic.Stop({ last_assistant_message: 'Xong rồi, anh Minh.', stop_hook_active: false, session_id: 's' } as never)
    expect(await reminderIn('turn 4')).toBe(false)
    const context = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    expect((context.instructionFiles ?? []).some(x => x.path.endsWith('address-reminder.md'))).toBe(false)
  })

  test('a subagent turn end writes no cost row; a main-loop turn end writes one (turn.complete hears both since 2.1.301)', async ($, on) => {
    const w = world(on, { files: PLUGIN_FILES })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(SESSION)
    const end = { answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as const
    await $.turn.complete({ ...end, turnId: 't-sub', agentId: 'agent-1' })
    expect(w.files.get('/host/.snagon/cost.jsonl')).toBeUndefined()
    await $.turn.complete({ ...end, turnId: 't-main' })
    expect((w.files.get('/host/.snagon/cost.jsonl') ?? '').trim().split('\n').length).toBe(1)
  })
})

describe('register: flow guards (step 10)', () => {
  test('outside flow tool.check keeps the engine\'s verdict and the sandbox switch reaches the tool unchanged', async ($, on) => {
    const calls: Record<string, unknown>[] = []
    world(on, { files: PLUGIN_FILES, calls })
    await $.session.start(SESSION)
    expect(await $.tool.check({ tool: 'Write', input: { file_path: `${HOME}/.gitconfig`, content: 'x' } })).toMatchObject({ decision: 'allow' })
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never) // the first-Bash gate
    await $.tool.call({ tool: 'Bash', command: 'ls', dangerouslyDisableSandbox: true } as never)
    expect(calls[calls.length - 1]?.dangerouslyDisableSandbox).toBe(true)
  })

  test('in flow tool.check decides with the mode the classic hooks reported, and the sandbox switch is turned off', async ($, on) => {
    const calls: Record<string, unknown>[] = []
    world(on, { files: { ...PLUGIN_FILES, '/host/README.md': 'r' }, flow: true, calls })
    await $.session.start(SESSION)
    const write = { tool: 'Write', input: { file_path: '/host/README.md', content: 'x' } }
    expect(String((await $.tool.check(write)).reason)).toContain('permission mode was not reported')
    await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'default' } as never)
    expect(await $.tool.check(write)).toMatchObject({ decision: 'allow' })
    const out = await $.tool.check({ tool: 'Write', input: { file_path: `${HOME}/.gitconfig`, content: 'x' } })
    expect(out.decision).toBe('deny')
    expect(String(out.reason)).toContain('outside the project')
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'tu-1', permission_mode: 'bypassPermissions' } as never)
    expect(String((await $.tool.check(write)).reason)).toContain('bypassPermissions')
    await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'default' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls', dangerouslyDisableSandbox: true } as never)
    expect(calls[calls.length - 1]?.dangerouslyDisableSandbox).toBe(false)
  })

  test('outside flow the prompt gets no card, other commands pass through and Stop keeps the journal reminder alone', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '# journal\n', '/host/src/a.py': 'a' } })
    const seen: string[] = []
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    on('command.run', ($, e) => { seen.push(`${e.command} ${e.args}`); return { text: 'core' } })
    await $.session.start(SESSION)
    const submitted = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never) as { context?: readonly string[] }
    expect(submitted.context ?? []).toEqual([])
    expect(await $.command.run({ command: 'compact', args: 'x', origin: { kind: 'composer' } } as never)).toMatchObject({ text: 'core' })
    expect(seen).toEqual(['compact x'])
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    const held = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect(String(held.block)).toContain('Session journal reminder: 1 file(s) changed after the last journal entry: src/a.py')
    expect(String(held.block)).not.toMatch(/^1\. /)
  })

  test('in flow Stop gives one numbered block: the claim, open floor or junk, pressure, then the journal reminder', async ($, on) => {
    const findings = [{ id: 'FL-1', f: 'F-01', rubricId: 'skip', sev: 'HIGH' as const, loc: 'tests/a.test.ts:3', status: 'open' }]
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/journal/2026-10-11.md': '# journal\n', '/host/src/a.py': 'a' }, flow: true, record: { findings, lock: { sessionId: 'sess-1234abcd', root: ROOT, branch: 'main', heartbeatAt: 1_000_000 } } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/host/src/a.py', old_string: 'a', new_string: 'b' } as never)
    const lines = String((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Xong rồi ✅' } as never)).block).split('\n')
    expect(lines[0]).toMatch(/^1\. The last reply claims the work is done, but the judge is missing/)
    expect(lines[1]).toMatch(/^2\. Unresolved floor or junk findings: FL-1/)
    expect(lines[2]).toMatch(/^3\. The current task is not passed/)
    expect(lines[3]).toMatch(/^4\. /)
    expect(lines.slice(3).join('\n')).toContain('src/a.py')
  })

  test('in flow the prompt carries the card, /flow-status answers it, and a release code never reaches the command line', async ($, on) => {
    world(on, { files: PLUGIN_FILES, flow: true })
    const seen: string[] = []
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    on('command.run', ($, e) => { seen.push(`${e.command} ${e.args}`); return { text: 'core' } })
    await $.session.start(SESSION)
    const submitted = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never) as { context?: readonly string[] }
    expect((submitted.context ?? []).join('\n')).toContain('flow · build / B2 F-01')
    const status = await $.command.run({ command: 'flow-status', args: '', origin: { kind: 'composer' } } as never)
    expect(String(status.text)).toContain('flow · build / B2 F-01')
    await $.command.run({ command: 'flow-approve', args: 'release 1234abcd ABC234', origin: { kind: 'composer' } } as never)
    expect(seen).toEqual(['flow-approve release 1234abcd ******'])
  })

  test('D1: a prompt the flow asks main to act on goes out after the command hook answered, on the clock, never from inside it', async ($, on) => {
    world(on, { files: PLUGIN_FILES, flow: true, mockClock: true, record: { phase: 'verify', task: 'V1', awaiting: '/flow-verify', lock: { sessionId: 'sess-1234abcd', root: ROOT, branch: 'main', heartbeatAt: 1_000_000 } } })
    const clock = mock.clock(on, { now: 1_000_000 })
    const prompts: string[] = []
    on('prompt.submit', ($, e) => { prompts.push(String(e.text)); return { text: e.text } })
    on('command.run', () => ({ text: 'core' }))
    await $.session.start(SESSION)
    const out = await $.command.run({ command: 'flow-verify', args: '', origin: { kind: 'composer' } } as never)
    expect(String(out.text)).toContain('Verify starts')
    expect(prompts).toEqual([]) // the engine refuses a submit while the command hook holds the turn (host check, 2.1.302)
    await clock.advance(50)
    expect(prompts).toEqual(['flow: verify starts. Call flow_check.'])
  })

  test('F37 wiring: /flow-ship and /flow-approve release through command.run; the code shows in the pane alone', async ($, on) => {
    const TREE = 'c'.repeat(40), HEAD_SHA = 'e'.repeat(40), URL = 'https://github.com/o/r.git', REPORT = '# Verify report\n- AC-001: passed\n'
    const none = { read: async () => { throw new Error('ENOENT') }, exists: async () => false, list: async () => [], run: async () => ok() } as unknown as Io
    const hCfg = (await cfgHash(none, ROOT, { top: ROOT, gitDir: `${ROOT}/.git`, commonDir: `${ROOT}/.git`, index: `${ROOT}/.git/index` }, HOME)).hash
    let pushed = false
    const w = world(on, {
      files: { ...PLUGIN_FILES, [`${ROOT}/docs/flow/verify.md`]: REPORT }, flow: true,
      record: {
        phase: 'ship', task: 'H0', awaiting: '/flow-ship', verifiedTree: TREE, verifyMdHash: await sha256(REPORT),
        frozen: { 'remote.url': URL, 'remote.rules': hashOf(''), 'remote.global': hashOf('\0--system--\0'), 'remote.keys': '', hCfg },
        lock: { sessionId: 'sess-1234abcd', root: ROOT, branch: 'main', heartbeatAt: 1_000_000 },
      },
      flowGit: g => {
        if (g[0] === 'write-tree') return ok(`${TREE}\n`)
        if (g.join(' ') === 'rev-parse --verify HEAD^{commit}') return ok(`${HEAD_SHA}\n`)
        if (g[0] === 'remote' && g[1] === 'get-url') return ok(`${URL}\n`)
        if (g[0] === 'ls-remote' && g[1] === '--') return ok(pushed ? `${HEAD_SHA}\trefs/heads/main\n` : '')
        if (g[0] === 'push') { pushed = true; return ok() }
        return undefined
      },
    })
    const seen: string[] = []
    on('command.run', ($, e) => { seen.push(`${e.command} ${e.args}`); return { text: 'core' } })
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start(SESSION)
    const shipped = await $.command.run({ command: 'flow-ship', args: '', origin: { kind: 'composer' } } as never)
    expect(String(shipped.text)).toContain('Shown in the flow pane')
    const ui = await $.ui.mount({ plugin: 'snagon-dev-mods', surface: 'terminal', component: 'Pane', requestId: 'flow-echo', props: { title: 'flow', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { top: 0, bodyRows: 60 }, view: {} } as never })
    const pane = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    const [, hash8 = '', code = ''] = /\/flow-approve release ([0-9a-f]{8}) ([A-Z2-9]{6})/.exec(pane) ?? []
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    const context = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never) as { context?: readonly string[] }
    const status = await $.tool.call({ tool: 'mcp__snagon-dev-mods__flow_status' } as never)
    const check = await $.tool.call({ tool: 'mcp__snagon-dev-mods__flow_check' } as never)
    const approved = await $.command.run({ command: 'flow-approve', args: `release ${hash8} ${code}`, origin: { kind: 'composer' } } as never)
    expect(String(approved.text)).toContain(`Released ${HEAD_SHA.slice(0, 12)} to main`)
    expect(pushed).toBe(true)
    const channels = [String(shipped.text), String(approved.text), ...(context.context ?? []), JSON.stringify(status), JSON.stringify(check), ...w.toasts, ...w.logs, ...w.appended, ...seen, ...w.files.values()]
    expect(channels.filter(t => t.includes(code))).toEqual([])
    expect(seen).toContain(`flow-approve release ${hash8} ******`)
  })

  test('the flow pane says that nothing waits when no echo is shown', async ($, on) => {
    world(on, { files: PLUGIN_FILES, flow: true })
    await $.session.start(SESSION)
    const ui = await $.ui.mount({ plugin: 'snagon-dev-mods', surface: 'terminal', component: 'Pane', requestId: 'flow-echo', props: { title: 'flow', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { top: 0, bodyRows: 20 }, view: {} } as never })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Nothing waits for approval.'])
  })

  test('in flow a Write whose file is not there after the call is withheld', async ($, on) => {
    world(on, { files: PLUGIN_FILES, flow: true })
    await $.session.start(SESSION)
    const write = { tool: 'Write', file_path: '/host/src/new.ts', content: 'x' } as never
    await $.tool.call(write) // the fact-forcing gate's first touch
    const out = await $.tool.call(write) // the stand-in tool answers without writing the file
    expect(String((out as { deny?: string }).deny)).toContain('gone after the call')
  })
})
