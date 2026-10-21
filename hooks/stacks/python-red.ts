// The Python stack's RED freeze (R2 plan §4.2, AC-STK-5). At RED each F test file's added lines and test functions are
// recorded, read as the whole file lexes them: a line is its indentation, its code with white space collapsed and its
// strings and comments as written (a reformat of the code is no change; an edit of a literal or a move into another
// block is). Each RED test is kept with its path (class and name) and its block, decorators included.
// Later: a RED line gone, or a RED test's name bound in its scope by anything but exactly the recorded block (a second
// def, an assignment, a decorator put on it, its class defined twice) is red-test-changed. A patch of what the tests
// import, in the file or in a test module it imports, is mock-after-red HIGH: a call of the patch API (pytest's
// monkeypatch and mocker, unittest.mock, under any import name or alias, over several lines) naming an imported name, a
// write to an imported module's attribute, an imported name bound again at the top (by an assignment, a def or class, a
// loop or `with` target, another import) or through `global`, a write to the module table, the builtins or a namespace
// (globals(), vars(), __dict__). A mock that names nothing imported is MEDIUM inside a new function, HIGH elsewhere.
import { hashOf } from '../session'
import { globRe } from '../flow-plan'
import type { DiffFile, LexedLine, RedShape, ScanFinding } from '../flow-scan'
import { PYTHON } from '../../flow/data/stacks/python'
import { lexLines } from './python-lex'
import { importLines, importsOf, moduleFiles, resolveImport } from './python-tests'

type Lex = { readonly text: string; readonly code: string; readonly lit: string; readonly n: number }
type Scope = { readonly kind: string; readonly name: string; readonly ind: number }
const indentOf = (t: string): number => /^[ \t]*/.exec(t.replace(/\t/g, '        '))?.[0].length ?? 0
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const DEF = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, TEST_DEF = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, SCOPE = /^\s*(?:async\s+)?(def|class)\s+(\w+)/
const IMPORT_LINE = /^\s*(?:from|import)\s/
/** Test modules: a helper the RED file imports counts only there (a module under test may set attributes). */
const TEST_SIDE = PYTHON.testFiles.map(globRe)

const lexOf = (text: string, x: LexedLine | undefined, n: number): Lex => ({ text, code: x?.code ?? '', lit: (x?.parts ?? []).map(p => p.text).join('\u0001'), n })
/** A file's lines with something on them, lexed in order: the whole new text when it is the diff's (every added line
 * found at its number), else the kept lines hunk by hunk. `added`: the added ones among them. */
function readFile(f: DiffFile, whole: string | undefined): { file: Lex[]; added: Lex[] } {
  const plus = f.lines.filter(l => l.kind === '+'), all = whole?.split('\n')
  const lines = all && plus.every(l => all[l.n - 1] === l.text) ? all.map((text, i) => ({ text, n: i + 1 })) : f.lines.filter(l => l.kind !== '-').map(l => ({ text: l.text, n: l.n }))
  const lx = lexLines(lines), ns = new Set(plus.map(l => l.n))
  const file = lines.map((l, i) => lexOf(l.text, lx[i], l.n)).filter(l => l.text.trim())
  return { file, added: file.filter(l => ns.has(l.n)) }
}
const lineHash = (l: Lex): string => hashOf(`${indentOf(l.text)}\u0000${l.code.trim().replace(/\s+/g, ' ')}\u0000${l.lit}`)
/** Each line's enclosing defs and classes, by indentation (a def or class line's own scope is the one around it). */
function scopesOf(ls: readonly Lex[]): Scope[][] {
  const out: Scope[][] = [], stack: Scope[] = []
  for (const l of ls) {
    if (!l.code.trim()) { out.push([...stack]); continue }
    const ind = indentOf(l.text)
    while (stack.length && ind <= (stack.at(-1)?.ind ?? -1)) stack.pop()
    out.push([...stack])
    const m = SCOPE.exec(l.code)
    if (m) stack.push({ kind: m[1] ?? '', name: m[2] ?? '', ind })
  }
  return out
}
/** Function blocks: from the first decorator above the def to the last line under it. */
function blocks(ls: readonly Lex[], re: RegExp): Array<{ start: number; def: number; end: number; name: string }> {
  const out: Array<{ start: number; def: number; end: number; name: string }> = []
  for (let i = 0; i < ls.length; i += 1) {
    const m = re.exec(ls[i]?.code ?? '')
    if (!m) continue
    const ind = indentOf(ls[i]?.text ?? '')
    let s = i, e = i
    for (let j = i - 1; j >= 0 && indentOf(ls[j]?.text ?? '') === ind && (/^\s*@/.test(ls[j]?.code ?? '') || !(ls[j]?.code ?? '').trim()); j -= 1) if (/^\s*@/.test(ls[j]?.code ?? '')) s = j
    for (let j = i + 1; j < ls.length && !((ls[j]?.code ?? '').trim() && indentOf(ls[j]?.text ?? '') <= ind); j += 1) e = j
    out.push({ start: s, def: i, end: e, name: m[1] ?? '' })
  }
  return out
}
const classPath = (scope: readonly Scope[]): string => scope.filter(s => s.kind === 'class').map(s => s.name).join('.')
const splitNames = (t: string): string[] => t.split(/[\s,*]+/).filter(x => /^[A-Za-z_]\w*$/.test(x))
/** The names a line of code binds in its scope: a def or class, an import, assignment and loop targets, `as` and walrus
 * names, and `global` or `del` names. */
function namesBound(c: string): string[] {
  const d = SCOPE.exec(c)
  if (d) return [d[2] ?? '']
  if (IMPORT_LINE.test(c)) return [...importsOf([c]).keys()]
  const out: string[] = []
  const a = /^\s*([\w\s,*]{1,200}?)\s*(?::[^=\n]{0,200})?(?:[-+*/%&|^@]|\/\/|\*\*|<<|>>)?=(?!=)/.exec(c), f = /^\s*(?:async\s+)?for\s+([\w\s,*]{1,200}?)\s+in\b/.exec(c), g = /^\s*(?:global|del)\s+([\w\s,]{1,200})/.exec(c)
  for (const m of [a, f, g]) if (m) out.push(...splitNames(m[1] ?? ''))
  for (const m of c.matchAll(/\b([A-Za-z_]\w*)\s*:=|\bas\s+([A-Za-z_]\w*)/g)) out.push(m[1] ?? m[2] ?? '')
  return out
}

/** At RED: per F test file, its added lines' hashes and each new test's lines (decorators to its end) and path. */
export function redShape(files: readonly DiffFile[], testFiles: readonly string[], texts: Readonly<Record<string, string>> = {}): Record<string, RedShape> {
  const out: Record<string, RedShape> = {}
  for (const f of files.filter(x => testFiles.includes(x.path))) {
    const { file, added } = readFile(f, texts[f.path]), hashes = file.map(lineHash), scopes = scopesOf(file), ns = new Set(added.map(l => l.n))
    const tests = blocks(file, TEST_DEF).filter(b => ns.has(file[b.def]?.n ?? -1) && !(scopes[b.def] ?? []).some(s => s.kind === 'def'))
    out[f.path] = { lines: added.map(lineHash), blocks: tests.map(b => hashes.slice(b.start, b.end + 1)), names: tests.map(b => [classPath(scopes[b.def] ?? []), b.name].filter(Boolean).join('.')) }
  }
  return out
}

/** Methods only the patch API has (any receiver), the builtins that set an attribute, and either reached by getattr
 * (its string read on the raw line). */
const PATCH_METHOD = /\.\s*(?:setattr|delattr|setitem|delitem|__setattr__|__delattr__)\s*\(\s*(?:[^\s)]|$)|(?<![\w.])(?:setattr|delattr)\s*\(\s*(?:[^\s)]|$)/
const GETATTR_RAW = /\bgetattr\s*\([^)\n]{0,200}['"](?:setattr|delattr|setitem|delitem|patch|object|dict|multiple|__setattr__)['"]/
const MODULE_TABLE = /\bsys\s*\.\s*modules\s*(?:\[[^\]\n]{0,200}\]\s*=(?!=)|\.\s*(?:update|setdefault|pop|clear)\s*\()|\bdel\s+sys\s*\.\s*modules\b/
const NAMESPACE = /\b(?:globals|vars|locals)\s*\([^)\n]{0,100}\)\s*(?:\[[^\]\n]{0,200}\]\s*=(?!=)|\.\s*update\s*\()|\.\s*__dict__\s*(?:\[[^\]\n]{0,200}\]\s*=(?!=)|\.\s*update\s*\()|\b__builtins__\b|\bbuiltins\s*\.\s*\w+\s*=(?!=)/
/** Mocks and environment changes that name nothing in particular. */
const MOCK_SOFT = /\b(?:Magic|Async|NonCallable)?Mock\s*\(|\bcreate_autospec\s*\(|\bmocker\s*\.\s*(?:spy|stub)\b|\bmonkeypatch\s*\.\s*(?:setenv|delenv|chdir|syspath_prepend)\b/
const PATCH_PARTS = new Set(['patch', 'mock', 'object', 'dict', 'multiple'])

/** The names that reach the patch API in a file: pytest's fixtures and unittest.mock's usual names, any import of
 * unittest.mock, mock or pytest_mock (`from unittest.mock import patch as p`), a MonkeyPatch made by hand, and a plain
 * alias of any of these (`mp = monkeypatch`, `po = mock.patch.object`). */
function patchCall(ls: readonly Lex[]): RegExp {
  const out = new Set(['monkeypatch', 'mocker', 'mock', 'patch'])
  for (const [local, v] of importsOf(ls.map(l => l.code))) if (/^(?:unittest\.mock|mock|pytest_mock)$/.test(v.spec) || (v.spec === 'unittest' && v.name === 'mock') || v.name === 'MonkeyPatch') out.add(local)
  for (const { code: c } of ls) {
    const a = /^\s*(\w+)\s*=\s*([\w.]+)\s*(?:\(|$)/.exec(c), path = (a?.[2] ?? '').replace(/^unittest\./, '').split('.')
    if (a && ((out.has(path[0] ?? '') && path.slice(1).every(x => PATCH_PARTS.has(x))) || path.at(-1) === 'MonkeyPatch')) out.add(a[1] ?? '')
    const made = /\bMonkeyPatch\b[^#\n]{0,200}\bas\s+(\w+)/.exec(c)
    if (made) out.add(made[1] ?? '')
  }
  return new RegExp(`(?<![\\w.])(?:unittest\\s*\\.\\s*)?(?:${[...out].map(escapeRe).join('|')})(?:\\s*\\.\\s*(?:mock|patch|object|dict|multiple))*\\s*\\(\\s*(?:[^\\s)]|$)`)
}
const refersTo = (text: string, names: readonly string[]): boolean => names.some(n => new RegExp(`(?<![\\w.])${escapeRe(n)}(?!\\w)`).test(text))
/** A call that starts on line `i` with the lines it runs over (to its closing bracket, at most 30 lines), as text. */
function callText(ls: readonly Lex[], i: number): string {
  let depth = 0, j = i
  for (; j < ls.length && j < i + 30; j += 1) { const c = ls[j]?.code ?? ''; depth += (c.match(/[([{]/g)?.length ?? 0) - (c.match(/[)\]}]/g)?.length ?? 0); if (depth <= 0) break }
  return ls.slice(i, j + 1).map(l => l.text).join('\n')
}

/** What a whole file reaches: the names its imports bind and the modules they name, which line binds each by import,
 * its patch-API call, and each line's scope. */
type Reach = { readonly ls: readonly Lex[]; readonly names: readonly string[]; readonly byImport: ReadonlyMap<string, ReadonlySet<number>>; readonly patch: RegExp; readonly scopes: Scope[][] }
function reachOf(ls: readonly Lex[]): Reach {
  const stmts = importLines(ls.map(l => l.code)), byImport = new Map<string, Set<number>>()
  for (const s of stmts) for (const [k] of s.binds) byImport.set(k, new Set([...(byImport.get(k) ?? []), s.line]))
  const specs = stmts.flatMap(s => s.binds.map(([, v]) => v.spec)).filter(s => s && !s.startsWith('.'))
  return { ls, names: [...new Set([...byImport.keys(), ...specs])], byImport, patch: patchCall(ls), scopes: scopesOf(ls) }
}
const isPatchCall = (l: Lex, r: Reach): boolean => PATCH_METHOD.test(l.code) || r.patch.test(l.code) || (/\bgetattr\s*\(/.test(l.code) && GETATTR_RAW.test(l.text))
/** Whether line `i` of the file patches what it imports: hard, whatever function it sits in. `rebind`: an imported
 * name bound again at the top or through `global` counts (the RED file; a helper's own names do not reach its tests). */
function hardAt(r: Reach, i: number, rebind: boolean): boolean {
  const l = r.ls[i], code = l?.code ?? ''
  if (!l) return false
  if (MODULE_TABLE.test(code) || NAMESPACE.test(code)) return true
  if (isPatchCall(l, r) && refersTo(callText(r.ls, i), r.names)) return true
  if (r.names.length && new RegExp(`^\\s*(?:${r.names.map(escapeRe).join('|')})(?:\\s*\\.\\s*\\w+)+\\s*(?:[-+*/%&|^@]|//|\\*\\*|<<|>>)?=(?!=)`).test(code)) return true
  if (!rebind) return false
  const top = !(r.scopes[i] ?? []).some(s => s.kind === 'def' || s.kind === 'class'), global = /^\s*global\s/.test(code)
  if (!top && !global) return false
  // an import binds again only a name another line imports; anything else binds again any imported name
  return namesBound(code).some(k => { const at = r.byImport.get(k); return at !== undefined && (!IMPORT_LINE.test(code) || [...at].some(x => x !== i)) })
}
/** The first added line of a test module that patches what it imports (hard forms only). */
function patchesIn(f: DiffFile, whole: string | undefined): number | null {
  const { file, added } = readFile(f, whole), r = reachOf(file), ns = new Set(added.map(l => l.n))
  return file.find((l, i) => ns.has(l.n) && hardAt(r, i, false))?.n ?? null
}

/** Whether a RED test's name is bound in its scope by exactly its recorded block, and its class once at the top. */
function testHeld(r: Reach, hashes: readonly string[], path: string, block: readonly string[]): boolean {
  const parts = path.split('.'), name = parts.at(-1) ?? '', classes = parts.slice(0, -1).join('.')
  const inScope = (i: number): boolean => classPath(r.scopes[i] ?? []) === classes && !(r.scopes[i] ?? []).some(s => s.kind === 'def')
  const binders = r.ls.flatMap((l, i) => (inScope(i) && namesBound(l.code).includes(name) ? [i] : []))
  const b = binders.length === 1 ? blocks(r.ls, DEF).find(x => x.def === binders[0]) : undefined
  if (!b || b.end - b.start + 1 !== block.length || hashes.slice(b.start, b.end + 1).some((h, k) => h !== block[k])) return false
  const top = parts[0] ?? ''
  return !classes || r.ls.filter((l, i) => !(r.scopes[i] ?? []).length && namesBound(l.code).includes(top)).length === 1
}

/** FL findings for each RED file: red-test-changed and mock-after-red. `texts`: the files' full new text (each file as
 * the whole of it lexes, its imports). A test module the RED file imports that gains a patch in this diff is reported
 * at that module's line. */
export function redFindings(files: readonly DiffFile[], red: Readonly<Record<string, RedShape>>, texts: Readonly<Record<string, string>> = {}): ScanFinding[] {
  const out: ScanFinding[] = []
  for (const [file, shape] of Object.entries(red)) {
    const f = files.find(x => x.path === file), { file: ls, added } = f ? readFile(f, texts[file]) : { file: [], added: [] }
    const hashes = ls.map(lineHash), now = added.map(lineHash), left = new Map<string, number>()
    for (const h of now) left.set(h, (left.get(h) ?? 0) + 1)
    const lost = shape.lines.some(h => { const n = left.get(h) ?? 0; left.set(h, n - 1); return n <= 0 })
    const r = reachOf(ls)
    // each RED test bound in its scope by exactly its block (a copy beside it, a second def, a decorator are no alibi)
    const changed = shape.names ? shape.names.some((path, k) => !testHeld(r, hashes, path, shape.blocks[k] ?? [])) : false
    if (lost || changed) out.push({ kind: 'FL', rule: 'red-test-changed', sev: 'HIGH', loc: file })
    const ns = new Set(added.map(l => l.n)), atRed = new Map<string, number>()
    for (const h of shape.lines) atRed.set(h, (atRed.get(h) ?? 0) + 1)
    // new functions (fixtures, helpers, tests) other than the RED tests: their own mocks are MEDIUM
    const redPaths = new Set(shape.names ?? []), redDefs = new Set(shape.blocks.map(b => b[0] ?? ''))
    const fresh = blocks(ls, DEF).filter(b => ns.has(ls[b.def]?.n ?? -1) && (shape.names ? !redPaths.has([classPath(r.scopes[b.def] ?? []), b.name].filter(Boolean).join('.')) : !redDefs.has(hashes[b.def] ?? '')))
    let worst: { sev: 'HIGH' | 'MEDIUM'; n: number } | null = null
    ls.forEach((l, i) => {
      if (!ns.has(l.n)) return
      const h = hashes[i] ?? '', c = atRed.get(h) ?? 0
      atRed.set(h, c - 1)
      if (c > 0) return
      const hard = hardAt(r, i, true)
      if (!hard && !isPatchCall(l, r) && !MOCK_SOFT.test(l.code)) return
      const sev = hard || !fresh.some(b => i >= b.start && i <= b.end) ? 'HIGH' : 'MEDIUM'
      if (!worst || (sev === 'HIGH' && worst.sev === 'MEDIUM')) worst = { sev, n: l.n }
    })
    // a test module the RED file imports (`from m import n` can name the module m.n) that gains a patch
    const specs = [...importsOf(ls.map(l => l.code)).values()].flatMap(v => [v.spec, ...(v.name ? [/^\.+$/.test(v.spec) ? `${v.spec}${v.name}` : `${v.spec}.${v.name}`] : [])])
    const helpers = new Set(specs.flatMap(s => { const rel = resolveImport(file, s); return rel ? files.filter(x => x.path !== file && moduleFiles(rel).includes(x.path) && TEST_SIDE.some(t => t.test(x.path))) : [] }))
    for (const helper of helpers) { const n = patchesIn(helper, texts[helper.path]); if (n !== null) out.push({ kind: 'FL', rule: 'mock-after-red', sev: 'HIGH', loc: `${helper.path}:${n}` }) }
    const w = worst as { sev: 'HIGH' | 'MEDIUM'; n: number } | null
    if (w) out.push({ kind: 'FL', rule: 'mock-after-red', sev: w.sev, loc: `${file}:${w.n}` })
  }
  return out
}
