// The Python stack's runner integrity (R2 plan §4.2, step 6; AC-PY-7, AC-RI-2, AC-RI-3, AC-STK-9): the root's `.venv`
// and each venv an approved command runs from, hashed whole as one tree (flow-tree.ts; bytecode caches aside,
// GAP-R2-0.6-24), with each venv's interpreter (its real path and its bytes). What a venv runs at start is kept apart
// (the interpreters, `pyvenv.cfg`, `.pth` files, sitecustomize and usercustomize, the `pytest11` plugins), so that a
// dependency change re-baselines only when it adds or changes none of them; and the refusals of S1 and S2 (O-4): a venv
// that sees the system site-packages, a `.pth` path line or an editable finder that leads outside the project, the
// venvs and the interpreters' own folders.
import type { Io } from '../session'
import type { FlowCommand } from '../flow-state'
import { digestsOf, mapDigest, pathsHashes, toolChanged, treeDigest, TreeError, type Problem, type RunnerState, type Tree } from '../flow-tree'
import { PYTHON } from '../../flow/data/stacks/python'
import { TOOL_MODULES } from './python-sources'

type Facts = { interp: Record<string, string>; start: Record<string, string>; pytest11: string[]; tool?: Record<string, string>; others?: Record<string, string> }
/** The modules pinned in each venv's site-packages (owner decision 2026-10-19: a re-baseline leaves their files as they
 * were): the toolchain's and mypy's compiler `mypyc`; mypy's compiled runtime and each pytest11 plugin's distribution are
 * added from the venv. */
const PINNED_MODULES = [...TOOL_MODULES, 'mypyc']

const SITE = '/lib/[^/]+/site-packages/'
const ere = (s: string): string => s.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&')
/** Files the interpreter runs or reads at start (EREs on the absolute path, for flow-tree.ts): the `.pth` files and
 * customize modules, `pyvenv.cfg`, the interpreter's names in `bin/` (a console script's shebang names one) and the
 * programs the approved commands run from `bin/` (security review, step 6). */
const startOf = (programs: readonly string[]): string => `${SITE}[^/]+\\.pth$|${SITE}(site|user)customize(\\.[^/]*|/.*)?$|/pyvenv\\.cfg$|/bin/(python[0-9.]*${programs.map(p => `|${ere(p)}`).join('')})$`
const LINES = `${SITE}[^/]+\\.pth$|/pyvenv\\.cfg$|${SITE}[^/]+\\.(dist|egg)-info/entry_points\\.txt$|${SITE}(__editable__|_editable_impl_)[^/]*\\.py$`
/** Where every Python ends a `.pth` line besides `\n` (3.12's universal newlines, 3.13's splitlines), and the characters
 * the readings part on: what only 3.13 ends a line at or strips (a BOM), and what Python's strip takes off and
 * JavaScript's keeps (`\x1c`–`\x1f`, `\x85`): a line holding one is refused (security review, step 6). */
const PTH_BREAK = /\r\n?/
const PTH_READ_APART = /[\v\f\x1c-\x1f\x85\u2028\u2029\ufeff]/
/** What a `.pth` import line may compute a module name with, once the forms pthImports reads are taken out
 * (`__import__('a')`, `import_module('a')`, an `exec` of one string literal): refused (security review round 4). */
const PTH_READABLE = /\b(?:__import__|import_module)\s*\(\s*(['"])[\w.]+\1\s*\)|\bexec\s*\(\s*(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")\s*\)/g
const PTH_DYNAMIC = /\b(?:exec|eval|compile|getattr|__import__|import_module)\b/
/** The characters Python's str.strip() takes off (str.isspace), for reading pyvenv.cfg as site.py does. */
const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const pyStrip = (s: string): string => s.replace(new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'gu'), '')
/** A plugin name the judge can pass to `-p` (never `no:…`). */
const PLUGIN_NAME = /^[A-Za-z_][\w.-]*$/
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'))
/** An absolute path with `.` and `..` taken out. */
const normAbs = (p: string): string => `/${p.split('/').reduce<string[]>((out, s) => (s === '..' ? out.slice(0, -1) : s && s !== '.' ? [...out, s] : out), []).join('/')}`
const inside = (p: string, dirs: readonly string[]): boolean => dirs.some(d => p === d || p.startsWith(`${d}/`))

/** What the approved commands run, as absolute paths: the venvs (the root's `.venv` and the `<dir>` of each
 * `<dir>/bin/<program>` that holds a `pyvenv.cfg`), and each other such `<dir>` inside the project (an interpreter the
 * agent's Bash can write: hashed whole, with no venv facts; security review, step 6). */
async function venvsOf(io: Io, top: string, commands: readonly FlowCommand[]): Promise<{ venvs: string[]; others: string[] }> {
  const named = commands.flatMap(c => { const d = /^(.+)\/bin\/[^/]+$/.exec(c.argv[0] ?? '')?.[1]; return d ? [d.startsWith('/') ? d : `${top}/${d.replace(/^(?:\.\/)+/, '')}`] : [] })
  const venvs: string[] = [], others: string[] = []
  for (const d of new Set([`${top}/.venv`, ...named])) {
    if ((await io.exists(`${d}/pyvenv.cfg`)) || (await io.exists(`${d}/bin/pyvenv.cfg`))) venvs.push(d)
    else if (d.startsWith(`${top}/`) && (await io.exists(d))) others.push(d)
  }
  return { venvs, others }
}

/** GAP-R2-0.6-7: the standard library of each venv's base interpreter: pyvenv.cfg's `home`, then `../lib/python<X.Y>` by
 * `version_info` (uv) or `version` (venv), else the one `python3.*` folder there, its site-packages left out. It lies
 * outside the project and outside allowWrite, so S1 hashes it once, for the setup echo, and nothing checks it again;
 * `hash` is null when it is not there or cannot be read (the echo says so; nothing is refused). */
export async function baseLibraries(io: Io, top: string, commands: readonly FlowCommand[]): Promise<Array<{ path: string; hash: string | null }>> {
  const out: Array<{ path: string; hash: string | null }> = []
  for (const v of (await venvsOf(io, top, commands)).venvs) {
    // site.py reads <venv>/bin/pyvenv.cfg first when it is there (PEP 405)
    const file = (await io.exists(`${v}/bin/pyvenv.cfg`)) ? `${v}/bin/pyvenv.cfg` : `${v}/pyvenv.cfg`
    const cfg = new Map((await io.read(file).catch(() => '')).split(/\r\n?|\n/).flatMap(l => (l.includes('=') ? [[pyStrip(l.slice(0, l.indexOf('='))).toLowerCase(), pyStrip(l.slice(l.indexOf('=') + 1))] as const] : [])))
    const home = cfg.get('home')
    // a cfg that cannot be read or names no absolute home is said in the echo, not skipped (security review r1)
    if (!home?.startsWith('/')) { out.push({ path: file, hash: null }); continue }
    const xy = /^(\d+)\.(\d+)/.exec(cfg.get('version_info') ?? cfg.get('version') ?? '')
    // the prefix is the interpreter's real one: Homebrew's `opt/python@3.X/bin/python3.X` links into a framework (code
    // review r2); no answer keeps `home`'s parent
    const real = await io.run(['/usr/bin/readlink', '-f', `${normAbs(home)}/python${xy ? `${xy[1]}.${xy[2]}` : '3'}`]).then(r => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '')
    const lib = `${dirOf(real.startsWith('/') ? dirOf(real) : normAbs(home))}/lib`
    const names = xy ? [`python${xy[1]}.${xy[2]}`] : (await io.list(lib).catch(() => [])).map(i => i.name).filter(n => /^python3\.\d+$/.test(n))
    const path = names.length === 1 ? `${lib}/${names[0]}` : lib
    out.push({ path, hash: names.length === 1 ? await libraryHash(io, path) : null })
  }
  return out
}
/** One hash over the files of a standard library but its site-packages, or null when it has none or the hashing run
 * fails in any way (a read error, a run that fails or times out): the echo says so and nothing is refused (security
 * review r1). */
async function libraryHash(io: Io, lib: string): Promise<string | null> {
  const entries = (await io.list(lib).catch(() => [])).map(i => i.name).filter(n => n !== 'site-packages').map(n => `${lib}/${n}`)
  if (!entries.length) return null
  try { return await mapDigest(await pathsHashes(io, entries)) } catch { return null }
}

/** The `name=module` entries of an entry_points.txt's `[pytest11]` section. */
export function pytest11Of(lines: readonly string[]): string[] {
  const out: string[] = []
  let on = false
  for (const raw of lines) {
    const l = raw.trim()
    if (/^\[.*\]$/.test(l)) { on = l.slice(1, -1).trim() === 'pytest11'; continue }
    const m = on && !/^[#;]/.test(l) ? /^([^=]+?)\s*=\s*(.+)$/.exec(l) : null
    if (m) out.push(`${m[1]}=${m[2]}`)
  }
  return out
}
/** A `.pth` file's lines as site.py reads them (`\r` ends one too). */
const pthLines = (lines: readonly string[]): string[] => lines.flatMap(l => l.split(PTH_BREAK))
/** The paths a `.pth` file puts on sys.path, as site.py reads it: comments, blank lines and `import` lines aside. */
export function pthPaths(file: string, lines: readonly string[]): string[] {
  return pthLines(lines).filter(l => !l.startsWith('#') && l.trim() && !/^import[ \t]/.test(l)).map(l => { const x = l.trimEnd(); return normAbs(x.startsWith('/') ? x : `${dirOf(file)}/${x}`) })
}
/** The top-level modules a `.pth` file's `import` lines can import: code every interpreter start runs. Read as text, the
 * strings an `exec(...)` runs included: `import a, b`, `from a import`, `__import__('a')`, `import_module('a')`. */
export function pthImports(lines: readonly string[]): string[] {
  const names = pthLines(lines).filter(l => /^import[ \t]/.test(l)).flatMap(l => [
    ...[...l.matchAll(/\bimport\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)/g)].flatMap(m => (m[1] ?? '').split(',')),
    ...[...l.matchAll(/\bfrom\s+([A-Za-z_]\w*)|\b(?:__import__|import_module)\s*\(\s*['"]([A-Za-z_]\w*)/g)].map(m => m[1] ?? m[2] ?? ''),
  ])
  return [...new Set(names.map(x => x.trim().split(/[\s.]/)[0] ?? '').filter(n => /^[A-Za-z_]\w*$/.test(n)))]
}

/** Real paths of `paths` (one io.run, NUL-separated); a path that does not exist keeps its own spelling; a real path
 * with a line break or a tab fails (TreeError). */
async function realPaths(io: Io, paths: readonly string[]): Promise<string[]> {
  if (!paths.length) return []
  // `printf .` after the path: $(...) would drop a trailing line break of the path itself
  const r = await io.run(['/bin/sh', '-c', 'for p in "$@"; do x=$(/bin/realpath "$p" 2>/dev/null && printf .) || x=; printf "%s\\0" "$x"; done', 'sh', ...paths], { timeoutMs: 30_000 })
  const got = r.stdout.split('\0').slice(0, -1).map(x => (x.endsWith('\n.') ? x.slice(0, -2) : ''))
  if (r.exitCode !== 0 || got.length !== paths.length || got.some(x => /[\n\t]/.test(x))) throw new TreeError('read', 'realpath', 'a real path with a line break or a tab')
  return paths.map((p, i) => got[i] || p)
}
/** The top-level modules of the distribution whose `entry_points.txt` this is (its RECORD, else its top_level.txt): a
 * pytest11 plugin's whole package, Hypothesis's library beside its plugin shim included (security review round 4). */
async function distModules(io: Io, entryPoints: string): Promise<string[]> {
  const dir = dirOf(entryPoints), record = `${dir}/RECORD`, top = `${dir}/top_level.txt`
  const names = (await io.exists(record)) ? (await io.read(record)).split('\n').map(l => /^"?([^/",]+)[/,]/.exec(l)?.[1] ?? '') : (await io.exists(top)) ? (await io.read(top)).split('\n') : []
  return [...new Set(names.map(s => s.trim()).filter(s => s && !/\.(?:dist|egg)-info$|^__pycache__$|^\.\.?$/.test(s)).map(s => s.split('.')[0] ?? ''))].filter(n => /^[A-Za-z_][\w-]*$/.test(n))
}
/** One digest per pinned module of each venv's site-packages (`<site>/<m>`, `<m>.*`, its package folder) and per module
 * in `extra` (absolute), keyed by the module's root-relative path; mypy's compiled runtime (`*__mypyc.*`) included. */
async function toolDigests(io: Io, venvs: readonly string[], extra: readonly string[], rel: (p: string) => string): Promise<Record<string, string>> {
  const mods: string[] = []
  for (const v of venvs) for (const py of ((await io.exists(`${v}/lib`)) ? await io.list(`${v}/lib`) : []).filter(i => /^(?:python|pypy)\d/.test(i.name)).map(i => i.name)) {
    const site = `${v}/lib/${py}/site-packages`
    if (!(await io.exists(site))) continue
    const runtime = (await io.list(site)).map(i => i.name).filter(n => /__mypyc\./.test(n))
    mods.push(...PINNED_MODULES.map(m => `${site}/${m}`), ...runtime.map(n => `${site}/${n}`))
  }
  return digestsOf(io, [...mods, ...extra], true, rel)
}

/** The refusals of S1 and S2 for these venvs (O-4, A-6, S-4). `roots`: the project and each venv, with each
 * interpreter's own folder, as real paths. */
async function venvProblems(io: Io, venvs: readonly string[], tree: Tree, rel: (p: string) => string, roots: readonly string[]): Promise<Problem[]> {
  const out: Problem[] = []
  // site.py reads `<venv>/bin/pyvenv.cfg` first when it is there (PEP 405), else `<venv>/pyvenv.cfg`: lines end at `\r`
  // too, key and value are stripped as str.strip() strips, the key lower-cased (a non-ASCII key: refused, its lower case
  // can differ), the value compared lower-cased
  for (const v of venvs) {
    const lines = [`${v}/bin/pyvenv.cfg`, `${v}/pyvenv.cfg`].flatMap(c => (tree.lines[c] ?? []).flatMap(l => l.split(PTH_BREAK)).map(line => ({ c, line })))
    for (const { c, line } of lines) if (line.includes('=') && /[^\x00-\x7f]/.test(line.slice(0, line.indexOf('=')))) out.push({ key: 'setup.venvCfg', vars: { file: rel(c) } })
    if (lines.some(({ line }) => { const i = line.indexOf('='); return i >= 0 && pyStrip(line.slice(0, i)).toLowerCase() === 'include-system-site-packages' && pyStrip(line.slice(i + 1)).toLowerCase() === 'true' })) out.push({ key: 'setup.venvSystem', vars: { venv: rel(v) } })
  }
  // a line 3.12 and 3.13 read apart (a form feed, a BOM, …) cannot be checked as both read it
  for (const [file, lines] of Object.entries(tree.lines)) if (/\.pth$/.test(file) && lines.some(l => PTH_READ_APART.test(l))) out.push({ key: 'setup.venvPath', vars: { file: rel(file), path: '(a line Python versions read apart)' } })
  // an import line that computes what it imports cannot be followed into the facts
  for (const [file, lines] of Object.entries(tree.lines)) if (/\.pth$/.test(file) && pthLines(lines).some(l => /^import[ \t]/.test(l) && PTH_DYNAMIC.test(l.replace(PTH_READABLE, '')))) out.push({ key: 'setup.venvPath', vars: { file: rel(file), path: '(an import line that computes what it imports)' } })
  // the paths a .pth line adds and the absolute paths an editable finder maps to; a line that is not UTF-8, or a finder
  // path with an escape, cannot be read as Python reads it, so it is refused
  const cands = Object.entries(tree.lines).flatMap(([file, lines]) => (/\.pth$/.test(file) ? pthPaths(file, lines) : /\.py$/.test(file) ? lines.flatMap(l => [...l.matchAll(/(['"])(\/[^'"\n]*)\1/g)].map(m => (/\\/.test(m[2] ?? '') ? `\\${m[2]}` : normAbs(m[2] ?? '')))) : []).map(path => ({ file, path })))
  for (const [file, lines] of Object.entries(tree.lines)) if (/\.pth$/.test(file) && lines.some(l => l.includes('\ufffd'))) out.push({ key: 'setup.venvPath', vars: { file: rel(file), path: '(a line that is not UTF-8)' } })
  const reals = await realPaths(io, cands.map(c => (c.path.startsWith('\\') ? '' : c.path)))
  // where the code is: the real path when the path exists, else the path as written
  cands.forEach((c, i) => { if (c.path.startsWith('\\') || !inside(reals[i] || c.path, roots)) out.push({ key: 'setup.venvPath', vars: { file: rel(c.file), path: c.path.replace(/^\\/, '') } }) })
  return out
}

/**
 * Runner integrity of the Python stack: the hash, the facts a re-baseline compares (venvRebaseBlock), the pytest11
 * plugins the judge loads by name (`-p`, autoload being off, GAP-R2-0.6-12) and the S1/S2 refusals. 'absent' when no venv
 * is there.
 */
export async function venvState(io: Io, top: string, commands: readonly FlowCommand[], home: string): Promise<RunnerState> {
  const { venvs, others } = await venvsOf(io, top, commands)
  const outside = PYTHON.packageManagers.flatMap(m => m.cacheDirs).map(d => (d.startsWith('~/') ? `${home}${d.slice(1)}` : d))
  const programs = [...new Set(commands.flatMap(c => { const m = /\/bin\/([^/]+)$/.exec(c.argv[0] ?? ''); return m?.[1] ? [m[1]] : [] }))]
  const tree = await treeDigest(io, { roots: [...venvs, ...others], prune: ['__pycache__'], outside, pinned: venvs.map(v => `${v}/bin/python`), project: top, report: startOf(programs), lines: LINES })
  if (tree.hash === 'absent') return { hash: 'absent', facts: '', load: [], problems: [] }
  const rel = (p: string): string => (p.startsWith(`${top}/`) ? p.slice(top.length + 1) : p)
  const interp = Object.fromEntries(venvs.map(v => { const p = tree.pinned[`${v}/bin/python`]; return [rel(v), `${p?.real ?? ''} ${p?.hash ?? ''}`] }))
  // the modules the .pth import lines run first: from the site-packages folder of their .pth, or from a folder inside a
  // venv that a .pth path line put on sys.path (security review round 4)
  const pths = Object.entries(tree.lines).filter(([p]) => p.endsWith('.pth'))
  const added = pths.flatMap(([p, l]) => pthPaths(p, l)).filter(d => venvs.some(v => inside(d, [v])))
  const mods = pths.flatMap(([p, l]) => pthImports(l).flatMap(m => [dirOf(p), ...added].map(d => `${d}/${m}`)))
  const cfgs = new Set(venvs.flatMap(v => [`${v}/pyvenv.cfg`, `${v}/bin/pyvenv.cfg`]))
  const start = Object.fromEntries(Object.entries({ ...tree.hashes, ...(await pathsHashes(io, [...new Set(mods)], true)) }).filter(([p]) => !p.endsWith('/pyvenv.cfg') || cfgs.has(p)).map(([p, h]) => [rel(p), h]).sort(([a = ''], [b = '']) => (a < b ? -1 : 1)))
  const pytest11 = [...new Set(Object.entries(tree.lines).filter(([p]) => p.endsWith('/entry_points.txt')).flatMap(([, l]) => pytest11Of(l)))].sort()
  // each pytest11 plugin's whole distribution (its RECORD), with the entry's own module, in its own site-packages
  const plugins: string[] = []
  for (const [p, l] of Object.entries(tree.lines).filter(([p]) => p.endsWith('/entry_points.txt'))) {
    const own = pytest11Of(l).map(e => e.slice(e.indexOf('=') + 1).trim().split(/[.:\s]/)[0] ?? '').filter(m => /^[A-Za-z_]\w*$/.test(m))
    if (own.length) plugins.push(...[...own, ...(await distModules(io, p))].map(m => `${dirOf(dirOf(p))}/${m}`))
  }
  // an interpreter folder inside the project with no pyvenv.cfg: one digest each, any change is the runner's
  const facts: Facts = { interp, start, pytest11, tool: await toolDigests(io, venvs, plugins, rel), others: await digestsOf(io, others, false, rel) }
  const load = [...new Set(pytest11.map(e => e.slice(0, e.indexOf('='))))].sort()
  // the interpreters' own folders: `<prefix>/bin/python3.x` → `<prefix>` (the standard library, GAP-R2-0.6-7)
  const prefixes = Object.values(tree.pinned).map(p => dirOf(p.real)).filter(d => d.endsWith('/bin')).map(dirOf)
  const roots = [...(await realPaths(io, [top, ...venvs])), ...prefixes]
  const problems = [...(await venvProblems(io, venvs, tree, rel, roots)), ...load.filter(n => !PLUGIN_NAME.test(n)).map(name => ({ key: 'setup.venvPlugin', vars: { name } }))]
  return { hash: tree.hash, facts: JSON.stringify(facts), load: load.filter(n => PLUGIN_NAME.test(n)), problems }
}

/**
 * Why a re-baseline after an accepted dependency change is refused (AC-RI-3, S-4), or null: a venv's interpreter, its
 * `pyvenv.cfg`, a `.pth` file or a customize module added or changed, a `pytest11` plugin added, a toolchain package's
 * files changed (owner decision 2026-10-19), a venv or one of its pyvenv.cfg files gone (Python then reads the base
 * interpreter's site-packages, or the other file; security review round 4), or an interpreter folder without one
 * changed. Other removals pass.
 * ASSUMPTION(GAP-R2-0.6-63): a changed `.pth` or customize module blocks like an added one (it can run code at start).
 */
export function venvRebaseBlock(frozen: string, now: string): string | null {
  let a: Facts, b: Facts
  try { a = JSON.parse(frozen) as Facts; b = JSON.parse(now) as Facts } catch { return 'pyvenv.cfg' }
  const differs = (x: Record<string, string>, y: Record<string, string>): string | undefined => Object.keys(y).sort().find(k => x[k] !== y[k])
  const gone = (x: Record<string, string>, y: Record<string, string>, f: (k: string) => boolean): string | undefined => Object.keys(x).sort().find(k => f(k) && !(k in y))
  const interp = differs(a.interp ?? {}, b.interp ?? {}) ?? gone(a.interp ?? {}, b.interp ?? {}, () => true)
  if (interp !== undefined) return `${interp}/bin/python`
  const start = differs(a.start ?? {}, b.start ?? {}) ?? gone(a.start ?? {}, b.start ?? {}, k => k.endsWith('pyvenv.cfg'))
  if (start !== undefined) return start
  const plugin = (b.pytest11 ?? []).find(e => !(a.pytest11 ?? []).includes(e))
  if (plugin !== undefined) return `pytest11 ${plugin}`
  const other = differs(a.others ?? {}, b.others ?? {}) ?? gone(a.others ?? {}, b.others ?? {}, () => true)
  if (other !== undefined) return other
  return toolChanged(a.tool, b.tool)
}
