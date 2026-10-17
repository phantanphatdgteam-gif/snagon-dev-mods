// A fake FlowHost for the flow wiring tests: files and symbolic links in memory, the commands the record protocol runs
// (mkdir, ln, rm, mv), git rev-parse, uname and stat's link count, and the session's flow state with versions.
import type { FlowSession } from '../types'
import type { FlowHost } from '../hooks/flow-host'
import type { RunResult } from '../hooks/session'
import { newRecord, repoKeyOf, versionPath, type FlowRecord } from '../hooks/flow-state'
import type { Layer, Settings } from '../hooks/flow-sandbox'

export const HOME = '/Users/u'
export const ROOT = `${HOME}/proj`
export const MOD_ROOT = `${HOME}/.claude/plugins/cache/m/snagon-dev-mods/0.5.1`
export const SESSION_ID = 'sess-1'
export const FLOW_ID = 'a1b2c3d4'
export const REPO_KEY = repoKeyOf(`${ROOT}/.git`)
/** The vendored files tickets quote (plan §8), as small stand-ins: each skill text names its skill; the testing reference
 * holds B1's sections and one section B1 does not get. */
export const VENDOR_SHA = 'aeac41d4d005999432bb7312f7ff06383a91d59d'
export const OVERRIDES_TEXT = '## Flow overrides\n\n- Write only the files this ticket names.\n'
export const METHOD_HEAD = `## Reference method (agent-skills, MIT, ${VENDOR_SHA.slice(0, 8)})`
export const VENDORED: Readonly<Record<string, string>> = {
  [`${MOD_ROOT}/flow/vendor/agent-skills.lock.json`]: JSON.stringify({ repo: 'https://github.com/addyosmani/agent-skills', sha: VENDOR_SHA, fetchedAt: '2026-10-17T12:05:47Z', files: {} }),
  [`${MOD_ROOT}/flow/vendor/overrides.md`]: OVERRIDES_TEXT,
  [`${MOD_ROOT}/flow/vendor/agent-skills/references/testing-patterns.md`]: ['# Testing Patterns', '## Test Structure (Arrange-Act-Assert)', 'STRUCTURE', '## Test Naming Conventions', 'NAMING', '## Common Assertions', 'NOT SENT', '## Mocking Patterns', '### Mock at Boundaries Only', 'BOUNDARIES', '## Test Anti-Patterns', 'ANTI', ''].join('\n'),
  ...Object.fromEntries(['planning-and-task-breakdown', 'incremental-implementation', 'debugging-and-error-recovery', 'code-review-and-quality', 'security-and-hardening']
    .map(s => [`${MOD_ROOT}/flow/vendor/agent-skills/skills/${s}/SKILL.md`, `---\nname: ${s}\n---\nMETHOD ${s}\n`])),
}

const done =(stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })

/** gitOut: answers by the git arguments after the hardened `-c` pairs, joined by spaces (a string is stdout, exit 0);
 * any other git call exits 1 with no output (none found). */
export type FakeOpts = {
  files?: Record<string, string>; links?: Record<string, string>; linkCount?: Record<string, number>; os?: string; git?: boolean; claudeDir?: string; pluginDirs?: string
  language?: 'en' | 'vi'; placed?: boolean; usd?: number; branch?: string; sessionId?: string
  gitOut?: Record<string, string | RunResult>; settings?: Partial<Record<Layer | 'merged', Settings>>; envText?: string; missing?: string[]; journalDir?: string
  run?: (argv: string[]) => RunResult | undefined
  /** What write-tree answers (the flow tree of the worktree). */
  tree?: string
  /** What write-tree answers for HEAD alone (no `add -A` since the read-tree); the worktree's tree when unset. */
  headTree?: string
}
/** The git arguments of a hardened call: after `git`, the `-c name=value` pairs dropped. */
export function gitArgs(argv: readonly string[]): string[] | null {
  const at = argv.indexOf('git')
  if (at < 0) return null
  let i = at + 1
  while (argv[i] === '-c') i += 2
  return argv.slice(i)
}
export function fakeHost(opts: FakeOpts = {}) {
  const panes: { id: string; title: string }[] = [], submitted: string[] = [], journal: string[] = []
  const files = new Map<string, string>(Object.entries({ [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n', [`${MOD_ROOT}/hooks/register.ts`]: '', ...VENDORED, ...opts.files }))
  const links = new Map<string, string>(Object.entries(opts.links ?? {}))
  const dirs = new Set<string>()
  const runs: string[][] = []
  let state: { value: FlowSession | undefined; version: number } = { value: undefined, version: 0 }
  let tree = opts.tree ?? 'f'.repeat(40), headTree = opts.headTree, staged = false, usd: number | undefined = opts.usd ?? 1, clock = 1_000_000
  let cwd = ROOT
  const isDir = (p: string): boolean => dirs.has(p) || [...files.keys(), ...links.keys()].some(k => k.startsWith(`${p}/`))
  /** The real path through links; null when a part is missing; undefined when a link leads nowhere. */
  const resolve = (path: string, depth = 0): string | null | undefined => {
    let cur = ''
    const parts = path.split('/').filter(Boolean)
    for (const [i, part] of parts.entries()) {
      const at = `${cur}/${part}`, link = links.get(at)
      if (link !== undefined) {
        const to = depth > 8 ? undefined : resolve(link, depth + 1)
        if (typeof to !== 'string') return i === parts.length - 1 ? undefined : null
        cur = to
      } else if (files.has(at) || isDir(at)) cur = at
      else return null
    }
    return cur || '/'
  }
  const host: FlowHost = {
    io: {
      read: async p => { const r = resolve(p); const t = r ? files.get(r) : undefined; if (t === undefined) throw new Error(`ENOENT: ${p}`); return t },
      write: async (p, t) => { files.set(p, t) },
      exists: async p => { const r = resolve(p); return typeof r === 'string' },
      list: async d => {
        const names = new Set<string>()
        for (const k of [...files.keys(), ...links.keys(), ...dirs]) if (k.startsWith(`${d}/`)) names.add(k.slice(d.length + 1).split('/')[0] ?? '')
        return [...names].filter(Boolean).map(name => {
          const p = `${d}/${name}`
          return { name, kind: links.has(p) ? 'other' : isDir(p) ? 'dir' : 'file', size: files.get(p)?.length ?? 0, mtimeMs: 0 }
        })
      },
      run: async argv => {
        runs.push(argv)
        const own = opts.run?.(argv)
        if (own) return own
        const [cmd, ...a] = argv
        const g = gitArgs(argv)
        if (g && opts.gitOut && g.join(' ') in opts.gitOut) { const v = opts.gitOut[g.join(' ')]; return typeof v === 'string' ? done(v) : v ?? done('', 1) }
        if (cmd === '/bin/sh' && a[1]?.startsWith('env |')) return done((opts.envText ?? 'PATH=/usr/bin:/bin\nHOME=/Users/u\n').split('\n').map(l => l.split('=')[0]).filter(Boolean).join('\n'))
        if (cmd === '/bin/sh' && a[1]?.startsWith('command -v')) return (opts.missing ?? []).includes(a[3] ?? '') ? done('', 1) : done(`/usr/local/bin/${a[3]}\n`)
        if (cmd === '/usr/bin/uname') return done(`${opts.os ?? 'Darwin'}\n`)
        if (cmd === '/usr/bin/stat') { const p = a[a.length - 1] ?? '', r = resolve(p); return r && files.has(r) ? done(`${opts.linkCount?.[r] ?? 1}\n`) : done('', 1, `stat: ${p}: No such file or directory`) }
        if (argv.includes('rev-parse')) return opts.git === false ? done('', 128, 'fatal: not a git repository') : done(`${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n${ROOT}/.git/index\n`)
        if (argv.includes('symbolic-ref')) return opts.branch === '' ? done('', 1) : done(`${opts.branch ?? 'main'}\n`)
        if (g?.[0] === 'ls-files') return done('')
        if (g?.[0] === 'read-tree') { staged = false; return done() }
        if (g?.[0] === 'add' && g[1] === '-A') { staged = true; return done() }
        if (g?.[0] === 'rm' && g[1] === '--cached') return done()
        if (g?.[0] === 'write-tree') return done(`${staged ? tree : headTree ?? tree}\n`)
        if (g) return done('', 1)
        if (cmd === '/bin/mkdir') { dirs.add(a[a.length - 1] ?? ''); return done() }
        if (cmd === '/bin/rm') { for (const p of a.slice(1)) files.delete(p); return done() }
        if (cmd === '/bin/ln') {
          const [from = '', to = ''] = a.slice(1)
          if (files.has(to)) return done('', 1, `ln: ${to}: File exists`)
          const t = files.get(from); if (t === undefined) return done('', 1, 'No such file or directory')
          files.set(to, t); return done()
        }
        if (cmd === '/bin/mv') {
          const [from = '', to = ''] = a.slice(1), t = files.get(from)
          if (t !== undefined) { files.delete(from); files.set(to, t); return done() }
          const under = [...files.keys()].filter(k => k.startsWith(`${from}/`))
          if (!under.length) return done('', 1, 'No such file')
          for (const k of under) { files.set(`${to}${k.slice(from.length)}`, files.get(k) ?? ''); files.delete(k) }
          return done()
        }
        if (argv[0] === '/usr/bin/curl') return done('200') // the probe's control, run by the mod outside the sandbox (SEC13-1)
        return done('', 127, `unexpected ${argv.join(' ')}`)
      },
      now: async () => clock,
      pluginRoot: MOD_ROOT,
    },
    home: HOME, root: ROOT, sessionId: opts.sessionId ?? SESSION_ID, cwd: async () => cwd,
    claudeDir: opts.claudeDir ?? `${HOME}/.claude`, pluginDirs: opts.pluginDirs ?? '',
    stat: async p => { const r = resolve(p); return r === null ? null : r === undefined ? { kind: 'other' } : { realPath: r, kind: files.has(r) ? 'file' : 'dir' } },
    readSession: async () => state,
    writeSession: async (value, ifVersion) => { if (ifVersion !== state.version) return false; state = { value, version: state.version + 1 }; return true },
    language: opts.language ?? 'en', address: opts.language === 'vi' ? 'Chủ dự án' : 'the project owner',
    open: async p => { panes.push({ id: p.id, title: p.title }); return { isPlaced: opts.placed ?? true } },
    submit: async text => { submitted.push(text) },
    usd: async () => usd,
    journal: async line => { journal.push(line) },
    journalDir: opts.journalDir ?? '.snagon/journal',
    // The local layer is the settings file unless a test gives it; the merge is the local file unless a test gives one.
    settings: async source => {
      const local = (): Settings => { const t = files.get(`${ROOT}/.claude/settings.local.json`); return t ? JSON.parse(t) as Settings : {} }
      return source ? opts.settings?.[source] ?? (source === 'local' ? local() : {}) : opts.settings?.merged ?? local()
    },
    env: { PATH: '/usr/bin:/bin', TMPDIR: '/private/var/folders/t' },
    runLong: async (argv, init) => host.io.run(argv, init),
  }
  return {
    host, files, links, runs, panes, submitted, journal,
    setTree: (t: string) => { tree = t }, setHeadTree: (t: string | undefined) => { headTree = t },
    setUsd: (n: number | undefined) => { usd = n }, setNow: (ms: number) => { clock = ms },
    session: () => state, setSession: (value: FlowSession) => { state = { value, version: state.version + 1 } }, cd: (to: string) => { cwd = to },
  }
}

/** An active flow record of this repository, written as version 1 (the S2 approval has frozen the setup). */
export function activeRecord(over: Partial<FlowRecord> = {}): FlowRecord {
  return {
    ...newRecord({ flowId: FLOW_ID, repoKey: REPO_KEY, root: ROOT, branch: 'main', sessionId: SESSION_ID, now: 1_000_000 }),
    phase: 'build', task: 'B2', feature: 'F-01',
    setup: {
      stack: 'typescript', commands: [{ id: 'test', argv: ['npm', 'test'], runner: 'vitest', mode: 'must-pass' }],
      allowTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task', 'Skill', 'TodoWrite', 'ToolSearch', 'AskUserQuestion'],
      allowMcp: [], journalDir: '.snagon/journal', remote: 'https://example.com/r.git', branch: 'main', pluginProject: false,
      caps: { plan: { e: 3, r: 0, d: 0 }, feature: { e: 3, r: 3, d: 4 }, verify: { e: 2, r: 0, d: 3 } }, sessionCap: 15,
    },
    features: [{ id: 'F-01', key: 'key-f01', files: ['src/a.ts', 'tests/a.test.ts'] }],
    ...over,
  }
}
export const recordFile = (r: FlowRecord): Record<string, string> => ({ [versionPath(HOME, r.flowId, r.version)]: `${JSON.stringify(r, null, 1)}\n` })
