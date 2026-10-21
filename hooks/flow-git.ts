// Git for flow (plan v7.1 §5.1 H_cfg, §5.4, §5.6). Every mod git call is hardened: no global or system config, no
// fsmonitor, hooks, global attributes or replace refs, and the git variables a host could carry (GIT_DIR,
// GIT_CONFIG_COUNT, GIT_SSH_COMMAND…) removed. Only the network calls of a release keep the user's config, after the
// config they depend on was checked against what the owner approved, and only over https, ssh or git. Paths come
// from --git-common-dir/--git-path, so linked worktrees work. Untrusted results throw or come back as a reason.
import { hashOf, type Io, type RunResult } from './session'
import { publishReason, type GitRead } from './gate'
import type { Stack } from '../flow/data/types'

export const HARDENED_ENV: Readonly<Record<string, string>> = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
// diff.suppressBlankEmpty would print a blank context line as an empty line, which the scan's diff reader drops
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=off', '-c', 'diff.suppressBlankEmpty=false']
const NETWORK = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=off']
/** Host variables that redirect git or inject config; the network calls keep the ssh and askpass ones. */
const REDIRECT = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_EXEC_PATH', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_ATTR_SOURCE', 'GIT_REPLACE_REF_BASE']
const LOCAL_ONLY = ['GIT_TEMPLATE_DIR', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PAGER', 'GIT_EDITOR']
/** Files that never change the flow tree: flow's own views and the sandbox settings file (plan §5.4). */
export const FLOW_TREE_EXCLUDES = ['.snagon', 'docs/flow/plan.md', 'docs/flow/verify.md', '.claude/settings.local.json']
/** Global and system keys a push depends on (git prints key names in lower case). */
export const PUSH_GLOBAL_KEYS = '^(credential\\.|core\\.sshcommand|core\\.hookspath|core\\.gitproxy|core\\.askpass|include\\.|includeif\\.|url\\.|http\\.|ssh\\.|push\\.|submodule\\.)'
/** Repository keys that run a program or route the push: refused outright, the agent's clone could carry them. */
const REPO_PUSH_KEYS = '^(credential\\.|core\\.sshcommand|core\\.askpass|core\\.gitproxy)'
const GIT_TIMEOUT_MS = 60_000
const NETWORK_TIMEOUT_MS = 120_000
const INCLUDE_DEPTH = 5

const unset = (names: readonly string[], keep: Record<string, string>): string[] => ['/usr/bin/env', ...names.filter(n => !(n in keep)).flatMap(n => ['-u', n])]
/** A hardened git call (plan §5.4). `config` adds `-c` pairs, such as the user's frozen excludes file. */
export function git(io: Io, cwd: string, args: readonly string[], o: { env?: Record<string, string>; config?: readonly string[]; stdin?: string } = {}): Promise<RunResult> {
  const env = { ...HARDENED_ENV, ...o.env }
  return io.run([...unset([...REDIRECT, ...LOCAL_ONLY], env), 'git', ...HARDENED, ...(o.config ?? []).flatMap(c => ['-c', c]), ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env, stdin: o.stdin })
}
/** The git settings every stack's command sources hold (GAP-R2-0.6-33): the config keys that run or route commands
 * (filters, aliases, remotes, push and url rewrites), the repository's info/exclude and the worktree's config. */
export async function gitKeyHashes(io: Io, p: GitPaths): Promise<Record<string, string>> {
  const keys = await git(io, p.top, ['config', '--null', '--get-regexp', '^(filter|alias|remote|push|url)\\.'])
  if (keys.exitCode > 1) throw new Error('git config failed')
  const file = (f: string): Promise<string> => io.read(f).then(hashOf, () => 'absent')
  return { 'git:config': hashOf(keys.exitCode === 0 ? keys.stdout : ''), 'git:info/exclude': await file(`${p.commonDir}/info/exclude`), 'git:config.worktree': await file(`${p.gitDir}/config.worktree`) }
}
/** The ignored files a stack's runner can still load (NK-09, GAP-R2-0.6-11), by content, keyed by root-relative path:
 * the stack's `loadable` globs at any depth, outside its dependency and build-output folders, hidden folders and the `skip` folders. A
 * file that cannot be read is `unreadable`, which a later read never matches. One mechanism for every stack. */
export async function ignoredLoadable(io: Io, p: GitPaths, stack: Stack, skip: readonly string[] = []): Promise<Record<string, string>> {
  // ASSUMPTION(GAP-R2-0.6-53): hidden folders are left out too (flow's .snagon, the agents' and tools' own folders):
  // Python cannot import from them and pytest does not collect them; their tools rewrite them while a flow runs
  // at any depth (a monorepo builds in each package); a stack whose closure can import from one truncates there instead
  const dirs = [...stack.dependencyDirs, ...stack.buildOutputs.filter(x => x.endsWith('/')), '.*', ...skip].map(d => d.replace(/\/+$/, ''))
  const excludes = [...dirs.map(d => `:(exclude,glob)**/${d}/**`), ...stack.buildOutputs.filter(x => x.startsWith('*')).flatMap(g => [`:(exclude,glob)**/${g}`, `:(exclude,glob)**/${g}/**`])]
  const names = (await out(io, p.top, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ...stack.loadable.map(g => `:(glob)**/${g}`), ...excludes])).split('\0').filter(Boolean)
  const hashes: Record<string, string> = {}
  for (const rel of [...new Set(names)].sort()) hashes[rel] = await io.read(`${p.top}/${rel}`).then(hashOf, () => 'unreadable')
  return hashes
}
/** Each file's text at `tree` (a commit or flow's tree of the worktree), for the scans: a file not in it is left out; a
 * file over git's 4 MiB output throws (the scan cannot read it whole). */
export async function blobsAt(io: Io, p: GitPaths, tree: string, paths: readonly string[]): Promise<Record<string, string>> {
  const texts: Record<string, string> = {}
  for (const path of new Set(paths)) {
    const r = await git(io, p.top, ['cat-file', 'blob', `${tree}:${path}`])
    if (r.exitCode !== 0) continue
    if (r.isStdoutTruncated) throw new Error(`flow: ${path} is over 4 MiB, too large to scan`)
    texts[path] = r.stdout
  }
  return texts
}
async function out(io: Io, cwd: string, args: readonly string[], o: { env?: Record<string, string>; config?: readonly string[]; noneIs?: number; stdin?: string } = {}): Promise<string> {
  const r = await git(io, cwd, args, o)
  if (o.noneIs !== undefined && r.exitCode === o.noneIs) return ''
  if (r.exitCode !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim().slice(0, 300)}`)
  if (r.isStdoutTruncated) throw new Error(`git ${args.slice(0, 2).join(' ')}: output over 4 MiB`)
  return r.stdout
}
/** The publish checks of gate.ts, run through hardened git. */
export const hardenedRead = (io: Io, cwd: string): GitRead => async args => {
  try { const r = await git(io, cwd, args); return { ok: r.exitCode === 0, out: r.stdout, truncated: r.isStdoutTruncated === true } } catch { return { ok: false, out: '' } }
}
/** The owner's own git config read locally (no network; `config` runs no hook), as git applies it to the owner's commands. */
const userConfig = (io: Io, cwd: string, args: readonly string[]): Promise<RunResult> =>
  io.run([...unset(REDIRECT, {}), 'git', '-c', 'core.fsmonitor=false', 'config', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } })
/** Entries walked in the core.hooksPath folder before H_cfg gives up (fail closed, bounded time). */
const HOOKS_PATH_CAP = 5000
/** How long naming what a link, FIFO or device in a hooks folder leads to may take. */
const STAT_TIMEOUT_MS = 5_000
/** `stat -f %HT`'s word for a plain file. */
const REGULAR = 'Regular File'
/** A network git call (ls-remote, push): the user's config for credentials and ssh, never prompts, no hooks. */
function netGit(io: Io, cwd: string, args: readonly string[]): Promise<RunResult> {
  // No local or file transport: git does not pass -c to a local receive-pack, so the target repository's hooks would run.
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:git' }
  return io.run([...unset(REDIRECT, env), 'git', ...NETWORK, ...args], { cwd, timeoutMs: NETWORK_TIMEOUT_MS, env })
}
/** `git config --null` output as [key, value] pairs. */
const pairs = (text: string): Array<[string, string]> => text.split('\0').filter(Boolean).map(e => { const i = e.indexOf('\n'); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)] })

export type GitPaths = { top: string; commonDir: string; gitDir: string; index: string }
export async function gitPaths(io: Io, root: string): Promise<GitPaths> {
  const [top, commonDir, gitDir, index] = (await out(io, root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir', '--git-path', 'index'])).split('\n')
  if (!top || !commonDir || !gitDir || !index) throw new Error('git rev-parse: incomplete paths')
  return { top, commonDir, gitDir, index }
}

/**
 * The tree flow compares (plan §5.4): the worktree (tracked and untracked, ignored files left out) or HEAD, in a temp
 * index so the real index is never touched, with the excludes removed from both so they compare equal. A nested
 * repository records only its commit and git is never run inside one (its .git is not protected), so in the worktree a
 * new nested repository, or a submodule that is checked out, throws: flow cannot see the files inside.
 */
export async function flowTree(io: Io, p: GitPaths, src: 'worktree' | 'head', token: string, config: readonly string[] = []): Promise<string> {
  const env = { GIT_INDEX_FILE: `${p.index}.flow-${token}.tmp` }
  try {
    const head = await git(io, p.top, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'])
    if (head.exitCode !== 0 && head.exitCode !== 1) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim().slice(0, 200)}`)
    await out(io, p.top, head.exitCode === 0 ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env, config })
    if (src === 'worktree') {
      const links = await gitlinks(io, p, env)
      await checkNested(io, p, links)
      // The gitlinks are excluded, so `add` never runs git inside one (its .git is the agent's), even if a folder is
      // swapped between the check and the add. Flow's own excludes are not named: an ignored path makes `add` fail.
      await out(io, p.top, ['add', '-A', '--', '.', ...links.map(l => `:(exclude,literal)${l}`)], { env, config }).catch((err: unknown) => {
        const empty = /'([^']+?)\/?' does not have a commit checked out/.exec(String(err))?.[1]
        throw empty ? new Error(`a nested repository appeared at ${empty}; flow cannot see its files`) : err
      })
      const added = (await gitlinks(io, p, env)).filter(l => !links.includes(l))
      if (added.length) throw new Error(`a nested repository appeared at ${added.join(', ')}; flow cannot see its files`)
    }
    await out(io, p.top, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...FLOW_TREE_EXCLUDES.map(x => `:(literal)${x}`)], { env, config })
    return (await out(io, p.top, ['write-tree'], { env, config })).trim()
  } finally { await io.run(['/bin/rm', '-f', env.GIT_INDEX_FILE]).catch(() => null) }
}
/** The gitlinks (submodules) in the temp index. ponytail: lists the whole index; past 4 MiB of output (about 60k files)
 * out() throws, and flow stops with that reason (F27). */
const gitlinks = async (io: Io, p: GitPaths, env: Record<string, string>): Promise<string[]> =>
  (await out(io, p.top, ['ls-files', '-s', '-z'], { env })).split('\0').filter(e => e.startsWith('160000 ')).map(e => e.slice(e.indexOf('\t') + 1))

/**
 * Refuses, without running git inside it, a submodule whose path is not an empty folder (or absent): checked out, or
 * replaced by a link or a file, which `add` would skip because the path is excluded. A new nested repository is caught
 * after `add` (adding one only reads its HEAD; git runs nothing inside it).
 */
async function checkNested(io: Io, p: GitPaths, links: readonly string[]): Promise<void> {
  for (const path of links) {
    const at = `${p.top}/${path}`
    const parent = at.slice(0, at.lastIndexOf('/'))
    const entry = (await io.exists(parent)) ? (await io.list(parent)).find(i => i.name === at.slice(at.lastIndexOf('/') + 1)) : undefined
    if (!entry) continue
    if (entry.kind !== 'dir') throw new Error(`the submodule path ${path} is not a folder (a link or a file); flow cannot see what it holds`)
    if ((await io.list(at)).length) throw new Error(`the submodule ${path} is checked out; flow cannot follow changes inside it yet (deinit it, or run without flow)`)
  }
}

/** Ignored files and folders (collapsed), minus dependency and build output, flow data and the journal (plan §5.3). */
export async function ignoredSet(io: Io, p: GitPaths, skip: { dirs: readonly string[]; globs: readonly string[] }, config: readonly string[] = []): Promise<{ hash: string; names: string[] }> {
  const dirName = (d: string): string => d.replace(/\/+$/, '')
  const skipped = (n: string): boolean =>
    [...skip.dirs, '.snagon'].map(dirName).some(d => n === d || n === `${d}/` || n.startsWith(`${d}/`) || n.includes(`/${d}/`) || n.endsWith(`/${d}`)) ||
    skip.globs.some(g => g.startsWith('*') ? n.replace(/\/+$/, '').endsWith(g.slice(1)) : false)
  const names = (await out(io, p.top, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z'], { config })).split('\0').filter(n => n && !skipped(n)).sort()
  return { hash: hashOf(names.join('\0')), names }
}

/**
 * H_cfg (plan §5.1): names and bytes of the repository config files and everything they include, the hooks and info
 * folders, and the project's Claude settings and MCP file. `parts` names each piece so a mismatch can say what changed.
 * A file that exists but cannot be read throws.
 */
export async function cfgHash(io: Io, root: string, p: GitPaths, home: string): Promise<{ hash: string; parts: Record<string, string>; includes: string[] }> {
  const parts: Record<string, string> = {}
  const included: string[] = []
  const take = async (path: string): Promise<void> => {
    try { parts[path] = hashOf(await io.read(path)) } catch (err) { if (await io.exists(path)) throw new Error(`cannot read ${path}: ${String(err)}`); parts[path] = 'absent' }
  }
  // a link, FIFO or device is never opened, as a read could block: what is not known to be a plain file is named by
  // `stat -L` first; a plain file (also through a link) is read, a missing one recorded absent, anything else recorded by
  // its type; a link also by where it points. Returns the type.
  const entry = async (path: string, kind: string): Promise<string> => {
    if (kind === 'file') { await take(path); return REGULAR }
    const st = await io.run(['/usr/bin/stat', '-L', '-f', '%HT', path], { timeoutMs: STAT_TIMEOUT_MS })
    const type = st.exitCode === 0 ? st.stdout.trim() : ''
    if (type === REGULAR || type === '') await take(path) // '': missing, or a link that leads nowhere
    else parts[path] = type
    const link = await io.run(['/usr/bin/readlink', path], { timeoutMs: STAT_TIMEOUT_MS })
    if (link.exitCode === 0 && link.stdout.trim()) parts[path] = `${parts[path]} -> ${link.stdout.trim()}`
    return type
  }
  const includes = async (cfg: string, depth: number): Promise<void> => {
    // only a plain file goes on to `git config --file`, which would block on a FIFO as a read does
    if ((await entry(cfg, '')) !== REGULAR || depth >= INCLUDE_DEPTH) return
    const dir = cfg.slice(0, cfg.lastIndexOf('/'))
    for (const [, v] of pairs(await out(io, root, ['config', '--no-includes', '--null', '--file', cfg, '--get-regexp', '^include(if\\..*)?\\.path$'], { noneIs: 1 }))) {
      const target = v.startsWith('~/') ? `${home}${v.slice(1)}` : v.startsWith('/') ? v : `${dir}/${v}`
      included.push(target)
      await includes(target, depth + 1)
    }
  }
  const walk = async (dir: string): Promise<void> => {
    if (!(await io.exists(dir))) { parts[dir] = 'absent'; return }
    for (const item of await io.list(dir)) await (item.kind === 'dir' ? walk(`${dir}/${item.name}`) : entry(`${dir}/${item.name}`, item.kind))
  }
  for (const cfg of new Set([`${p.commonDir}/config`, `${p.commonDir}/config.worktree`, `${p.gitDir}/config.worktree`])) await includes(cfg, 0)
  await walk(`${p.commonDir}/hooks`)
  await walk(`${p.commonDir}/info`)
  // NK-01: git runs the hooks in core.hooksPath for the owner's own commits, outside any sandbox; husky 9 keeps them in
  // .husky/_, which git ignores, so neither flowTree nor the ignored-file set sees an edit there
  const hp = await userConfig(io, p.top, ['--type=path', '--get', 'core.hooksPath']) // git expands ~ and ~user
  if (hp.exitCode > 1) throw new Error(`git config core.hooksPath failed: ${hp.stderr.trim().slice(0, 200)}`)
  const hooksPath = hp.stdout.trim()
  parts['core.hooksPath'] = hooksPath || 'unset' // always there: parts without it were frozen before 0.5.4 (offCfg)
  if (hooksPath) {
    const dir = hooksPath.startsWith('/') ? hooksPath : `${p.top}/${hooksPath}`
    let seen = 0
    const walkHooks = async (d: string, items: Awaited<ReturnType<Io['list']>>): Promise<void> => {
      for (const item of items) {
        if ((seen += 1) > HOOKS_PATH_CAP) throw new Error(`the hooks folder ${dir} (core.hooksPath) holds more than ${HOOKS_PATH_CAP} entries`)
        const at = `${d}/${item.name}`
        await (item.kind === 'dir' ? walkHooks(at, await io.list(at)) : entry(at, item.kind))
      }
    }
    if (!(await io.exists(dir))) parts[dir] = 'absent'
    else {
      const items = await io.list(dir).catch(() => null)
      await (items === null ? entry(dir, 'other') : walkHooks(dir, items)) // not a folder (/dev/null): recorded by its type
    }
  }
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) await entry(`${root}/${f}`, '')
  return { hash: hashOf(Object.keys(parts).sort().map(k => `${k}=${parts[k]}`).join('\n')), parts, includes: included }
}

/** The H_cfg parts that differ from what S2b froze (`frozen`: `hCfg` and the `cfg:<part>` keys), sorted; null when the
 * hash is the same. Empty when only the hash differs. */
export async function cfgDrift(io: Io, root: string, home: string, frozen: Readonly<Record<string, string>>): Promise<string[] | null> {
  return partsDrift(frozen, await cfgHash(io, root, await gitPaths(io, root), home))
}
/** cfgDrift for a cfgHash already taken. */
export function partsDrift(frozen: Readonly<Record<string, string>>, cfg: { hash: string; parts: Readonly<Record<string, string>> }): string[] | null {
  if (cfg.hash === frozen.hCfg) return null
  const was = Object.fromEntries(Object.entries(frozen).filter(([k]) => k.startsWith('cfg:')).map(([k, v]) => [k.slice(4), v]))
  return [...new Set([...Object.keys(was), ...Object.keys(cfg.parts)])].filter(k => was[k] !== cfg.parts[k]).sort()
}
/** The H_cfg parts a setup approval binds (GAP-054-9): all but the settings file S2b writes, which the probe checks itself. */
export const seenHash = (parts: Readonly<Record<string, string>>, root: string): string =>
  hashOf(Object.keys(parts).filter(k => k !== `${root}/.claude/settings.local.json`).sort().map(k => `${k}=${parts[k]}`).join('\n'))

/** Why cfgHash failed, for the owner's `cfg.unreadable` text (S1, flow_check, the probe, /flow-off). */
export const cfgDetail = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300)

/** Why a push URL cannot be used: not https/ssh/git (or scp-like ssh), or a user name, token or password in it. */
export function urlProblem(url: string): string | null {
  if (/^[a-z][\w+.-]*::/i.test(url)) return 'a transport helper (such as ext::) in the remote URL'
  const m = /^([a-z][\w+.-]*):\/\/([^/]*)/i.exec(url)
  if (!m) return /^[^/\s:]+:/.test(url) && !url.startsWith('.') ? null : 'a local path as the remote (its hooks would run outside the sandbox)'
  const scheme = (m[1] ?? '').toLowerCase()
  if (!['https', 'ssh', 'git'].includes(scheme)) return `the ${scheme} transport`
  const user = /^([^@]*)@/.exec(m[2] ?? '')?.[1]
  if (user !== undefined && (scheme === 'https' || user.includes(':'))) return 'a user name, token or password in the remote URL'
  return null
}

/** Config values can hold tokens, so only their hash and the key names are kept (the names are what the echo shows). */
export type PushFacts = { url: string; urlRules: string; globalKeys: string; keyNames: string[]; repoCredentialKeys: string[] }
const mask = (k: string): string => k.replace(/:\/\/[^/@]*@/g, '://***@')
/** What a push of `remote` depends on (plan §5.6 step 2–3); frozen at S2, compared at H2. Included files count. A URL
 * that cannot be pushed to (a token in it, a local path) throws, so it is never stored. */
export async function pushFacts(io: Io, p: GitPaths, remote: string): Promise<PushFacts> {
  const url = (await out(io, p.top, ['remote', 'get-url', '--push', remote])).trim()
  const bad = urlProblem(url)
  if (bad) throw new Error(`remote ${remote}: ${bad}`)
  const rules = await out(io, p.top, ['config', '--includes', '--null', '--get-regexp', '^url\\.'], { noneIs: 1 })
  const user = async (scope: string): Promise<string> => {
    const r = await netGit(io, p.top, ['config', '--includes', '--null', scope, '--get-regexp', PUSH_GLOBAL_KEYS])
    if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`git config ${scope} failed: ${r.stderr.trim().slice(0, 200)}`)
    return r.exitCode === 0 ? r.stdout : ''
  }
  const global = await user('--global'), system = await user('--system')
  // A url.<base>.* key name holds a URL, which may carry a token: the user part is masked.
  const keyNames = [...new Set([...pairs(rules), ...pairs(global), ...pairs(system)].map(([k]) => mask(k)))].sort()
  const keys: string[] = []
  for (const f of new Set([`${p.commonDir}/config`, `${p.gitDir}/config.worktree`])) {
    if (!(await io.exists(f))) continue
    for (const [k] of pairs(await out(io, p.top, ['config', '--includes', '--null', '--file', f, '--get-regexp', REPO_PUSH_KEYS], { noneIs: 1 }))) keys.push(mask(k))
  }
  return { url, urlRules: hashOf(rules), globalKeys: hashOf(`${global}\0--system--\0${system}`), keyNames, repoCredentialKeys: keys }
}

/** The remote branch's tip (that exact ref), or null when the branch does not exist there. */
export async function remoteTip(io: Io, cwd: string, url: string, branch: string): Promise<string | null> {
  const r = await netGit(io, cwd, ['ls-remote', '--', url, `refs/heads/${branch}`])
  if (r.exitCode !== 0) throw new Error(`git ls-remote failed: ${r.stderr.trim().slice(0, 300)}`)
  return r.stdout.split('\n').map(l => l.split('\t')).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0]?.match(/^[0-9a-f]{40,64}$/)?.[0] ?? null
}
/** Which of `shas` are commits this repository has (one cat-file process). */
async function localCommits(io: Io, p: GitPaths, shas: readonly string[]): Promise<string[]> {
  if (!shas.length) return []
  const answer = await out(io, p.top, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { stdin: `${shas.join('\n')}\n` })
  return answer.split('\n').map(l => l.split(' ')).filter(([, t]) => t === 'commit').map(([s]) => s ?? '')
}

/** writable: folders Bash can write besides the worktree (TMPDIR and /tmp realpaths, the sandbox allowWrite paths);
 * configFiles: the global (and system) config files git reads for the push in this environment, existing or not. */
export type Frozen = { remote: string; branch: string; hCfg: string; facts: PushFacts; revsHash?: string; writable?: readonly string[]; configFiles?: readonly string[] }
export type ReleaseResult = { ok: true; head: string; revsHash: string; revs: string[] } | { ok: false; reason: 'tampered' | 'remoteChanged' | 'pushRejected' | 'publish' | 'frozenChanged' | 'couldNotRun'; detail: string }

/** Config include targets Bash can write (the worktree, temp folders, sandbox write paths: `places`), compared without
 * letter case; they could change git's config between two reads. Symbolic links in the target are not followed. */
export const writableIncludes = (includes: readonly string[], places: readonly string[]): string[] => {
  const norm = (x: string): string => `/${x.split('/').reduce<string[]>((a, s) => (s === '..' ? a.slice(0, -1) : s && s !== '.' ? [...a, s] : a), []).join('/')}`.normalize('NFC').toLowerCase()
  return includes.filter(i => places.some(pl => norm(i) === norm(pl) || norm(i).startsWith(`${norm(pl)}/`)))
}

/** Every config file git can read for the push: the system and global files that hold entries, every include target
 * they name (whether or not it exists yet: git skips a missing one without a word), and both global files git would read
 * once they exist. None may sit in a folder Bash can write, where a background process could swap it between the check
 * and the push (security review of step 10). The repository's own files under its git folder are H_cfg's. */
async function pushConfigFiles(io: Io, p: GitPaths, home: string, candidates?: readonly string[]): Promise<string[]> {
  const r = await netGit(io, p.top, ['config', '--show-origin', '--null', '--includes', '--list'])
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw new Error(`git config --list failed: ${r.stderr.trim().slice(0, 200)}`)
  const parts = r.stdout.split('\0'), own = [p.commonDir, p.gitDir].map(d => `${d}/`)
  // a relative GIT_CONFIG_GLOBAL or XDG_CONFIG_HOME is taken from the folder git runs in
  const starts = new Set((candidates ?? [`${home}/.gitconfig`, `${home}/.config/git/config`]).map(c => (c.startsWith('/') ? c : `${p.top}/${c}`)))
  const target = (v: string, from: string): string => (v.startsWith('~/') ? `${home}${v.slice(1)}` : v.startsWith('/') ? v : `${from.slice(0, from.lastIndexOf('/'))}/${v}`)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const o = parts[i] ?? '', kv = parts[i + 1] ?? '', nl = kv.indexOf('\n')
    if (!o.startsWith('file:')) continue
    const origin = o.startsWith('file:/') ? o.slice(5) : `${p.top}/${o.slice(5)}`
    starts.add(origin)
    if (nl > 0 && /^include(?:if\..*)?\.path$/i.test(kv.slice(0, nl))) starts.add(target(kv.slice(nl + 1), origin))
  }
  // every include target, as cfgHash walks them: whatever its condition says now (the agent can move HEAD) and whether
  // or not the file exists yet (git skips a missing one without a word)
  const files = new Set<string>()
  const walk = async (f: string, depth: number): Promise<void> => {
    if (files.has(f)) return
    files.add(f)
    if (depth >= INCLUDE_DEPTH || !(await io.exists(f))) return
    for (const [, v] of pairs(await out(io, p.top, ['config', '--no-includes', '--null', '--file', f, '--get-regexp', '^include(if\\..*)?\\.path$'], { noneIs: 1 }))) {
      await walk(target(v, f), depth + 1)
    }
  }
  for (const f of starts) await walk(f, 0)
  return [...files].filter(f => !own.some(d => f.startsWith(d)))
}

async function stillFrozen(io: Io, root: string, p: GitPaths, home: string, frozen: Frozen): Promise<ReleaseResult | PushFacts> {
  const cfg = await cfgHash(io, root, p, home)
  if (cfg.hash !== frozen.hCfg) return { ok: false, reason: 'tampered', detail: 'repository config changed since setup' }
  const places = [p.top, '/tmp', '/private/tmp', ...(frozen.writable ?? [])], inside = writableIncludes(cfg.includes, places)
  if (inside.length) return { ok: false, reason: 'tampered', detail: `a git config include points into a folder Bash can write: ${inside.join(', ')}` }
  const user = writableIncludes(await pushConfigFiles(io, p, home, frozen.configFiles), places)
  if (user.length) return { ok: false, reason: 'tampered', detail: `a git config file the push reads is in a folder Bash can write: ${user.join(', ')}` }
  const facts = await pushFacts(io, p, frozen.remote)
  const changed = (['url', 'urlRules', 'globalKeys'] as const).filter(k => facts[k] !== frozen.facts[k])
  if (changed.length) return { ok: false, reason: 'remoteChanged', detail: changed.join(', ') }
  return facts.repoCredentialKeys.length ? { ok: false, reason: 'remoteChanged', detail: `not allowed for a push: ${facts.repoCredentialKeys.join(', ')}` } : facts
}

/**
 * H2 (plan §5.6): config and push facts unchanged, the range from the remote's real tip (never local remote-tracking
 * refs, which the agent can move), the publish scan with HEAD's whole tree, the rev list the owner approved, the config
 * checked again right before the push, then the push and a check that the remote now points at HEAD. With `push`
 * false it stops after the scan (the release echo).
 */
export async function release(io: Io, root: string, p: GitPaths, home: string, frozen: Frozen, push: boolean): Promise<ReleaseResult> {
  try {
    const facts = await stillFrozen(io, root, p, home, frozen)
    if ('ok' in facts) return facts
    const head = (await out(io, p.top, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const tip = await remoteTip(io, p.top, facts.url, frozen.branch)
    let revs = [head]
    if (tip) {
      if (!(await localCommits(io, p, [tip])).length) return { ok: false, reason: 'pushRejected', detail: `the remote branch is at ${tip.slice(0, 12)}, which is not here; pull first` }
      revs = [head, '--not', tip]
    } else {
      const all = await netGit(io, p.top, ['ls-remote', '--heads', '--tags', '--', facts.url])
      if (all.exitCode !== 0) throw new Error(`git ls-remote failed: ${all.stderr.trim().slice(0, 300)}`)
      const known = await localCommits(io, p, [...new Set([...all.stdout.matchAll(/^([0-9a-f]{40,64})\t/gm)].map(m => m[1] ?? ''))].filter(Boolean))
      if (known.length) revs = [head, '--not', ...known]
    }
    const leak = await publishReason(hardenedRead(io, p.top), revs, { headTree: true })
    if (leak) return { ok: false, reason: 'publish', detail: leak }
    const revsHash = hashOf(await out(io, p.top, ['rev-list', ...revs]))
    if (!push) return { ok: true, head, revsHash, revs }
    if (frozen.revsHash !== revsHash) return { ok: false, reason: 'frozenChanged', detail: 'the commits to publish changed since the release echo' }
    const again = await stillFrozen(io, root, p, home, frozen)
    if ('ok' in again) return again
    const pushed = await netGit(io, p.top, ['push', '--recurse-submodules=no', '--', facts.url, `${head}:refs/heads/${frozen.branch}`])
    if (pushed.exitCode !== 0) return { ok: false, reason: 'pushRejected', detail: pushed.stderr.trim().slice(0, 400) }
    const after = await remoteTip(io, p.top, facts.url, frozen.branch)
    return after === head ? { ok: true, head, revsHash, revs } : { ok: false, reason: 'pushRejected', detail: `the remote branch is at ${after ?? 'nothing'} after the push, not ${head.slice(0, 12)}` }
  } catch (err) { return { ok: false, reason: 'couldNotRun', detail: String(err).slice(0, 400) } }
}

/** A clean checkout of `sha` in `dir` for the CMD-SRC re-baseline (plan §1.1 item 10), removed afterwards. */
export async function withBaseWorktree<T>(io: Io, p: GitPaths, sha: string, dir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await out(io, p.top, ['worktree', 'add', '--detach', '--force', dir, sha])
  try { return await fn(dir) } finally {
    await git(io, p.top, ['worktree', 'remove', '--force', dir]).catch(() => null)
    await git(io, p.top, ['worktree', 'prune']).catch(() => null)
  }
}
