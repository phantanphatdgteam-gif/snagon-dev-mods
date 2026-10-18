// The judge (plan v7.1 §3.3, §5.1): runs approved commands in the judge sandbox with a timeout, reads their results
// (the runner's JSON report when it can ask for one: console text can be printed by a test), decides must-pass and
// no-new-failures, checks the RED rule per added test, and computes security forcing, scope and plugin integrity.
// What the gate freezes about the commands themselves is in flow-sources.ts.
import { hashOf, type Io } from './session'
import { failures, counts, classify, stripAnsi, touchesSecurity, type Signature, type Counts, type Report } from '../flow/parse'
import { git, FLOW_TREE_EXCLUDES, type GitPaths } from './flow-git'
import { resolveSpec, moduleFiles } from './flow-sources'
import { codeOf, lexParts, lexLines, MOD, modsOf } from './flow-js'
import { globRe } from './flow-plan'
import type { DiffFile } from './flow-scan'
import type { Stack } from '../flow/data/types'

export type Command = { id: string; runner: string; mode: 'must-pass' | 'no-new-failures' }
export type RunOutput = { exitCode: number; output: string; ms: number }
/** passed: with a report, the tests that passed (testKey), so a test skipped or gone later counts as a new failure;
 * runErrors: errors the runner counted outside any test (vitest's "Errors N"). */
export type Baseline = { signatures: Signature[]; counts: Counts | null; exitCode: number; passed?: string[]; runErrors?: number }
export type Verdict = { pass: boolean; newFailures: Signature[]; evalProblems: string[]; counts: Counts | null; note?: string }

export const MAX_RUN_MS = 600_000
/** min(max(3 × baseline, baseline + 60 s), 10 min) (plan §5.1). */
export const timeoutFor = (baselineMs: number): number => Math.min(Math.max(3 * baselineMs, baselineMs + 60_000), MAX_RUN_MS)

/** Runs one judged command line (judgeArgv's). Killed at its timeout: too slow. Not started, or either stream past
 * 4 MiB (failures could be cut off): could not run. */
export async function runJudged(io: Io, argv: readonly string[], cwd: string, timeoutMs: number): Promise<{ ok: true; run: RunOutput } | { ok: false; reason: 'tooSlow' | 'couldNotRun'; detail: string }> {
  const start = await io.now()
  try {
    const r = await io.run([...argv], { cwd, timeoutMs })
    const ms = (await io.now()) - start
    if (r.isStdoutTruncated || r.isStderrTruncated) return { ok: false, reason: 'couldNotRun', detail: 'output over 4 MiB' }
    return { ok: true, run: { exitCode: r.exitCode, output: [r.stdout, r.stderr].filter(Boolean).join('\n'), ms } }
  } catch (err) {
    const ms = (await io.now()) - start
    return ms >= timeoutMs - 1000 ? { ok: false, reason: 'tooSlow', detail: `${Math.round(ms / 1000)} s` } : { ok: false, reason: 'couldNotRun', detail: String(err).slice(0, 300) }
  }
}

const RUN_FLAGS: Readonly<Record<string, (dir: string, argv: readonly string[]) => { flags: string[]; report: boolean }>> = {
  vitest: d => ({ flags: ['--reporter=default', '--reporter=json', `--outputFile.json=${d}/report.json`], report: true }),
  jest: d => ({ flags: ['--json', `--outputFile=${d}/report.json`, '--no-cache'], report: true }),
  eslint: d => ({ flags: [`--cache-location=${d}/eslintcache`], report: false }),
  tsc: (_d, argv) => ({ flags: argv.some(a => a === '-b' || a === '--build') ? ['--force'] : ['--incremental', 'false', '--composite', 'false'], report: false }),
}
/**
 * The command as the judge runs it: the runner's JSON report requested into `runDir` (a fresh folder per run) and its
 * caches turned off or moved there (an edited cache would change results with no diff). Possible when the runner is
 * named in the command or the command is a package-manager script whose body is that runner alone; otherwise the
 * command runs as approved, with no report.
 */
export function judgedArgv(argv: readonly string[], runner: string, runDir: string, scriptBody?: string): { argv: string[]; reportFile: string | null } {
  const base = (x: string): string => x.slice(x.lastIndexOf('/') + 1)
  const pm = base(argv[0] ?? ''), sub = argv[1] ?? '', named = Boolean(argv[2])
  const script = (pm === 'npm' && (sub === 'test' || ((sub === 'run' || sub === 'run-script') && named))) || ((pm === 'pnpm' || pm === 'yarn') && (sub === 'test' || (sub === 'run' && named))) || (pm === 'bun' && sub === 'run' && named)
  const body = script ? (scriptBody ?? '').trim() : ''
  const single = script && new RegExp(`^(?:npx\\s+)?${runner}(?:\\s|$)`).test(body) && !/[;&|<>`$()]/.test(body)
  const make = RUN_FLAGS[runner]
  if (!make || !(single || (!script && argv.some(a => base(a) === runner)))) return { argv: [...argv], reportFile: null }
  const { flags, report } = make(runDir, single ? body.split(/\s+/) : argv)
  const dashes = single && pm === 'npm' && !argv.slice(2).includes('--') ? ['--'] : []
  return { argv: [...argv, ...dashes, ...flags], reportFile: report ? `${runDir}/report.json` : null }
}

/** A failure message without what changes from run to run: durations, long numbers, hex ids, absolute folders. */
const normMessage = (m: string): string => stripAnsi(m).replace(/\(\d+(?:\.\d+)?\s?m?s\)/g, '').replace(/(?:\/[^\s'"():]+)+\/([^\s'"():/]+)/g, '…/$1')
  .replace(/\b\d{6,}\b/g, '#').replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '#').replace(/\s+/g, ' ').trim()
const keyOf = (s: Signature): string => [s.file, s.id, normMessage(s.message), String(s.collection)].join('\u0000')
/** Failures in `now` beyond those in `base`, as multisets: the same failure twice counts twice. */
export function newFailures(now: readonly Signature[], base: readonly Signature[]): Signature[] {
  const left = new Map<string, number>()
  for (const s of base) left.set(keyOf(s), (left.get(keyOf(s)) ?? 0) + 1)
  return now.filter(s => { const n = left.get(keyOf(s)) ?? 0; if (n > 0) { left.set(keyOf(s), n - 1); return false } return true })
}
/** A report's failures as signatures: failed tests, files that failed outside their tests, files that failed to load. */
export const reportSignatures = (r: Report, runner: string): Signature[] => [
  ...r.tests.filter(t => t.status === 'failed').map(t => ({ runner, file: t.file, id: t.id, message: t.message, collection: false })),
  ...r.fileErrors.map(e => ({ runner, file: e.file, id: '(file)', message: e.message, collection: false })),
  ...r.collection.map(c => ({ runner, file: c.file, id: '', message: c.message, collection: true })),
]
export const testKey = (t: { file: string; id: string }): string => `${t.file}\u0000${t.id.replace(/ › /g, ' > ')}`
/** Whether a test title carries the eval id itself (not AC-0011, not a describe name). */
const hasId = (title: string, id: string): boolean => new RegExp(`(?<![\\w-])${id}(?!\\d)`).test(title)
const lastPart = (id: string): string => id.split(/ > | › /).at(-1) ?? id
/** Runner and report paths can start at different folders (a package's rootDir, the git top). */
const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
const sameId = (a: string, b: string): boolean => a.replace(/ › /g, ' > ') === b.replace(/ › /g, ' > ')
/** Whether the report accounts for a failure the console printed: the same test or a suite (describe) holding tests,
 * not passed in the report, or a file error or load failure in that file. */
function explained(report: Report, s: Signature): boolean {
  const fileLevel = [...report.collection, ...report.fileErrors].some(c => sameFile(c.file, s.file))
  if (s.collection) return fileLevel
  const id = s.id.replace(/ › /g, ' > ')
  return fileLevel || report.tests.some(t => sameFile(t.file, s.file) && t.status !== 'passed' && (sameId(t.id, id) || t.id.replace(/ › /g, ' > ').startsWith(`${id} > `)))
}
/** vitest's count of errors outside any test (an unhandled rejection), from its last summary. */
export const runErrorsOf = (output: string): number => Number([...output.matchAll(/^\s*Errors\s+(\d+)\s+errors?\b/gm)].at(-1)?.[1] ?? 0)

/**
 * One command's verdict. A requested report that is missing (`null`), or one the console contradicts, never passes.
 * With a report, in both modes: a test that passed at the baseline must not turn skipped or vanish, errors outside any
 * test must not grow, and each required eval id (plan §5.1 "every required eval id passed") needs tests titled with it
 * that all ran and passed. must-pass: exit 0 and, with a report, no failure at all. no-new-failures: the failures are a
 * sub-multiset of the baseline's, and a failing exit with no readable failure never passes. Without a report an eval
 * id cannot be proven (GAP-step5-5).
 */
/** What the diff did to test and suite declarations (declChanges). */
export type DeclChanges = { removedTitles?: readonly string[]; addedTitles?: readonly string[]; removedSuites?: readonly string[]; addedSuites?: readonly string[] }
export function judgeRun(cmd: Command, run: RunOutput, base: Baseline | null, stack: Stack, required: readonly string[], present: ReadonlyMap<string, readonly string[]>, report?: Report | null, diff?: DeclChanges): Verdict {
  const fail = (note: string, measured: Counts | null = null): Verdict => ({ pass: false, newFailures: [], evalProblems: [], counts: measured, note })
  if (report === null) return fail('report missing or unreadable')
  const measured = report ? report.counts : counts(run.output, stack, cmd.runner)
  const printed = failures(run.output, stack, cmd.runner)
  const sigs = report ? reportSignatures(report, cmd.runner) : printed
  if (report && (printed ?? []).some(s => !explained(report, s))) return fail('the report and the console disagree', measured)
  const sig = (file: string, id: string, message: string): Signature => ({ runner: cmd.runner, file, id, message, collection: false })
  // A test gone from the report is fine when the diff removed or renamed its declaration and did not declare that title
  // again (the scan judges removals), or renamed a describe it sat in while it still passes under the new one. Skipped,
  // or gone with its declaration still there (hidden, gated), is a regression.
  const gone = (k: string): boolean => {
    const file = k.slice(0, k.indexOf('\u0000')), id = k.slice(k.indexOf('\u0000') + 1), leaf = lastPart(id)
    const titled = (list?: readonly string[]): boolean => (list ?? []).some(t => names(leaf, t))
    if (titled(diff?.removedTitles) && !titled(diff?.addedTitles)) return false
    const suiteRenamed = id.split(/ > | › /).slice(0, -1).some(sx => (diff?.removedSuites ?? []).includes(sx) && !(diff?.addedSuites ?? []).includes(sx))
    return !(suiteRenamed && (report?.tests ?? []).some(t => sameFile(t.file, file) && t.status === 'passed' && lastPart(t.id) === leaf))
  }
  const regressed = report && base?.passed ? base.passed.filter(k => { const now = report.tests.find(t => testKey(t) === k); return now ? now.status === 'skipped' : gone(k) })
    .map(k => sig(k.slice(0, k.indexOf('\u0000')), k.slice(k.indexOf('\u0000') + 1), 'passed at the baseline; now skipped or not run')) : []
  const errors = runErrorsOf(run.output) + (report?.runtimeErrors ?? 0)
  const runErr = report && errors > (base?.runErrors ?? 0) ? [sig('', '(run)', `${errors} errors outside any test`)] : []
  const evalProblems = required.flatMap(id => {
    const files = present.get(id) ?? []
    if (report) {
      const ran = report.tests.filter(t => hasId(t.title, id))
      if (ran.some(t => t.status === 'failed') || [...report.collection, ...report.fileErrors].some(c => files.includes(c.file))) return [`${id} failed`]
      return ran.length && ran.every(t => t.status === 'passed') ? [] : [`${id} not run`]
    }
    if (!files.length) return [`${id} has no test`]
    // ASSUMPTION(GAP-step5-5): console text alone never proves an eval id passed.
    return (sigs ?? []).some(s => (s.collection ? files.includes(s.file) : hasId(lastPart(s.id), id))) ? [`${id} failed`] : [`${id} not proven (no runner report)`]
  })
  if (cmd.mode === 'must-pass') {
    const fresh = [...regressed, ...runErr]
    return { pass: run.exitCode === 0 && !(report && sigs?.length) && !fresh.length && !evalProblems.length, newFailures: fresh, evalProblems, counts: measured }
  }
  if (sigs === null) return fail('output not readable', measured)
  if (run.exitCode !== 0 && sigs.length === 0 && !runErr.length && !(report && errors)) return fail('failed without a failure the stack can read', measured)
  const fresh = [...newFailures(sigs, base?.signatures ?? []), ...regressed, ...runErr]
  return { pass: !fresh.length && !evalProblems.length, newFailures: fresh, evalProblems, counts: measured, note: measured ? undefined : 'count not measured' }
}

const closeParen = (t: string, start: number): number => { let d = 0; for (let i = start; i < t.length; i += 1) { if (t[i] === '(') d += 1; else if (t[i] === ')' && --d === 0) return i + 1 } return -1 }
/** Test declarations in a text, with their modifiers: `it('…'`, `test.only(\n '…'`, and the table forms `it.each(rows)('…'`
 * and it.each`table`('…'. A `.test(` method call is not a test. */
export function declarations(text: string): Array<{ title: string; mods: string }> {
  const out: Array<{ title: string; mods: string }> = []
  for (const m of text.matchAll(new RegExp(`(?<![.\\w$])(?:it|test)(${MOD})\\s*`, 'g'))) {
    const at = m.index ?? 0
    if (/^\s*(?:\/\/|\/\*|\*)/.test(text.slice(text.lastIndexOf('\n', at) + 1, at))) continue // a commented-out test
    let i = at + m[0].length
    const mods = modsOf(m[1] ?? '')
    if (/\.each$/.test(mods)) {
      i = text[i] === '`' ? text.indexOf('`', i + 1) + 1 : text[i] === '(' ? closeParen(text, i) : -1
      if (i <= 0) continue
      while (/\s/.test(text[i] ?? '')) i += 1
    }
    if (text[i] !== '(') continue
    i += 1
    while (/\s/.test(text[i] ?? '')) i += 1
    const q = text[i]
    if (q !== '"' && q !== "'" && q !== '`') continue
    let j = i + 1, title = ''
    while (j < text.length && text[j] !== q) { if (text[j] === '\\') { title += text[j + 1] ?? ''; j += 2 } else { title += text[j]; j += 1 } }
    if (j < text.length && title) out.push({ title, mods })
  }
  return out
}
export const titlesIn = (text: string): string[] => declarations(text).map(d => d.title)
const SUITE_TITLE = new RegExp(`(?<![.\\w$])(?:describe|suite|context)${MOD}\\s*\\(\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`, 'g')
/** The test and suite titles the diff removes and adds in the given test files (renames, deletions, re-declarations). */
export function declChanges(files: readonly DiffFile[], testFiles: readonly string[]): Required<DeclChanges> {
  const side = (kind: '+' | '-'): string => files.filter(f => testFiles.includes(f.path)).map(f => f.lines.filter(l => l.kind === kind).map(l => l.text).join('\n')).join('\n')
  const suites = (text: string): string[] => [...text.matchAll(SUITE_TITLE)].map(m => m[2] ?? '').filter(Boolean)
  const [minus, plus] = [side('-'), side('+')]
  return { removedTitles: titlesIn(minus), addedTitles: titlesIn(plus), removedSuites: suites(minus), addedSuites: suites(plus) }
}
/** Tests added in the diff of the feature's test files, by title. */
export const addedTests = (files: readonly DiffFile[], testFiles: readonly string[]): Array<{ file: string; name: string }> =>
  files.filter(f => testFiles.includes(f.path)).flatMap(f => titlesIn(f.lines.filter(l => l.kind === '+').map(l => l.text).join('\n')).map(name => ({ file: f.path, name })))

/** Named and default imports of a file: local name → the module spec and the name it exports. */
export function importsOf(lines: readonly string[]): Map<string, { spec: string; name: string }> {
  const out = new Map<string, { spec: string; name: string }>()
  const text = lines.join('\n')
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const item of (m[1] ?? '').split(',').map(x => x.trim()).filter(x => x && !x.startsWith('type '))) {
      const [name, local] = item.split(/\s+as\s+/).map(x => x.trim())
      if (name) out.set(local ?? name, { spec: m[2] ?? '', name })
    }
  }
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) out.set(m[1] ?? '', { spec: m[2] ?? '', name: 'default' })
  return out
}

const PLACEHOLDER = /(%[sdifjoOpc#%]|\$\{[^}]*\}|\$[\w.]+)/
const isTable = (name: string): boolean => PLACEHOLDER.test(name)
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A failure id names a test: the whole id or its last part after a describe path; a table title matches every row. */
const names = (id: string, name: string): boolean => id === name || id.endsWith(` > ${name}`) || id.endsWith(` › ${name}`)
  || (isTable(name) && new RegExp(`(?:^| > | › )${name.split(PLACEHOLDER).map((part, i) => (i % 2 ? '.*?' : escapeRe(part))).join('')}$`).test(id))

export type RedInput = {
  files: readonly DiffFile[]; failures: readonly Signature[]; fTestFiles: readonly string[]; fAcs: readonly string[]; newFiles: readonly string[]; stack: Stack
  /** The runner's report of the RED run, when there is one: it tells a skipped or never-run test from a passing one. */
  report?: Report
  /** Whether `name` is absent from the module at the F start tree (git grep at that tree). */
  absentAtStart: (moduleRel: string, name: string) => Promise<boolean>
}
/** The RED rule (plan §3.3): every added test (every row of a table) fails, by an assertion or by an import of
 * something that does not exist yet (a module marked (new), or an export the module lacks at the start tree), and
 * every F AC id is in an added test's title. */
export async function redCheck(o: RedInput): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = []
  const linesOf = (file: string): string[] => o.files.filter(f => f.path === file).flatMap(f => f.lines.filter(l => l.kind !== '-').map(l => l.text))
  const accepted = async (file: string, message: string, who: string): Promise<string | null> => {
    const c = classify(message, o.stack)
    if (c.kind === 'assertion') return null
    if (c.kind === 'moduleNotFound') {
      const rel = resolveSpec(file, c.module)
      return rel && moduleFiles(rel).some(x => o.newFiles.includes(x)) ? null : `${file} cannot load ${c.module}, which the plan does not mark (new)`
    }
    if (c.kind === 'missingExport') {
      const imports = importsOf(linesOf(file))
      const imp = imports.get(c.symbol) ?? [...imports.values()].find(v => v.name === c.symbol)
      const rel = imp ? resolveSpec(file, imp.spec) : null
      if (!imp || !rel) return `${who} fails on ${c.symbol}, which it does not import from a project file`
      return (await o.absentAtStart(rel, imp.name)) ? null : `${who} fails on ${c.symbol}, which ${rel} already exports`
    }
    return `${who} fails for another reason (${message.slice(0, 80)})`
  }
  const collected = new Set<string>()
  for (const s of o.failures.filter(x => x.collection)) {
    if (!o.fTestFiles.includes(s.file)) { problems.push(`${s.file} failed to load, outside the feature's test files`); continue }
    collected.add(s.file)
    const why = await accepted(s.file, s.message, s.file)
    if (why) problems.push(why)
  }
  const added = addedTests(o.files, o.fTestFiles)
  const used = new Set<number>()
  for (const t of added) {
    if (collected.has(t.file)) continue
    const hits = o.failures.map((s, k) => ({ s, k })).filter(({ s, k }) => !used.has(k) && !s.collection && s.file === t.file && names(s.id, t.name))
    const take = isTable(t.name) ? hits : hits.slice(0, 1)
    const seen = o.report?.tests.filter(x => x.file === t.file && names(x.id, t.name)) ?? []
    if (!take.length || seen.some(x => x.status === 'passed')) {
      problems.push(!o.report || seen.some(x => x.status === 'passed') ? `an added test passes: ${t.name}` : seen.length ? `an added test is skipped: ${t.name}` : `an added test did not run: ${t.name}`)
      continue
    }
    for (const { s, k } of take) { used.add(k); const why = await accepted(t.file, s.message, t.name); if (why) { problems.push(why); break } }
  }
  for (const ac of o.fAcs) if (!added.some(t => hasId(t.name, ac))) problems.push(`no added test names ${ac}`)
  return { ok: !problems.length, problems }
}

/** git grep at `tree`: whether `name` (a whole word) is absent from the module's files. */
export async function symbolAbsent(io: Io, p: GitPaths, tree: string, moduleRel: string, name: string): Promise<boolean> {
  const r = await git(io, p.top, ['grep', '-q', '-w', '-F', '-e', name, tree, '--', ...moduleFiles(moduleRel)])
  if (r.exitCode > 1) throw new Error(`git grep failed: ${r.stderr.trim().slice(0, 200)}`)
  return r.exitCode === 1
}

/** `{a,b}` choices expanded, since git pathspec globs have none. */
const expandBraces = (g: string): string[] => { const m = /\{([^{}]*)\}/.exec(g); return m ? (m[1] ?? '').split(',').flatMap(x => expandBraces(g.replace(m[0], x))) : [g] }
/** Eval ids declared in test titles (not comments; not skipped, todo or failing-by-design tests) in the worktree's test
 * files, tracked or not: id → files. */
export async function evalIdsInTests(io: Io, p: GitPaths, testGlobs: readonly string[]): Promise<Map<string, string[]>> {
  const specs = testGlobs.flatMap(expandBraces).map(g => `:(glob)${g}`)
  const r = await git(io, p.top, ['grep', '--untracked', '-I', '-z', '-l', '-E', 'AC-[0-9]{3}', '--', ...specs])
  if (r.exitCode > 1 || r.isStdoutTruncated) throw new Error(`git grep failed: ${r.stderr.trim().slice(0, 200)}`)
  const out = new Map<string, string[]>()
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    for (const d of declarations(await io.read(`${p.top}/${file}`))) {
      if (/\.(?:skip|todo|fails|failing)\b/.test(d.mods)) continue
      for (const id of d.title.match(/(?<![\w-])AC-\d{3}(?!\d)/g) ?? []) out.set(id, [...new Set([...(out.get(id) ?? []), file])])
    }
  }
  return out
}

/** What test code has no reason to reach: the process, module loading, globals, eval. Test code runs inside or next to
 * the runner and could rewrite its results; a forced security review is how the MVP sees it (T2, F31). Words prose
 * also uses are read on the code only (literals blanked, regex and template literals lexed), so a title saying
 * "process" is not; the rest, which no title uses, on the raw line, so no literal can hide them. */
const RUNTIME_IN_CODE = /\bprocess\b(?!\s*\.\s*env\b)|\bglobal\b|\brequire\s*\(|\beval\s*\(|\bFunction\s*\(|\bwriteFile/
const BUILTIN = '(?:node:[\\w/]+|fs|fs/promises|child_process|net|tls|http|https|http2|vm|worker_threads|os|module|inspector|process|cluster|dgram)'
const RUNTIME_ANYWHERE = new RegExp([
  '\\bglobalThis\\b', '\\.\\s*constructor\\b(?=\\s*[(.[])', '\\bmainModule\\b', '\\bmodule\\s*\\.\\s*require\\b', '\\bReflect\\s*\\.', '__proto__', '\\b(?:get|set)PrototypeOf\\b',
  '\\bfromCharCode\\b', '\\batob\\s*\\(', '\\.\\s*join\\s*\\(\\s*([\'"`])\\1\\s*\\)\\s*\\]', '\\[\\s*`[^\\]]*\\$\\{', '[\\w$\\])]\\s*\\[[^\\]]*[\'"`]\\s*\\+', '\\]\\s*\\[[^\\]]*\\]\\s*\\(',
  `\\b(?:importActual|requireActual|importMock|requireMock)\\s*\\(\\s*['"\`]${BUILTIN}['"\`]`, `['"\`]node:[\\w/]+['"\`]`, `['"\`]child_process['"\`]`,
].join('|'))
/** A dynamic import of anything but a relative path or a path alias (`@/`, `~/`, `#`), read on the raw line. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!['"`](?:\.{1,2}\/|[@~]\/|#))/
/** Whether added or removed lines of any code file match a pattern that forces `Security: yes`; in test files also
 * any reach into the runtime. */
export function securityForced(files: readonly DiffFile[], stack: Stack): boolean {
  const tests = stack.testFiles.map(globRe)
  return files.some(f => {
    if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(f.path)) return false
    const isTest = tests.some(t => t.test(f.path))
    // The code is read three ways (the state carried from the lines above, and the line alone from code and from inside
    // a template), so a template or regex literal cannot hide a word from all of them.
    const kept = f.lines.filter(l => l.kind !== '-'), carried = isTest ? lexLines(kept).map(x => x.code) : []
    return f.lines.some(l => {
      if (l.kind === ' ') return false
      if (touchesSecurity(l.text, stack)) return true
      if (!isTest) return false
      const at = kept.indexOf(l), codes = [codeOf(l.text), lexParts(l.text, 'tpl').code, at >= 0 ? carried[at] ?? '' : '']
      return codes.some(c => RUNTIME_IN_CODE.test(c)) || RUNTIME_ANYWHERE.test(l.text) || DYNAMIC_IMPORT.test(l.text)
    })
  })
}

/** Changed files outside the active feature's Files (flow's own views aside). */
export const outOfScope = (files: readonly DiffFile[], fFiles: readonly string[]): string[] =>
  files.map(f => f.path).filter(p => !FLOW_TREE_EXCLUDES.some(x => p === x || p.startsWith(`${x}/`)) && !fFiles.some(x => x.toLowerCase() === p.toLowerCase()))

/** The mod's version from its manifest, for the owner's card (NK-04); '' when it cannot be read or is not a plain
 * version string. */
export async function pluginVersion(io: Io, root: string): Promise<string> {
  try {
    const v: unknown = (JSON.parse(await io.read(`${root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? v : ''
  } catch { return '' }
}

/** One hash over the loaded plugin's files (S2, every flow_check), the generated types and .git left out. */
export async function pluginIntegrity(io: Io, root: string): Promise<string> {
  const parts: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const item of await io.list(dir)) {
      const r = rel ? `${rel}/${item.name}` : item.name
      if (r === '.claude-plugin/types' || r === '.git') continue
      if (item.kind === 'dir') await walk(`${dir}/${item.name}`, r)
      else parts.push(`${r}=${hashOf(await io.read(`${dir}/${item.name}`))}`)
    }
  }
  await walk(root, '')
  return hashOf(parts.sort().join('\n'))
}
