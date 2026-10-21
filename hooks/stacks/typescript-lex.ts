// Light JS/TS reading for the scans and the judge, line by line as a diff shows them: comments, strings, template
// and regex literals told apart from code; bracket depth; where a line sits (a test, a suite, another function, inside
// control flow); code left unreachable after a return; and the test API written with spaces, `?.` or comments.
// The TypeScript stack's lexer (hooks/flow-js.ts until R2 step 1, unchanged).

export type LexState = 'code' | 'block' | 'tpl'
export type LexPart = { text: string; comment: boolean }
/** parts: comment and literal texts; code: the line with literals blanked and comments removed. */
export type Lexed = { parts: LexPart[]; code: string; state: LexState }
type Kept = { n: number; text: string }

/** `it`/`test` modifiers as written: `.only`, ` .only`, `?.only`, `/* x *\/.only`, across lines too. */
export const MOD = '(?:(?:\\s|\\/\\*[^*]*\\*\\/)*(?:\\?\\.|\\.)(?:\\s|\\/\\*[^*]*\\*\\/)*[\\w$]+)*'
export const TEST_START = new RegExp(`(?<![.\\w$])(?:it|test)${MOD}\\s*\\(`)
export const SUITE_START = new RegExp(`(?<![.\\w$])(?:describe|suite|context)${MOD}\\s*\\(`)
/** A test call with its modifiers captured; a tagged-template table opening (`test.each\``, `describe.each\``). */
const TEST_CALL = new RegExp(`(?<![.\\w$])(?:it|test)(${MOD})\\s*\\(`)
const TEST_TABLE = new RegExp(`(?<![.\\w$])(?:it|test)${MOD}\\s*\``), SUITE_TABLE = new RegExp(`(?<![.\\w$])(?:describe|suite|context)${MOD}\\s*\``)
/** test.* calls that are not a test body: Playwright hooks, steps, fixtures. */
const NOT_A_TEST = /\.(?:before|after)(?:Each|All)\b|\.(?:step|use|extend)\b/
/** The test API reached through a computed key (`it[m](…)`): its modifier cannot be read. */
export const TEST_COMPUTED = new RegExp(`(?<![.\\w$])(?:it|test|describe|suite|bench)${MOD}\\s*(?:\\?\\.)?\\s*\\[`)
/** Matched modifiers in one spelling (`it ?. only` → `.only`). */
export const modsOf = (raw: string): string => raw.replace(/\/\*[^*]*\*\/|\s|\?/g, '')
/** A line with member access spelled one way: comments dropped, spaces and `?.` around a dot collapsed. */
export const normCalls = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*(?:\?\.|\.)\s*/g, '.')

/** Whether a `/` at `i` starts a regex literal rather than a division: nothing, punctuation or a keyword before it. */
function regexStart(text: string, i: number): boolean {
  const before = text.slice(0, i).trimEnd()
  return !before || /[(,=:[!&|?{};~<>^%]$/.test(before) || /\b(?:if|while|for)\s*\(.*\)$/.test(before) || /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(before)
}
/** The end (exclusive, flags included) of a regex literal starting at `i`, or -1 when the line closes none. */
function regexEnd(text: string, i: number): number {
  let j = i + 1, inClass = false
  for (; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\\') { j += 1; continue }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) break
  }
  if (j >= text.length || j === i + 1) return -1
  j += 1
  while (/[a-z]/.test(text[j] ?? '')) j += 1
  return j
}

/** One line lexed from the state the line before left. A template's `${…}` is code and is lexed as such. */
export function lexParts(text: string, start: LexState): Lexed {
  const parts: LexPart[] = []
  let st: LexState = start, code = '', cur = '', i = 0
  const push = (comment: boolean): void => { parts.push({ text: cur, comment }); cur = '' }
  while (i < text.length) {
    const c = text[i] ?? '', d = text[i + 1] ?? ''
    if (st === 'block') { if (c === '*' && d === '/') { st = 'code'; push(true); i += 2 } else { cur += c; i += 1 } continue }
    if (st === 'tpl') {
      if (c === '\\') { cur += text.slice(i, i + 2); i += 2 } else if (c === '`') { st = 'code'; push(false); code += '""'; i += 1 } else if (c === '$' && d === '{') {
        let j = i + 2, open = 1
        for (; j < text.length && open > 0; j += 1) { if (text[j] === '{') open += 1; else if (text[j] === '}') open -= 1 }
        const inner = lexParts(text.slice(i + 2, open === 0 ? j - 1 : j), 'code')
        parts.push(...inner.parts)
        code += ` ${inner.code} `
        i = j
      } else { cur += c; i += 1 }
      continue
    }
    if (c === '/' && d === '/') { cur = text.slice(i + 2); push(true); break }
    if (c === '/' && d === '*') { st = 'block'; i += 2; continue }
    if (c === '/' && regexStart(text, i)) {
      const end = regexEnd(text, i)
      if (end > 0) { cur = text.slice(i + 1, end).replace(/\/[a-z]*$/, ''); push(false); code += '/re/'; i = end; continue }
    }
    if (c === '`') { st = 'tpl'; i += 1; continue }
    if (c === '"' || c === "'") { let j = i + 1; while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1; cur = text.slice(i + 1, j); push(false); code += '""'; i = j + 1; continue }
    code += c
    i += 1
  }
  if (cur || st !== 'code') push(st === 'block')
  return { parts, code, state: st }
}
export const codeOf = (text: string): string => lexParts(text, 'code').code
/** Each line lexed with the state carried from the line before; a hunk restarts in code, or in a comment when it starts
 * on a `*` line (inside a JSDoc block). */
export function lexLines(lines: readonly Kept[]): Lexed[] {
  const out: Lexed[] = []
  let state: LexState = 'code', last = -2
  for (const l of lines) {
    if (l.n !== last + 1) state = /^\s*\*(?:\s|$)/.test(l.text) ? 'block' : 'code'
    last = l.n
    const lexed = lexParts(l.text, state)
    state = lexed.state
    out.push(lexed)
  }
  return out
}

const bracketDepth = (code: string): number => (code.match(/[([{]/g)?.length ?? 0) - (code.match(/[)\]}]/g)?.length ?? 0)
/** Brackets a line opens minus those it closes, literals and comments left out. */
export const depth = (text: string): number => bracketDepth(codeOf(text))

const CONTROL = /^\s*(?:\}\s*)?(?:if|else|for|while|do|try|catch|finally|switch|case|default)\b|^\s*\{\s*$/
export type Place = { fn: 'test' | 'suite' | 'other' | 'unknown'; nested: boolean }
/** What a block opener holding a line is: a test or suite body (a tagged-template table found above the line that
 * closes its template), a control-flow block, or anything else. */
function openerKind(kept: readonly Kept[], k: number, code: string): 'test' | 'suite' | 'control' | 'other' {
  const call = TEST_CALL.exec(code)
  if (call) { const mods = modsOf(call[1] ?? ''); return /\.describe\b/.test(mods) ? 'suite' : NOT_A_TEST.test(mods) ? 'other' : 'test' }
  if (SUITE_START.test(code)) return 'suite'
  if (/^\s*""\s*\(/.test(code)) {
    for (let j = k - 1; j >= 0 && kept[j + 1]?.n === (kept[j]?.n ?? -9) + 1; j -= 1) {
      const raw = kept[j]?.text ?? ''
      if (TEST_TABLE.test(raw)) return 'test'
      if (SUITE_TABLE.test(raw)) return 'suite'
      if (raw.includes('`')) break
    }
    return 'other'
  }
  if (/(?:=>|\bfunction\b[^{]*)\s*\{\s*$/.test(code)) return 'other' // a callback, even on an if line
  return CONTROL.test(code) ? 'control' : 'other'
}
/** The visible lines lexed with their carried state, when the caller has not. */
const codesOf = (kept: readonly Kept[], codes?: readonly string[]): readonly string[] => codes ?? lexLines(kept).map(x => x.code)
/**
 * Where line `at` sits, read back through the visible lines: the function holding it (a test or suite callback, any
 * other function or literal), whether control flow (if, loop, try, a bare block) lies between, or unknown when the
 * view ends first. `codes`: the lines' code, when already lexed with their carried state.
 */
export function placeOf(kept: readonly Kept[], at: number, codes?: readonly string[]): Place {
  const c = codesOf(kept, codes)
  let bal = 0, nested = false
  for (let k = at - 1; k >= 0; k -= 1) {
    const l = kept[k], next = kept[k + 1]
    if (!l || (next && next.n !== l.n + 1)) return { fn: 'unknown', nested }
    const code = c[k] ?? ''
    bal += bracketDepth(code)
    if (bal <= 0) continue
    const kind = openerKind(kept, k, code)
    if (kind !== 'control') return { fn: kind, nested }
    nested = true
    bal = 0
  }
  return { fn: (kept[0]?.n ?? 9) <= 1 ? 'other' : 'unknown', nested }
}
/** The index of the line opening the innermost block that holds line `at`; -1 at the top of the file; undefined when
 * the view ends first. */
export function openerAt(kept: readonly Kept[], at: number, codes?: readonly string[]): number | undefined {
  const c = codesOf(kept, codes)
  let bal = 0
  for (let k = at - 1; k >= 0; k -= 1) {
    const l = kept[k], next = kept[k + 1]
    if (!l || (next && next.n !== l.n + 1)) return undefined
    bal += bracketDepth(c[k] ?? '')
    if (bal > 0) return k
  }
  return (kept[0]?.n ?? 9) <= 1 ? -1 : undefined
}
/** Whether an opener line starts a test or suite body (a new describe around existing tests is fine), a control block,
 * a named function (its body runs only if called), or anything else (a callback). */
export function blockKind(kept: readonly Kept[], k: number, codes?: readonly string[]): 'test' | 'suite' | 'control' | 'loop' | 'named-fn' | 'other' {
  const code = codesOf(kept, codes)[k] ?? ''
  const kind = openerKind(kept, k, code)
  if (kind === 'control') return /^\s*(?:\}\s*)?for\b/.test(code) ? 'loop' : 'control'
  if (kind !== 'other') return kind
  return /^\s*(?:export\s+)?(?:(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:async\s+)?function\s*\*?\s*[\w$]+\s*\()/.test(code) ? 'named-fn' : 'other'
}

/** A line that carries on the statement above it (a method chain, a ternary, an operator). */
const CONTINUES = /^\s*(?:\?\.|\.(?!\.)|\?\?|\?|:|&&|\|\||[+\-*%^|&]|\/(?![/*]))/
/** Whether a statement follows the return at `at` in the same block (that code never runs). Unknown when the view ends
 * first: false. */
export function deadCodeAfter(kept: readonly Kept[], at: number, codes?: readonly string[]): boolean {
  const codeAt = (k: number): string => codes?.[k] ?? codeOf(kept[k]?.text ?? '')
  let d = bracketDepth(codeAt(at)), k = at
  for (; k + 1 < kept.length; k += 1) {
    const cur = kept[k], nx = kept[k + 1]
    if (!cur || !nx || nx.n !== cur.n + 1) return false
    if (d <= 0 && !CONTINUES.test(nx.text)) break
    d += bracketDepth(codeAt(k + 1))
  }
  for (let j = k + 1; j < kept.length; j += 1) {
    const l = kept[j], prev = kept[j - 1]
    if (!l || !prev || l.n !== prev.n + 1) return false
    const t = codeAt(j).trim()
    if (t) return !/^[)\]}]/.test(t)
  }
  return false
}
