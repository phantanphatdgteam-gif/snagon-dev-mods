// B3, the judge (plan v7.1 §3 B3 and its twelve checks, §4.7, F45): every approved command at the worktree against the
// baseline, the eval ids of this feature and the earlier ones, the test count, floor, junk and scope, the RED tests as
// frozen, the ignored-file set, Security forcing. (Command sources, H_cfg and the plugin's files are checked by every
// flow_check first.) Open floor or junk findings block the flow for the owner; a red run gets a debug ticket with the
// failing output and the feature pack, one debug round each; a green judge moves the feature to review (B4).
import { debugRole } from '../flow/data/routing'
import type { FindingDigest } from './flow-state'
import { judgeRun, outOfScope, timeoutFor, MAX_RUN_MS, type Verdict } from './flow-judge'
import { parseDiff, scan, type DiffFile, type ScanFinding } from './flow-scan'
import { blobsAt, ignoredSet, type GitPaths } from './flow-git'
import { changedHunks, debugTicketText, fixTicketText, scopeViolations, sha256 } from './flow-review'
import { issueTicket, lostReissue } from './flow-ticket'
import { canonical } from './flow-owner'
import { globRe, type FeatureRow, type Plan } from './flow-plan'
import type { RedShape } from './flow-scan'
import { blockFlow, dropView, session, type FlowHost } from './flow-host'
import { updateRecord, usedIds, type Blocked, type FlowRecord, type UpdateResult } from './flow-state'
import { capRound, featureNow, featureTicket, redFile, type FeatureNow } from './flow-build'
import { methodText } from './flow-method'
import { frozenBaseline, ignoredSkip, type BaselineFile } from './flow-baseline'
import { diffBetween, START_PROMPT } from './flow-reviewing'
import { judgedBlock, judgedRun } from './flow-run'
import { stackOf } from './stacks/index'
import { hashOf, type Io } from './session'

const SCANNED = /^(?:FL|J)-\d+$/
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const isBlocked = (x: unknown): x is Blocked => typeof x === 'object' && x !== null && 'reason' in x && 'vars' in x

/** Check 2: the Required eval ids of this feature and every earlier one. */
export const requiredIds = (plan: Plan, f: FeatureRow): string[] => {
  const upTo = plan.features.slice(0, plan.features.findIndex(x => x.id === f.id) + 1).flatMap(x => x.acs)
  return plan.acs.filter(a => a.required && upTo.includes(a.id)).map(a => a.id)
}

/** The RED tests of the feature as frozen at B1 (their shape file must still hash to redTestHash). */
async function frozenRed(h: FlowHost, r: FlowRecord, f: string): Promise<Record<string, RedShape> | Blocked> {
  const all: unknown = JSON.parse(await h.io.read(redFile(h.home, r.flowId)).catch(() => '{}'))
  const shapes = typeof all === 'object' && all !== null ? (all as Record<string, Record<string, RedShape>>)[f] : undefined
  if (!shapes || (await sha256(canonical(shapes))) !== r.redTestHash[f]) return { reason: 'tampered', vars: { file: redFile(h.home, r.flowId) } }
  return shapes
}

/** The feature's RED test files as frozen at B1; none while they are not recorded (or their shape file does not hold). */
export async function redFiles(h: FlowHost, r: FlowRecord, f: string): Promise<string[]> {
  const shapes = await frozenRed(h, r, f)
  return isBlocked(shapes) ? [] : Object.keys(shapes)
}

/** A finding on a line (`path:n`) gets `sig`, the hash of that line's text in `texts` (the new side's files whole,
 * trailing blanks dropped), so it is known again when lines move (535 trial M-3); one on a file, a count or a file not in
 * `texts` gets none. */
export function withSigs(found: readonly ScanFinding[], texts: Readonly<Record<string, string>>, redSigs: Readonly<Record<string, string>> = {}): ScanFinding[] {
  const split = new Map<string, readonly string[]>()
  const lineAt = (path: string, n: number): string | undefined => {
    if (!Object.hasOwn(texts, path)) return undefined
    if (!split.has(path)) split.set(path, (texts[path] ?? '').split('\n'))
    return split.get(path)?.[n - 1]
  }
  return found.map(x => {
    // a RED file changed (the finding names the file, no line) is known by the file's whole text, as its SHA-256 (`redSigs`,
    // a security boundary: hashOf is 64 bits): an owner's waiver covers the text the owner read, and another text, or a
    // deleted file (''), is a new finding
    if (x.rule === 'red-test-changed' && x.loc === fileOf(x.loc)) return { ...x, sig: redSigs[x.loc] ?? hashOf(texts[x.loc] ?? '') }
    const m = /^(.+):(\d+)$/.exec(x.loc), line = m ? lineAt(m[1] ?? '', Number(m[2])) : undefined
    return line === undefined ? x : { ...x, sig: hashOf(line.trimEnd()) }
  })
}
const fileOf = (loc: string): string => /^(.+):\d+$/.exec(loc)?.[1] ?? loc
/** Rules whose finding means its line's text alone, wherever the line sits: only these follow a line that moved. A rule
 * whose meaning hangs on the place (a return in a test, a mock in the RED test, a fix outside its hunks) never moves
 * (security review of M-3). */
const MOVABLE: ReadonlySet<string> = new Set(['suppression', 'debug-leftover', 'todo-marker', 'injection', 'trivial-assert', 'flow-data-reference'])
/** Statuses that claim a line before a closed finding does: deleting a waived copy never takes over an open copy's line. */
const LIVE: ReadonlySet<string> = new Set(['open', 'resolved'])
/** Earlier findings paired with found ones, each found one at most once, open and resolved ones first, always with the
 * same rule and severity: at the same place first (with the same line text when both carry its hash), then, for a
 * MOVABLE rule, one whose line moved, by its file and line text (M-3). Earlier id → the index of its found finding.
 * ASSUMPTION(GAP-R2-0.6-141). */
function pairFindings(old: readonly FindingDigest[], found: readonly ScanFinding[]): Map<string, number> {
  const out = new Map<string, number>(), used = new Set<number>()
  const order = [...old].sort((a, b) => Number(!LIVE.has(a.status)) - Number(!LIVE.has(b.status)))
  const pass = (same: (x: FindingDigest, y: ScanFinding) => boolean): void => {
    for (const x of order) {
      if (out.has(x.id)) continue
      const k = found.findIndex((y, i) => !used.has(i) && y.rule === x.rubricId && y.sev === x.sev && same(x, y))
      if (k >= 0) { out.set(x.id, k); used.add(k) }
    }
  }
  pass((x, y) => y.loc === x.loc && (x.sig === undefined || y.sig === undefined || y.sig === x.sig))
  pass((x, y) => MOVABLE.has(x.rubricId) && x.sig !== undefined && y.sig === x.sig && fileOf(y.loc) === fileOf(x.loc))
  return out
}
/** A diff's test files whole on both sides (`before` at `from`, `now` at `to`), so a stack that reads declarations from
 * code reads them in their files: a hunk can start inside a string (review of the M-5 fix). */
export async function testTexts(io: Io, p: GitPaths, from: string, to: string, files: readonly DiffFile[]): Promise<{ before: Record<string, string>; now: Record<string, string> }> {
  return { before: await blobsAt(io, p, from, files.filter(f => f.status !== 'added').map(f => f.path)), now: await blobsAt(io, p, to, files.filter(f => f.status !== 'deleted').map(f => f.path)) }
}
/** The found findings no settled one pairs with, the caller's `own` earlier findings pairing in the same round: at V4,
 * the junk no feature settled, wherever its line moved since (M-3), while verify's own open copy keeps its line and a
 * settled copy still at its place stays settled. */
export function unsettled(settled: readonly FindingDigest[], found: readonly ScanFinding[], own: readonly FindingDigest[] = []): ScanFinding[] {
  const ids = new Set(settled.map(x => x.id))
  const hidden = new Set([...pairFindings([...own, ...settled], found)].flatMap(([id, k]) => (ids.has(id) ? [k] : [])))
  return found.filter((_, k) => !hidden.has(k))
}

/** New scan findings get the next FL-n or J-n; an open one the scan no longer finds is resolved, and a resolved one it
 * finds again opens again; the others keep their status (a waived one stays waived). A finding is found again at its
 * place or at the line its text moved to, and keeps its id and status there (535 trial M-3); its place with other text
 * is a new finding. */
export function mergeFindings(old: readonly FindingDigest[], f: string, found: readonly ScanFinding[], floor: Readonly<Record<string, number>> = {}): FindingDigest[] {
  const key = (x: ScanFinding): string => `${x.rule}\u0000${x.loc}\u0000${x.sev}`
  const paired = pairFindings(old.filter(x => x.f === f && SCANNED.test(x.id)), found)
  const kept = old.map(x => {
    if (x.f !== f || !SCANNED.test(x.id)) return x
    const k = paired.get(x.id), at = k === undefined ? undefined : found[k]
    const y = at ? { ...x, loc: at.loc, ...(at.sig === undefined ? {} : { sig: at.sig }) } : x
    return y.status === 'open' && !at ? { ...y, status: 'resolved' } : y.status === 'resolved' && at ? { ...y, status: 'open' } : y
  })
  // a found finding at the place and severity of a paired one (the same rule twice on a line) is that one, not a new one
  const taken = new Set([...paired.values()].flatMap(k => { const y = found[k]; return y ? [key(y)] : [] }))
  // new ids go on from the highest number given (floor: the record's lastIds), never reusing one a seal dropped
  const used = usedIds(old, floor)
  let fl = used.FL ?? 0, j = used.J ?? 0
  const fresh = [...new Map(found.filter(x => !taken.has(key(x))).map(x => [key(x), x])).values()]
  return [...kept, ...fresh.map(x => ({ id: x.kind === 'FL' ? `FL-${(fl += 1)}` : `J-${(j += 1)}`, f, rubricId: x.rule, sev: x.sev, loc: x.loc, status: 'open', ...(x.sig === undefined ? {} : { sig: x.sig }) }))]
}

/** The blocked reason an open HIGH floor or junk finding gives (§3.2): the RED-test and injection rules have their own. */
const findingBlock = (x: FindingDigest): Blocked =>
  x.rubricId === 'red-test-changed' ? { reason: 'redTestChanged', vars: { id: x.id, feature: x.f, location: x.loc } }
    : x.rubricId === 'injection' ? { reason: 'injection', vars: { id: x.id, location: x.loc } }
    : { reason: x.id.startsWith('FL-') ? 'floor' : 'junk', vars: { id: x.id, rule: x.rubricId, location: x.loc } }
/** The open finding whose rule has its own block, the RED-test rule first: a weakened RED test is a trivial assertion
 * too, and the owner must see that the RED test changed (S6 run 2 of 2026-10-20). */
const OWN_BLOCK_RULES = ['red-test-changed', 'injection'] as const
const ownBlockFirst = (opens: readonly FindingDigest[]): FindingDigest | undefined =>
  OWN_BLOCK_RULES.map(rule => opens.find(x => x.rubricId === rule)).find(x => x !== undefined)

/** failing: the first red command in the approved order and its output; ran: the tests the test runner ran (passed or
 * failed): a skipped or removed test lowers it, a failing one does not; base: the frozen baseline the runs were judged
 * against. */
type Judged = { verdicts: Verdict[]; failing: { command: string; text: string } | null; ran: number | null; base: BaselineFile }
/** null: the frozen baseline did not hold, and frozenBaseline has blocked the flow already. */
async function runAll(h: FlowHost, r: FlowRecord, fn: FeatureNow): Promise<Judged | Blocked | null> {
  const held = await frozenBaseline(h, r)
  if (!held) return null
  const { data, code } = stackOf(r), globs = data.testFiles.map(globRe)
  const required = requiredIds(fn.plan, fn.f), present = await code.evalIdsInTests(h.io, fn.p, data.testFiles)
  const tests = fn.files.filter(x => globs.some(t => t.test(x.path)))
  let texts: Awaited<ReturnType<typeof testTexts>>
  try { texts = await testTexts(h.io, fn.p, fn.start, fn.now, tests) } catch (err) { return { reason: 'couldNotRun', vars: { detail: `decl: ${err instanceof Error ? err.message : String(err)}` } } }
  const decl = code.declChanges(fn.files, tests.map(x => x.path), texts)
  const out: Judged = { verdicts: [], failing: null, ran: null, base: held.base }
  for (const cmd of r.setup?.commands ?? []) {
    const base = held.base.commands[cmd.id]
    const run = await judgedRun(h, r, cmd, base ? timeoutFor(base.ms) : MAX_RUN_MS)
    if (!run.ok) return judgedBlock(cmd, run)
    const tests = data.testRunners.includes(cmd.runner)
    const v = judgeRun(cmd, run.run, base ?? null, data, tests ? required : [], present, run.report, decl)
    if (!v.pass && out.failing === null) out.failing = { command: cmd.id, text: [run.run.output, ...v.newFailures.map(s => `${s.file} > ${s.id}: ${s.message}`), ...v.evalProblems, v.note ?? ''].filter(Boolean).join('\n') }
    if (tests && v.counts) out.ran = v.counts.passed + v.counts.failed
    out.verdicts.push(v)
  }
  return out
}

/** Check 10: after a review round, every hunk changed since its tree overlaps a FIX range or sits in a feature test file. */
async function fixScope(h: FlowHost, r: FlowRecord, fn: FeatureNow): Promise<ScanFinding[]> {
  const round = r.round?.f === fn.f.id ? r.round : undefined
  if (!round || round.tree === fn.now) return []
  const hunks = changedHunks(parseDiff(await diffBetween(h, fn.p, round.tree, fn.now)))
  // a scope correction's claim (an FL id) covers only the hunk that finding flagged (D11-R2-2); the claims leave the fix
  // map when the next round opens (openRound), so they cover that hunk for the rest of this round, debug runs included
  const flagged = Object.fromEntries(r.findings.filter(x => x.f === fn.f.id && /^FL-\d+$/.test(x.id)).map(x => [x.id, x.loc]))
  return scopeViolations(hunks, r.fixMap ?? {}, fn.tests, flagged).map((loc): ScanFinding => ({ kind: 'FL', rule: 'fix-scope', sev: 'HIGH', loc }))
}

/** §4.5: one scope correction per round, and only after an edit run of the round, a fix or a debug (a change during
 * review with no edit ticket is the owner's to judge): the round is this feature's and its newest ticket is an attested
 * fix or debug and the round is not corrected yet; or the correction itself was lost in a restart (used, never started),
 * and comes again free, as every lost ticket does. */
const correctionDue = (r: FlowRecord, f: string): boolean => {
  const newest = [...r.tickets].reverse().find(t => t.f === f)
  if (r.round?.f !== f || !newest) return false
  const lostCorrection = r.round.corrected === true && newest.kind === 'fix' && newest.used && newest.toolUseId === undefined
  return lostCorrection || (r.round.corrected !== true && (newest.kind === 'fix' || newest.kind === 'debug') && newest.attested === true)
}
/** The feature's open scanned HIGH findings; the correction is for fix-scope ones alone (R-2: a RED-test, injection,
 * out-of-scope or junk finding beside them blocks for the owner as before, and counts as a self-caused block). */
const openScannedHigh = (fs: readonly FindingDigest[], f: string): FindingDigest[] => fs.filter(x => x.f === f && SCANNED.test(x.id) && x.status === 'open' && x.sev === 'HIGH')
/** The correction ticket: a fix ticket carrying the fix-scope findings (and whatever else is open), so the author
 * confines the change to its FIX ranges or reports ranges that cover the hunks it needed. The round is not charged: the
 * correction is part of it (dry run of step 13, D11: two or three FL findings and four owner commands per fix round,
 * mostly a fix that reported no ranges). */
async function correctionTicket(h: FlowHost, r: FlowRecord, fn: FeatureNow): Promise<void> {
  const details = (await session(h)).value.details
  const findings = r.findings.filter(x => x.f === fn.f.id).map(x => ({ ...x, ...details[x.id] }))
  const id = await issueTicket(h, r, { role: 'author', f: fn.f.id, kind: 'fix', build: nonce => fixTicketText({ f: fn.f.id, nonce, pluginProject: r.setup?.pluginProject ?? false, findings }), also: x => ({ ...x, round: x.round ? { ...x.round, corrected: true } : x.round }) })
  if (id === null) { await blockFlow(h, r.flowId, { reason: 'split', vars: { id: fn.f.id } }); return }
  await h.submit(START_PROMPT)
}

/** flow_check at B3 (and after a fix): the twelve checks, then a block, a scope correction, a debug ticket (task B3) or
 * review (task B4, true). */
export async function judgeStep(h: FlowHost, r: FlowRecord): Promise<boolean> {
  const block = async (why: Blocked): Promise<false> => { await blockFlow(h, r.flowId, why); return false }
  const fn = await featureNow(h, r)
  if (isBlocked(fn)) return block(fn)
  const shapes = await frozenRed(h, r, fn.f.id)
  if (isBlocked(shapes)) return block(shapes)
  const judged = await runAll(h, r, fn)
  if (judged === null) return false
  if (isBlocked(judged)) return block(judged)
  // the baseline once more after the runs: changed while they ran, it blocks (frozenBaseline) and nothing is judged
  if (!(await frozenBaseline(h, r))) return false
  const stack = stackOf(r), testCmd = r.setup?.commands.find(c => stack.data.testRunners.includes(c.runner))
  const baseCounts = testCmd ? judged.base.commands[testCmd.id]?.counts : undefined, baseRan = baseCounts ? baseCounts.passed + baseCounts.failed : undefined
  // the changed code files (and the RED files) whole on both sides of the diff, from its own trees
  const code = fn.files.filter(x => stack.code.lex(x.path, []) !== null)
  let texts: Record<string, string>, before: Record<string, string>
  try {
    texts = await blobsAt(h.io, fn.p, fn.now, [...code.filter(x => x.status !== 'deleted').map(x => x.path), ...Object.keys(shapes)])
    before = await blobsAt(h.io, fn.p, fn.start, code.filter(x => x.status !== 'added').map(x => x.path))
  } catch (err) { return block({ reason: 'couldNotRun', vars: { detail: `scan: ${err instanceof Error ? err.message : String(err)}` } }) }
  const ignoredNow = (await ignoredSet(h.io, fn.p, ignoredSkip(stack.data))).hash
  // check 3: count ≥ baseline + new
  const counts = baseRan !== undefined && judged.ran !== null ? { counts: { before: baseRan + stack.code.addedTests(fn.files, fn.tests, texts).length, after: judged.ran } } : {}
  const s = scan(fn.diffText, [], { stack, frozen: [], red: shapes, texts, before, ...counts, ignored: { before: r.frozen.ignored ?? ignoredNow, after: ignoredNow } })
  if (s.status === 'error') return block({ reason: 'couldNotRun', vars: { detail: `scan: ${s.error ?? ''}` } })
  const scope = [...outOfScope(fn.files, fn.f.files.map(x => x.path)).map((p): ScanFinding => ({ kind: 'FL', rule: 'out-of-scope', sev: 'HIGH', loc: p })), ...(await fixScope(h, r, fn))]
  const forced = fn.f.security !== true && stack.code.securityForced(fn.files)
  const green = judged.verdicts.every(v => v.pass)
  // the findings, and what blocks, come from the newest record: an owner decision taken while the commands ran stays
  // scope findings carry no line text: a fix-scope place names a hunk, not a line that means anything alone (M-3 review)
  const redSigs = Object.fromEntries(await Promise.all(Object.keys(shapes).map(async f => [f, await sha256(texts[f] ?? '')] as const)))
  const now = await h.io.now(), found = [...withSigs(s.findings, texts, redSigs), ...scope]
  const openIn = (fs: readonly FindingDigest[]): FindingDigest | undefined => fs.find(x => x.f === fn.f.id && SCANNED.test(x.id) && x.status === 'open' && x.sev === 'HIGH')
  const after = settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => {
    const findings = mergeFindings(x.findings, fn.f.id, found, x.lastIds)
    return { ...x, findings, judge: { tree: fn.now, green, task: 'B3', f: fn.f.id, at: now }, task: green && !openIn(findings) ? 'B4' : 'B3', ...(forced ? { frozen: { ...x.frozen, [`security:${fn.f.id}`]: 'forced' } } : {}) }
  }))
  const opens = openScannedHigh(after.findings, fn.f.id), other = ownBlockFirst(opens) ?? opens.find(x => x.rubricId !== 'fix-scope')
  if (opens.length) {
    if (!other && correctionDue(after, fn.f.id)) { await correctionTicket(h, after, fn); return false }
    return block(findingBlock(other ?? opens[0] as FindingDigest))
  }
  // red (some command failed, so `green` is false): the debug ticket of the first red command
  if (judged.failing) { await debugTicket(h, after, fn, judged.failing, Object.keys(shapes)); return false }
  return true
}

/** F45: the debug ticket (one debug round), or the debug cap blocked. A red typecheck, build or lint goes to the stack's
 * build fixer, a red test to the debugger (R2 plan §4.4). `redFiles`: the feature's RED test files. An unused
 * `/flow-allow red` for this feature makes this ticket the allowed one: it may edit those files and takes no round.
 * ASSUMPTION(GAP-R2-0.6-144): the allowance is one extra debug ticket, used once, for the feature being built only. */
async function debugTicket(h: FlowHost, r: FlowRecord, fn: FeatureNow, failing: { command: string; text: string }, redFiles: readonly string[]): Promise<void> {
  // a used allowance whose ticket was lost in a restart goes to the re-issue of that ticket (it takes no round either)
  const a = r.redAllow, lost = lostReissue(r, fn.f.id, 'd') ? [...r.tickets].reverse().find(t => t.f === fn.f.id)?.id : undefined
  const allowed = a && a.feature === fn.f.id && (!a.used || (lost !== undefined && a.ticket === lost)) ? a : undefined
  const round = allowed ? { ok: true as const, also: (x: FlowRecord): FlowRecord => ({ ...x, redAllow: { ...allowed, used: true, ticket: x.tickets.at(-1)?.id ?? '' } }) } : capRound(r, fn.key, 'feature', fn.f.id, 'd')
  if (!round.ok) return void (await blockFlow(h, r.flowId, round.blocked))
  const role = debugRole(failing.command), pluginProject = r.setup?.pluginProject ?? false, method = await methodText(h.io, role)
  const redAllow = allowed ? { redAllow: { files: redFiles, reason: allowed.reason } } : {}
  const why = await featureTicket(h, r, fn, { role, kind: 'debug', build: (nonce, pack) => debugTicketText({ f: fn.f.id, nonce, pluginProject, command: failing.command, failing: failing.text, pack, method, ...redAllow }), also: round.also })
  if (why) await blockFlow(h, r.flowId, why)
}
