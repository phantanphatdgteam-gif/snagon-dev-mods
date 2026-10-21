// The RED freeze (plan v7.1 §3.3): at RED the added test hunks of each F test file are recorded; later, a removed or
// changed RED line, a line inserted into a RED test, or a mock, spy or patch of imported code added to that file is FL.
// Adding more tests is fine: a spy inside a new test is only MEDIUM. The TypeScript stack's (hooks/flow-red.ts until
// R2 step 1, unchanged).
import { hashOf } from '../session'
import { TEST_START, SUITE_START, depth, codeOf } from './typescript-lex'
import { resolveSpec, moduleFiles } from './typescript-sources'
import type { DiffFile, RedShape, ScanFinding } from '../flow-scan'

export const norm = (t: string): string => t.trim().replace(/\s+/g, ' ')
/** The test (or suite) blocks in a list of lines, as index ranges: an opener to the line that closes it. */
function blockRanges(lines: readonly string[], start: RegExp = TEST_START): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!start.test(lines[i] ?? '')) continue
    let d = 0, j = i
    for (; j < lines.length; j += 1) { d += depth(lines[j] ?? ''); if (d <= 0) break }
    out.push([i, Math.min(j, lines.length - 1)])
    i = j
  }
  return out
}
/** At RED: per F test file, the shape later edits must keep (whitespace-normalized, so a reformat is not a change). */
export function redShape(files: readonly DiffFile[], testFiles: readonly string[]): Record<string, RedShape> {
  const out: Record<string, RedShape> = {}
  for (const f of files.filter(x => testFiles.includes(x.path))) {
    const lines = f.lines.filter(l => l.kind === '+' && norm(l.text)).map(l => hashOf(norm(l.text)))
    out[f.path] = { lines, blocks: blockRanges(f.lines.filter(l => l.kind === '+' && norm(l.text)).map(l => l.text)).map(([s, e]) => lines.slice(s, e + 1)) }
  }
  return out
}
const hasRun = (seq: readonly string[], run: readonly string[]): boolean => seq.some((_, i) => run.every((h, k) => seq[i + k] === h))

/** Replacing what a RED test exercises, wherever it is written: module mocks, matcher extension, property patches
 * (Object.assign into an existing object, defineProperty, Object[...], Reflect, __proto__), and a bare side-effect
 * import (its module runs, unseen, before the tests). */
const MOCK_HARD = /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|unmock|hoisted|stubGlobal|stubEnv|setMock|replaceProperty)\b|\bexpect\s*\.\s*extend\s*\(|\bObject\s*(?:\.\s*(?:assign\s*\(\s*(?!\{)|defineProperty|defineProperties|setPrototypeOf)|\[)|\bReflect\b|__proto__|^\s*import\s+['"`]/
/** `prototype` anywhere in code (`X.prototype.y =`, `const { prototype: P } = X`), except as the target of a spy. */
const PROTOTYPE = /\bprototype\b/, SPY_ON_PROTOTYPE = /\bspyOn\s*\(\s*[^,()]*\bprototype\b\s*,/
/** Any member write (`a.b = …`, `a[k] += …`), read on code: outside a new test it changes what RED tests see. */
const MEMBER_WRITE = /[\w$\])]\s*(?:\??\.\s*[\w$]+|\[[^\]]*\])\s*(?:[+\-*/%&|^]|\*\*|<<|>>>?|\?\?|\|\||&&)?=(?![=>])/
/** Spies and mock implementations: scoped when written inside a new test. */
const MOCK_SOFT = /\b(?:vi|jest)\s*\.\s*spyOn\b|\.\s*mock(?:Return|Resolved|Rejected|Implementation)/
/** Built-ins whose members a test can overwrite to change what the code under test sees (DOM and console left out:
 * tests set those up as a matter of course). */
const GLOBAL_ROOTS = ['globalThis', 'global', 'Math', 'Date', 'JSON', 'Array', 'Object', 'Number', 'String', 'Promise', 'Symbol', 'Intl', 'crypto', 'performance']
const alt = (names: readonly string[]): string => names.map(n => n.replace(/\$/g, '\\$')).join('|')
/** An assignment to a member of one of `names`, through casts (`(x as any).y =`, `(<any>x).y =`, `x!.y =`). */
const memberWrite = (names: readonly string[]): RegExp => new RegExp(`^[\\s;(]*(?:<[^>]+>\\s*)?(?:${alt(names)})(?![\\w$])!?(?:\\s+as\\s+[^)=]+)?\\)?(?:\\s*\\??\\.\\s*[\\w$]+|\\s*\\[[^\\]]+\\])+\\s*=(?!=)`)
/** Local names a file imports (default, namespace, named), one import statement at a time, with the aliases made of
 * them or of the built-in roots (`const p = pricing`, `const b = p`, `const D = Date`), followed to a fixed point. */
function importedNames(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^\s*import\s+(?!type\b)([^;'"`]*?)\s+from\s*['"][^'"]+['"]/gm)) {
    const clause = (m[1] ?? '').trim()
    out.push(/\*\s+as\s+([\w$]+)/.exec(clause)?.[1] ?? '', /^([\w$]+)/.exec(clause)?.[1] ?? '')
    for (const item of /\{([^}]*)\}/.exec(clause)?.[1]?.split(',') ?? []) out.push(item.trim().startsWith('type ') ? '' : item.trim().split(/\s+as\s+/).at(-1)?.trim() ?? '')
  }
  let names = [...new Set(out)].filter(n => /^[\w$]+$/.test(n))
  for (let hop = 0; hop < 5; hop += 1) {
    const more = [...text.matchAll(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:<[^>]+>\\s*)?\\(?\\s*(?:${alt([...names, ...GLOBAL_ROOTS])})(?![\\w$])\\s*(?:as\\s+[^;)]+)?\\)?\\s*;?\\s*$`, 'gm'))].map(m => m[1] ?? '').filter(a => a && !names.includes(a))
    if (!more.length) break
    names = [...names, ...more]
  }
  return names
}
/** Whether an added line of a helper module patches what tests import: a hard mock, a prototype, or a write to one of
 * its imported bindings or the built-in roots. */
function patchesIn(f: DiffFile): number | null {
  const names = importedNames(f.lines.filter(l => l.kind !== '-').map(l => l.text).join('\n')), write = memberWrite([...names, ...GLOBAL_ROOTS])
  for (const l of f.lines.filter(x => x.kind === '+')) { const code = codeOf(l.text); if (MOCK_HARD.test(l.text) || (/\bprototype\b/.test(code) && !SPY_ON_PROTOTYPE.test(code)) || write.test(l.text)) return l.n }
  return null
}

/** FL findings for each RED file: red-test-changed, and mock-after-red (HIGH; MEDIUM for a spy or a built-in write inside
 * a new test or a new describe). `texts`: the RED files' full text, for their imports. A helper module the RED file
 * imports that gains a patch in this diff is reported at the helper's line. */
export function redFindings(files: readonly DiffFile[], red: Readonly<Record<string, RedShape>>, texts: Readonly<Record<string, string>> = {}): ScanFinding[] {
  const out: ScanFinding[] = []
  for (const [file, shape] of Object.entries(red)) {
    const mine = files.filter(f => f.path === file)
    const add = mine.flatMap(f => f.lines.filter(l => l.kind === '+' && norm(l.text)))
    const now = add.map(l => hashOf(norm(l.text)))
    const left = new Map<string, number>()
    for (const h of now) left.set(h, (left.get(h) ?? 0) + 1)
    const lost = shape.lines.some(h => { const n = left.get(h) ?? 0; left.set(h, n - 1); return n <= 0 })
    if (lost || shape.blocks.some(b => !hasRun(now, b))) out.push({ kind: 'FL', rule: 'red-test-changed', sev: 'HIGH', loc: file })
    const texts0 = add.map(l => l.text), opens = new Set(shape.blocks.map(b => b[0]))
    const fresh = [
      ...blockRanges(texts0).filter(([s, e]) => !shape.blocks.some(b => b.length === e - s + 1 && b.every((h, k) => h === now[s + k]))),
      ...blockRanges(texts0, SUITE_START).filter(([s, e]) => !now.slice(s, e + 1).some(h => opens.has(h))),
    ]
    const text = texts[file] ?? mine.flatMap(f => f.lines.filter(l => l.kind !== '-').map(l => l.text)).join('\n')
    const names = importedNames(text)
    const patch = names.length ? memberWrite(names) : null, globals = memberWrite(GLOBAL_ROOTS)
    const atRed = new Map<string, number>()
    for (const h of shape.lines) atRed.set(h, (atRed.get(h) ?? 0) + 1)
    let worst: { sev: 'HIGH' | 'MEDIUM'; n: number } | null = null
    add.forEach((l, i) => {
      const h = now[i] ?? '', c = atRed.get(h) ?? 0
      atRed.set(h, c - 1)
      if (c > 0) return
      const code = codeOf(l.text), inFresh = fresh.some(([s, e]) => i >= s && i <= e)
      const hard = MOCK_HARD.test(l.text) || (PROTOTYPE.test(code) && !SPY_ON_PROTOTYPE.test(code)) || Boolean(patch?.test(l.text))
      const soft = MOCK_SOFT.test(l.text) || globals.test(l.text) || (!inFresh && MEMBER_WRITE.test(code))
      if (!hard && !soft) return
      const sev = hard || !inFresh ? 'HIGH' : 'MEDIUM'
      if (!worst || (sev === 'HIGH' && worst.sev === 'MEDIUM')) worst = { sev, n: l.n }
    })
    // A module the RED file imports (relatively) that gains a patch in this diff.
    for (const m of text.matchAll(/^\s*import\b[^'"`]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const rel = resolveSpec(file, m[1] ?? '')
      const helper = rel ? files.find(f => moduleFiles(rel).includes(f.path)) : undefined
      const n = helper ? patchesIn(helper) : null
      if (helper && n !== null) out.push({ kind: 'FL', rule: 'mock-after-red', sev: 'HIGH', loc: `${helper.path}:${n}` })
    }
    const w = worst as { sev: 'HIGH' | 'MEDIUM'; n: number } | null
    if (w) out.push({ kind: 'FL', rule: 'mock-after-red', sev: w.sev, loc: `${file}:${w.n}` })
  }
  return out
}
