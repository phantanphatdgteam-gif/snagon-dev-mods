// The TypeScript stack's reading of test code (in hooks/flow-judge.ts until R2 step 1, unchanged): test and suite
// declarations and the titles a diff removes and adds, a file's imports, the eval ids in test titles, and the reach into
// the runtime that forces a security review.
import { touchesSecurity } from '../../flow/parse'
import { git, type GitPaths } from '../flow-git'
import { globRe } from '../flow-plan'
import type { Io } from '../session'
import type { DeclChanges } from '../flow-judge'
import type { DiffFile } from '../flow-scan'
import type { Stack } from '../../flow/data/types'
import { codeOf, lexParts, lexLines, MOD, modsOf } from './typescript-lex'

const closeParen = (t: string, start: number): number => { let d = 0; for (let i = start; i < t.length; i += 1) { if (t[i] === '(') d += 1; else if (t[i] === ')' && --d === 0) return i + 1 } return -1 }
/** Test declarations in a text, with their modifiers: `it('…'`, `test.only(\n '…'`, and the table forms `it.each(rows)('…'`
 * and it.each`table`('…'. A `.test(` method call is not a test. */
export function declarations(text: string): Array<{ title: string; mods: string }> {
  const out: Array<{ title: string; mods: string }> = []
  for (const m of text.matchAll(new RegExp(`(?<![.\\w$])(?:it|test)(${MOD})\\s*`, 'g'))) {
    const at = m.index ?? 0
    if (/^\s*(?:\/\/|\/\*|\*)/.test(text.slice(text.lastIndexOf('\n', at) + 1, at))) continue // a commented-out test
    let i = at + m[0].length
    const mods = modsOf(m[1] ?? '')
    if (/\.each$/.test(mods)) {
      i = text[i] === '`' ? text.indexOf('`', i + 1) + 1 : text[i] === '(' ? closeParen(text, i) : -1
      if (i <= 0) continue
      while (/\s/.test(text[i] ?? '')) i += 1
    }
    if (text[i] !== '(') continue
    i += 1
    while (/\s/.test(text[i] ?? '')) i += 1
    const q = text[i]
    if (q !== '"' && q !== "'" && q !== '`') continue
    let j = i + 1, title = ''
    while (j < text.length && text[j] !== q) { if (text[j] === '\\') { title += text[j + 1] ?? ''; j += 2 } else { title += text[j]; j += 1 } }
    if (j < text.length && title) out.push({ title, mods })
  }
  return out
}
export const titlesIn = (text: string): string[] => declarations(text).map(d => d.title)
const SUITE_TITLE = new RegExp(`(?<![.\\w$])(?:describe|suite|context)${MOD}\\s*\\(\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`, 'g')
/** The test and suite titles the diff removes and adds in the given test files (renames, deletions, re-declarations). */
export function declChanges(files: readonly DiffFile[], testFiles: readonly string[]): Required<DeclChanges> {
  const side = (kind: '+' | '-'): string => files.filter(f => testFiles.includes(f.path)).map(f => f.lines.filter(l => l.kind === kind).map(l => l.text).join('\n')).join('\n')
  const suites = (text: string): string[] => [...text.matchAll(SUITE_TITLE)].map(m => m[2] ?? '').filter(Boolean)
  const [minus, plus] = [side('-'), side('+')]
  return { removedTitles: titlesIn(minus), addedTitles: titlesIn(plus), removedSuites: suites(minus), addedSuites: suites(plus) }
}
/** Tests added in the diff of the feature's test files, by title. */
export const addedTests = (files: readonly DiffFile[], testFiles: readonly string[]): Array<{ file: string; name: string }> =>
  files.filter(f => testFiles.includes(f.path)).flatMap(f => titlesIn(f.lines.filter(l => l.kind === '+').map(l => l.text).join('\n')).map(name => ({ file: f.path, name })))

/** Named and default imports of a file: local name → the module spec and the name it exports. */
export function importsOf(lines: readonly string[]): Map<string, { spec: string; name: string }> {
  const out = new Map<string, { spec: string; name: string }>()
  const text = lines.join('\n')
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const item of (m[1] ?? '').split(',').map(x => x.trim()).filter(x => x && !x.startsWith('type '))) {
      const [name, local] = item.split(/\s+as\s+/).map(x => x.trim())
      if (name) out.set(local ?? name, { spec: m[2] ?? '', name })
    }
  }
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) out.set(m[1] ?? '', { spec: m[2] ?? '', name: 'default' })
  return out
}

/** `{a,b}` choices expanded, since git pathspec globs have none. */
const expandBraces = (g: string): string[] => { const m = /\{([^{}]*)\}/.exec(g); return m ? (m[1] ?? '').split(',').flatMap(x => expandBraces(g.replace(m[0], x))) : [g] }
/** Eval ids declared in test titles (not comments; not skipped, todo or failing-by-design tests) in the worktree's test
 * files, tracked or not: id → files. */
export async function evalIdsInTests(io: Io, p: GitPaths, testGlobs: readonly string[]): Promise<Map<string, string[]>> {
  const specs = testGlobs.flatMap(expandBraces).map(g => `:(glob)${g}`)
  const r = await git(io, p.top, ['grep', '--untracked', '-I', '-z', '-l', '-E', 'AC-[0-9]{3}', '--', ...specs])
  if (r.exitCode > 1 || r.isStdoutTruncated) throw new Error(`git grep failed: ${r.stderr.trim().slice(0, 200)}`)
  const out = new Map<string, string[]>()
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    for (const d of declarations(await io.read(`${p.top}/${file}`))) {
      if (/\.(?:skip|todo|fails|failing)\b/.test(d.mods)) continue
      for (const id of d.title.match(/(?<![\w-])AC-\d{3}(?!\d)/g) ?? []) out.set(id, [...new Set([...(out.get(id) ?? []), file])])
    }
  }
  return out
}

/** What test code has no reason to reach: the process, module loading, globals, eval. Test code runs inside or next to
 * the runner and could rewrite its results; a forced security review is how the MVP sees it (T2, F31). Words prose
 * also uses are read on the code only (literals blanked, regex and template literals lexed), so a title saying
 * "process" is not; the rest, which no title uses, on the raw line, so no literal can hide them. */
const RUNTIME_IN_CODE = /\bprocess\b(?!\s*\.\s*env\b)|\bglobal\b|\brequire\s*\(|\beval\s*\(|\bFunction\s*\(|\bwriteFile/
const BUILTIN = '(?:node:[\\w/]+|fs|fs/promises|child_process|net|tls|http|https|http2|vm|worker_threads|os|module|inspector|process|cluster|dgram)'
const RUNTIME_ANYWHERE = new RegExp([
  '\\bglobalThis\\b', '\\.\\s*constructor\\b(?=\\s*[(.[])', '\\bmainModule\\b', '\\bmodule\\s*\\.\\s*require\\b', '\\bReflect\\s*\\.', '__proto__', '\\b(?:get|set)PrototypeOf\\b',
  '\\bfromCharCode\\b', '\\batob\\s*\\(', '\\.\\s*join\\s*\\(\\s*([\'"`])\\1\\s*\\)\\s*\\]', '\\[\\s*`[^\\]]*\\$\\{', '[\\w$\\])]\\s*\\[[^\\]]*[\'"`]\\s*\\+', '\\]\\s*\\[[^\\]]*\\]\\s*\\(',
  `\\b(?:importActual|requireActual|importMock|requireMock)\\s*\\(\\s*['"\`]${BUILTIN}['"\`]`, `['"\`]node:[\\w/]+['"\`]`, `['"\`]child_process['"\`]`,
].join('|'))
/** A dynamic import of anything but a relative path or a path alias (`@/`, `~/`, `#`), read on the raw line. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!['"`](?:\.{1,2}\/|[@~]\/|#))/
/** Whether added or removed lines of any code file match a pattern that forces `Security: yes`; in test files also
 * any reach into the runtime. */
export function securityForced(files: readonly DiffFile[], stack: Stack): boolean {
  const tests = stack.testFiles.map(globRe)
  return files.some(f => {
    if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(f.path)) return false
    const isTest = tests.some(t => t.test(f.path))
    // The code is read three ways (the state carried from the lines above, and the line alone from code and from inside
    // a template), so a template or regex literal cannot hide a word from all of them.
    const kept = f.lines.filter(l => l.kind !== '-'), carried = isTest ? lexLines(kept).map(x => x.code) : []
    return f.lines.some(l => {
      if (l.kind === ' ') return false
      if (touchesSecurity(l.text, stack)) return true
      if (!isTest) return false
      const at = kept.indexOf(l), codes = [codeOf(l.text), lexParts(l.text, 'tpl').code, at >= 0 ? carried[at] ?? '' : '']
      return codes.some(c => RUNTIME_IN_CODE.test(c)) || RUNTIME_ANYWHERE.test(l.text) || DYNAMIC_IMPORT.test(l.text)
    })
  })
}
