// Reads runner output with a stack's patterns (plan v7.1 §5.1): ANSI codes stripped, one signature per failure (a
// multiset: the same failure twice counts twice), the test counts, and the error forms RED accepts. Pure functions.
import type { Stack } from './data/types'

export type Signature = { readonly runner: string; readonly file: string; readonly id: string; readonly message: string; readonly collection: boolean }
export type Counts = { readonly passed: number; readonly failed: number; readonly skipped: number }

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/**
 * Every failure the runner printed, in order; null when this stack has no patterns for the runner (the output cannot be
 * read, so a caller must not treat it as "no failures"). Where a pattern says so, the failure's message is the next
 * non-empty line, which is what RED classifies (assertion or an accepted import error) per test.
 */
export function failures(output: string, stack: Stack, runner: string): Signature[] | null {
  const patterns = stack.failures.filter(p => p.runner === runner).map(p => ({ ...p, entryRe: new RegExp(p.entry), headerRe: p.fileHeader ? new RegExp(p.fileHeader) : null, stopRe: p.stopAt ? new RegExp(p.stopAt) : null }))
  if (!patterns.length) return null
  const out: Signature[] = []
  let file = ''
  let pending: number[] = [] // failures still waiting for their message line (vitest prints a shared error once, F16)
  for (const line of stripAnsi(output).split('\n')) {
    if (patterns.some(p => p.stopRe?.test(line))) break
    const header = patterns.map(p => p.headerRe?.exec(line)?.groups?.file).find(Boolean)
    if (header) { file = header; pending = []; continue }
    const hit = patterns.map(p => ({ p, m: p.entryRe.exec(line) })).find(x => x.m)
    if (hit?.m) {
      const g = hit.m.groups ?? {} // a pattern may have no named groups (a whole-file collection error)
      out.push({ runner, file: g.file ?? file, id: g.test ?? g.id ?? g.rule ?? '', message: g.message ?? '', collection: hit.p.collection === true })
      pending = hit.p.messageNext ? [...pending, out.length - 1] : []
      continue
    }
    const text = line.trim()
    if (pending.length && text) { for (const i of pending) { const w = out[i]; if (w) out[i] = { ...w, message: text } } pending = [] }
  }
  return out
}

/** The runner's own summary counts (its last summary: a test can print a fake one first), or null when there is none. */
export function counts(output: string, stack: Stack, runner: string): Counts | null {
  const c = stack.counters.find(x => x.runner === runner)
  if (!c) return null
  const text = stripAnsi(output)
  const num = (source: string): number | null => { const m = [...text.matchAll(new RegExp(source, 'gm'))].at(-1); return m?.[1] ? Number(m[1]) : null }
  const passed = num(c.passed), failed = num(c.failed)
  if (passed === null && failed === null) return null
  return { passed: passed ?? 0, failed: failed ?? 0, skipped: num(c.skipped) ?? 0 }
}

export type ReportTest = { file: string; id: string; title: string; status: 'passed' | 'failed' | 'skipped'; message: string }
/** collection: files that failed with no test results (they did not load); fileErrors: files that failed outside their
 * tests (a throwing afterAll or beforeAll); runtimeErrors: jest's count of suites that failed to run. */
export type Report = { tests: ReportTest[]; collection: Array<{ file: string; message: string }>; fileErrors: Array<{ file: string; message: string }>; runtimeErrors?: number; counts: Counts }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const firstLine = (m: unknown): string => (typeof m === 'string' ? stripAnsi(m).split('\n').map(l => l.trim()).find(l => l && !l.startsWith('●')) ?? '' : '')
/**
 * A runner's JSON report (vitest --reporter=json, jest --json: the same shape). It comes from the runner, not from
 * console text a test can print, so it is what the judge trusts when it has one. Files are made root-relative; a file
 * that failed with no test results failed to load. Anything malformed gives null.
 */
export function readReport(text: string, root: string): Report | null {
  let r: unknown
  try { r = JSON.parse(text) } catch { return null }
  if (!isObj(r) || !Array.isArray(r.testResults)) return null
  const rel = (p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p)
  const tests: ReportTest[] = [], collection: Array<{ file: string; message: string }> = [], fileErrors: Array<{ file: string; message: string }> = []
  for (const t of r.testResults as unknown[]) {
    if (!isObj(t) || typeof t.name !== 'string' || !Array.isArray(t.assertionResults)) return null
    const file = rel(t.name)
    const failedTests = t.assertionResults.filter(a => isObj(a) && a.status === 'failed').length
    if (t.status === 'failed' && t.assertionResults.length === 0) collection.push({ file, message: firstLine(t.message) })
    // A file error: no failed test, jest's "Test suite failed to run" block, or (vitest) any file message at all.
    const msg = typeof t.message === 'string' ? stripAnsi(t.message) : ''
    const suite = /●\s+Test suite failed to run\s*\n+\s*([^\n]+)/.exec(msg)?.[1]?.trim()
    if (t.status === 'failed' && t.assertionResults.length > 0 && (failedTests === 0 || suite || (msg.trim() && !/^\s*●/.test(msg)))) fileErrors.push({ file, message: suite ?? firstLine(t.message) })
    for (const a of t.assertionResults as unknown[]) {
      if (!isObj(a) || typeof a.title !== 'string') return null
      const ancestors = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.filter((x): x is string => typeof x === 'string') : []
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'
      tests.push({ file, id: [...ancestors, a.title].join(' > '), title: a.title, status, message: Array.isArray(a.failureMessages) ? firstLine(a.failureMessages[0]) : '' })
    }
  }
  const count = (status: ReportTest['status']): number => tests.filter(t => t.status === status).length // from the listing itself
  return { tests, collection, fileErrors, runtimeErrors: typeof r.numRuntimeErrorTestSuites === 'number' ? r.numRuntimeErrorTestSuites : 0, counts: { passed: count('passed'), failed: count('failed'), skipped: count('skipped') } }
}

/** What RED looks at: whether an assertion failed, and the modules and symbols that import errors name. */
export function redErrors(output: string, stack: Stack): { readonly assertion: boolean; readonly modules: string[]; readonly symbols: string[] } {
  const text = stripAnsi(output)
  const all = (sources: readonly string[], group: string): string[] =>
    [...new Set(sources.flatMap(s => [...text.matchAll(new RegExp(s, 'gm'))].map(m => m.groups?.[group] ?? '').filter(Boolean)))]
  return { assertion: stack.red.assertion.some(s => new RegExp(s, 'm').test(text)), modules: all(stack.red.moduleNotFound, 'module'), symbols: all(stack.red.missingExport, 'symbol') }
}

export type Classified = { kind: 'assertion' } | { kind: 'moduleNotFound'; module: string } | { kind: 'missingExport'; symbol: string; module?: string } | { kind: 'other' }
/** One failure message as RED sees it (F20): an assertion, a module not found, a missing export (with the module, when
 * the stack's error names it: Python's do), or anything else. */
export function classify(message: string, stack: Stack): Classified {
  const text = stripAnsi(message)
  if (stack.red.assertion.some(s => new RegExp(s, 'm').test(text))) return { kind: 'assertion' }
  const group = (sources: readonly string[], name: string): string | undefined => sources.map(s => new RegExp(s, 'm').exec(text)?.groups?.[name]).find(Boolean)
  const module = group(stack.red.moduleNotFound, 'module')
  if (module) return { kind: 'moduleNotFound', module }
  const hit = stack.red.missingExport.map(s => new RegExp(s, 'm').exec(text)?.groups).find(g => g?.symbol)
  if (!hit?.symbol) return { kind: 'other' }
  return hit.module ? { kind: 'missingExport', symbol: hit.symbol, module: hit.module } : { kind: 'missingExport', symbol: hit.symbol }
}

/** Whether changed source text matches a pattern that forces `Security: yes` (plan §3, B3). */
export const touchesSecurity = (text: string, stack: Stack): boolean => stack.securityPatterns.some(p => new RegExp(p).test(text))
