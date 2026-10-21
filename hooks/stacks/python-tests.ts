// The Python stack's reading of test code (R2 plan §4.2): test functions and classes and the names a diff removes and
// adds, a file's imports and the files a module can be, the eval ids in test names and strings, and the patterns that
// force a security review. Read on code only (python-lex.ts), so a name in a docstring or a comment is not a test.
import { touchesSecurity } from '../../flow/parse'
import { git, type GitPaths } from '../flow-git'
import type { Io } from '../session'
import type { DeclChanges } from '../flow-judge'
import type { DiffFile } from '../flow-scan'
import type { Stack } from '../../flow/data/types'
import { lexLines, lexText } from './python-lex'

/** pytest's default test functions (python_functions = test*), plain or async. */
const TEST_DEF = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/
/** A class pytest collects: named Test* (python_classes), or a unittest TestCase. */
const CLASS = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\)?)?\s*:?/
const codes = (lines: readonly string[]): string[] => lexText(lines).map(x => x.code)
/** Per changed line, the first name `read` finds in any of the line's readings. */
const named = (read: (code: string) => string | undefined) => (lines: ReadonlyArray<readonly string[]>): string[] =>
  lines.flatMap(cs => cs.map(read).filter((n): n is string => Boolean(n)).slice(0, 1))
const testNames = named(c => TEST_DEF.exec(c)?.[1])
const suites = named(c => {
  const m = CLASS.exec(c), name = m?.[1] ?? ''
  return name && (name.startsWith('Test') || /TestCase\b/.test(m?.[2] ?? '')) ? name : undefined // IsolatedAsyncioTestCase, APITestCase
})
/** Texts of whole files by path, one side of a diff. */
export type SideTexts = Readonly<Record<string, string>>
/** For each line a file's diff changed on one side ('+' added, '-' removed), the code it reads as: from `whole`, that
 * side's text, when every changed line sits at its number there; else two readings, with the side's kept lines hunk by
 * hunk and with the changed lines alone, so a name either one sees counts. A changed line can open a string a kept line
 * closes (535 trial M-5: an edited module docstring hid every test added below it, and RED failed three rounds), and a
 * hunk can start inside a string (its one kept line a closing `"""`). ASSUMPTION(GAP-R2-0.6-142). */
function changedCodes(f: DiffFile, kind: '+' | '-', whole?: string): string[][] {
  const changed = f.lines.filter(l => l.kind === kind), all = typeof whole === 'string' ? whole.split('\n') : undefined
  if (all && changed.every(l => all[l.n - 1] === l.text)) { const lx = lexText(all); return changed.map(l => [lx[l.n - 1]?.code ?? '']) }
  const side = f.lines.filter(l => l.kind === kind || l.kind === ' ')
  const hunks = lexLines(side.map(l => ({ n: kind === '-' && l.kind === ' ' ? (l.o ?? 0) : l.n, text: l.text })))
  const alone = codes(changed.map(l => l.text))
  return side.flatMap((l, i) => (l.kind === kind ? [hunks[i]?.code ?? ''] : [])).map((c, k) => [c, alone[k] ?? ''])
}
const sideOf = (files: readonly DiffFile[], testFiles: readonly string[], kind: '+' | '-', texts?: SideTexts): string[][] =>
  files.filter(f => testFiles.includes(f.path)).flatMap(f => changedCodes(f, kind, texts?.[f.path]))

/** The test and class names the diff removes and adds in the given test files (renames, deletions, re-declarations);
 * `texts`: the files whole on the old (`before`) and new (`now`) side, where the caller has them. */
export function declChanges(files: readonly DiffFile[], testFiles: readonly string[], texts: { before?: SideTexts; now?: SideTexts } = {}): Required<DeclChanges> {
  const [minus, plus] = [sideOf(files, testFiles, '-', texts.before), sideOf(files, testFiles, '+', texts.now)]
  return { removedTitles: testNames(minus), addedTitles: testNames(plus), removedSuites: suites(minus), addedSuites: suites(plus) }
}
/** Tests added in the diff of the feature's test files, by function name (a method's report id adds its class path);
 * `now`: the files whole on the new side, where the caller has them. */
export const addedTests = (files: readonly DiffFile[], testFiles: readonly string[], now?: SideTexts): Array<{ file: string; name: string }> =>
  files.filter(f => testFiles.includes(f.path)).flatMap(f => testNames(changedCodes(f, '+', now?.[f.path])).map(name => ({ file: f.path, name })))

const FROM = /^[ \t]*from[ \t]+(\.*(?:\w+(?:\.\w+)*)?)[ \t]+import[ \t]+(.*)$/, IMPORT = /^[ \t]*import[ \t]+(.*)$/
/** A file's imports: local name → the module and the name it binds. `from m import a as b`: b → (m, a); `import m.n`:
 * m → (m, ''); `import m.n as k`: k → (m.n, ''). A parenthesised list or a backslash carries a statement on (at most
 * 200 lines); `;` separates statements. Read line by line, in linear time. */
export function importsOf(lines: readonly string[]): Map<string, { spec: string; name: string }> {
  return new Map(importLines(codes(lines)).flatMap(x => x.binds))
}
/** The import statements of lexed code lines: the line each starts on and the names it binds (local → module, name). */
export function importLines(cs: readonly string[]): Array<{ line: number; binds: Array<[string, { spec: string; name: string }]> }> {
  const out: Array<{ line: number; binds: Array<[string, { spec: string; name: string }]> }> = []
  for (let i = 0; i < cs.length; i += 1) {
    if (!/^[ \t]*(?:from|import)[ \t]/.test(cs[i] ?? '')) continue
    const line = i
    let stmt = cs[i] ?? ''
    for (let k = 0; k < 200 && i + 1 < cs.length && (/\\[ \t]*$/.test(stmt) || (stmt.includes('(') && !stmt.includes(')'))); k += 1) { i += 1; stmt = `${stmt.replace(/\\[ \t]*$/, '')} ${cs[i] ?? ''}` }
    const binds: Array<[string, { spec: string; name: string }]> = []
    for (const part of stmt.split(';')) {
      const from = FROM.exec(part), imp = from ? null : IMPORT.exec(part)
      for (const item of (from?.[2] ?? imp?.[1] ?? '').replace(/[()]/g, ' ').split(',').map(x => x.trim()).filter(Boolean)) {
        const [name = '', local] = item.split(/\s+as\s+/).map(x => x.trim())
        if (from && name && name !== '*') binds.push([local ?? name, { spec: from[1] ?? '', name }])
        if (imp && name) binds.push([local ?? (name.split('.')[0] ?? name), { spec: local ? name : (name.split('.')[0] ?? name), name: '' }])
      }
    }
    out.push({ line, binds })
  }
  return out
}

/** A module spec as a root-relative module path without extension: `spikefix.core` → `spikefix/core`, `.core` from
 * `src/pkg/a.py` → `src/pkg/core`, `..` one package up; null for a malformed spec or one above the root. */
export function resolveImport(from: string, spec: string): string | null {
  const m = /^(\.*)((?:\w+(?:\.\w+)*)?)$/.exec(spec)
  if (!m || (!m[1] && !m[2])) return null
  const rest = (m[2] ?? '').split('.').filter(Boolean)
  if (!m[1]) return rest.join('/')
  const dir = from.split('/').slice(0, -1), up = (m[1] ?? '').length - 1
  return up > dir.length ? null : [...dir.slice(0, dir.length - up), ...rest].join('/') || null
}
/** The files an import of module path `rel` can load: the module or the package, at the root, under src/ (the src
 * layout) or under a tests folder (pytest puts it on sys.path). */
export const moduleFiles = (rel: string): string[] => [...new Set(['', 'src/', 'tests/', 'test/'].flatMap(d => [`${d}${rel}.py`, `${d}${rel}/__init__.py`]))]

/** Eval ids in the worktree's test files, tracked or not, in the stack's spellings: in a test function's name
 * (`test_ac_001_x`) or a string of the code (a parametrize id, `id="AC-001 empty"`), comments aside (GAP-R2-0.6-44):
 * id → files. */
export async function evalIdsInTests(io: Io, p: GitPaths, testGlobs: readonly string[], stack: Stack): Promise<Map<string, string[]>> {
  // a prefilter that must hold every spelling in the stack's evalIdForms (grep has no lookbehind)
  const r = await git(io, p.top, ['grep', '--untracked', '-I', '-z', '-l', '-E', '(AC|ac)[-_][0-9]{3}', '--', ...testGlobs.map(g => `:(glob)${g}`)])
  if (r.exitCode > 1 || r.isStdoutTruncated) throw new Error(`git grep failed: ${r.stderr.trim().slice(0, 200)}`)
  const forms = stack.evalIdForms.map(f => new RegExp(f, 'g')), out = new Map<string, string[]>()
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    const lexed = lexText((await io.read(`${p.top}/${file}`)).split('\n'))
    const texts = lexed.flatMap(l => [TEST_DEF.exec(l.code)?.[1] ?? '', ...l.parts.filter(x => !x.comment).map(x => x.text)])
    for (const t of texts) for (const f of forms) for (const m of t.matchAll(f)) { const id = `AC-${m[1] ?? ''}`; out.set(id, [...new Set([...(out.get(id) ?? []), file])]) }
  }
  return out
}

/** Whether added or removed lines of a Python file match a pattern that forces `Security: yes` (step 4 adds the
 * runtime reach read on code and the test-file rules). */
export const securityForced = (files: readonly DiffFile[], stack: Stack): boolean =>
  files.some(f => /\.pyi?$/.test(f.path) && f.lines.some(l => l.kind !== ' ' && touchesSecurity(l.text, stack)))
