// The Python stack's floor and junk rules (R2 plan §4.2, spec §4.2; AC-PY-5, AC-STK-6, AC-STK-7): skips, early and
// conditional returns in tests, process exits (pytest.exit too), trivial asserts, suppressions in comments, selection
// filters added to pytest's options, pytest hooks that can rewrite results or reports in any Python file (S-5), lowered
// coverage; print outside tests and entrypoints, debugger calls, TODO markers in comments, commented-out code. Code is
// read lexed (python-lex.ts): a word in a string or a comment is not code, and `# noqa` inside a string is no suppression.
import { floorStart, injections, junkRules, removedCodes, type DiffFile, type Hit, type Line, type ScanCtx, type ScanFinding, type View } from '../flow-scan'

export const CODE = /\.pyi?$/
/** pytest's and coverage's config files: where selection filters and thresholds live. */
const CONFIG = /(^|\/)(pyproject\.toml|setup\.cfg|pytest\.ini|\.pytest\.ini|tox\.ini|\.coveragerc)$/
/** Test files proper; other files under the test globs are helpers, where the same rules are only MEDIUM. */
const TEST_FILE = /(^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/
const TEST_DEF = /^\s*(?:async\s+)?def\s+test\w*\s*\(/
const DEF = /^\s*(?:async\s+)?def\s+\w+/
const CLASS = /^\s*class\s+\w+/
const CONTROL = /^\s*(?:if|elif|else|for|while|try|except|finally|with|async\s+(?:for|with)|match|case)\b/
const SKIP = [
  /\bmark\s*\.\s*(?:skip|skipif|xfail)\b/, /\bpytest\s*\.\s*(?:skip|xfail|importorskip)\s*\(/, /(?<![\w.])(?:skip|xfail|importorskip)\s*\(/,
  /\bunittest\s*\.\s*(?:skip|skipIf|skipUnless|expectedFailure)\b/, /^\s*@\s*(?:skip|skipIf|skipUnless|expectedFailure)\b/, /\.\s*skipTest\s*\(/,
  // what those raise, raised by hand
  /\bSkipTest\b/, /\bskip\s*\.\s*Exception\b/,
]
const EXIT = /\b(?:sys\s*\.\s*exit|os\s*\.\s*(?:_exit|abort)|pytest\s*\.\s*exit)\s*\(|(?<![\w.])(?:exit|quit)\s*\(|\braise\s+SystemExit\b/
const ASSERTION = /^\s*assert\b|\bself\s*\.\s*(?:assert|fail)\w*\s*\(|\bpytest\s*\.\s*(?:raises|warns|fail)\b/
/** An assert that holds whatever the code does, read on code (a string literal is `""` there) or, for a literal
 * compared with itself, on the raw line. */
const TRIVIAL = [
  /^\s*assert\b\s*(?:\(\s*)?(?:True|1|not\s+(?:False|0|None)|[rRbBuUfF]{0,2}"")\s*(?:\)\s*)?(?:,|$)/, /^\s*assert\b\s*(?:\(\s*)?([A-Za-z_][\w.]*)\s*(?:==|is)\s*\1\s*(?:\)\s*)?(?:,|$)/,
  /\bself\s*\.\s*assertTrue\s*\(\s*(?:True|1)\s*\)/, /\bself\s*\.\s*assert(?:Equal|Is)\s*\(\s*([\w.]+)\s*,\s*\1\s*\)/,
]
const TRIVIAL_RAW = /^\s*assert\b\s*(?:\(\s*)?("(?:[^"\\\n]|\\.){0,200}"|'(?:[^'\\\n]|\\.){0,200}'|-?\d+(?:\.\d+)?|None|True|False|\[\]|\{\}|\(\))\s*(?:==|is)\s*\1\s*(?:\)\s*)?(?:,|#|$)/
/** The plan's suppressions (§4.2), read in comments only (`# ruff: noqa` holds `noqa`), in any case, as the tools
 * read them (coverage takes `# pragma no cover`). */
const SUPPRESSION = /\bnoqa\b|\btype\s*:\s*ignore\b|\bpragma\s*:?\s*no\s*cover\b|\bmypy\s*:\s*ignore-errors\b/i
/** pytest hooks that can rewrite results or the report (defined, or assigned in a plugin module), among them the ones that
 * run the test call or its protocol or see each report (owner decision 2026-10-19), a wrapper around any hook, and the
 * fixtures that reach the report or the terminal (S-5): FL in any Python file. */
/** One of those hooks named in a string (`globals()["pytest_pyfunc_call"] = f`, a `specname`): defined under another name. */
const FORCING_NAME = /^\s*pytest_(?:runtest_makereport|runtest_logreport|runtest_protocol|pyfunc_call|report_\w+|terminal_summary|sessionfinish|unconfigure)\s*$/
const REPORT_FORCING = /\bspecname\s*=|\bpytest_(?:runtest_makereport|runtest_logreport|runtest_protocol|pyfunc_call|report_\w+|terminal_summary|sessionfinish|unconfigure)\s*(?:\(|=(?!=))|\bhookwrapper\s*=\s*(?!False\b|0\b|None\b)[\w(]|\bhookimpl\s*\([^)\n]{0,200}\bwrapper\s*=\s*(?!False\b|0\b|None\b)[\w(]|\bcapsys\s*\.\s*disabled\b|\brecord_xml_attribute\b/
/** The plan's selection filters added to pytest's options (addopts and the like): `-x` and `-k` also inside a bundle of
 * flags that take no value (`-xvs`, `-vk expr`, `-kfast`); `-rx` is `-r`'s value. */
const FILTER = /(?<![\w-])-[qvslVh]*[xk]|(?<![\w-])(?:--deselect|--exitfirst|--lf|--last-failed)(?![\w-])|(?<![\w-])-p\s*no:/
const THRESHOLD = /\b(?:fail[_-]under|cov-fail-under)\b["']?[ \t]*(?:[=:][ \t]*)?["']?(-?\d+(?:\.\d+)?)/g
/** A config line that is a comment (TOML, INI): no filter or threshold is read in it. */
const CONFIG_COMMENT = /^\s*[#;]/
const DEBUGGER = /(?<![\w.])breakpoint\s*\(|\bpdb\s*\.\s*set_trace\s*\(|^\s*(?:import\s+i?pdb\b|from\s+i?pdb\s+import\b)/
const PRINT = /(?<![\w.])print\s*\(/
/** Commented-out code: a comment's text with a call, an assignment, a subscript, or a block opener's colon at its end;
 * tool directives (shebang, coding, type, noqa, pragma, linters and formatters) are not. */
const COMMENTED_CODE = /[()=[\]]|:\s*$/
const DIRECTIVE = /^\s*(?:!|-\*-|type\s*:|noqa\b|pragma\b|(?:pylint|fmt|mypy|ruff|isort|pyright)\s*:)/i
const RETURN = /(?:^\s*|[;:]\s*)return\b/
const TRIVIAL_RETURN = /^return(?:\s+(?:None|True|False|-?\d+(?:\.\d+)?|""|\[\s*\]|\{\s*\}|\(\s*\)))?\s*$/

const indentOf = (t: string): number => /^[ \t]*/.exec(t.replace(/\t/g, '        '))?.[0].length ?? 0
const codeAt = (v: View, k: number): string => v.codes?.[k] ?? v.kept[k]?.text ?? ''
/** What holds kept line `at`: the nearest function above it indented less (a test, another one, or none in view) and
 * whether control flow sits between them. Lines with no code (inside a string, comment only) are skipped. */
function placeOf(v: View, at: number): { fn: 'test' | 'other' | 'unknown'; nested: boolean } {
  let ind = indentOf(v.kept[at]?.text ?? ''), nested = CONTROL.test(codeAt(v, at)) && /:\s*return\b/.test(codeAt(v, at))
  for (let k = at - 1; k >= 0 && ind > 0; k -= 1) {
    const code = codeAt(v, k), i = indentOf(v.kept[k]?.text ?? '')
    if (!code.trim() || i >= ind) continue
    ind = i
    if (DEF.test(code)) return { fn: TEST_DEF.test(code) ? 'test' : 'other', nested }
    if (CLASS.test(code)) return { fn: 'other', nested }
    if (CONTROL.test(code)) nested = true
  }
  return { fn: 'unknown', nested }
}
/** Whether code follows kept line `at` in its own block: the next line with code, indented as deep. */
function codeAfter(v: View, at: number): boolean {
  const ind = indentOf(v.kept[at]?.text ?? '')
  for (let k = at + 1; k < v.kept.length; k += 1) if (codeAt(v, k).trim()) return indentOf(v.kept[k]?.text ?? '') >= ind
  return false
}
/** Rules for one added line of a test file: skips, a return that ends a test early or under a condition, exits and
 * trivial asserts. */
function testLine(l: Line, at: number, v: View, sev: 'HIGH' | 'MEDIUM', hit: Hit): void {
  const code = codeAt(v, at)
  if (SKIP.some(r => r.test(code))) hit('skip-or-only', l.n)
  if (RETURN.test(code)) {
    const place = placeOf(v, at), trivial = TRIVIAL_RETURN.test(code.slice(code.search(/\breturn\b/)).trim())
    if (place.fn === 'test') { if (place.nested) hit('conditional-return', l.n, sev); else if (trivial || codeAfter(v, at)) hit('early-return', l.n, sev) }
    else if (place.fn === 'unknown' && (place.nested || trivial)) hit(place.nested ? 'conditional-return' : 'early-return', l.n, 'MEDIUM')
  }
  if (EXIT.test(code)) hit('exit-in-test', l.n, sev)
  if (TRIVIAL.some(r => r.test(code)) || (/^\s*assert\b/.test(code) && TRIVIAL_RAW.test(l.text))) hit('trivial-assert', l.n)
}
const thresholds = (lines: readonly Line[]): number[] => lines.filter(l => !CONFIG_COMMENT.test(l.text)).flatMap(l => [...l.text.matchAll(THRESHOLD)].map(m => Number(m[1]))).sort((a, b) => a - b)

function floor(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  const hit: Hit = (rule, n, sev = 'HIGH') => { out.push({ kind: 'FL', rule, sev, loc: n === undefined ? f.path : `${f.path}:${n}` }) }
  const py = CODE.test(f.path), sev: 'HIGH' | 'MEDIUM' = TEST_FILE.test(f.path) ? 'HIGH' : 'MEDIUM'
  const at = new Map(v.kept.map((l, i) => [l, i])), gone = py && isTest && f.status !== 'deleted' ? removedCodes(ctx.stack, f, ctx.before?.[f.path]) : new Map<Line, string>()
  const textOf = (l: Line): string => (!py ? l.text : l.kind === '-' ? (gone.get(l) ?? l.text) : codeAt(v, at.get(l) ?? -1))
  if (floorStart(f, ctx, isTest, hit, t => TEST_DEF.test(t), t => ASSERTION.test(t), textOf)) return
  for (const l of f.lines.filter(x => x.kind === '+')) {
    const k = at.get(l) ?? -1, code = codeAt(v, k)
    if (isTest && py) testLine(l, k, v, sev, hit)
    if (py && SUPPRESSION.test((v.lexed?.[k]?.parts ?? []).filter(x => x.comment).map(x => x.text).join(' '))) hit('suppression', l.n)
    if (py && (REPORT_FORCING.test(code) || (v.lexed?.[k]?.parts ?? []).some(x => !x.comment && FORCING_NAME.test(x.text)))) hit('report-forcing', l.n)
    if (CONFIG.test(f.path) && !CONFIG_COMMENT.test(l.text) && FILTER.test(l.text)) hit('test-filter', l.n)
  }
  for (const x of injections(v)) hit('injection', x.n, x.sev)
  if (CONFIG.test(f.path)) {
    const was = thresholds(f.lines.filter(x => x.kind === '-')), is = thresholds(f.lines.filter(x => x.kind === '+'))
    if (was.length && (is.length < was.length || was.some((x, i) => (is[i] ?? 0) < x))) hit('coverage-lowered')
  }
}

function junk(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  const hit: Hit = (rule, n, sev = 'HIGH') => { out.push({ kind: 'J', rule, sev, loc: n === undefined ? f.path : `${f.path}:${n}` }) }
  // entrypoints: a folder prefix, or a file name at any depth (`src/pkg/__main__.py`)
  const entry = ctx.stack.data.entrypoints.some(e => (e.endsWith('/') ? f.path.startsWith(e) : f.path === e || f.path.endsWith(`/${e}`)))
  const at = new Map(v.kept.map((l, i) => [l, i]))
  // a line with no code (a comment, a docstring line) has nothing to run
  const debug = (l: Line): boolean => { if (!CODE.test(f.path)) return false; const code = codeAt(v, at.get(l) ?? -1); return DEBUGGER.test(code) || (!isTest && !entry && PRINT.test(code)) }
  // a line that is only a comment reading as code (a call, an assignment, a subscript, a block opener); tool directives
  // are not (owner decision 2026-10-19: three in a row, MEDIUM, as TypeScript's)
  const commented = (l: Line): boolean => {
    const k = at.get(l) ?? -1, text = (v.lexed?.[k]?.parts ?? []).filter(x => x.comment).map(x => x.text).join('').replace(/^#+/, '')
    return CODE.test(f.path) && !codeAt(v, k).trim() && text.trim() !== '' && !DIRECTIVE.test(text) && COMMENTED_CODE.test(text)
  }
  junkRules(f, v, hit, debug, commented)
}

/** Both rule sets on one file, floor first (the order the finding ids follow). */
export function scanFile(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  floor(f, v, ctx, isTest, out)
  junk(f, v, ctx, isTest, out)
}
