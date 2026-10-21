// A judged pytest run's results (R2 plan §4.2, AC-PY-3, S-5): its JUnit report (flow/junit.ts), trusted only while
// pytest's own summary line, the last line it prints, agrees with it. A test can print a summary of its own: two lines
// shaped like one in the output (either stream), or a last line that is not one, give null, which never passes.
import { junitReport } from '../../flow/junit'
import { stripAnsi, type Report } from '../../flow/parse'

/** pytest's summary line in its `=` form (the judge passes --verbosity=0; P1): `=== 1 failed, 2 passed in 0.03s ===`,
 * with `(H:MM:SS)` after the seconds from a minute on, and `no tests ran` for the items when nothing ran. */
const SUMMARY = /^=+ (.+) in \d+(?:\.\d+)?s(?: \(\d+:\d\d:\d\d\))? =+$/
/** The items pytest prints (its KNOWN_TYPES and pytest 9's subtests); any other gives null (GAP-R2-0.6-41). */
const ITEM = /^(\d+) (failed|passed|skipped|deselected|xfailed|xpassed|warnings?|errors?|subtests? (?:passed|failed|skipped))$/
export type PytestSummary = { failed: number; passed: number; skipped: number; xfailed: number; xpassed: number; errors: number }

/** The counts of the summary line: the one line of `output` shaped like it, which must be the last non-empty line of
 * `stdout`; null otherwise. */
export function pytestSummary(output: string, stdout: string): PytestSummary | null {
  const lines = (text: string): string[] => stripAnsi(text).split('\n').map(l => l.trim()).filter(Boolean)
  if (lines(output).filter(l => SUMMARY.test(l)).length !== 1) return null
  const m = SUMMARY.exec(lines(stdout).at(-1) ?? '')
  if (!m) return null
  const s: PytestSummary = { failed: 0, passed: 0, skipped: 0, xfailed: 0, xpassed: 0, errors: 0 }
  if (m[1] === 'no tests ran') return s
  for (const item of (m[1] ?? '').split(', ')) {
    const x = ITEM.exec(item), n = Number(x?.[1] ?? 0), kind = x?.[2] ?? ''
    if (!x) return null
    if (kind === 'failed' || kind === 'passed' || kind === 'skipped' || kind === 'xfailed' || kind === 'xpassed') s[kind] += n
    else if (kind.startsWith('error')) s.errors += n
  }
  return s
}

/** The report of a judged pytest run, checked against its summary line (GAP-R2-0.6-22): failed, errors and skipped +
 * xfailed equal the failure, error and skipped elements, passed + xpassed are at least the testcases with none. Null for
 * a report or a run that cannot be read, or when they disagree. */
export function readPytestReport(text: string, run?: { readonly output: string; readonly stdout?: string }): Report | null {
  const got = junitReport(text)
  if (!got || !run) return null
  const s = pytestSummary(run.output, run.stdout ?? run.output), t = got.totals
  if (!s) return null
  const agree = s.failed === t.failure && s.errors === t.error && s.skipped + s.xfailed === t.skipped && s.passed + s.xpassed >= t.childless
  return agree ? got.report : null
}
