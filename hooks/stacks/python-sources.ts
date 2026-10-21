// The Python stack's command sources (R2 plan §4.2; GAP-R2-0.6-10, -11, -46): the files that decide what the judged
// commands run, hashed at S2; a change to one is CMD-SRC, except an edit the feature declares to a conftest or a module
// a conftest or pytest plugin reaches (reviewed, and it forces Security: yes: it runs before every test, AC-PY-6) and a
// dependency-only edit (AC-PY-8). Listed: every file of CMD_SOURCE at any depth, tracked or untracked and not ignored,
// outside the root's environments; the modules `pytest_plugins` and `-p` (in the configs and the approved command lines)
// name, followed through their imports as far as the TypeScript closure goes, with the package `__init__.py` above each;
// mypy `plugins` and ruff's `extend` chain; a module that would shadow a runner or standard-library module at a folder
// on the judge's sys.path (S-2); the ignored files the interpreter can load, which imports can reach too.
import { hashOf, type Io } from '../session'
import { git, gitKeyHashes, ignoredLoadable, type GitPaths } from '../flow-git'
import { readToml, type TomlTable, type TomlValue } from '../../flow/toml'
import { PYTHON } from '../../flow/data/stacks/python'
import { RUNNER_CLOSURE, STDLIB } from '../../flow/data/python-shadow'
import { lexText } from './python-lex'
import { importsOf, resolveImport } from './python-tests'

const CMD_SOURCE = /(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|pytest\.toml|\.pytest\.toml|pytest\.ini|\.pytest\.ini|tox\.ini|\.pypirc|noxfile\.py|conftest\.py|\.gitignore|requirements[^/]*\.txt|constraints[^/]*\.txt|uv\.lock|uv\.toml|poetry\.lock|poetry\.toml|Pipfile(\.lock)?|pip\.conf|\.python-version|mypy\.ini|\.mypy\.ini|ruff\.toml|\.ruff\.toml|\.coveragerc|sitecustomize\.py|usercustomize\.py)$/
/** The root's virtual environments are the runner's (runner integrity), not the project's sources; a folder of that
 * name deeper down is not the judge's and stays listed. */
const IN_ENV = /^\.(?:venv|tox|nox)\//
const CONFTEST = /(^|\/)conftest\.py$/, TEST_MODULE = /(^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/
const PYTEST_CONFIG = /(^|\/)(pyproject\.toml|setup\.cfg|pytest\.toml|\.pytest\.toml|pytest\.ini|\.pytest\.ini|tox\.ini)$/
const MYPY_CONFIG = /(^|\/)(pyproject\.toml|setup\.cfg|mypy\.ini|\.mypy\.ini)$/, RUFF_CONFIG = /(^|\/)(pyproject\.toml|ruff\.toml|\.ruff\.toml)$/
/** Ignored folders left out of the ignored listing besides the stack's own (GAP-R2-0.6-54, review step 5): bytecode the
 * judge does not read, and environments under other names. Not dependency folders: setup does not refuse them. */
const SKIP = ['__pycache__', 'venv', 'env', 'node_modules', 'site-packages']
/** A module path only a folder the listings leave out holds: loadable but not hashed, so the closure is truncated. */
const EXCLUDED = new RegExp(`(^|/)(?:\\.[^/]*|${[...PYTHON.dependencyDirs, ...PYTHON.buildOutputs.filter(x => x.endsWith('/')).map(d => d.slice(0, -1)), ...SKIP].map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`)
const MODULE_NAME = /^[A-Za-z_]\w*(?:\.\w+)*$/
const NOT_NAMES: ReadonlySet<string> = new Set(['for', 'in', 'if', 'else', 'and', 'or', 'not', 'is', 'None', 'True', 'False', 'lambda', 'pytest_plugins'])
/** How far and how wide import chains are followed; past it the sources carry `closure:truncated`. */
const CLOSURE_DEPTH = 4, CLOSURE_MAX = 300
/** The names the runner closure and a venv's Python take (S-2), by the minor version its pyvenv.cfg names (uv's
 * `version_info`, venv's `version`); a version the data does not list, or none, takes every listed version's names. */
export function shadowedFor(pyvenvCfg: string): ReadonlySet<string> {
  const minor = /^\s*version(?:_info)?\s*=\s*(\d+\.\d+)/m.exec(pyvenvCfg)?.[1], own = minor === undefined ? undefined : STDLIB[minor]
  return new Set([...RUNNER_CLOSURE, ...(own ? [own] : Object.values(STDLIB)).flat()])
}
const SHADOWED = shadowedFor('')
/** A module at the top of a folder: `json.py`, `json/__init__.py`, a sourceless `json.pyc`, an extension `json….so`. */
const TOP_MODULE = /^((?:[^/]+\/)*?)([A-Za-z_]\w*)(?:\.py|\.pyc|(?:\.[\w-]+)?\.so|\/__init__\.py)$/
const dirOf = (p: string): string => (p.includes('/') ? `${p.slice(0, p.lastIndexOf('/'))}/` : '')
const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v)
const at = (t: TomlValue | undefined, ...path: string[]): TomlValue | undefined => path.reduce<TomlValue | undefined>((v, k) => (isTable(v) && Object.hasOwn(v, k) ? v[k] : undefined), t)
const strings = (v: TomlValue | undefined): string[] => (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []).map(x => x.trim()).filter(Boolean)
/** A root-relative path with `.` and `..` resolved; null when it is absolute or climbs above the root. */
export function normPath(p: string): string | null {
  if (/^[~/]/.test(p)) return null
  const out: string[] = []
  for (const s of p.split('/')) { if (s === '..') { if (!out.length) return null; out.pop() } else if (s && s !== '.') out.push(s) }
  return out.join('/')
}
const dirPath = (p: string): string => (p ? `${p}/` : '')

/** The module names `-p` loads in a text or a command line (`-p x`, `-px`, `"-p", "x"`, and inside a bundle of flags
 * that take no value: `-qp x`, `-qpx`); `-p no:x` loads nothing. */
export function pFlagNames(text: string): string[] {
  const tokens = text.match(/[^\s"',[\]=]+/g) ?? []
  return tokens.flatMap((t, i) => { const m = /^-[qvslVhx]*p(.*)$/.exec(t); return m ? [m[1] || (tokens[i + 1] ?? '')] : [] }).filter(n => /^[A-Za-z_][\w.]*$/.test(n))
}
/** The module names a file's `pytest_plugins` bindings name (`=`, `+=`, `.append`, `.extend`, through the names they
 * use, two levels down), and whether one builds its names at run time (a call, a comprehension, an f-string, `%`, a
 * write through globals(), setattr or a subscript): those cannot be followed, so the closure is truncated. */
export function pluginBindings(text: string): { names: string[]; built: boolean } {
  const lx = lexText(text.split('\n')), names = new Set<string>()
  let built = false
  /** The value from `from` on line `i`, over the lines its brackets hold (at most 50). */
  const value = (i: number, from: number): { code: string; lits: string[] } => {
    let code = '', depth = 0
    const lits: string[] = []
    for (let j = i; j < lx.length && j < i + 50; j += 1) {
      const c = j === i ? (lx[j]?.code ?? '').slice(from) : (lx[j]?.code ?? '')
      code += ` ${c}`
      lits.push(...(lx[j]?.parts ?? []).filter(x => !x.comment).map(x => x.text))
      depth += (c.match(/[([{]/g)?.length ?? 0) - (c.match(/[)\]}]/g)?.length ?? 0)
      if (depth <= 0) break
    }
    return { code, lits }
  }
  const visit = (target: RegExp, level: number): void => lx.forEach((l, i) => {
    const m = target.exec(l.code)
    if (!m) return
    const v = value(i, m.index + m[0].length)
    if (/\w\s*\(|\bfor\b|\b(?:[fF][rR]?|[rR][fF])""|%|\.format\b/.test(v.code)) built = true
    for (const t of v.lits) if (MODULE_NAME.test(t)) names.add(t)
    if (level < 2) for (const id of new Set(v.code.match(/\b[A-Za-z_]\w*\b(?!"")/g) ?? [])) if (!NOT_NAMES.has(id)) visit(new RegExp(`^\\s*${id}\\s*(?::[^=\\n]{0,100})?\\+?=(?!=)`), level + 1)
  })
  visit(/\bpytest_plugins\s*(?::[^=\n]{0,100})?\+?=(?!=)|\bpytest_plugins\s*\.\s*(?:append|extend)\b/, 0)
  if (lx.some(l => /\b(?:globals|vars)\s*\(\s*\)\s*\[|\bsetattr\s*\(|\bpytest_plugins\s*\[/.test(l.code) && /pytest_plugins/.test(`${l.code} ${l.parts.map(x => x.text).join(' ')}`))) built = true
  return { names: [...names], built }
}
/** The modules a conftest's `pytest_plugins` literal names (literalModules finds the other forms). */
export function pytestPlugins(text: string): string[] {
  const m = /^pytest_plugins[ \t]*(?::[^=\n]{0,100})?=[ \t]*/m.exec(text)
  if (!m) return []
  const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 5000)
  const value = /^[[(]/.test(rest) ? rest.slice(0, rest.search(/[\])]/) + 1 || rest.length) : (rest.split('\n')[0] ?? '')
  return [...value.matchAll(/['"]([A-Za-z_][\w.]*)['"]/g)].map(x => x[1] ?? '')
}
/** mypy `plugins` (a module, or a path from the config's folder) and ruff's `extend` (a path) in one config file. */
export function configRefs(rel: string, text: string): { mypy: string[]; ruff: string[]; readable: boolean } {
  const toml = /\.toml$/.test(rel) ? readToml(text) : null
  if (/\.toml$/.test(rel) && !toml) return { mypy: [], ruff: [], readable: false }
  const mypy = MYPY_CONFIG.test(rel) ? (toml ? strings(at(toml, 'tool', 'mypy', 'plugins')) : [...text.matchAll(/^[ \t]*plugins[ \t]*[=:][ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/gm)].flatMap(m => (m[1] ?? '').split(/[,\s]+/).filter(Boolean))) : []
  const ruff = RUFF_CONFIG.test(rel) && toml ? strings(/pyproject\.toml$/.test(rel) ? at(toml, 'tool', 'ruff', 'extend') : at(toml, 'extend')) : []
  return { mypy: mypy.map(x => x.replace(/:.*$/, '')), ruff, readable: true }
}
/** The folders a root config's `pythonpath` puts on sys.path (root-relative, as pytest reads it); null: unreadable or
 * outside the root. */
export function pythonpathOf(rel: string, text: string): string[] | null {
  let entries: string[]
  if (/\.toml$/.test(rel)) {
    const t = readToml(text)
    if (!t) return null
    const v = /pyproject\.toml$/.test(rel) ? (at(t, 'tool', 'pytest', 'ini_options', 'pythonpath') ?? at(t, 'tool', 'pytest', 'pythonpath')) : at(t, 'pytest', 'pythonpath')
    entries = typeof v === 'string' ? v.split(/\s+/) : strings(v)
  } else entries = [...text.matchAll(/^[ \t]*pythonpath[ \t]*[=:][ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/gm)].flatMap(m => (m[1] ?? '').split(/\s+/))
  const out = entries.filter(Boolean).map(normPath)
  return out.some(x => x === null) ? null : out.map(x => dirPath(x ?? ''))
}
/** The folder pytest puts on sys.path for a test module or conftest (prepend mode): the first one above it, its own
 * included, without an `__init__.py`. */
const basedir = (file: string, has: (x: string) => boolean): string => { let d = dirOf(file); while (d && has(`${d}__init__.py`)) d = dirOf(d.slice(0, -1)); return d }
/** The folders on the judge's sys.path the project controls: the root, `src/`, `pythonpath` and each test basedir. */
export function sysPathRoots(files: readonly string[], pythonpath: readonly string[]): string[] {
  const set = new Set(files)
  return [...new Set(['', 'src/', ...pythonpath, ...files.filter(f => TEST_MODULE.test(f)).map(f => basedir(f, x => set.has(x)))])]
}
/** The files at a sys.path folder named like a runner or standard-library module (S-2). */
export function shadowFiles(files: readonly string[], roots: readonly string[], shadowed: ReadonlySet<string> = SHADOWED): string[] {
  const at = new Set(roots)
  return files.filter(f => { const m = TOP_MODULE.exec(f); return m !== null && at.has(m[1] ?? '') && shadowed.has(m[2] ?? '') })
}

/**
 * Hashes of every command source by root-relative path (with `closure:truncated` when a chain was cut or ran into a
 * folder the listings leave out, and the git keys every stack holds); `reached`: the sources found from a conftest or
 * plugin (they can be declared, see cmdSourceVerdict); `setupChain`: those of them that run before every test (all of
 * them: conftests, their plugins, what those import and the packages above). Frozen at S2.
 */
export async function commandSources(io: Io, p: GitPaths, argvs: ReadonlyArray<readonly string[]> = []): Promise<{ hashes: Record<string, string>; reached: string[]; setupChain: string[] }> {
  const r = await git(io, p.top, ['ls-files', '-z', '-co', '--exclude-standard'])
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw new Error(`git ls-files failed: ${r.stderr.trim().slice(0, 200)}`)
  const ignored = await ignoredLoadable(io, p, PYTHON, SKIP)
  const files = [...new Set(r.stdout.split('\0'))].filter(x => x && !IN_ENV.test(x)), listed = new Set([...files, ...Object.keys(ignored)])
  const texts = new Map<string, string>()
  const read = async (rel: string): Promise<boolean> => {
    if (!texts.has(rel)) { const t = await io.read(`${p.top}/${rel}`).catch(() => null); if (t === null) return false; texts.set(rel, t) }
    return true
  }
  const found = new Set<string>(), reached: string[] = []
  let truncated = false
  const named = files.filter(x => CMD_SOURCE.test(x))
  for (const rel of named) await read(rel)
  const pythonpath = named.filter(x => !x.includes('/') && PYTEST_CONFIG.test(x)).flatMap(x => { const pp = pythonpathOf(x, texts.get(x) ?? ''); if (pp === null) truncated = true; return pp ?? [] })
  const roots = sysPathRoots([...listed], pythonpath)
  const shadowed = shadowedFor(await io.read(`${p.top}/.venv/pyvenv.cfg`).catch(() => ''))
  for (const rel of [...named, ...shadowFiles(files, roots, shadowed)]) if (await read(rel)) found.add(rel)
  const initsAbove = (file: string): string[] => file.split('/').slice(0, -1).map((_, i, dirs) => `${dirs.slice(0, i + 1).join('/')}/__init__.py`).filter(x => x !== file && listed.has(x))
  /** Adds files (declarable when `declarable`) with the package inits above them; returns those that were new. A named
   * source stays undeclarable, a conftest aside. Only what the closure adds counts toward CLOSURE_MAX. */
  let grown = 0
  const add = async (cands: readonly string[], declarable: boolean, capped = true): Promise<string[]> => {
    const fresh: string[] = []
    for (const x of cands.flatMap(c => [c, ...initsAbove(c)])) {
      const known = found.has(x)
      if (known && !(declarable && CONFTEST.test(x) && !reached.includes(x))) continue
      if (!known && capped && grown >= CLOSURE_MAX) { truncated = true; break }
      if (!(await read(x))) continue
      if (!known) { found.add(x); if (capped) grown += 1 }
      if (declarable) reached.push(x)
      fresh.push(x)
    }
    return fresh
  }
  /** Every listed file a module path can be at a sys.path folder (pytest may put a basedir first), or the path itself,
   * added when new; a module only an excluded folder holds truncates the closure. */
  const reach = async (rel: string | null, declarable: boolean): Promise<string[]> => {
    if (rel === null) return []
    const cands = rel.endsWith('.py') ? [rel] : roots.flatMap(d => [`${d}${rel}.py`, `${d}${rel}/__init__.py`, `${d}${rel}.pyc`])
    const hits = cands.filter(c => listed.has(c))
    if (hits.length) return add(hits, declarable)
    for (const c of cands) if (EXCLUDED.test(c) && await io.exists(`${p.top}/${c}`)) { truncated = true; break }
    return []
  }
  const pluginRefs = (from: string): string[] => {
    const text = texts.get(from) ?? ''
    if (!/\bpytest_plugins\b/.test(text)) return []
    const b = pluginBindings(text)
    if (b.built) truncated = true
    return b.names
  }
  // the setup chain: every conftest (ignored ones too: pytest loads them), the plugins configs, command lines and
  // conftests name, and what those import
  let wave = await add([...listed].filter(x => CONFTEST.test(x)).sort(), true, false)
  const plugins = [...named.filter(x => PYTEST_CONFIG.test(x)).flatMap(x => pFlagNames(texts.get(x) ?? '')), ...argvs.flatMap(a => pFlagNames(a.join(' ')))]
  for (const name of [...plugins, ...wave.flatMap(pluginRefs)]) wave.push(...(await reach(resolveImport('', name), true)))
  for (let depth = 0; depth < CLOSURE_DEPTH && wave.length; depth += 1) {
    const next: string[] = []
    for (const from of wave) {
      for (const v of importsOf((texts.get(from) ?? '').split('\n')).values()) for (const spec of [v.spec, ...(v.name ? [/^\.+$/.test(v.spec) ? `${v.spec}${v.name}` : `${v.spec}.${v.name}`] : [])]) next.push(...(await reach(resolveImport(from, spec), true)))
      for (const name of pluginRefs(from)) next.push(...(await reach(resolveImport('', name), true)))
    }
    wave = next
  }
  if (wave.length) truncated = true
  // mypy plugins and ruff's extend chain: hashed, never declarable (they decide what the checks accept)
  for (const cfg of [...found].filter(x => MYPY_CONFIG.test(x) || RUFF_CONFIG.test(x))) {
    let chain = [cfg]
    for (let depth = 0; depth < CLOSURE_DEPTH && chain.length; depth += 1) {
      const next: string[] = []
      for (const from of chain) {
        const refs = configRefs(from, texts.get(from) ?? '')
        if (!refs.readable) { truncated = true; continue }
        for (const m of refs.mypy) {
          if (!/\.py$|\//.test(m)) { await reach(resolveImport('', m), false); continue }
          const rel = normPath(`${dirOf(from)}${m}`)
          if (rel === null || !(await io.exists(`${p.top}/${rel}`))) { truncated = true; continue }
          if (!found.has(rel) && (await read(rel))) found.add(rel)
        }
        for (const e of refs.ruff) {
          const rel = normPath(`${dirOf(from)}${e}`)
          // an extend outside the root, or one that is not there, cannot be hashed; an ignored one is read all the same
          if (rel === null || !(listed.has(rel) || (await io.exists(`${p.top}/${rel}`)))) { truncated = true; continue }
          if (!found.has(rel) && (await read(rel))) { found.add(rel); next.push(rel) }
        }
      }
      chain = next
    }
    if (chain.length) truncated = true
  }
  const hashes: Record<string, string> = {}
  for (const rel of [...found].sort()) hashes[rel] = hashOf(texts.get(rel) ?? '')
  if (truncated) hashes['closure:truncated'] = 'yes'
  const chain = [...new Set(reached)]
  return { hashes: { ...ignored, ...hashes, ...(await gitKeyHashes(io, p)) }, reached: chain, setupChain: chain }
}

/** The toolchain's top-level modules, also its distribution names: the runner closure, the checkers' own dependencies,
 * pytest-xdist's result transport and Hypothesis, whose library decides what its plugin reports (security review round
 * 4). A re-baseline leaves their files as they were (python-runner.ts). */
export const TOOL_MODULES: readonly string[] = [...RUNNER_CLOSURE, 'pathspec', 'exceptiongroup', 'colorama', 'pygments', 'execnet', 'hypothesis']
/** Packages that run or judge the checks (the runner closure, pytest's and mypy's own dependencies, any pytest plugin),
 * and those a config loads plugins from (`-p`, mypy `plugins`): never a dependency-only change. */
const TOOLCHAIN: ReadonlySet<string> = new Set(TOOL_MODULES.map(n => n.toLowerCase().replace(/[-_.]+/g, '-')))
const normName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')
/** A toolchain package by normalized name: TOOLCHAIN, any pytest plugin, the type stubs mypy reads (`types-*`, `*-stubs`,
 * owner decision 2026-10-19) and the packages the pyproject loads plugins from. */
const isTool = (n: string, plugins: ReadonlySet<string>): boolean => TOOLCHAIN.has(n) || n.startsWith('pytest-') || n.startsWith('types-') || n.endsWith('-stubs') || plugins.has(n)
const pluginPackages = (pyproject: string): string[] => [...configRefs('pyproject.toml', pyproject).mypy.filter(m => !/\.py$|\//.test(m)), ...pFlagNames(pyproject)].map(m => normName(m.split('.')[0] ?? ''))
/** pyproject's dependency arrays and tables (`*`: any key). */
const DEP_PATHS: ReadonlyArray<readonly string[]> = [['project', 'dependencies'], ['project', 'optional-dependencies'], ['dependency-groups'], ['tool', 'uv', 'dev-dependencies'], ['tool', 'poetry', 'dependencies'], ['tool', 'poetry', 'dev-dependencies'], ['tool', 'poetry', 'group', '*', 'dependencies']]
/** Poetry's dependency table keys that keep a package on its index (`source`, `git`, `path`, `url` do not). */
const POETRY_KEYS: ReadonlySet<string> = new Set(['version', 'extras', 'markers', 'python', 'platform', 'optional', 'allow-prereleases'])
/** JSON with sorted keys, where inf, -inf, nan and -0 stay apart (plain JSON writes them as null and 0). */
const canon = (v: TomlValue | undefined): string => JSON.stringify(v, (_k, x: unknown) => {
  if (typeof x === 'number' && (!Number.isFinite(x) || Object.is(x, -0))) return `\u0000num:${Object.is(x, -0) ? '-0' : String(x)}`
  return x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x
}) ?? 'undefined'
/** A table with the given paths taken out. */
function strip(t: TomlValue, paths: ReadonlyArray<readonly string[]>): TomlValue {
  if (!isTable(t)) return t
  const out: TomlTable = {}
  for (const [k, v] of Object.entries(t)) {
    const here = paths.filter(x => x[0] === k || x[0] === '*')
    if (here.some(x => x.length === 1)) continue
    Object.defineProperty(out, k, { value: here.length ? strip(v, here.map(x => x.slice(1))) : v, enumerable: true, writable: true, configurable: true })
  }
  return out
}
/** One dependency entry: where it sits (a table entry's key last) and its text (a string, or a value as canon JSON). */
type Dep = { readonly path: readonly string[]; readonly text: string }
function depEntries(t: TomlValue | undefined, paths: ReadonlyArray<readonly string[]>, where: readonly string[] = []): Dep[] {
  return paths.flatMap(path => {
    if (!path.length) {
      if (Array.isArray(t)) return t.map(x => ({ path: where, text: typeof x === 'string' ? x : canon(x) }))
      return isTable(t) ? Object.entries(t).flatMap(([k, v]) => (Array.isArray(v) ? depEntries(v, [[]], [...where, k]) : [{ path: [...where, k], text: canon(v) }])) : []
    }
    const [head = '', ...rest] = path
    return isTable(t) ? Object.keys(t).filter(k => head === '*' || k === head).flatMap(k => depEntries(t[k], [rest], [...where, k])) : []
  })
}
/** Whether an added, changed or removed dependency entry is one an index serves and no toolchain or plugin package. */
function entryOk(d: Dep, removed: boolean, plugins: ReadonlySet<string>): boolean {
  const poetry = d.path[0] === 'tool' && d.path[1] === 'poetry'
  if (!poetry && d.text.startsWith('{')) return /^\{"include-group":"[\w.-]+"\}$/.test(d.text) // dependency-groups: a group, no package
  const name = normName(poetry ? (d.path.at(-1) ?? '') : (/^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(d.text)?.[1] ?? ''))
  if (!name || isTool(name, plugins) || (poetry && name === 'python')) return false
  if (removed) return true
  if (!poetry) return !/^[^;]*@/.test(d.text)
  const v: unknown = JSON.parse(d.text)
  return typeof v === 'string' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).every(k => POETRY_KEYS.has(k)))
}
/** A pyproject edit that changes only dependency entries, each from an index and none a toolchain or plugin package. */
export function pyprojectDepsOnly(before: string, after: string): boolean {
  const a = readToml(before), b = readToml(after)
  if (!a || !b || canon(strip(a, DEP_PATHS)) !== canon(strip(b, DEP_PATHS))) return false
  const plugins = new Set([...pluginPackages(before), ...pluginPackages(after)]), key = (d: Dep): string => JSON.stringify([d.path, d.text])
  const was = depEntries(a, DEP_PATHS), now = depEntries(b, DEP_PATHS), wasKeys = new Set(was.map(key)), nowKeys = new Set(now.map(key))
  return now.filter(d => !wasKeys.has(key(d))).every(d => entryOk(d, false, plugins)) && was.filter(d => !nowKeys.has(key(d))).every(d => entryOk(d, true, plugins))
}
const hostOf = (u: string): string => /^[a-z][\w+.-]*:\/\/([^/?#]*)/i.exec(u)?.[1]?.toLowerCase() ?? ''
const urlsOf = (v: TomlValue | undefined): string[] => (typeof v === 'string' ? (/^[a-z][\w+.-]*:\/\//i.test(v) ? [v] : []) : Array.isArray(v) ? v.flatMap(urlsOf) : isTable(v) ? Object.values(v).flatMap(urlsOf) : [])
/** A lockfile edit that adds, changes or drops package entries only, each from an index and hosts the lockfile already
 * used (poetry: a `legacy` source, or PyPI with none), none a toolchain package; the rest of the file as it was
 * (poetry's content hash aside). uv's own project entry (editable or virtual `.`) may change. */
export function lockDepsOnly(kind: 'uv' | 'poetry', before: string, after: string, plugins: ReadonlySet<string> = new Set()): boolean {
  const a = readToml(before), b = readToml(after)
  if (!a || !b) return false
  const rest = (t: TomlTable): string => canon(kind === 'poetry' && isTable(t.metadata) ? { ...(strip(t, [['package']]) as TomlTable), metadata: strip(t.metadata, [['content-hash']]) } : strip(t, [['package']]))
  if (rest(a) !== rest(b)) return false
  const pkgs = (t: TomlTable): TomlTable[] => (Array.isArray(t.package) ? t.package.filter(isTable) : [])
  const was = new Set(pkgs(a).map(canon)), now = new Set(pkgs(b).map(canon))
  const added = pkgs(b).filter(x => !was.has(canon(x))), gone = pkgs(a).filter(x => !now.has(canon(x)))
  const own = (x: TomlTable): boolean => kind === 'uv' && (at(x, 'source', 'editable') === '.' || at(x, 'source', 'virtual') === '.')
  const index = (x: TomlTable): string => String((kind === 'uv' ? at(x, 'source', 'registry') : at(x, 'source', 'type') === 'legacy' ? at(x, 'source', 'url') : undefined) ?? '')
  const indexes = new Set(pkgs(a).map(index).filter(Boolean)), hosts = new Set(pkgs(a).flatMap(x => urlsOf(x)).map(hostOf))
  const fromIndex = (x: TomlTable): boolean => (kind === 'poetry' && !isTable(x.source)) || indexes.has(index(x))
  const tool = (x: TomlTable): boolean => isTool(normName(String(x.name ?? '')), plugins)
  return [...added, ...gone].every(x => own(x) || !tool(x)) && added.every(x => own(x) || (fromIndex(x) && urlsOf(x).every(u => hosts.has(hostOf(u)))))
}

/**
 * Changed command sources split three ways (plan §4.2): dependency-only (a pyproject.toml in the feature's Files whose
 * dependency entries alone changed, and the uv.lock or poetry.lock beside it, in Files, changed in package entries
 * only); declared (a conftest or a module the setup chain reaches, in Files: a reviewed edit that forces Security: yes,
 * AC-PY-6); CMD-SRC otherwise.
 */
export function cmdSourceVerdict(changed: readonly string[], texts: Readonly<Record<string, { before: string; after: string }>>, fFiles: readonly string[], reached: readonly string[] = [], setupChain: readonly string[] = []): { cmdSrc: string[]; dependencyOnly: string[]; declared: string[]; forceSecurity: boolean } {
  const pyOk = new Set(changed.filter(x => /(^|\/)pyproject\.toml$/.test(x) && fFiles.includes(x) && texts[x] !== undefined && pyprojectDepsOnly(texts[x]?.before ?? '', texts[x]?.after ?? '')))
  const lockOk = (x: string): boolean => {
    const kind = /(^|\/)uv\.lock$/.test(x) ? 'uv' : /(^|\/)poetry\.lock$/.test(x) ? 'poetry' : null, t = texts[x], py = texts[`${dirOf(x)}pyproject.toml`]
    // the packages the pyproject loads plugins from are toolchain in its lock too (a relock can move them)
    const plugins = new Set(py ? [...pluginPackages(py.before), ...pluginPackages(py.after)] : [])
    return kind !== null && fFiles.includes(x) && pyOk.has(`${dirOf(x)}pyproject.toml`) && t !== undefined && lockDepsOnly(kind, t.before, t.after, plugins)
  }
  const ok = (x: string): boolean => pyOk.has(x) || lockOk(x)
  const declared = (x: string): boolean => !ok(x) && reached.includes(x) && fFiles.includes(x)
  const decl = changed.filter(declared)
  return { cmdSrc: changed.filter(x => !ok(x) && !declared(x)), dependencyOnly: changed.filter(ok), declared: decl, forceSecurity: decl.some(x => setupChain.includes(x)) }
}
