// Floor and junk scans (plan v7.1 §5.2, §5.3) over a unified diff (SCAN_DIFF_ARGS) plus the untracked files. Only added
// and removed lines count, so pre-existing junk is never flagged. A finding names a rule and a location, never the
// text. A scan that cannot read its input is `error`, which blocks like a violation.
import { globRe } from './flow-plan'
import { FLOW_TREE_EXCLUDES } from './flow-git'
import { redFindings } from './flow-red'
import { TEST_COMPUTED, normCalls, lexLines, placeOf, openerAt, blockKind, deadCodeAfter, type Lexed } from './flow-js'
export { redShape } from './flow-red'
import type { Stack } from '../flow/data/types'

/** The git diff the scan reads: whole functions as context (so a return's test is in view), fixed prefixes (a
 * repository's diff.noprefix or diff.mnemonicPrefix would change them). */
export const SCAN_DIFF_ARGS = ['diff', '-U1', '--function-context', '--text', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'] as const

/** n: the line number on its side; at (removed lines): the new-side line where the removal sits. */
export type Line = { kind: '+' | '-' | ' '; n: number; text: string; at?: number }
export type DiffFile = { path: string; status: 'added' | 'deleted' | 'modified'; lines: Line[] }
export type ScanFinding = { kind: 'FL' | 'J'; rule: string; sev: 'HIGH' | 'MEDIUM'; loc: string }
export type ScanResult = { status: 'clean' | 'violation' | 'error'; findings: ScanFinding[]; error?: string }
/** At RED, per F test file: the hashes of its added lines (a multiset) and, per added test, its lines in order. */
export type RedShape = { lines: string[]; blocks: string[][] }
/** frozen: files no edit may touch; red: the RED shape per F test file; texts: the RED files' current full text (their
 * imports are often out of the diff); counts: tests before/after; ignored: the ignored-file set hash at F start and now. */
export type ScanCtx = { stack: Stack; frozen: readonly string[]; red?: Readonly<Record<string, RedShape>>; texts?: Readonly<Record<string, string>>; counts?: { before: number; after: number }; ignored?: { before: string; after: string } }

/** The review protocol's strings (plan §4.1) and the owner's commands: in a comment or string they aim at the reviewer. */
export const PROTOCOL_TOKENS = ['REVIEW-END', 'NO-FINDINGS', 'FINDING |', '[flow-escalate]', 'TICKET ', 'UNTRUSTED-', '/flow-approve', '/flow-waive', '/flow-decide', '/flow-ship']
/** The distinctive tokens, matched anywhere on a line in any case and spacing (no code or prose uses them otherwise). */
const TOKEN_RES = [/(?<![\w-])review\s*-\s*end(?![\w-])/i, /(?<![\w-])no\s*-\s*findings(?![\w-])/i, /\[\s*flow\s*-\s*escalate\s*\]/i, /\/flow-(?:approve|waive|decide|ship)\b/i, /FINDING\s*\|/]
/** Tokens common words could form, matched as written inside comments and strings only. */
const STRING_TOKENS = ['TICKET ', 'UNTRUSTED-']

const CODE = /\.[cm]?[jt]sx?$/
const CONFIG = /(^|\/)((vitest|vite|jest|playwright|karma)(\.[\w-]+)?\.config\.\w+|package\.json|\.mocharc[\w.]*)$/
const PROSE = /\.(md|mdx|txt|rst)$/i
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
const PHRASE_VERB = /\b(?:[Ii]gnore|[Aa]pprove[ds]?|[Pp]re-?approved|[Rr]eport no|[Ss]kip)\b/
const PHRASES = [new RegExp(`\\b(?:reviewers?|assistants?)\\b.{0,40}?${PHRASE_VERB.source}`, 'i'), new RegExp(`\\b(?:AI|LLM)s?\\b.{0,40}?${PHRASE_VERB.source}`)]
const DEBUG = /\bconsole\.(?:log|debug)\s*\(|^\s*debugger\s*;?\s*$/
const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b/
const JUNK_FILE = /\.(tmp|bak|orig|rej|swp)$|~$|(^|\/)\.DS_Store$|(^|\/)scratch[^/]*$|(^|\/)debug[^/]*\.log$|(^|\/)out\.txt$/
const COMMENTED_CODE = /^\s*\/\/.*[;{}()=]/
const LOOKALIKE_FROM = 'АВЕКМНОРСТХІЈЅаеорсухіјѕΑΒΕΖΗΙΚΜΝΟΡΤΧΥο', LOOKALIKE_TO = 'ABEKMHOPCTXIJSaeopcyxijsABEZHIKMNOPTXYo'

const C_ESC: Readonly<Record<string, string>> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
/** A path as git prints it: plain, or C-quoted with escapes and octal UTF-8 bytes. Throws on bytes that are not UTF-8. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p
  const chars = Array.from(p.slice(1, -1))
  let enc = ''
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] ?? '', d = chars[i + 1] ?? ''
    if (c !== '\\') enc += encodeURIComponent(c)
    else if (/[0-7]/.test(d)) { enc += `%${parseInt(chars.slice(i + 1, i + 4).join(''), 8).toString(16).padStart(2, '0')}`; i += 3 }
    else { enc += encodeURIComponent(C_ESC[d] ?? d); i += 1 }
  }
  return decodeURIComponent(enc)
}
/** The path a `diff --git` header names (renames are off, so both sides name the same file), or '' when unclear. */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) return unquote(/^"(?:\\.|[^"\\])*"\s+("(?:\\.|[^"\\])*")$/.exec(rest)?.[1] ?? '""').replace(/^b\//, '')
  const len = (rest.length - 5) / 2
  return Number.isInteger(len) && rest.startsWith('a/') && rest.slice(2 + len, 5 + len) === ' b/' && rest.slice(2, 2 + len) === rest.slice(5 + len) ? rest.slice(5 + len) : ''
}
/** A unified diff as files and ordered lines with their line numbers (new numbering for '+' and context). Throws on
 * input it cannot read. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null, oldN = 0, newN = 0, inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { file = { path: headerPath(line.slice(11)), status: 'modified', lines: [] }; files.push(file); inHunk = false; continue }
    if (!file) continue
    if (!inHunk) {
      const side = /^(?:---|\+\+\+) (.*?)\t?$/.exec(line)?.[1]
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (side && side !== '/dev/null' && !file.path) file.path = unquote(side).replace(/^[ab]\//, '')
    }
    if (line.startsWith('@@')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!h) throw new Error(`unreadable hunk header in ${file.path || 'a file'}`)
      // An empty new side (`+6,0`) names the line before the gap: its removals sit at the next line.
      oldN = Number(h[1]); newN = Number(h[2]) + (h[3] === '0' ? 1 : 0); inHunk = true; continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) file.lines.push({ kind: '+', n: newN++, text: line.slice(1) })
    else if (line.startsWith('-')) file.lines.push({ kind: '-', n: oldN++, text: line.slice(1), at: newN })
    else if (line.startsWith(' ')) { file.lines.push({ kind: ' ', n: newN, text: line.slice(1) }); newN += 1; oldN += 1 }
  }
  if (files.some(f => !f.path)) throw new Error('a diff entry without a path')
  return files
}

const clean = (t: string): string => Array.from(t.normalize('NFKC').replace(/\p{Cf}/gu, '')).map(c => { const k = LOOKALIKE_FROM.indexOf(c); return k < 0 ? c : LOOKALIKE_TO[k] ?? c }).join('')
const mixedScript = (t: string): boolean => (t.match(/[\p{L}\p{M}]+/gu) ?? []).some(w => /\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w))
/** A file's kept lines (added and context) and, for JS/TS, each one lexed with the state carried across lines. */
type View = { kept: Line[]; lexed: Lexed[] | null; codes?: string[] }
type Hit = (rule: string, n?: number, sev?: 'HIGH' | 'MEDIUM') => void
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
/** Per added line: whether its comments and strings (whole lines outside JS/TS) carry a protocol token (HIGH), or a
 * reviewer phrase, a hidden character or a mixed-script word (MEDIUM). */
function injections(v: View): Array<{ n: number; sev: 'HIGH' | 'MEDIUM' }> {
  const out: Array<{ n: number; sev: 'HIGH' | 'MEDIUM' }> = []
  for (const [i, l] of v.kept.entries()) {
    if (l.kind !== '+') continue
    const parts = v.lexed ? (v.lexed[i]?.parts ?? []).map(x => x.text) : [l.text]
    const seen = clean(parts.join(' \u0000 ')), joined = clean(parts.join(''))
    const whole = clean(l.text)
    const token = TOKEN_RES.some(r => r.test(whole) || r.test(joined)) || STRING_TOKENS.some(t => seen.includes(t) || joined.includes(t))
    if (token || PHRASES.some(r => r.test(seen)) || /\p{Cf}/u.test(l.text) || mixedScript(l.text)) out.push({ n: l.n, sev: token ? 'HIGH' : 'MEDIUM' })
  }
  return out
}

const thresholds = (lines: readonly Line[]): Map<string, number[]> => {
  const out = new Map<string, number[]>()
  for (const l of lines) for (const m of l.text.matchAll(THRESHOLD)) out.set(m[1] ?? '', [...(out.get(m[1] ?? '') ?? []), Number(m[2])].sort((a, b) => a - b))
  return out
}

function floor(f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]): void {
  const hit = (rule: string, n?: number, sev: 'HIGH' | 'MEDIUM' = 'HIGH'): void => { out.push({ kind: 'FL', rule, sev, loc: n === undefined ? f.path : `${f.path}:${n}` }) }
  const base = f.path.slice(f.path.lastIndexOf('/') + 1)
  if (/^(claude|agents)\.md$/i.test(base)) hit('agent-instructions')
  if (ctx.frozen.some(x => x.toLowerCase() === f.path.toLowerCase())) hit('frozen-file')
  if (isTest && f.status === 'deleted') { hit('test-file-deleted'); return }
  const added = f.lines.filter(l => l.kind === '+'), removed = f.lines.filter(l => l.kind === '-')
  const decl = (l: Line): boolean => TEST_DECL.test(normCalls(l.text))
  const testRemoved = isTest && removed.filter(decl).length > added.filter(decl).length
  if (testRemoved) hit('test-removed')
  else if (isTest && removed.filter(l => ASSERTION.test(l.text)).length > added.filter(l => ASSERTION.test(l.text)).length) hit('assertion-removed')
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
  if (f.status === 'added' && JUNK_FILE.test(f.path)) { hit('junk-file'); return }
  const entry = ctx.stack.entrypoints.some(e => (e.endsWith('/') ? f.path.startsWith(e) : f.path === e))
  const gitignore = /(^|\/)\.gitignore$/.test(f.path)
  const lexOf = new Map(v.kept.map((l, i) => [l, v.lexed?.[i]]))
  let run: Line[] = []
  for (const l of f.lines) {
    if (l.kind !== '+') { run = []; continue }
    if (gitignore) { if (l.text.trim()) hit('gitignore', l.n); continue }
    if (CODE.test(f.path) && !isTest && !entry && DEBUG.test(l.text)) hit('debug-leftover', l.n)
    // In code, only comments count: `'(XXX) XXX-XXXX'` is a format mask, not a marker.
    const lexed = lexOf.get(l)
    if (TODO.test(lexed ? lexed.parts.filter(x => x.comment).map(x => x.text).join(' ') : l.text)) hit('todo-marker', l.n)
    if (l.text.includes('.snagon/')) hit('flow-data-reference', l.n)
    run = COMMENTED_CODE.test(l.text) ? [...run, l] : []
    if (run.length === 3) hit('commented-code', run[0]?.n, 'MEDIUM')
  }
}

/** Both scans over the diff and the untracked files (as added). Flow's own views are never scanned. */
export function scan(diffText: string, untracked: ReadonlyArray<{ path: string; content: string }>, ctx: ScanCtx): ScanResult {
  let files: DiffFile[]
  try {
    files = [...parseDiff(diffText), ...untracked.map((u): DiffFile => ({ path: u.path, status: 'added', lines: u.content.split('\n').map((text, i) => ({ kind: '+' as const, n: i + 1, text })).filter((l, i, all) => !(i === all.length - 1 && l.text === '')) }))]
  } catch (err) { return { status: 'error', findings: [], error: String(err) } }
  const excluded = (p: string): boolean => FLOW_TREE_EXCLUDES.some(x => p === x || p.startsWith(`${x}/`))
  const tests = ctx.stack.testFiles.map(globRe)
  const findings: ScanFinding[] = []
  for (const f of files.filter(x => !excluded(x.path))) {
    const isTest = tests.some(t => t.test(f.path))
    const kept = f.lines.filter(l => l.kind !== '-'), lexed = CODE.test(f.path) ? lexLines(kept) : null
    const view: View = { kept, lexed, codes: lexed?.map(x => x.code) }
    floor(f, view, ctx, isTest, findings)
    junk(f, view, ctx, isTest, findings)
  }
  findings.push(...redFindings(files, ctx.red ?? {}, ctx.texts ?? {}))
  if (ctx.counts && ctx.counts.after < ctx.counts.before) findings.push({ kind: 'FL', rule: 'fewer-tests', sev: 'HIGH', loc: `${ctx.counts.before}→${ctx.counts.after}` })
  if (ctx.ignored && ctx.ignored.before !== ctx.ignored.after) findings.push({ kind: 'J', rule: 'ignored-set', sev: 'HIGH', loc: 'ignored files' })
  return { status: findings.some(f => f.sev === 'HIGH') ? 'violation' : 'clean', findings }
}
