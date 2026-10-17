// Command sources and runner integrity (plan v7.1 §3.2, §5.1): what the gate freezes at S2, so that a change to what
// the judged commands run is CMD-SRC (with the dependency-only exception), and a patched runner is seen.
import { hashOf, type Io } from './session'
import { git, type GitPaths } from './flow-git'
import type { Stack } from '../flow/data/types'

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
/** A relative path resolved against the folder of `from` (root-relative), or null for a package name. */
export function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const parts = from.split('/').slice(0, -1)
  for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg) }
  return parts.join('/')
}
/** The files an import of `rel` can load: itself, with each extension (a `.js` import may name a `.ts` file), or an index. */
export function moduleFiles(rel: string): string[] {
  const base = rel.replace(/\.(?:[cm]?[jt]sx?)$/, '')
  return [...new Set([rel, ...EXTS.map(e => `${base}${e}`), ...EXTS.map(e => `${base}/index${e}`)])]
}

/** The runner and the toolchain: never changed under the dependency-only exception. */
export const TOOLCHAIN = /^(?:vitest|@vitest\/.+|vite|vite-node|jest|@jest\/.+|jest-.+|ts-jest|babel-jest|typescript|ts-node|tsx|eslint|@eslint\/.+|@typescript-eslint\/.+|eslint-.+|prettier|@biomejs\/.+|esbuild|@esbuild\/.+|@swc\/(?!helpers$).+|@babel\/(?!runtime(?:-corejs\d+)?$).+|rollup|@rollup\/.+)$/
/** Packages whose code decides results: the toolchain and the assertion libraries the runners load. */
const RUNNER_FAMILY = new RegExp(`${TOOLCHAIN.source.slice(0, -2)}|expect|pretty-format|chai|tinypool|tinyspy|tinyrainbow)$`)
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies']
/** A version from the registry (a range or a dist-tag) or a workspace package, not a file, link, alias, git or URL source. */
const REGISTRY_SPEC = /^(?:workspace:[\w.^~<>=*|\s-]*|[\w.^~<>=*|\s-]+)$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
/** Whether two package.json texts differ only in dependency lists (GAP-step5-1: plain dependencies count), each changed
 * entry a registry version of a package that is not the runner or the toolchain. */
export function depsVerdict(before: string, after: string): { ok: boolean; changed: string[] } {
  try {
    const [a, b]: unknown[] = [JSON.parse(before), JSON.parse(after)]
    if (!isObj(a) || !isObj(b)) return { ok: false, changed: [] }
    const rest = (o: Record<string, unknown>): string => stable(Object.fromEntries(Object.entries(o).filter(([k]) => !DEP_KEYS.includes(k))))
    const deps = (o: Record<string, unknown>): Map<string, unknown> => new Map(DEP_KEYS.flatMap(k => (isObj(o[k]) ? Object.entries(o[k] as Record<string, unknown>).map(([n, v]): [string, unknown] => [`${k}:${n}`, v]) : [])))
    const da = deps(a), db = deps(b)
    const changed = [...new Set([...da.keys(), ...db.keys()])].filter(k => stable(da.get(k)) !== stable(db.get(k)))
    const ok = rest(a) === rest(b) && changed.every(k => { const n = k.slice(k.indexOf(':') + 1), v = db.get(k); return !TOOLCHAIN.test(n) && (v === undefined || (typeof v === 'string' && REGISTRY_SPEC.test(v) && !v.startsWith('.'))) })
    return { ok, changed: [...new Set(changed.map(k => k.slice(k.indexOf(':') + 1)))].sort() }
  } catch { return { ok: false, changed: [] } }
}

/** The package a lockfile line starts an entry for: an npm `node_modules/<name>` key (its last segment) or a pnpm or
 * yarn `<name>@…` key; undefined for any other line. */
const entryKey = (l: string): string | undefined => /node_modules\/((?:@[^/"]+\/)?[^/"]+)"\s*:/.exec(l)?.[1] ?? /^\s*['"]?\/?((?:@[^/@'"\s]+\/)?[^/@'"\s:]+)@/.exec(l)?.[1]
/** A lockfile as entries: each entry's key line (with its package name) → its lines; lines before the first entry
 * belong to the root (''). */
function lockEntries(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let key = '\u0000'
  for (const l of text.split('\n')) { const name = entryKey(l); if (name !== undefined) key = `${name}\u0000${l.trim()}`; out.set(key, [...(out.get(key) ?? []), l]) }
  return out
}
/** Lines only in `after` (as multisets). */
function addedLines(before: readonly string[], after: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const l of before) left.set(l, (left.get(l) ?? 0) + 1)
  return after.filter(l => { const n = left.get(l) ?? 0; left.set(l, n - 1); return n <= 0 })
}
const REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com']
const NON_REGISTRY = /\b(?:file|link|portal|patch|git\+\w+|github|gitlab|bitbucket):|git:\/\//
/** Hosts packages are fetched from (resolved, tarball, resolution values; not funding or homepage links). */
const hostsOf = (lines: readonly string[]): string[] => lines.flatMap(l => (/\b(?:resolved|tarball|resolution)\b/.test(l) ? [...l.matchAll(/\bhttps?:\/\/([^/\s"']+)/g)].map(m => (m[1] ?? '').toLowerCase()) : []))
/** Whether a path taken from importer folder `importer` stays inside the repository. */
function within(importer: string, target: string): boolean {
  const parts = importer === '.' ? [] : importer.split('/')
  for (const seg of target.split('/')) { if (seg === '..') { if (!parts.length) return false; parts.pop() } else if (seg && seg !== '.') parts.push(seg) }
  return true
}
/** pnpm `link:` lines whose target, taken from the importer they sit under, stays inside the repository (a line that
 * also appears under an importer it would leave is not one). */
function insideLinks(text: string): Set<string> {
  const ok = new Set<string>(), bad = new Set<string>()
  let importer: string | null = null, inImporters = false
  for (const l of text.split('\n')) {
    if (/^\S/.test(l)) { inImporters = /^importers:\s*$/.test(l); importer = null; continue }
    const imp = inImporters ? /^ {2}(['"]?)([^'"\s][^:]*?)\1:\s*$/.exec(l) : null
    if (imp) { importer = imp[2] ?? null; continue }
    const link = /\blink:([^\s'"]+)/.exec(l)?.[1]
    if (link) (importer !== null && !link.startsWith('/') && within(importer, link) ? ok : bad).add(l)
  }
  for (const l of bad) ok.delete(l)
  return ok
}
/** A lockfile change that leaves every runner, toolchain and assertion package's entry alone, and adds packages only
 * from registries it already used (yarn's own `~builtin` patches aside). */
function lockOnlyAdds(before: string, after: string): boolean {
  const a = lockEntries(before), b = lockEntries(after)
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter(k => (a.get(k) ?? []).join('\n') !== (b.get(k) ?? []).join('\n'))
  const added = changed.flatMap(k => addedLines(a.get(k) ?? [], b.get(k) ?? []))
  const known = new Set([...REGISTRIES, ...hostsOf(before.split('\n'))])
  const links = insideLinks(after)
  const foreign = (l: string): boolean => !links.has(l) && !/patch:.*#(?:~|optional!)builtin</.test(l) && (NON_REGISTRY.test(l) || /\bhttp:\/\//.test(l))
  return !changed.some(k => RUNNER_FAMILY.test(k.slice(0, k.indexOf('\u0000')))) && !added.some(foreign) && hostsOf(added).every(h => known.has(h))
}

const dirOf = (p: string): string => (p.includes('/') ? `${p.slice(0, p.lastIndexOf('/'))}/` : '')
/**
 * Changed command sources split three ways (plan §3.2): dependency-only (package.json files that pass depsVerdict and
 * the lockfile above them that passes lockOnlyAdds, each in the feature's Files); declared (a file sources reach through
 * an import or a script, listed in the feature's Files: an ordinary reviewed edit, GAP-step5-7); CMD-SRC otherwise.
 * forceSecurity: a declared file is in a setup chain (it runs before every test), so the feature gets a security review
 * (GAP-step5-9).
 */
export function cmdSourceVerdict(changed: readonly string[], texts: Readonly<Record<string, { before: string; after: string }>>, fFiles: readonly string[], stack: Stack, reached: readonly string[] = [], setupChain: readonly string[] = []): { cmdSrc: string[]; dependencyOnly: string[]; declared: string[]; forceSecurity: boolean } {
  const locks = new Set(stack.packageManagers.flatMap(m => m.lockfiles))
  const okPkg = new Set(changed.filter(p => /(^|\/)package\.json$/.test(p) && fFiles.includes(p) && texts[p] !== undefined && depsVerdict(texts[p]?.before ?? '', texts[p]?.after ?? '').ok))
  // A lockfile serves every package.json below it (a monorepo root lock): all of those that changed must be dependency-only.
  const under = (d: string): string[] => changed.filter(x => /(^|\/)package\.json$/.test(x) && x.startsWith(d))
  const okLock = (p: string): boolean => { const t = texts[p], pkgs = under(dirOf(p)); return locks.has(p.slice(dirOf(p).length)) && fFiles.includes(p) && pkgs.length > 0 && pkgs.every(x => okPkg.has(x)) && t !== undefined && lockOnlyAdds(t.before, t.after) }
  const ok = (p: string): boolean => okPkg.has(p) || okLock(p)
  // ASSUMPTION(GAP-step5-7): a reached source the feature declares is reviewed like any other edit, not CMD-SRC.
  const declared = (p: string): boolean => !ok(p) && reached.includes(p) && fFiles.includes(p)
  const decl = changed.filter(declared)
  return { cmdSrc: changed.filter(p => !ok(p) && !declared(p)), dependencyOnly: changed.filter(ok), declared: decl, forceSecurity: decl.some(p => setupChain.includes(p)) }
}

const CMD_SOURCE = /(^|\/)(package\.json|\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|(vitest|jest|playwright|vite)(\.[\w-]+)?\.config\.\w+|vitest\.workspace\.\w+|babel\.config\.\w+|\.babelrc(\.\w+)?|\.swcrc|tsconfig[\w.-]*\.json|[^/]*\.setup\.\w+|setupTests\.\w+|global-?[sS]etup\.\w+|eslint\.config\.\w+|\.eslintrc(\.\w+)?|\.eslintignore|biome\.jsonc?|\.mocharc[\w.]*|\.env(\.(?!(?:example|sample|template|dist)$)[\w.-]+)?|\.pnpmfile\.cjs|\.pnp\.c?js|\.pnp\.loader\.mjs|Makefile|justfile|\.gitattributes)$|(^|\/)(\.yarn\/(plugins|releases|patches)|patches|__mocks__)\//
/** Ignored files that can still steer a command; node_modules is left out (the runner hash covers the runner). */
const IGNORED_SPECS = ['.env', '.env.*', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnp.cjs', '.pnp.loader.mjs', '*.config.*', '*.setup.*', 'tsconfig*.json'].map(g => `:(glob)**/${g}`)
/** Files whose text names other command sources: runner configs, workspaces, setup files, package.json. */
const REFERRING = /(^|\/)((vitest|jest|playwright|vite)(\.[\w-]+)?\.config\.\w+|vitest\.workspace\.\w+|package\.json)$|setup/i
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
/** A spec written as a path alias (`@/x`, `~/x`, `#x`): followed through tsconfig `paths`, or the closure is truncated. */
const ALIAS_LIKE = /^(?:[@~]\/|#)/
/** How far and how wide import chains are followed; past it the sources carry `closure:truncated`. */
const CLOSURE_DEPTH = 4, CLOSURE_MAX = 300
const RUNNER_KEYS = /["']?\b(setupFiles|setupFilesAfterEnv|globalSetup|globalTeardown|snapshotSerializers|testEnvironment|environment|resolver|runner|testRunner|testSequencer|sequencer|reporters|workspace|projects|transform|watchPlugins)\b["']?\s*:\s*(\[[^\]]*\]|\{[^}]*\}|['"][^'"]*['"])/g
const PATHLIKE = /^(?:<rootDir>\/|\.{1,2}\/)|^[\w@.-]+(?:\/[\w@.-]+)+\.(?:[cm]?[jt]sx?|json)$/
/** The files a config's runner keys name (setup, environment, reporters, …): they stay CMD-SRC even when declared. */
export function keyedPaths(from: string, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(RUNNER_KEYS)) for (const v of (m[2] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
    const ref = v[1] ?? ''
    if (PATHLIKE.test(ref)) out.push(resolveSpec(from, ref.startsWith('.') ? ref : `./${ref.replace(/^<rootDir>\//, '')}`) ?? '')
  }
  return [...new Set(out.filter(Boolean))]
}
/** What a runner config or setup file refers to: its relative imports and its keyed files. An entry point (`main`,
 * `exports`, `lib.entry`) is not followed. Root-relative. */
export function referencedPaths(from: string, text: string, aliases: Readonly<Record<string, string>> = {}): string[] {
  const imports = [...text.matchAll(IMPORT_SPEC)].map(m => {
    const spec = m[1] ?? '', key = Object.keys(aliases).find(a => spec.startsWith(a))
    return spec.startsWith('.') ? resolveSpec(from, spec) ?? '' : key !== undefined ? `${aliases[key]}${spec.slice(key.length)}` : ''
  })
  return [...new Set([...imports, ...keyedPaths(from, text)].filter(Boolean))]
}
const OPERAND = /^(?:\.{1,2}\/)?[\w@.-]+(?:(?:\/[\w@.-]+)*\.(?:[cm]?[jt]sx?|sh|py|json)|(?:\/[\w@.-]+)+)$/
const operandsOf = (from: string, tokens: readonly string[]): string[] => [...new Set(tokens.flatMap(t => t.split('=')).filter(t => !t.startsWith('-') && OPERAND.test(t)).map(t => resolveSpec(from, t.startsWith('.') ? t : `./${t}`) ?? ''))].filter(Boolean)
const PM_SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+([\w:.-]+)|(test)\b)/g
/** The package scripts approved command lines run: `npm test`, `npm run <x>`, pnpm, yarn and bun alike. */
export const scriptNames = (argvs: ReadonlyArray<readonly string[]>): string[] => [...new Set(argvs.flatMap(a => {
  const pm = (a[0] ?? '').slice((a[0] ?? '').lastIndexOf('/') + 1)
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return []
  if ((a[1] === 'run' || a[1] === 'run-script') && a[2]) return [a[2]]
  return a[1] === 'test' && pm !== 'bun' ? ['test'] : []
}))]
/** The files the named scripts (with their pre/post scripts and the scripts they run in turn) name, root-relative. */
export function scriptOperands(pkgPath: string, text: string, names: readonly string[]): string[] {
  let scripts: Record<string, unknown>
  try { const pkg: unknown = JSON.parse(text); scripts = isObj(pkg) && isObj(pkg.scripts) ? pkg.scripts : {} } catch { return [] }
  const seen = new Set<string>(), queue = [...names], tokens: string[] = []
  while (queue.length) {
    const name = queue.shift() ?? ''
    for (const n of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[n]
      if (seen.has(n) || typeof body !== 'string') continue
      seen.add(n)
      tokens.push(...body.split(/[\s;&|()<>]+/))
      for (const m of body.matchAll(PM_SCRIPT)) queue.push(m[1] ?? m[2] ?? '')
    }
  }
  return operandsOf(pkgPath, tokens)
}
/** The files an approved command line names. */
export const argvOperands = (argv: readonly string[]): string[] => operandsOf('', argv)

/** tsconfig `paths` (`"@/*": ["./src/*"]`) as alias prefixes to root-relative folders. The file may hold comments. */
function tsAliases(text: string | undefined): Record<string, string> {
  if (!text) return {}
  try {
    const json: unknown = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(?<![:"'\w])\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'))
    const opts = isObj(json) && isObj(json.compilerOptions) ? json.compilerOptions : {}
    const base = typeof opts.baseUrl === 'string' ? opts.baseUrl : '.'
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(isObj(opts.paths) ? opts.paths : {})) {
      const target = Array.isArray(v) && typeof v[0] === 'string' ? v[0] : ''
      if (!k.endsWith('*') || !target.endsWith('*')) continue
      const dir = resolveSpec('tsconfig.json', `./${base}/${target.slice(0, -1)}`.replace(/\/+/g, '/'))
      if (dir !== null) out[k.slice(0, -1)] = dir ? `${dir}/` : ''
    }
    return out
  } catch { return {} }
}

/**
 * Hashes of every command source (plan §5.1): by name, tracked, untracked or ignored; the files the approved commands
 * (`commands`) and the package scripts they run name; the import chains of configs, setup files and those files; and
 * the git keys that run or route commands. `reached` lists the sources found through a script or an import (they can
 * be declared, see cmdSourceVerdict); `setupChain` those of them a setup file, reporter or environment pulls in. A
 * manual mock (`__mocks__/`) counts only where jest applies it with no jest.mock line: beside node_modules at the
 * root, a package root or a jest `roots` folder. Frozen at S2.
 */
export async function commandSources(io: Io, p: GitPaths, commands: ReadonlyArray<readonly string[]> = []): Promise<{ hashes: Record<string, string>; reached: string[]; setupChain: string[] }> {
  const list = async (args: string[]): Promise<string[]> => {
    const r = await git(io, p.top, ['ls-files', '-z', ...args])
    if (r.exitCode !== 0 || r.isStdoutTruncated) throw new Error(`git ls-files failed: ${r.stderr.trim().slice(0, 200)}`)
    return r.stdout.split('\0').filter(x => x && CMD_SOURCE.test(x))
  }
  const texts = new Map<string, string>()
  const read = async (rel: string): Promise<boolean> => {
    if (!rel || rel.startsWith('..')) return false
    if (!texts.has(rel)) { const t = await io.read(`${p.top}/${rel}`).catch(() => null); if (t === null) return false; texts.set(rel, t) }
    return true
  }
  const named = [...(await list(['-co', '--exclude-standard'])), ...(await list(['-o', '-i', '--exclude-standard', '--', ...IGNORED_SPECS, ':(exclude,glob)**/node_modules/**']))]
  const found = new Set<string>(), reached: string[] = [], keyed = new Set<string>(), chain = new Set<string>()
  for (const rel of named) if (await read(rel)) found.add(rel)
  const roots = new Set(['', ...named.filter(x => /(^|\/)package\.json$/.test(x)).map(dirOf)])
  for (const cfg of named.filter(x => /(^|\/)(jest\.config\.\w+|package\.json)$/.test(x))) {
    for (const m of (texts.get(cfg) ?? '').matchAll(/["']?\broots["']?\s*:\s*\[([^\]]*)\]/g)) for (const v of (m[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
      const d = resolveSpec(cfg, `./${(v[1] ?? '').replace(/^<rootDir>\/?/, '')}`)
      if (d !== null) roots.add(d ? `${d}/` : '')
    }
  }
  for (const rel of [...found]) { const i = rel.indexOf('__mocks__/'); if (i >= 0 && !roots.has(rel.slice(0, i))) found.delete(rel) }
  /** Adds the first readable file a reference can mean; returns it when it is new. A keyed file is not declarable; a
   * file a setup chain pulls in is marked. */
  const reach = async (ref: string, viaKey = false, inChain = false): Promise<string | null> => {
    for (const cand of moduleFiles(ref)) {
      if (found.has(cand)) return null
      if (await read(cand)) {
        found.add(cand)
        if (viaKey) keyed.add(cand); else reached.push(cand)
        if (inChain || viaKey) chain.add(cand)
        return cand
      }
    }
    return null
  }
  const setupNamed = (rel: string): boolean => /setup/i.test(rel.slice(rel.lastIndexOf('/') + 1))
  const aliases = tsAliases(texts.get('tsconfig.json'))
  /** Whether a file imports through a path alias this tsconfig does not resolve (its target cannot be followed). */
  const unresolved = (text: string): boolean => [...text.matchAll(IMPORT_SPEC)].some(m => ALIAS_LIKE.test(m[1] ?? '') && !Object.keys(aliases).some(a => (m[1] ?? '').startsWith(a)))
  let wave: string[] = []
  for (const ref of [...commands.flatMap(argvOperands), ...(texts.has('package.json') ? scriptOperands('package.json', texts.get('package.json') ?? '', scriptNames(commands)) : [])]) { const got = await reach(ref); if (got) wave.push(got) }
  wave.push(...[...found].filter(x => REFERRING.test(x)))
  let truncated = false
  for (let depth = 0; depth < CLOSURE_DEPTH && wave.length; depth += 1) {
    const next: string[] = []
    for (const from of wave) for (const ref of [...referencedPaths(from, texts.get(from) ?? '', aliases), ...(unresolved(texts.get(from) ?? '') ? [''] : [])]) {
      if (!ref) { truncated = true; continue }
      if (found.size >= CLOSURE_MAX) { truncated = true; break }
      const got = await reach(ref, keyedPaths(from, texts.get(from) ?? '').includes(ref), chain.has(from) || keyed.has(from) || setupNamed(from))
      if (got) next.push(got)
    }
    wave = next
  }
  const hashes: Record<string, string> = {}
  for (const rel of [...found].sort()) hashes[rel] = hashOf(texts.get(rel) ?? '')
  // Past the depth: truncated only when a file the last wave refers to exists and was not reached.
  for (const from of truncated ? [] : wave) for (const ref of referencedPaths(from, texts.get(from) ?? '', aliases)) if (!truncated && !moduleFiles(ref).some(c => found.has(c))) for (const c of moduleFiles(ref)) if (await io.exists(`${p.top}/${c}`)) { truncated = true; break }
  if (truncated) hashes['closure:truncated'] = 'yes'
  const keys = await git(io, p.top, ['config', '--null', '--get-regexp', '^(filter|alias|remote|push|url)\\.'])
  if (keys.exitCode > 1) throw new Error('git config failed')
  hashes['git:config'] = hashOf(keys.exitCode === 0 ? keys.stdout : '')
  for (const [k, f] of [['git:info/exclude', `${p.commonDir}/info/exclude`], ['git:config.worktree', `${p.gitDir}/config.worktree`]] as const) hashes[k] = await io.read(f).then(hashOf, () => 'absent')
  return { hashes, reached, setupChain: reached.filter(x => chain.has(x)) }
}

const CACHE_SPECS = ['*.tsbuildinfo', '.eslintcache', '.prettiercache', '.stylelintcache'].map(g => `:(glob)**/${g}`)
const CACHE_DIRS = ['node_modules/.cache', 'node_modules/.vite', 'node_modules/.vitest']
/** Tool caches in the project that change results with no diff when edited (tsbuildinfo, lint caches, loader caches).
 * The judged-run wiring moves them into the run folder before each judged run (F30, GAP-step5-8). Root-relative. */
export async function cacheFiles(io: Io, p: GitPaths): Promise<string[]> {
  const r = await git(io, p.top, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ...CACHE_SPECS, ':(exclude,glob)**/node_modules/**'])
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw new Error(`git ls-files failed: ${r.stderr.trim().slice(0, 200)}`)
  const extra: string[] = [...CACHE_DIRS]
  // Custom locations: tsBuildInfoFile in any tsconfig, --cache-location / --cache-file in package scripts.
  const cfgs = await git(io, p.top, ['ls-files', '-z', '-co', '--exclude-standard', '--', ':(glob)**/tsconfig*.json', ':(glob)**/package.json', ':(exclude,glob)**/node_modules/**'])
  for (const cfg of cfgs.stdout.split('\0').filter(Boolean)) {
    const text = await io.read(`${p.top}/${cfg}`).catch(() => '')
    for (const m of text.matchAll(/"tsBuildInfoFile"\s*:\s*"([^"]+)"|--cache-(?:location|file)[= ]+([^\s"'&;|]+)/g)) { const v = m[1] ?? m[2] ?? ''; extra.push(resolveSpec(cfg, v.startsWith('.') ? v : `./${v}`) ?? '') }
  }
  const out = r.stdout.split('\0').filter(Boolean)
  for (const d of extra) if (d && !d.startsWith('..') && !out.includes(d) && (await io.exists(`${p.top}/${d}`))) out.push(d)
  return out
}

/** The folder node would load `dep` from for a package at real path `from`: `<ancestor>/node_modules/<dep>`, nearest
 * first (pnpm keeps a package's dependencies next to its real path). */
async function resolveDep(io: Io, from: string, top: string, dep: string): Promise<string | null> {
  for (let d = from; d.length >= top.length && d.includes('/'); d = d.slice(0, d.lastIndexOf('/'))) {
    if (d.endsWith('/node_modules')) continue
    if (await io.exists(`${d}/node_modules/${dep}`)) return `${d}/node_modules/${dep}`
  }
  return null
}
/**
 * The runner's code, hashed by one process: the runner packages, every toolchain or assertion package they reach, and
 * the direct dependencies of each (by real path, so pnpm layouts count), plus node_modules/.bin. Frozen at S2 and
 * checked before every judged run. 'absent' when no listed package is installed under node_modules (Yarn PnP, a
 * global runner): the caller must not treat that as integrity (plan §2.6 residual, R2).
 */
export async function runnerHash(io: Io, top: string, packages: readonly string[]): Promise<string> {
  const realOf = async (dirs: readonly string[]): Promise<string[]> => {
    if (!dirs.length) return []
    const r = await io.run(['/bin/sh', '-c', 'for d in "$@"; do (cd "$d" 2>/dev/null && pwd -P) || echo; done', 'sh', ...dirs], { timeoutMs: 30_000 })
    return r.stdout.split('\n').slice(0, dirs.length)
  }
  const hashed = new Set<string>(), followed = new Set<string>()
  let wave = (await realOf(packages.map(n => `${top}/node_modules/${n}`))).map(dir => ({ dir, family: true })).filter(x => x.dir)
  while (wave.length) {
    const next: Array<{ dir: string; family: boolean }> = []
    for (const { dir, family } of wave) {
      hashed.add(dir)
      if (!family || followed.has(dir)) continue
      followed.add(dir)
      const pkg: unknown = JSON.parse(await io.read(`${dir}/package.json`).catch(() => '{}'))
      const deps = ['dependencies', 'optionalDependencies'].flatMap(k => Object.keys(isObj(pkg) && isObj(pkg[k]) ? (pkg[k] as Record<string, unknown>) : {}))
      for (const dep of deps) { const at = await resolveDep(io, dir, top, dep); if (at) next.push({ dir: at, family: RUNNER_FAMILY.test(dep) }) }
    }
    const reals = await realOf(next.map(x => x.dir))
    wave = next.map((x, i) => ({ dir: reals[i] ?? '', family: x.family })).filter(x => x.dir && !(followed.has(x.dir) || (!x.family && hashed.has(x.dir))))
  }
  if (!hashed.size) return 'absent'
  // The package files (find -H: a package folder may be a link), then every bin entry: its link text or its content.
  const script = 'bin=$1; shift; { find -H "$@" -type f -print0 | LC_ALL=C sort -z | xargs -0 /usr/bin/shasum -a 256; for b in "$bin"/*; do [ -e "$b" ] || [ -L "$b" ] || continue; printf "%s " "${b##*/}"; if [ -L "$b" ]; then readlink "$b"; else /usr/bin/shasum -a 256 < "$b"; fi; done; } | /usr/bin/shasum -a 256'
  const r = await io.run(['/bin/sh', '-c', script, 'sh', `${top}/node_modules/.bin`, ...[...hashed].sort()], { timeoutMs: 120_000 })
  if (r.exitCode !== 0) throw new Error(`runner hash failed: ${r.stderr.trim().slice(0, 200)}`)
  return r.stdout.trim().split(/\s/)[0] ?? ''
}
