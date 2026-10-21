// A strict TOML reader for the files flow judges (R2 plan §4.2, GAP-R2-0.6-5, S-14): pyproject.toml, uv.lock,
// poetry.lock and the tools' configs. TOML 1.0 in the forms these files use: tables, arrays of tables, dotted and quoted
// keys, basic and literal strings, integers, floats, booleans, arrays and inline tables. Anything else (a date, a key
// or table given twice, a table defined again, a dotted key into a closed table, a multi-line string outside a prose key,
// a control character) gives null: the caller then counts the edit as a change of what the commands run (CMD-SRC), never
// as dependencies only. Pure, one pass, nesting capped.
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

const MAX_CHARS = 16 * 1024 * 1024, MAX_DEPTH = 32
/** Keys whose string may span lines (prose in pyproject.toml); elsewhere a multi-line string gives null. */
const MULTILINE_KEYS: ReadonlySet<string> = new Set(['description', 'readme', 'text', 'license'])
const BAD_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\r(?!\n)/
const BARE = /[A-Za-z0-9_-]/
const ESC: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
const INT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/, RADIX = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/
const FLOAT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/
/** How a table came to be: a header, the parent of one, a dotted key, an inline table, an element of [[…]]. */
type Kind = 'header' | 'implicit' | 'dotted' | 'inline' | 'element'
const FAIL = Symbol('toml')

/** The document's root table, or null for anything outside the subset (see the header). */
export function readToml(text: string): TomlTable | null {
  // tomllib reads CRLF as LF first (inside multi-line strings too); a lone CR stays a bad character
  const src = text.replace(/\r\n/g, '\n')
  if (src.length > MAX_CHARS || src.startsWith('﻿') || BAD_CHAR.test(src)) return null
  const kinds = new Map<TomlTable, Kind>(), aots = new Set<TomlValue[]>(), root: TomlTable = {}
  let i = 0, cur = root
  const fail = (): never => { throw FAIL }
  const peek = (k = 0): string => src[i + k] ?? ''
  const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v)
  // own keys only, both ways: `__proto__`, `constructor` and `toString` are keys like any other
  const set = (t: TomlTable, k: string, v: TomlValue): void => { Object.defineProperty(t, k, { value: v, enumerable: true, writable: true, configurable: true }) }
  const own = (t: TomlTable, k: string): TomlValue | undefined => (Object.hasOwn(t, k) ? t[k] : undefined)
  const table = (kind: Kind): TomlTable => { const t: TomlTable = {}; kinds.set(t, kind); return t }
  const ws = (): void => { while (peek() === ' ' || peek() === '\t') i += 1 }
  const newline = (): boolean => { if (peek() === '\n') { i += 1; return true } if (peek() === '\r' && peek(1) === '\n') { i += 2; return true } return false }
  const comment = (): void => { if (peek() === '#') while (i < src.length && peek() !== '\n' && peek() !== '\r') i += 1 }
  /** Blank lines and comments (between expressions, inside arrays). */
  const blank = (): void => { for (;;) { ws(); comment(); if (!newline()) return } }
  const eol = (): void => { ws(); comment(); if (!newline() && i < src.length) fail() }

  function escape(): string {
    const c = peek()
    i += 1
    const known = ESC[c]
    if (known !== undefined) return known
    const n = c === 'u' ? 4 : c === 'U' ? 8 : 0, hex = src.slice(i, i + n)
    if (!n || !new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) return fail()
    const cp = parseInt(hex, 16)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fail()
    i += n
    return String.fromCodePoint(cp)
  }
  /** Up to two quotes may stand before the closing three (`"""a"""""` is `a""`). */
  const closing = (q: string): number => { let n = 3; while (n < 5 && src[i + n] === q) n += 1; return n }
  function basic(multi: boolean): string {
    if (src.startsWith('"""', i)) {
      if (!multi) fail()
      i += 3
      newline()
      let out = ''
      for (;;) {
        if (i >= src.length) fail()
        if (src.startsWith('"""', i)) { const n = closing('"'); out += '"'.repeat(n - 3); i += n; return out }
        const c = peek()
        i += 1
        if (c !== '\\') { out += c; continue }
        // a backslash at a line's end takes the line break and the white space after it away
        let j = i
        while (src[j] === ' ' || src[j] === '\t') j += 1
        if (src[j] === '\n' || (src[j] === '\r' && src[j + 1] === '\n')) { i = j; while (/[ \t\r\n]/.test(peek())) i += 1 } else out += escape()
      }
    }
    i += 1
    let out = ''
    for (;;) {
      const c = peek()
      if (!c || c === '\n' || c === '\r') fail()
      i += 1
      if (c === '"') return out
      out += c === '\\' ? escape() : c
    }
  }
  function literal(multi: boolean): string {
    if (src.startsWith("'''", i)) {
      if (!multi) fail()
      i += 3
      newline()
      const end = src.indexOf("'''", i)
      if (end < 0) fail()
      const start = i
      i = end
      const n = closing("'"), out = src.slice(start, end) + "'".repeat(n - 3)
      i = end + n
      return out
    }
    const end = src.indexOf("'", i + 1), line = src.slice(i + 1, end)
    if (end < 0 || /[\r\n]/.test(line)) fail()
    i = end + 1
    return line
  }
  function scalar(): TomlValue {
    const start = i
    while (i < src.length && !/[ \t\r\n,\]}#]/.test(peek())) i += 1
    const t = src.slice(start, i)
    if (t === 'true' || t === 'false') return t === 'true'
    if (/^[+-]?(?:inf|nan)$/.test(t)) return t.endsWith('nan') ? Number.NaN : t.startsWith('-') ? -Infinity : Infinity
    if (INT.test(t) || RADIX.test(t)) { const n = Number(t.replace(/_/g, '')); return Number.isSafeInteger(n) ? n : fail() }
    if (FLOAT.test(t) && /[.eE]/.test(t)) return Number(t.replace(/_/g, ''))
    return fail() // a date, a time, or no value at all
  }
  /** A key's parts; a key deeper than MAX_DEPTH fails (headers and dotted keys build tables too). */
  function key(): string[] {
    const parts: string[] = []
    for (;;) {
      if (parts.length >= MAX_DEPTH) fail()
      ws()
      if (peek() === '"') parts.push(basic(false))
      else if (peek() === "'") parts.push(literal(false))
      else { const start = i; while (BARE.test(peek())) i += 1; if (i === start) fail(); parts.push(src.slice(start, i)) }
      ws()
      if (peek() !== '.') return parts
      i += 1
    }
  }
  function value(depth: number, multi: boolean): TomlValue {
    if (depth > MAX_DEPTH) fail()
    const c = peek()
    if (c === '"') return basic(multi)
    if (c === "'") return literal(multi)
    if (c === '[') {
      i += 1
      const out: TomlValue[] = []
      for (;;) {
        blank()
        if (peek() === ']') { i += 1; return out }
        out.push(value(depth + 1, false))
        blank()
        if (peek() === ',') i += 1
        else if (peek() === ']') { i += 1; return out } else fail()
      }
    }
    if (c === '{') {
      i += 1
      const t = table('inline')
      ws()
      if (peek() === '}') { i += 1; return t }
      for (;;) {
        pair(t, depth + 1)
        ws()
        if (peek() === '}') { i += 1; return t }
        if (peek() !== ',') fail()
        i += 1
        ws()
        if (peek() === '}') fail() // no trailing comma in TOML 1.0
      }
    }
    return scalar()
  }
  /** `key = value` into `t`; a dotted key makes the tables on its way (dotted ones only can be gone through again). */
  function pair(t: TomlTable, depth: number): void {
    const k = key()
    if (peek() !== '=') fail()
    i += 1
    ws()
    const last = k.at(-1) ?? ''
    const v = value(depth, MULTILINE_KEYS.has(last))
    let at = t
    for (const part of k.slice(0, -1)) {
      const next = own(at, part)
      if (next === undefined) { const n = table('dotted'); set(at, part, n); at = n } else if (isTable(next) && kinds.get(next) === 'dotted') at = next
      else fail()
    }
    if (own(at, last) !== undefined) fail()
    set(at, last, v)
  }
  function header(): void {
    const aot = src.startsWith('[[', i)
    i += aot ? 2 : 1
    const k = key()
    if (!src.startsWith(aot ? ']]' : ']', i)) fail()
    i += aot ? 2 : 1
    eol()
    let at = root
    for (const part of k.slice(0, -1)) {
      let next = own(at, part)
      if (next === undefined) { const n = table('implicit'); set(at, part, n); at = n; continue }
      if (Array.isArray(next)) next = aots.has(next) ? next.at(-1) : fail()
      if (!isTable(next) || kinds.get(next) === 'inline') fail()
      at = next as TomlTable
    }
    const last = k.at(-1) ?? '', existing = own(at, last)
    if (aot) {
      const list = existing === undefined ? [] : Array.isArray(existing) && aots.has(existing) ? existing : fail()
      if (existing === undefined) { aots.add(list); set(at, last, list) }
      cur = table('element')
      list.push(cur)
      return
    }
    if (existing === undefined) { cur = table('header'); set(at, last, cur); return }
    // a table so far only the parent of a header can be defined once
    if (isTable(existing) && kinds.get(existing) === 'implicit') { kinds.set(existing, 'header'); cur = existing; return }
    fail()
  }

  try {
    for (;;) {
      blank()
      if (i >= src.length) return root
      if (peek() === '[') header()
      else { pair(cur, 0); eol() }
    }
  } catch (err) {
    if (err === FAIL) return null
    throw err
  }
}
