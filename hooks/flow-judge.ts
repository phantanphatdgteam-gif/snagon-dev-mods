// The judge (plan v7.1 §3.3, §5.1): runs approved commands in the judge sandbox with a timeout, reads their results
// (the runner's JSON report when it can ask for one: console text can be printed by a test), decides must-pass and
// no-new-failures, checks the RED rule per added test, and computes scope and plugin integrity. How a stack's runner is
// asked for its report, and what its test code declares, is the stack's code (hooks/stacks/); what the gate freezes
// about the commands themselves is the stack's command sources.
import { hashOf, type Io } from './session'
import { failures, counts, classify, stripAnsi, type Signature, type Counts, type Report } from '../flow/parse'
import { git, FLOW_TREE_EXCLUDES, type GitPaths } from './flow-git'
import type { DiffFile } from './flow-scan'
import type { Stack } from '../flow/data/types'
import type { StackEntry } from './stacks/index'

export type Command = { id: string; runner: string; mode: 'must-pass' | 'no-new-failures' }
/** output: both streams, stdout first; stdout alone too, for a runner whose summary must be its last line (pytest). */
export type RunOutput = { exitCode: number; output: string; ms: number; stdout?: string }
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
    return { ok: true, run: { exitCode: r.exitCode, output: [r.stdout, r.stderr].filter(Boolean).join('\n'), ms, stdout: r.stdout } }
  } catch (err) {
    const ms = (await io.now()) - start
    return ms >= timeoutMs - 1000 ? { ok: false, reason: 'tooSlow', detail: `${Math.round(ms / 1000)} s` } : { ok: false, reason: 'couldNotRun', detail: String(err).slice(0, 300) }
  }
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
/** Whether a test title carries the eval id itself, in one of the stack's spellings (not AC-0011, not a describe name). */
const hasId = (title: string, id: string, stack: Stack): boolean => {
  const n = /^AC-(\d{3})$/.exec(id)?.[1]
  return n !== undefined && stack.evalIdForms.some(f => [...title.matchAll(new RegExp(f, 'g'))].some(m => m[1] === n))
}
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
    const titled = (list?: readonly string[]): boolean => (list ?? []).some(t => names(leaf, t, stack.paramIds))
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
      const ran = report.tests.filter(t => hasId(t.title, id, stack))
      if (ran.some(t => t.status === 'failed') || [...report.collection, ...report.fileErrors].some(c => files.includes(c.file))) return [`${id} failed`]
      return ran.length && ran.every(t => t.status === 'passed') ? [] : [`${id} not run`]
    }
    if (!files.length) return [`${id} has no test`]
    // ASSUMPTION(GAP-step5-5): console text alone never proves an eval id passed.
    return (sigs ?? []).some(s => (s.collection ? files.includes(s.file) : hasId(lastPart(s.id), id, stack))) ? [`${id} failed`] : [`${id} not proven (no runner report)`]
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

const PLACEHOLDER = /(%[sdifjoOpc#%]|\$\{[^}]*\}|\$[\w.]+)/
const isTable = (name: string): boolean => PLACEHOLDER.test(name)
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A failure id names a test: the whole id or its last part after a describe path; a table title matches every row;
 * with parameter ids (`params`, pytest's `test_x[1-2]`) every parameter set of the name does. */
const names = (id: string, name: string, params = false): boolean => id === name || id.endsWith(` > ${name}`) || id.endsWith(` › ${name}`)
  || (params && new RegExp(`(?:^| > )${escapeRe(name)}\\[.*\\]$`).test(id))
  || (isTable(name) && new RegExp(`(?:^| > | › )${name.split(PLACEHOLDER).map((part, i) => (i % 2 ? '.*?' : escapeRe(part))).join('')}$`).test(id))

export type RedInput = {
  files: readonly DiffFile[]; failures: readonly Signature[]; fTestFiles: readonly string[]; fAcs: readonly string[]; newFiles: readonly string[]; stack: StackEntry
  /** The runner's report of the RED run, when there is one: it tells a skipped or never-run test from a passing one. */
  report?: Report
  /** The RED tree's test files whole: the added tests are read from them (a hunk can start inside a string). */
  texts?: Readonly<Record<string, string>>
  /** Whether `name` is absent from the module at the F start tree (git grep at that tree). */
  absentAtStart: (moduleRel: string, name: string) => Promise<boolean>
  /** Whether any of the files is in the F start tree: a module that is in neither it nor the plan's (new) files is not
   * the project's (a package, the standard library). */
  inStart: (files: readonly string[]) => Promise<boolean>
}
/** The RED rule (plan §3.3): every added test (every row of a table) fails, by an assertion or by an import of
 * something that does not exist yet (a module marked (new), or an export the module lacks at the start tree), and
 * every F AC id is in an added test's title. */
export async function redCheck(o: RedInput): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [], { data, code } = o.stack
  const linesOf = (file: string): string[] => o.files.filter(f => f.path === file).flatMap(f => f.lines.filter(l => l.kind !== '-').map(l => l.text))
  const accepted = async (file: string, message: string, who: string): Promise<string | null> => {
    const c = classify(message, data)
    if (c.kind === 'assertion') return null
    if (c.kind === 'moduleNotFound') {
      const rel = code.resolveImport(file, c.module)
      return rel && code.moduleFiles(rel).some(x => o.newFiles.includes(x)) ? null : `${file} cannot load ${c.module}, which the plan does not mark (new)`
    }
    if (c.kind === 'missingExport') {
      // the module the error names (Python's do, GAP-R2-0.6-43), else the file's import of the symbol
      const imports = c.module ? null : code.importsOf(linesOf(file))
      const imp = c.module ? { spec: c.module, name: c.symbol } : imports?.get(c.symbol) ?? [...(imports?.values() ?? [])].find(v => v.name === c.symbol)
      const rel = imp ? code.resolveImport(file, imp.spec) : null
      // a module named in the error (any spec resolves) counts only when it is the project's (code review, step 3)
      const own = rel !== null && (!c.module || code.moduleFiles(rel).some(x => o.newFiles.includes(x)) || (await o.inStart(code.moduleFiles(rel))))
      if (!imp || !rel || !own) return `${who} fails on ${c.symbol}, which it does not import from a project file`
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
  // with parameter ids a name takes every run of it (each class's, each parameter set's), so it is counted once
  const listed = code.addedTests(o.files, o.fTestFiles, o.texts)
  const added = data.paramIds ? [...new Map(listed.map(t => [`${t.file}\u0000${t.name}`, t])).values()] : listed
  const used = new Set<number>()
  for (const t of added) {
    if (collected.has(t.file)) continue
    const hits = o.failures.map((s, k) => ({ s, k })).filter(({ s, k }) => !used.has(k) && !s.collection && s.file === t.file && names(s.id, t.name, data.paramIds))
    const take = isTable(t.name) || data.paramIds ? hits : hits.slice(0, 1)
    const seen = o.report?.tests.filter(x => x.file === t.file && names(x.id, t.name, data.paramIds)) ?? []
    if (!take.length || seen.some(x => x.status === 'passed')) {
      problems.push(!o.report || seen.some(x => x.status === 'passed') ? `an added test passes: ${t.name}` : seen.length ? `an added test is skipped: ${t.name}` : `an added test did not run: ${t.name}`)
      continue
    }
    for (const { s, k } of take) { used.add(k); const why = await accepted(t.file, s.message, t.name); if (why) { problems.push(why); break } }
  }
  // an added test's name carries the id, or (with a report) the title of one of its runs does: pytest's parameter ids
  const runTitles = (t: { file: string; name: string }): string[] => o.report?.tests.filter(x => x.file === t.file && names(x.id, t.name, data.paramIds)).map(x => x.title) ?? []
  for (const ac of o.fAcs) if (!added.some(t => hasId(t.name, ac, data) || runTitles(t).some(title => hasId(title, ac, data)))) problems.push(`no added test names ${ac}`)
  return { ok: !problems.length, problems }
}

/** git ls-tree at `tree`: whether any of the files is there. */
export async function anyInTree(io: Io, p: GitPaths, tree: string, files: readonly string[]): Promise<boolean> {
  const r = await git(io, p.top, ['ls-tree', '-r', '--name-only', '-z', tree, '--', ...files])
  if (r.exitCode !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim().slice(0, 200)}`)
  return r.stdout.split('\0').some(Boolean)
}

/** git grep at `tree`: whether `name` (a whole word) is absent from a module's files (the stack's `moduleFiles`). */
export async function symbolAbsent(io: Io, p: GitPaths, tree: string, files: readonly string[], name: string): Promise<boolean> {
  const r = await git(io, p.top, ['grep', '-q', '-w', '-F', '-e', name, tree, '--', ...files])
  if (r.exitCode > 1) throw new Error(`git grep failed: ${r.stderr.trim().slice(0, 200)}`)
  return r.exitCode === 1
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
