// Light Python reading for the scans and the judge, line by line as a diff shows them (R2 plan §4.2): comments and
// strings (single, double and triple quotes; the r, b, u, f and t prefixes and their pairs; f-strings with nested quotes,
// replacement fields and format specs, PEP 701) told apart from code, the state carried across lines (a triple-quoted
// string, a field left open). Output as the TypeScript lexer's: each line's comment and literal texts, and its code with
// literals blanked to `""` (the prefix kept) and comments removed. Lines given without the lines before them (a hunk)
// start in code, so a hunk that starts inside a string misreads: the scan lexes whole files when it has them.
import type { LexedLine } from '../flow-scan'

/** A string (its closing quote, whether it has fields, whether `\N{name}` is an escape in it: not in a raw or bytes
 * string), a field's expression (its bracket depth) or a format spec. */
type Frame = { readonly k: 'str'; readonly q: string; readonly f: boolean; readonly named: boolean } | { readonly k: 'expr'; readonly depth: number } | { readonly k: 'spec' }
export type PyState = readonly Frame[]
type Part = { text: string; comment: boolean }

const PREFIX = /^(?:[rRuUbBfFtT]|[bB][rR]|[rR][bB]|[fF][rR]|[rR][fF]|[tT][rR]|[rR][tT])$/
/** A named escape: a Unicode name is letters, digits, spaces and hyphens (bounded, so a line of `\N{` stays linear). */
const NAMED = /\\N\{[A-Za-z0-9 -]{1,100}\}/y
const quoteAt = (text: string, i: number): string => { const c = text[i] ?? ''; return text.startsWith(c.repeat(3), i) ? c.repeat(3) : c }
/** The string literal that starts at `i`, if one does: its prefix and opening quote. */
function stringAt(text: string, i: number): { prefix: string; q: string } | null {
  const c = text[i] ?? ''
  if (c === '"' || c === "'") return { prefix: '', q: quoteAt(text, i) }
  if (/\w/.test(text[i - 1] ?? '')) return null
  const prefix = /^([rRuUbBfFtT]{1,2})(?=['"])/.exec(text.slice(i, i + 3))?.[1]
  return prefix && PREFIX.test(prefix) ? { prefix, q: quoteAt(text, i + prefix.length) } : null
}

/** One line lexed from the state the line before left (`start`, innermost frame last). */
export function lexLine(line: string, start: PyState): { parts: Part[]; code: string; state: PyState } {
  const text = line.replace(/\r$/, ''), frames: Frame[] = [...start], parts: Part[] = [] // a CRLF file's line ends in \r
  let code = '', cur = '', i = 0
  const flush = (): void => { if (cur) parts.push({ text: cur, comment: false }); cur = '' }
  const setTop = (f: Frame): void => { frames[frames.length - 1] = f }
  while (i < text.length) {
    const top = frames.at(-1), c = text[i] ?? '', d = text[i + 1] ?? ''
    if (top?.k === 'str') {
      // a backslash escapes the next character (a quote included, raw or not), never a field's brace; `\N{EM DASH}` is
      // one escape, text to its brace, where Python reads it so (in a raw f-string `\N{x}` is a field)
      NAMED.lastIndex = i
      const named = top.named && c === '\\' && d === 'N' && NAMED.test(text) ? NAMED.lastIndex : -1
      if (named > 0) { cur += text.slice(i, named); i = named }
      else if (c === '\\' && !(top.f && (d === '{' || d === '}'))) { cur += text.slice(i, i + 2); i += 2 }
      else if (text.startsWith(top.q, i)) { flush(); frames.pop(); i += top.q.length }
      else if (top.f && (c === '{' || c === '}') && d === c) { cur += c + c; i += 2 }
      else if (top.f && c === '{') { flush(); frames.push({ k: 'expr', depth: 0 }); code += ' '; i += 1 }
      else { cur += c; i += 1 }
      continue
    }
    if (top?.k === 'spec') {
      if (c === '{') { flush(); frames.push({ k: 'expr', depth: 0 }) } else if (c === '}') { flush(); frames.pop() } else cur += c
      i += 1
      continue
    }
    // code: the top level, or a field of an f-string
    if (c === '#') { flush(); parts.push({ text: text.slice(i + 1), comment: true }); break }
    const s = stringAt(text, i)
    if (s) { code += `${s.prefix}""`; frames.push({ k: 'str', q: s.q, f: /[fFtT]/.test(s.prefix), named: !/[rRbB]/.test(s.prefix) }); i += s.prefix.length + s.q.length; continue }
    if (top?.k === 'expr') {
      if (c === '}' && top.depth === 0) { frames.pop(); code += ' '; i += 1; continue }
      if (top.depth === 0 && c === '!' && /[rsa]/.test(d) && /[:}]/.test(text[i + 2] ?? '')) { i += 2; continue } // a conversion
      if (top.depth === 0 && c === ':') { setTop({ k: 'spec' }); code += ' '; i += 1; continue }
      if ('([{'.includes(c)) setTop({ k: 'expr', depth: top.depth + 1 })
      else if (')]}'.includes(c)) setTop({ k: 'expr', depth: top.depth - 1 })
    }
    code += c
    i += 1
  }
  flush()
  // a single-quoted string ends with its line unless a backslash carries it on
  for (let top = frames.at(-1); top?.k === 'str' && top.q.length === 1 && !text.endsWith('\\'); top = frames.at(-1)) frames.pop()
  return { parts, code, state: frames }
}

/** Each line lexed with the state carried from the line before; a gap in the line numbers (a new hunk) restarts in code. */
export function lexLines(lines: ReadonlyArray<{ readonly n: number; readonly text: string }>): LexedLine[] {
  const out: LexedLine[] = []
  let state: PyState = [], last = -2
  for (const l of lines) {
    if (l.n !== last + 1) state = []
    last = l.n
    const x = lexLine(l.text, state)
    state = x.state
    out.push({ parts: x.parts, code: x.code })
  }
  return out
}
/** Lines that follow one another (a side of a diff, a whole file), lexed. */
export const lexText = (lines: readonly string[]): LexedLine[] => lexLines(lines.map((text, n) => ({ n, text })))
export const codeOf = (text: string): string => lexLine(text, []).code
