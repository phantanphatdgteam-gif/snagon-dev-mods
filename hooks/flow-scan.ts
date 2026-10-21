// Floor and junk scans (plan v7.1 §5.2, §5.3) over a unified diff (SCAN_DIFF_ARGS) plus the untracked files. Only added
// and removed lines count, so pre-existing junk is never flagged. A finding names a rule and a location, never the
// text. A scan that cannot read its input is `error`, which blocks like a violation. The rules for the code itself are
// the stack's (its code's `lex`, `scanFile` and `redFindings`, hooks/stacks/); the diff reader, the injection rule and
// the checks over the whole run (test count, ignored set) are here.
import { globRe } from './flow-plan'
import { FLOW_TREE_EXCLUDES } from './flow-git'
import type { StackEntry } from './stacks/index'

/** The git diff the scan reads: whole functions as context (so a return's test is in view), fixed prefixes (a
 * repository's diff.noprefix or diff.mnemonicPrefix would change them). */
export const SCAN_DIFF_ARGS = ['diff', '-U1', '--function-context', '--text', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'] as const

/** n: the line number on its side; at (removed lines): the new-side line where the removal sits; o (context lines): the
 * old-side line number. */
export type Line = { kind: '+' | '-' | ' '; n: number; text: string; at?: number; o?: number }
export type DiffFile = { path: string; status: 'added' | 'deleted' | 'modified'; lines: Line[] }
/** sig: the hash of the text of the line `loc` names (`path:n`), set by flow-judging's withSigs; none on a file or count. */
export type ScanFinding = { kind: 'FL' | 'J'; rule: string; sev: 'HIGH' | 'MEDIUM'; loc: string; sig?: string }
export type ScanResult = { status: 'clean' | 'violation' | 'error'; findings: ScanFinding[]; error?: string }
/** At RED, per F test file: the hashes of its added lines (a multiset) and, per added test, its lines in order and (for
 * a stack that records them) its path, `Class.name`, so another binding of the name is seen. */
export type RedShape = { lines: string[]; blocks: string[][]; names?: string[] }
/** frozen: files no edit may touch; red: the RED shape per F test file; texts: the new side's full text of the changed
 * code files and the RED files (a hunk can start inside a string, and imports are often out of the diff); before: the
 * old side's full text of the changed code files; counts: tests before/after; ignored: the ignored-file set hash at F
 * start and now. */
export type ScanCtx = { stack: StackEntry; frozen: readonly string[]; red?: Readonly<Record<string, RedShape>>; texts?: Readonly<Record<string, string>>; before?: Readonly<Record<string, string>>; counts?: { before: number; after: number }; ignored?: { before: string; after: string } }
/** One kept line as the stack's lexer reads it: its comment and literal texts, and its code with literals blanked. */
export type LexedLine = { readonly parts: ReadonlyArray<{ readonly text: string; readonly comment: boolean }>; readonly code: string }
/** A file's kept lines (added and context) and, for the stack's code files, each one lexed with the state carried across
 * lines. */
export type View = { kept: Line[]; lexed: LexedLine[] | null; codes?: string[] }
export type Hit = (rule: string, n?: number, sev?: 'HIGH' | 'MEDIUM') => void

/** The review protocol's strings (plan §4.1) and the owner's commands: in a comment or string they aim at the reviewer. */
export const PROTOCOL_TOKENS = ['REVIEW-END', 'NO-FINDINGS', 'FINDING |', '[flow-escalate]', 'TICKET ', 'UNTRUSTED-', '/flow-approve', '/flow-waive', '/flow-allow', '/flow-decide', '/flow-ship']
/** The distinctive tokens, matched anywhere on a line in any case and spacing (no code or prose uses them otherwise). */
const TOKEN_RES = [/(?<![\w-])review\s*-\s*end(?![\w-])/i, /(?<![\w-])no\s*-\s*findings(?![\w-])/i, /\[\s*flow\s*-\s*escalate\s*\]/i, /\/flow-(?:approve|waive|allow|decide|ship)\b/i, /FINDING\s*\|/]
/** Tokens common words could form, matched as written inside comments and strings only. */
const STRING_TOKENS = ['TICKET ', 'UNTRUSTED-']

const PHRASE_VERB = /\b(?:[Ii]gnore|[Aa]pprove[ds]?|[Pp]re-?approved|[Rr]eport no|[Ss]kip)\b/
const PHRASES = [new RegExp(`\\b(?:reviewers?|assistants?)\\b.{0,40}?${PHRASE_VERB.source}`, 'i'), new RegExp(`\\b(?:AI|LLM)s?\\b.{0,40}?${PHRASE_VERB.source}`)]
/** Markers of unfinished work (in a stack's code files, read in comments only). */
export const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b/
/** Files nobody means to commit: editor and merge leftovers, scratch files, debug logs. */
export const JUNK_FILE = /\.(tmp|bak|orig|rej|swp)$|~$|(^|\/)\.DS_Store$|(^|\/)scratch[^/]*$|(^|\/)debug[^/]*\.log$|(^|\/)out\.txt$/
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
    else if (line.startsWith(' ')) { file.lines.push({ kind: ' ', n: newN, text: line.slice(1), o: oldN }); newN += 1; oldN += 1 }
  }
  if (files.some(f => !f.path)) throw new Error('a diff entry without a path')
  return files
}

const clean = (t: string): string => Array.from(t.normalize('NFKC').replace(/\p{Cf}/gu, '')).map(c => { const k = LOOKALIKE_FROM.indexOf(c); return k < 0 ? c : LOOKALIKE_TO[k] ?? c }).join('')
const mixedScript = (t: string): boolean => (t.match(/[\p{L}\p{M}]+/gu) ?? []).some(w => /\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w))
/** Per added line: whether its comments and strings (whole lines outside the stack's code files) carry a protocol token
 * (HIGH), or a reviewer phrase, a hidden character or a mixed-script word (MEDIUM). Every stack's floor rules end with it. */
export function injections(v: View): Array<{ n: number; sev: 'HIGH' | 'MEDIUM' }> {
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

/** The floor rules every stack's floor starts with (the order finding ids follow): agent instruction files, frozen
 * files, a deleted test file (true: nothing more to read in it), and a diff that removes more test declarations
 * (`decl`) or assertions (`assertion`) than it adds, each read on one line as `textOf` gives it (the raw line, or its
 * code where the stack lexes both sides). */
export function floorStart(f: DiffFile, ctx: ScanCtx, isTest: boolean, hit: Hit, decl: (text: string) => boolean, assertion: (text: string) => boolean, textOf: (l: Line) => string = l => l.text): boolean {
  const base = f.path.slice(f.path.lastIndexOf('/') + 1)
  if (/^(claude|agents)\.md$/i.test(base)) hit('agent-instructions')
  if (ctx.frozen.some(x => x.toLowerCase() === f.path.toLowerCase())) hit('frozen-file')
  if (isTest && f.status === 'deleted') { hit('test-file-deleted'); return true }
  const count = (kind: '+' | '-', p: (text: string) => boolean): number => f.lines.filter(l => l.kind === kind && p(textOf(l))).length
  if (isTest && count('-', decl) > count('+', decl)) hit('test-removed')
  else if (isTest && count('-', assertion) > count('+', assertion)) hit('assertion-removed')
  return false
}

/** The junk rules every stack shares, in one pass over the added lines (the order finding ids follow): a junk file,
 * added .gitignore lines, the stack's debug leftovers (`debug`), TODO markers (in a code file's comments only),
 * references to flow's own data, and three commented-out code lines in a row (`commented`; null: no such rule). */
export function junkRules(f: DiffFile, v: View, hit: Hit, debug: (l: Line) => boolean, commented: ((l: Line) => boolean) | null): void {
  if (f.status === 'added' && JUNK_FILE.test(f.path)) { hit('junk-file'); return }
  const gitignore = /(^|\/)\.gitignore$/.test(f.path)
  const lexOf = new Map(v.kept.map((l, i) => [l, v.lexed?.[i]]))
  let run: Line[] = []
  for (const l of f.lines) {
    if (l.kind !== '+') { run = []; continue }
    if (gitignore) { if (l.text.trim()) hit('gitignore', l.n); continue }
    if (debug(l)) hit('debug-leftover', l.n)
    // In code, only comments count: `'(XXX) XXX-XXXX'` is a format mask, not a marker.
    const lexed = lexOf.get(l)
    if (TODO.test(lexed ? lexed.parts.filter(x => x.comment).map(x => x.text).join(' ') : l.text)) hit('todo-marker', l.n)
    if (l.text.includes('.snagon/')) hit('flow-data-reference', l.n)
    run = commented?.(l) ? [...run, l] : []
    if (run.length === 3) hit('commented-code', run[0]?.n, 'MEDIUM')
  }
}

/** Lines of one side lexed by the stack: from that side's whole text when the caller has it (each line taken by its
 * number `num`, and a line that differs from the text throws), else hunk by hunk. */
export function sideLexed(stack: StackEntry, path: string, lines: readonly Line[], whole: string | undefined, num: (l: Line) => number): LexedLine[] | null {
  if (whole === undefined || stack.code.lexWhole?.(path) === false) return stack.code.lex(path, lines.map(l => ({ ...l, n: num(l) })))
  const all = whole.split('\n'), lexed = stack.code.lex(path, all.map((text, i) => ({ kind: ' ' as const, n: i + 1, text })))
  if (!lexed) return null
  return lines.map(l => {
    const k = num(l) - 1
    if (all[k] !== l.text) throw new Error(`${path}:${k + 1} is not the text the diff shows`)
    return lexed[k] ?? { parts: [], code: '' }
  })
}

/** The code of each removed line, lexed by the stack on the old side (its whole text when the scan has it, else hunk by
 * hunk with the context lines at their old numbers), so a commented-out or quoted test or assertion is none on either
 * side (GAP-R2-0.6-50; TypeScript too, owner decision 2026-10-19). A file the stack does not lex keeps its raw lines. */
export function removedCodes(stack: StackEntry, f: DiffFile, before: string | undefined): Map<Line, string> {
  const side = f.lines.filter(l => l.kind !== '+'), lexed = sideLexed(stack, f.path, side, before, l => (l.kind === '-' ? l.n : (l.o ?? -1)))
  const out = new Map<Line, string>()
  side.forEach((l, i) => { if (l.kind === '-') out.set(l, lexed?.[i]?.code ?? l.text) })
  return out
}

/** Both scans over the diff and the untracked files (as added), with the stack's rules and RED freeze. Flow's own views
 * are never scanned. */
export function scan(diffText: string, untracked: ReadonlyArray<{ path: string; content: string }>, ctx: ScanCtx): ScanResult {
  let files: DiffFile[]
  try {
    files = [...parseDiff(diffText), ...untracked.map((u): DiffFile => ({ path: u.path, status: 'added', lines: u.content.split('\n').map((text, i) => ({ kind: '+' as const, n: i + 1, text })).filter((l, i, all) => !(i === all.length - 1 && l.text === '')) }))]
  } catch (err) { return { status: 'error', findings: [], error: String(err) } }
  const excluded = (p: string): boolean => FLOW_TREE_EXCLUDES.some(x => p === x || p.startsWith(`${x}/`))
  const { code } = ctx.stack, tests = ctx.stack.data.testFiles.map(globRe)
  const findings: ScanFinding[] = []
  try {
    for (const f of files.filter(x => !excluded(x.path))) {
      const isTest = tests.some(t => t.test(f.path))
      const kept = f.lines.filter(l => l.kind !== '-'), lexed = sideLexed(ctx.stack, f.path, kept, ctx.texts?.[f.path], l => l.n)
      const view: View = { kept, lexed, codes: lexed?.map(x => x.code) }
      code.scanFile(f, view, ctx, isTest, findings)
    }
  } catch (err) { return { status: 'error', findings: [], error: String(err) } }
  findings.push(...code.redFindings(files, ctx.red ?? {}, ctx.texts ?? {}))
  if (ctx.counts && ctx.counts.after < ctx.counts.before) findings.push({ kind: 'FL', rule: 'fewer-tests', sev: 'HIGH', loc: `${ctx.counts.before}→${ctx.counts.after}` })
  if (ctx.ignored && ctx.ignored.before !== ctx.ignored.after) findings.push({ kind: 'J', rule: 'ignored-set', sev: 'HIGH', loc: 'ignored files' })
  return { status: findings.some(f => f.sev === 'HIGH') ? 'violation' : 'clean', findings }
}
