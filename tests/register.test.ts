import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { WORKER_SCRIPT } from '../hooks/handoff'
import { INSTALL_SCRIPT } from '../hooks/install'

const ROOT = '/host'
const HOME = '/home/u'
const SESSION = { surface: 'terminal', isInteractive: false, cwd: ROOT } as const
const FAKE_TOKEN = 'ghp_' + 'c'.repeat(36)

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ok = (stdout = '', exitCode = 0): Run => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** A small engine: host files under /host, the user's files under /home/u, plugin files keyed from /instructions/, processes scripted. */
function world(on: On, opts: { files?: Record<string, string>; exempt?: boolean; git?: Record<string, string>; tools?: string[]; install?: string } = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const mtimes = new Map<string, number>()
  let clock = 1_000_000
  const appended: string[] = []
  const spawns: string[][] = []
  const toasts: string[] = []
  const logs: string[] = []
  const touch = (p: string) => { clock += 1000; mtimes.set(p, clock) }
  for (const k of files.keys()) touch(k)
  const norm = (p: string) => {
    if (p.startsWith(ROOT) || p.startsWith(HOME)) return p.replace(/\/$/, '')
    for (const mark of ['/local', '/instructions']) { const i = p.indexOf(mark); if (i > 0) return p.slice(i).replace(/\/$/, '') }
    return p.replace(/\/$/, '')
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.Stop', () => ({}))
  on('classic.PreCompact', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('session.root', () => ({ value: ROOT as never }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? HOME : undefined) as never }))
  on('session.id', () => ({ value: 'sess-1234abcd' as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 10 }, rateLimits: [], cost: { usd: 1 } } as never }))
  on('clock.now', () => { clock += 1; return { value: clock as never } })
  on('ui.log', ($, e) => { logs.push(String((e as { text?: string }).text)); return { value: undefined as never } })
  on('ui.status', () => ({ value: undefined as never }))
  on('ui.toast', ($, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined as never } })
  on('tool.register', ($, e) => { opts.tools?.push(e.name); return { value: { tool: `mcp__snagon-dev-mods__${e.name}` } as never } })
  on('fs.exists', ($, e) => { const p = norm(e.path); return { value: (files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`))) as never } })
  on('fs.read', ($, e) => { const t = files.get(norm(e.path)); return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t as never } })
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
  on('process.run', ($, e) => {
    const [cmd, ...rest] = e.argv
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
    if (cmd === 'sqlite3') return { deny: 'ENOENT: sqlite3' }
    if (cmd === '/usr/bin/tail') {
      const text = files.get(rest[2] ?? '') ?? ''
      if (rest[0] === '-n') return { value: ok(text.split('\n').slice(-Number(rest[1]) - 1).join('\n')) as never }
      return { value: ok(text.slice(Number((rest[1] ?? '+1').slice(1)) - 1)) as never }
    }
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
  on('tool.call', () => ({ result: 'ran' as never }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks, ...(e.instructionFiles ? { instructionFiles: e.instructionFiles } : {}) }))
  return { files, appended, spawns, toasts, logs }
}

const PLUGIN_FILES = {
  '/instructions/always/common.md': '<!-- note -->\n# Common\nCANARY-ALWAYS\n',
  '/instructions/paths/python/style.md': '---\npaths:\n  - "**/*.py"\n---\n# Python\nCANARY-PY\n',
  '/home/u/.snagon/instructions/owner.md': '# Owner\nCANARY-LOCAL\n',
}
const BLOCKS = [{ name: 'claudeMd', text: 'host rules' }]
const HOST_FILE = { path: '/host/CLAUDE.md', kind: 'project', content: 'host rules\n' } as const

describe('register', () => {
  test('session start registers the three memory tools', async ($, on) => {
    const names: string[] = []
    world(on, { files: PLUGIN_FILES, tools: names })
    await $.session.start(SESSION)
    expect(names.sort()).toEqual(['memory_get', 'memory_save', 'memory_search'])
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
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': 'app.py\0.snagon/memory/memory.jsonl\0', 'diff --cached -U0 --no-color --no-ext-diff': diff } })
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
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': 'app.py\0', 'diff --cached -U0 --no-color --no-ext-diff': '+++ b/app.py\n+print(1)' } })
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
    world(on, { files: PLUGIN_FILES, git: { 'rev-parse --verify --quiet HEAD': 'abc', 'diff HEAD --name-only -z --diff-filter=d': '.env.local\0', 'diff HEAD -U0 --no-color --no-ext-diff': '' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git commit -m x .env.local' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('private path: .env.local')
  })

  test('a push is checked against every unpushed commit; deleting a private file is allowed', async ($, on) => {
    const range = 'HEAD --branches feature --not --remotes --max-count=500'
    world(on, { files: PLUGIN_FILES, git: { 'rev-list --count HEAD --branches feature --not --remotes': '3\n', [`log --name-only --format= --diff-filter=d ${range}`]: 'app.py\n', [`log -p -U0 --no-color --no-ext-diff --format= ${range}`]: ['diff --git a/app.py b/app.py', '+++ b/app.py', '@@ -1 +1 @@', `+K = "${FAKE_TOKEN}"`].join('\n') } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const pushed = await $.tool.call({ tool: 'Bash', command: 'git push origin feature' } as never)
    expect(String((pushed as { deny?: string }).deny)).toContain('possible secret in app.py: GitHub token')
  })

  test('removing a tracked private file can be committed (deletions are not listed)', async ($, on) => {
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': '', 'diff --cached -U0 --no-color --no-ext-diff': 'diff --git a/.env b/.env\n--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-SECRET=1' } })
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
    world(on, { files: PLUGIN_FILES, git: { 'diff --cached --name-only -z --diff-filter=d': 'id_ed25519\0', 'diff --cached -U0 --no-color --no-ext-diff': '' } })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'git commit -am first' } as never)
    expect(String((out as { deny?: string }).deny)).toContain('private path: id_ed25519')
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
  test('a reply with a bare pronoun gets a one-time reminder on the next prompt; the full form does not', async ($, on) => {
    world(on, { files: { ...PLUGIN_FILES, '/host/.snagon/config.json': JSON.stringify({ address: 'anh Minh' }) } })
    await $.session.start(SESSION)
    await $.classic.Stop({ last_assistant_message: 'Xong rồi, anh Minh. Hoặc anh tự chạy lệnh đó.', stop_hook_active: false, session_id: 's' } as never)
    const first = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    const reminder = (first.instructionFiles ?? []).find(x => x.path.endsWith('address-reminder.md'))
    expect(reminder?.content).toContain('"anh Minh" every time')
    const second = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    expect((second.instructionFiles ?? []).some(x => x.path.endsWith('address-reminder.md'))).toBe(false)
    await $.classic.Stop({ last_assistant_message: 'Xong rồi, anh Minh.', stop_hook_active: false, session_id: 's' } as never)
    const third = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [HOST_FILE] })
    expect((third.instructionFiles ?? []).some(x => x.path.endsWith('address-reminder.md'))).toBe(false)
  })
})
