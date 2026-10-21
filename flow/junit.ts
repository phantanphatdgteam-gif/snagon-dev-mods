// The JUnit XML report of a judged pytest run (R2 plan §3.3, spike P1: xunit1, which carries `file` and `line`). It
// comes from the runner, not from console text a test prints, yet the code under test can write the file too, so the
// reader is strict (S-14): anything outside the XML pytest writes gives null, which never passes. Pure, one pass, no
// recursion. A test's id is its class path and name joined with ' > ' (the core's id grammar): the module part of
// `classname` is the file itself.
import type { Report, ReportTest } from './parse'

/** Bounds on an untrusted file: its length in UTF-16 units (the judge reads no report over 16 MiB of bytes,
 * hooks/flow-run.ts), how deep elements nest, and how many there are (a few per test: 400k is past any real suite). */
const MAX_CHARS = 16 * 1024 * 1024, MAX_DEPTH = 64, MAX_NODES = 400_000
type Node = { name: string; attrs: Map<string, string>; kids: Node[]; text: string }

/** Characters no XML file holds raw: C0 controls but tab and line ends, U+FFFE/U+FFFF, lone surrogates, and U+FFFD
 * (what decoding leaves for bytes that were not UTF-8). */
const RAW_BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F�￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** XML's white space only (JS `\s` would also take U+00A0, U+2028, U+FEFF…), and anything else. */
const WS = '[ \\t\\r\\n]', NOT_WS = /[^ \t\r\n]/
const DECL = new RegExp(`^<\\?xml${WS}+version${WS}*=${WS}*(["'])1\\.0\\1(?:${WS}+encoding${WS}*=${WS}*(["'])(?:utf-8|UTF-8)\\2)?(?:${WS}+standalone${WS}*=${WS}*(["'])(?:yes|no)\\3)?${WS}*\\?>`)
const NAME = '[A-Za-z_][\\w.-]*'
const OPEN = new RegExp(`<(${NAME})((?:${WS}+${NAME}${WS}*=${WS}*(?:"[^"<]*"|'[^'<]*'))*)${WS}*(/?)>`, 'y')
const CLOSE = new RegExp(`</(${NAME})${WS}*>`, 'y')
const ATTR = new RegExp(`${WS}+(${NAME})${WS}*=${WS}*(?:"([^"<]*)"|'([^'<]*)')`, 'g')
const ENTITY: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
/** XML's Char production: what a numeric entity may name. */
const xmlChar = (c: number): boolean => c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff)

/** Text or an attribute value with its entities decoded: the five named ones and numeric ones; null for any other `&`. */
function decode(raw: string): string | null {
  let bad = false
  const out = raw.replace(/&(?:#x([0-9A-Fa-f]{1,6});|#([0-9]{1,7});|([A-Za-z]{2,4});)?/g, (_all, hex?: string, dec?: string, named?: string) => {
    const c = hex !== undefined ? parseInt(hex, 16) : dec !== undefined ? Number(dec) : -1
    if (c >= 0) { if (xmlChar(c)) return String.fromCodePoint(c); bad = true; return '' }
    const v = named !== undefined ? ENTITY[named] : undefined
    if (v === undefined) bad = true
    return v ?? ''
  })
  return bad ? null : out
}

/** The document's root element: elements, attributes, text and CDATA; an XML declaration first or none. Null for a BOM,
 * a DOCTYPE, a comment, a processing instruction, an unknown entity, an unbalanced or duplicate-attribute tag, text
 * outside the root, a second root, deeper nesting than MAX_DEPTH, or more than MAX_CHARS characters. */
function parse(src: string): Node | null {
  if (src.length > MAX_CHARS || src.startsWith('﻿') || RAW_BAD.test(src)) return null
  const open: Node[] = []
  let i = DECL.exec(src)?.[0].length ?? 0, root: Node | null = null, nodes = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i), end = lt < 0 ? src.length : lt, top = open.at(-1)
    if (end > i) {
      const raw = src.slice(i, end)
      if (!top) { if (NOT_WS.test(raw)) return null } else { const t = decode(raw); if (t === null) return null; top.text += t }
    }
    if (lt < 0) break
    if (src.startsWith('<![CDATA[', lt)) {
      const close = src.indexOf(']]>', lt + 9)
      if (close < 0 || !top) return null
      top.text += src.slice(lt + 9, close)
      i = close + 3
      continue
    }
    if (src.startsWith('</', lt)) {
      CLOSE.lastIndex = lt
      const m = CLOSE.exec(src)
      if (!m || open.pop()?.name !== m[1]) return null
      i = CLOSE.lastIndex
      continue
    }
    OPEN.lastIndex = lt
    const m = OPEN.exec(src)
    // a DOCTYPE, comment or processing instruction; a second root; an element deeper than MAX_DEPTH, closed or not, or
    // past MAX_NODES
    if (!m || (root && !open.length) || open.length >= MAX_DEPTH || (nodes += 1) > MAX_NODES) return null
    const attrs = new Map<string, string>()
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      const key = a[1] ?? '', v = decode(a[2] ?? a[3] ?? '')
      if (v === null || attrs.has(key)) return null
      attrs.set(key, v)
    }
    const node: Node = { name: m[1] ?? '', attrs, kids: [], text: '' }
    if (top) top.kids.push(node)
    else root = node
    if (!m[3]) open.push(node)
    i = OPEN.lastIndex
  }
  return open.length ? null : root
}

const UINT = /^(?:0|[1-9][0-9]{0,8})$/
type Result = 'failure' | 'error' | 'skipped'
const RESULTS: ReadonlySet<string> = new Set(['failure', 'error', 'skipped'])
/** Elements pytest writes that say nothing about a result: properties (record_property) and captured output. */
const IGNORED: ReadonlySet<string> = new Set(['properties', 'system-out', 'system-err'])
const RANK: Readonly<Record<ReportTest['status'], number>> = { passed: 0, skipped: 1, failed: 2 }
/** A root-relative path as xunit1 writes it: relative, no empty, `.` or `..` segment. */
const cleanPath = (p: string): boolean => p.length > 0 && !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..')
/** The module a test file is: `tests/test_a.py` is `tests.test_a`. */
const moduleOf = (file: string): string => file.replace(/\.py$/, '').split('/').join('.')
/** A collection failure's cause: the body's last `E   ` line (the message attribute only says "collection failure").
 * Linear on purpose: a lazy group before `\s*$` is quadratic on a long run of spaces, which code under test can print. */
const lastE = (body: string): string | undefined => body.split('\n').map(l => (/^E\s/.test(l) ? l.slice(1).trim() : '')).filter(Boolean).at(-1)

/** One testcase: a test with its status, a module that failed to load, or null when its shape is not pytest's. */
function caseOf(c: Node): { test: ReportTest } | { collection: { file: string; message: string } } | null {
  const classname = c.attrs.get('classname'), name = c.attrs.get('name'), file = c.attrs.get('file'), line = c.attrs.get('line')
  if (classname === undefined || !name || file === undefined || !cleanPath(file) || (line !== undefined && !UINT.test(line)) || NOT_WS.test(c.text)) return null
  if (c.kids.some(k => !RESULTS.has(k.name) && !IGNORED.has(k.name))) return null
  const results = c.kids.filter(k => RESULTS.has(k.name)), module = moduleOf(file)
  if (classname === '') {
    // pytest's module elements (no `line`, the name is the file's dotted module): a module that failed to load,
    // `<error message="collection failure">`, or one skipped whole (importorskip, skip(allow_module_level=True)),
    // `<skipped message="collection skipped">`, one skipped test named after the module (GAP-R2-0.6-37)
    const e = results[0], message = e?.attrs.get('message')
    if (results.length !== 1 || line !== undefined || name !== module) return null
    if (e?.name === 'error' && message === 'collection failure') return { collection: { file, message: lastE(e.text) ?? message } }
    return e?.name === 'skipped' && message === 'collection skipped' ? { test: { file, id: name, title: name, status: 'skipped', message } } : null
  }
  // A test a class inherits from a class in another file carries that file, so its classname is not under it: null until
  // the caller can map classnames to the tree's test files (GAP-R2-0.6-38)
  if (classname !== module && !classname.startsWith(`${module}.`)) return null
  const id = [...(classname === module ? [] : classname.slice(module.length + 1).split('.')), name].join(' > ')
  // a failure or an error fails the test; one test can hold several (failed subtests), the worst counts
  const worst = results.find(k => k.name !== 'skipped') ?? results[0]
  const status: ReportTest['status'] = !worst ? 'passed' : worst.name === 'skipped' ? 'skipped' : 'failed'
  return { test: { file, id, title: name, status, message: (worst?.attrs.get('message') ?? '').split('\n')[0] ?? '' } }
}

/** The result elements of a report and its testcases with none (a pass), for the check against the runner's summary
 * line (GAP-R2-0.6-22: failed, errors and skipped + xfailed are exact there, passed + xpassed at least `childless`). */
export type JunitTotals = { readonly failure: number; readonly error: number; readonly skipped: number; readonly childless: number }

/**
 * A pytest JUnit report (xunit1) as flow's Report, with its totals, or null. Each suite's `failures`, `errors` and
 * `skipped` must equal its failure, error and skipped elements, and `tests` be at least its testcases (subtests count
 * there too, GAP-R2-0.6-22). The same test twice (a failure in the call and an error in teardown) takes the worse status;
 * one classname and name in two files is null.
 */
export function junitReport(text: string): { report: Report; totals: JunitTotals } | null {
  const doc = parse(text)
  const suites = doc?.name === 'testsuites' ? doc.kids : doc?.name === 'testsuite' ? [doc] : null
  if (!suites || suites.some(s => s.name !== 'testsuite')) return null
  const tests = new Map<string, ReportTest>(), fileOf = new Map<string, string>(), collection: Report['collection'] = []
  const total: Record<Result, number> = { failure: 0, error: 0, skipped: 0 }
  let childless = 0
  for (const s of suites) {
    const num = (k: string): number => { const v = s.attrs.get(k); return v !== undefined && UINT.test(v) ? Number(v) : -1 }
    const seen: Record<Result, number> = { failure: 0, error: 0, skipped: 0 }
    let cases = 0
    for (const c of s.kids) {
      if (IGNORED.has(c.name)) continue
      if (c.name !== 'testcase') return null
      const got = caseOf(c)
      if (!got) return null
      cases += 1
      if (!c.kids.some(k => RESULTS.has(k.name))) childless += 1
      for (const k of c.kids) if (RESULTS.has(k.name)) seen[k.name as Result] += 1
      const key = `${c.attrs.get('classname') ?? ''}\u0000${c.attrs.get('name') ?? ''}`, file = c.attrs.get('file') ?? ''
      if ((fileOf.get(key) ?? file) !== file) return null
      fileOf.set(key, file)
      if ('collection' in got) { collection.push(got.collection); continue }
      const at = `${got.test.file}\u0000${got.test.id}`, before = tests.get(at)
      if (!before || RANK[got.test.status] > RANK[before.status]) tests.set(at, got.test)
    }
    if (num('failures') !== seen.failure || num('errors') !== seen.error || num('skipped') !== seen.skipped || num('tests') < cases) return null
    for (const k of RESULTS) total[k as Result] += seen[k as Result]
  }
  const list = [...tests.values()], count = (st: ReportTest['status']): number => list.filter(t => t.status === st).length
  return {
    report: { tests: list, collection, fileErrors: [], runtimeErrors: 0, counts: { passed: count('passed'), failed: count('failed'), skipped: count('skipped') } },
    totals: { ...total, childless },
  }
}
/** The report alone (junitReport). */
export const readJunit = (text: string): Report | null => junitReport(text)?.report ?? null
