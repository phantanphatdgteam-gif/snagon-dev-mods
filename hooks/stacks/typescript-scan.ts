// The TypeScript stack's floor and junk rules (plan v7.1 §5.2, §5.3; in hooks/flow-scan.ts until R2 step 1, unchanged):
// skips, gated, early-returning and wrapped tests, removed tests and assertions, exits, swallowed errors, trivial
// asserts, suppressions, matcher overrides, result forcing and lowered coverage; debug leftovers, TODO markers in
// comments and commented-out code. flow-scan.ts runs scanFile on each file of the diff.
import { TEST_COMPUTED, normCalls, placeOf, openerAt, blockKind, deadCodeAfter } from './typescript-lex'
import { floorStart, injections, junkRules, removedCodes, type DiffFile, type Hit, type Line, type ScanCtx, type ScanFinding, type View } from '../flow-scan'

/** The stack's code files: the ones its lexer reads. */
export const CODE = /\.[cm]?[jt]sx?$/
const CONFIG = /(^|\/)((vitest|vite|jest|playwright|karma)(\.[\w-]+)?\.config\.\w+|package\.json|\.mocharc[\w.]*)$/
const TEST_API = '(?<![.\\w$])(?:it|test|describe|suite|bench)'
const SKIP_ONLY = [
  new RegExp(`${TEST_API}(?:\\.\\w+)*\\.(?:skip|only|todo|fails|failing|skipIf|runIf)\\b`), TEST_COMPUTED,
  /(?<![.\w$])(?:xit|xdescribe|xtest|fit|fdescribe|ftest)\s*\(/, /\.each\(\s*\[\s*\]\s*\)/, /\bexpect\.assertions\(\s*0\s*\)/, /(?:^\s*(?:await\s+)?|=>\s*)skip\s*\(/, /\b(?:ctx|t|task|c)\.skip\s*\(/,
]
/** A skip-type modifier on a line of its own, continuing a test API call from the line above. */
const SKIP_NEXT = /^\s*(?:\?\.|\.)\s*(?:skip|only|todo|fails|failing|skipIf|runIf)\b/
const API_AT_END = /(?<![.\w$])(?:it|test|describe|suite|bench)(?:\.[\w$]+)*\s*$/
const TEST_DECL = /(?<![.\w$])(?:it|test)(?:(?:\.\w+)*\s*\(\s*['"`]|(?:\.\w+)*\.each\b)/
/** Test files proper; other files under the test globs are helpers, where the same rules are only MEDIUM. */
const SPEC_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
/** A return statement anywhere on a line (after `;`, `{` or `}` too), read on code. */
const RETURN_ANY = /(?:^|[;{})]|\belse)\s*return\b/
const GUARD_LINE = /^\s*(?:\}\s*)?(?:(?:else\s+)?if\b|else\b)/
/** A return value that says nothing about the code under test (read on code, from the return keyword on). */
const TRIVIAL_RETURN = /^return(?:\s+(?:void\s+0|undefined|null|true|false|-?\d+(?:\.\d+)?|""|Promise\s*\.\s*resolve\s*\([^()]*\)|\{\s*\}|\[\s*\]))?\s*;?[\s}]*$/
/** A test declared under a gate on its own line: `if (…) it(`, `cond && it(`, `cond ? it(…)`. */
const GATED_DECL = /^\s*(?:\}\s*)?(?:(?:else\s+)?if\s*\(.*\)|else)\s*\{?\s*(?:it|test)\b|(?:&&|\|\||\?\?|\?)\s*(?:it|test)\s*[.(]/
/** The test API used as a value (aliased, destructured, passed, listed), unless the line declares its own `it`. */
const API_VALUE = /(?<=[=(,:?\[{|&]\s*)(?:it|test|describe)\s*(?=[;,\]}:]|\)(?!\s*(?::\s*[^=]+)?=>)|$)|\}\s*=\s*(?:it|test|describe)\b/
const API_SHADOW = /\(\s*(?:it|test)\s*\)\s*=>|\b(?:it|test)\s*=>|\b(?:const|let|var)\s+(?:it|test)\b/
/** `.fails(` / `.failing(` on any receiver: a test that passes by failing. */
const FAILS_CALL = /\.(?:fails|failing)\s*\(/
const ASSERTION = /\bexpect\s*\(|\bassert\b/
const EXIT = /\bprocess\.(?:exit|reallyExit|abort|kill)\s*\(/
const SWALLOW = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|tslint:disable|\bjshint\b|\b(?:istanbul|c8|v8) ignore\b|\/\*\s*(?:eslint\s+['"]?[@\w/-]+['"]?\s*:|eslint-env\b|globals?\s)/
/** The built-in matchers of jest and vitest, by exact name. */
const MATCHER = `(?:${['toBe', 'toBeCloseTo', 'toBeDefined', 'toBeFalsy', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeInstanceOf', 'toBeLessThan', 'toBeLessThanOrEqual', 'toBeNaN', 'toBeNull', 'toBeOneOf', 'toBeTruthy', 'toBeTypeOf', 'toBeUndefined', 'toContain', 'toContainEqual', 'toEqual', 'toHaveBeenCalled', 'toHaveBeenCalledOnce', 'toHaveBeenCalledTimes', 'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toHaveLastReturnedWith', 'toHaveLength', 'toHaveNthReturnedWith', 'toHaveProperty', 'toHaveReturned', 'toHaveReturnedTimes', 'toHaveReturnedWith', 'toHaveResolved', 'toHaveResolvedWith', 'toMatch', 'toMatchFileSnapshot', 'toMatchInlineSnapshot', 'toMatchObject', 'toMatchSnapshot', 'toSatisfy', 'toStrictEqual', 'toThrow', 'toThrowError', 'toThrowErrorMatchingInlineSnapshot', 'toThrowErrorMatchingSnapshot', 'toBeCalled', 'toBeCalledTimes', 'toBeCalledWith', 'toReturn', 'toReturnTimes', 'toReturnWith', 'lastCalledWith', 'lastReturnedWith', 'nthCalledWith', 'nthReturnedWith'].join('|')})(?![\\w$])`
/** A built-in matcher redefined: every assertion using it can pass. expect.extend on one line anywhere; a method or key
 * with a matcher's name only in a file that can define matchers (tests, setup, a file calling expect.extend). */
const MATCHER_EXTEND = new RegExp(`\\bexpect\\s*\\.\\s*extend\\s*\\(\\s*\\{[^}]*?\\b${MATCHER}['"]?\\s*[:(]`)
const MATCHER_DEF = new RegExp(`^\\s*['"]?(?:async\\s+)?${MATCHER}['"]?\\s*(?::|\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{)`)
const TRIVIAL = [
  /expect\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|(['"`])[^'"`]*\2)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /expect\(\s*([A-Za-z_$][\w$.]*)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /expect\(\s*(?:true|1|'[^']*'|"[^"]*")\s*\)\.toBeTruthy\(\s*\)/, /\bassert(?:\.ok)?\(\s*true\s*\)/,
]
const FORCING = /\btestResultsProcessor\b|\breporters?["']?\s*:|passWithNoTests/
const THRESHOLD = /\b(lines|branches|functions|statements|threshold)\b["']?\s*:\s*(-?\d+(?:\.\d+)?)/g
const DEBUG = /\bconsole\.(?:log|debug)\s*\(|^\s*debugger\s*;?\s*$/
const COMMENTED_CODE = /^\s*\/\/.*[;{}()=]/

const IMPORT_LOOKBACK = 50
/** The names an import list line holds (`import {`, `a, b as c,`, `} from 'x'`), or null when it holds anything else.
 * String operations and simple classes only: the line is untrusted and may be long. */
function importNames(text: string): string[] | null {
  const from = text.search(/\bfrom\s*['"`]/)
  const head = (from >= 0 ? text.slice(0, from) : text).replace(/^\s*import\b/, '')
  const tokens = head.split(/[\s,{}]+/).filter(Boolean)
  return tokens.every(t => /^[\w$]+$/.test(t)) ? tokens : null
}
/** Whether a kept line is part of an import declaration: its first line, or a line of a `{ … }` list that one opened. */
function inImport(v: View, at: number): boolean {
  const text = (k: number): string => v.kept[k]?.text ?? ''
  if (/^\s*import\b/.test(text(at))) return true
  if (importNames(text(at)) === null) return false
  for (let k = at - 1; k >= 0 && at - k <= IMPORT_LOOKBACK; k -= 1) {
    const t = text(k)
    if (/^\s*import\b/.test(t)) return t.includes('{') && !t.includes('}')
    if (importNames(t) === null || t.includes('}')) return false
  }
  return false
}
/** Rules for one added line of a test file: skips (also through aliases, gates and chains split over lines), returns
 * that end a test or suite early, process exits, swallowed errors and trivial asserts. */
function testLine(l: Line, at: number, v: View, spec: 'HIGH' | 'MEDIUM', hit: Hit): void {
  const { kept, codes } = v, code = codes?.[at] ?? l.text, calls = normCalls(l.text)
  // The code line a continuation hangs from: back past blank, comment-only and other continuation lines.
  let k = at - 1
  while (k >= 0 && (!(codes?.[k] ?? kept[k]?.text ?? '').trim() || /^\s*(?:\?\.|\.)/.test(codes?.[k] ?? kept[k]?.text ?? ''))) k -= 1
  const chained = SKIP_NEXT.test(l.text) && k >= 0 && API_AT_END.test(normCalls(codes?.[k] ?? kept[k]?.text ?? ''))
  // The test API imported under its own name is no alias; renamed on import (`it as t`) it is.
  const aliased = inImport(v, at) ? /\b(?:it|test|describe)\s+as\s+[\w$]/.test(l.text) : API_VALUE.test(code) && !API_SHADOW.test(code)
  if (SKIP_ONLY.some(r => r.test(calls)) || FAILS_CALL.test(normCalls(code)) || chained || aliased) hit('skip-or-only', l.n)
  if (GATED_DECL.test(code) && TEST_DECL.test(calls)) hit('conditional-test', l.n, spec)
  if (RETURN_ANY.test(code)) {
    // A guard, a return inside control flow, a value that means nothing, or code after it, in a test or suite body. In
    // another function (a mock, a callback, a hook) it is fine; out of view, a guard or a trivial return is MEDIUM.
    const place = placeOf(kept, at, codes), ret = code.slice(code.search(/\breturn\b/))
    const cond = GUARD_LINE.test(code) || place.nested, trivial = !cond && TRIVIAL_RETURN.test(ret)
    const deadTail = /;\s*[^\s})\]]/.test(ret.replace(/^return\b[^;]*/, ''))
    if (place.fn === 'test' || place.fn === 'suite') { if (cond) hit('conditional-return', l.n, spec); else if (trivial || deadTail || deadCodeAfter(kept, at, codes)) hit('early-return', l.n, spec) }
    else if (place.fn === 'unknown' && (cond || trivial)) hit(cond ? 'conditional-return' : 'early-return', l.n, 'MEDIUM')
  }
  if (EXIT.test(l.text)) hit('exit-in-test', l.n, spec)
  if (SWALLOW.test(l.text)) hit('swallowed-error', l.n, 'MEDIUM')
  if (TRIVIAL.some(r => r.test(l.text))) hit('trivial-assert', l.n)
}
/** Unchanged assertions or test declarations that now sit under a new block: control flow or a named function (their
 * code may never run: HIGH in test files), a loop (MEDIUM). A new describe or a callback around them is fine. */
function wrapped(v: View, spec: 'HIGH' | 'MEDIUM', hit: Hit): void {
  const { kept, codes } = v, seen = new Set<number>()
  for (const [i, l] of kept.entries()) {
    if (l.kind !== ' ') continue
    const code = codes?.[i] ?? l.text, isDecl = TEST_DECL.test(normCalls(code))
    if (!isDecl && !ASSERTION.test(code)) continue
    const o = openerAt(kept, i, codes)
    if (o === undefined || o < 0 || kept[o]?.kind !== '+' || seen.has(o)) continue
    const kind = blockKind(kept, o, codes)
    const sev = kind === 'control' || kind === 'named-fn' ? spec : kind === 'loop' ? 'MEDIUM' : null
    if (sev) { seen.add(o); hit(isDecl ? 'conditional-test' : 'wrapped-assertion', kept[o]?.n, sev) }
  }
}

const thresholds = (lines: readonly Line[]): Map<string, number[]> => {
  const out = new Map<string, number[]>()
  for (const l of lines) for (const m of l.text.matchAll(THRESHOLD)) out.set(m[1] ?? '', [...(out.get(m[1] ?? '') ?? []), Number(m[2])].sort((a, b) => a - b))
  return out
}

function floor(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  const hit = (rule: string, n?: number, sev: 'HIGH' | 'MEDIUM' = 'HIGH'): void => { out.push({ kind: 'FL', rule, sev, loc: n === undefined ? f.path : `${f.path}:${n}` }) }
  // removed and added tests and assertions counted on code, the old side lexed too: a commented-out assertion is one
  // removed (owner decision 2026-10-19, as Python's GAP-R2-0.6-50)
  const lexes = CODE.test(f.path), gone = lexes && isTest && f.status !== 'deleted' ? removedCodes(ctx.stack, f, ctx.before?.[f.path]) : new Map<Line, string>()
  const at = new Map(v.kept.map((l, i) => [l, i]))
  const textOf = (l: Line): string => (!lexes ? l.text : l.kind === '-' ? (gone.get(l) ?? l.text) : (v.codes?.[at.get(l) ?? -1] ?? l.text))
  if (floorStart(f, ctx, isTest, hit, t => TEST_DECL.test(normCalls(t)), t => ASSERTION.test(t), textOf)) return
  const added = f.lines.filter(l => l.kind === '+'), removed = f.lines.filter(l => l.kind === '-')
  const spec: 'HIGH' | 'MEDIUM' = SPEC_FILE.test(f.path) ? 'HIGH' : 'MEDIUM'
  const source = CODE.test(f.path) || CONFIG.test(f.path) || /\.(?:vue|svelte|json)$/.test(f.path)
  const matcherFile = isTest || /setup/i.test(f.path) || v.kept.some(l => /\bexpect\s*\.\s*extend\b/.test(l.text))
  for (const l of added) {
    if (isTest) testLine(l, v.kept.indexOf(l), v, spec, hit)
    if (source && SUPPRESSION.test(l.text)) hit('suppression', l.n)
    if (source && /prettier-ignore/.test(l.text)) hit('suppression', l.n, 'MEDIUM')
    if (source && (MATCHER_EXTEND.test(l.text) || (matcherFile && MATCHER_DEF.test(l.text)))) hit('matcher-override', l.n)
    if (CONFIG.test(f.path) && FORCING.test(l.text)) hit('result-forcing', l.n)
  }
  if (isTest) wrapped(v, spec, hit)
  for (const x of injections(v)) hit('injection', x.n, x.sev)
  if (CONFIG.test(f.path)) {
    const now = thresholds(added)
    for (const [key, was] of thresholds(removed)) { const is = now.get(key) ?? []; if (is.length < was.length || was.some((v, i) => (is[i] ?? 0) < v)) hit('coverage-lowered') }
  }
}

function junk(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  const hit = (rule: string, n?: number, sev: 'HIGH' | 'MEDIUM' = 'HIGH'): void => { out.push({ kind: 'J', rule, sev, loc: n === undefined ? f.path : `${f.path}:${n}` }) }
  const entry = ctx.stack.data.entrypoints.some(e => (e.endsWith('/') ? f.path.startsWith(e) : f.path === e))
  junkRules(f, v, hit, l => CODE.test(f.path) && !isTest && !entry && DEBUG.test(l.text), l => COMMENTED_CODE.test(l.text))
}

/** Both rule sets on one file, floor first (the order the finding ids follow). */
export function scanFile(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  floor(f, v, ctx, isTest, out)
  junk(f, v, ctx, isTest, out)
}
