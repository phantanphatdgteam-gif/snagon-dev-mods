// B3, the judge (plan v7.1 §3 B3 and its twelve checks, §4.7, F45): every approved command at the worktree against the
// baseline, the eval ids of this feature and the earlier ones, the test count, floor, junk and scope, the RED tests as
// frozen, the ignored-file set, Security forcing. (Command sources, H_cfg and the plugin's files are checked by every
// flow_check first.) Open floor or junk findings block the flow for the owner; a red run gets a debug ticket with the
// failing output and the feature pack, one debug round each; a green judge moves the feature to review (B4).
import { TYPESCRIPT } from '../flow/data/stacks'
import type { FindingDigest } from './flow-state'
import { addedTests, declChanges, evalIdsInTests, judgeRun, outOfScope, securityForced, timeoutFor, MAX_RUN_MS, type Verdict } from './flow-judge'
import { parseDiff, scan, type ScanFinding } from './flow-scan'
import { ignoredSet } from './flow-git'
import { changedHunks, debugTicketText, fixTicketText, scopeViolations, sha256 } from './flow-review'
import { issueTicket } from './flow-ticket'
import { canonical } from './flow-owner'
import { globRe, type FeatureRow, type Plan } from './flow-plan'
import type { RedShape } from './flow-scan'
import { blockFlow, dropView, session, type FlowHost } from './flow-host'
import { updateRecord, usedIds, type Blocked, type FlowRecord, type UpdateResult } from './flow-state'
import { capRound, featureNow, featureTicket, redFile, type FeatureNow } from './flow-build'
import { methodText } from './flow-method'
import { frozenBaseline, IGNORED_SKIP, type BaselineFile } from './flow-baseline'
import { diffBetween, START_PROMPT } from './flow-reviewing'
import { judgedRun } from './flow-run'

const TEST_RUNNERS = new Set(['vitest', 'jest'])
const SCANNED = /^(?:FL|J)-\d+$/
const TESTS = TYPESCRIPT.testFiles.map(globRe)
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

/** New scan findings get the next FL-n or J-n; an open one the scan no longer finds is resolved, and a resolved one it
 * finds again opens again; the others keep their status (a waived one stays waived). */
export function mergeFindings(old: readonly FindingDigest[], f: string, found: readonly ScanFinding[], floor: Readonly<Record<string, number>> = {}): FindingDigest[] {
  const key = (rule: string, loc: string): string => `${rule}\u0000${loc}`
  const now = new Set(found.map(x => key(x.rule, x.loc)))
  const kept = old.map(x => {
    if (x.f !== f || !/^(?:FL|J)-\d+$/.test(x.id)) return x
    const found = now.has(key(x.rubricId, x.loc))
    return x.status === 'open' && !found ? { ...x, status: 'resolved' } : x.status === 'resolved' && found ? { ...x, status: 'open' } : x
  })
  const known = new Set(kept.filter(x => x.f === f).map(x => key(x.rubricId, x.loc)))
  // new ids go on from the highest number given (floor: the record's lastIds), never reusing one a seal dropped
  const used = usedIds(old, floor)
  let fl = used.FL ?? 0, j = used.J ?? 0
  const fresh = [...new Map(found.filter(x => !known.has(key(x.rule, x.loc))).map(x => [key(x.rule, x.loc), x])).values()]
  return [...kept, ...fresh.map(x => ({ id: x.kind === 'FL' ? `FL-${(fl += 1)}` : `J-${(j += 1)}`, f, rubricId: x.rule, sev: x.sev, loc: x.loc, status: 'open' }))]
}

/** The blocked reason an open HIGH floor or junk finding gives (§3.2): the RED-test and injection rules have their own. */
const findingBlock = (x: FindingDigest): Blocked =>
  x.rubricId === 'red-test-changed' ? { reason: 'redTestChanged', vars: { id: x.id, feature: x.f, location: x.loc } }
    : x.rubricId === 'injection' ? { reason: 'injection', vars: { id: x.id, location: x.loc } }
    : { reason: x.id.startsWith('FL-') ? 'floor' : 'junk', vars: { id: x.id, rule: x.rubricId, location: x.loc } }

/** ran: the tests the test runner ran (passed or failed): a skipped or removed test lowers it, a failing one does not;
 * base: the frozen baseline the runs were judged against. */
type Judged = { verdicts: Verdict[]; failing: string | null; ran: number | null; base: BaselineFile }
/** null: the frozen baseline did not hold, and frozenBaseline has blocked the flow already. */
async function runAll(h: FlowHost, r: FlowRecord, fn: FeatureNow): Promise<Judged | Blocked | null> {
  const held = await frozenBaseline(h, r)
  if (!held) return null
  const required = requiredIds(fn.plan, fn.f), present = await evalIdsInTests(h.io, fn.p, TYPESCRIPT.testFiles)
  const decl = declChanges(fn.files, fn.files.map(x => x.path).filter(p => TESTS.some(t => t.test(p))))
  const out: Judged = { verdicts: [], failing: null, ran: null, base: held.base }
  for (const cmd of r.setup?.commands ?? []) {
    const base = held.base.commands[cmd.id]
    const run = await judgedRun(h, r, cmd, base ? timeoutFor(base.ms) : MAX_RUN_MS)
    if (!run.ok) return run.reason === 'tooSlow' ? { reason: 'tooSlow', vars: { command: cmd.id, limit: 'its time limit' } } : { reason: 'couldNotRun', vars: { detail: `${cmd.id}: ${run.detail}` } }
    const tests = TEST_RUNNERS.has(cmd.runner)
    const v = judgeRun(cmd, run.run, base ?? null, TYPESCRIPT, tests ? required : [], present, run.report, decl)
    if (!v.pass && out.failing === null) out.failing = [run.run.output, ...v.newFailures.map(s => `${s.file} > ${s.id}: ${s.message}`), ...v.evalProblems, v.note ?? ''].filter(Boolean).join('\n')
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
  const testCmd = r.setup?.commands.find(c => TEST_RUNNERS.has(c.runner))
  const baseCounts = testCmd ? judged.base.commands[testCmd.id]?.counts : undefined, baseRan = baseCounts ? baseCounts.passed + baseCounts.failed : undefined
  const texts = Object.fromEntries(await Promise.all(Object.keys(shapes).map(async p => [p, await h.io.read(`${r.root}/${p}`).catch(() => '')] as const)))
  const ignoredNow = (await ignoredSet(h.io, fn.p, IGNORED_SKIP)).hash
  // check 3: count ≥ baseline + new
  const counts = baseRan !== undefined && judged.ran !== null ? { counts: { before: baseRan + addedTests(fn.files, fn.tests).length, after: judged.ran } } : {}
  const s = scan(fn.diffText, [], { stack: TYPESCRIPT, frozen: [], red: shapes, texts, ...counts, ignored: { before: r.frozen.ignored ?? ignoredNow, after: ignoredNow } })
  if (s.status === 'error') return block({ reason: 'couldNotRun', vars: { detail: `scan: ${s.error ?? ''}` } })
  const scope = [...outOfScope(fn.files, fn.f.files.map(x => x.path)).map((p): ScanFinding => ({ kind: 'FL', rule: 'out-of-scope', sev: 'HIGH', loc: p })), ...(await fixScope(h, r, fn))]
  const forced = fn.f.security !== true && securityForced(fn.files, TYPESCRIPT)
  const green = judged.verdicts.every(v => v.pass)
  // the findings, and what blocks, come from the newest record: an owner decision taken while the commands ran stays
  const now = await h.io.now(), found = [...s.findings, ...scope]
  const openIn = (fs: readonly FindingDigest[]): FindingDigest | undefined => fs.find(x => x.f === fn.f.id && SCANNED.test(x.id) && x.status === 'open' && x.sev === 'HIGH')
  const after = settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => {
    const findings = mergeFindings(x.findings, fn.f.id, found, x.lastIds)
    return { ...x, findings, judge: { tree: fn.now, green, task: 'B3', f: fn.f.id, at: now }, task: green && !openIn(findings) ? 'B4' : 'B3', ...(forced ? { frozen: { ...x.frozen, [`security:${fn.f.id}`]: 'forced' } } : {}) }
  }))
  const opens = openScannedHigh(after.findings, fn.f.id), other = opens.find(x => x.rubricId !== 'fix-scope')
  if (opens.length) {
    if (!other && correctionDue(after, fn.f.id)) { await correctionTicket(h, after, fn); return false }
    return block(findingBlock(other ?? opens[0] as FindingDigest))
  }
  if (!green) { await debugTicket(h, after, fn, judged.failing ?? 'a check failed'); return false }
  return true
}

/** F45: the debug ticket (one debug round), or the debug cap blocked. */
async function debugTicket(h: FlowHost, r: FlowRecord, fn: FeatureNow, failing: string): Promise<void> {
  const round = capRound(r, fn.key, 'feature', fn.f.id, 'd')
  if (!round.ok) return void (await blockFlow(h, r.flowId, round.blocked))
  const pluginProject = r.setup?.pluginProject ?? false, method = await methodText(h.io, 'debugger')
  const why = await featureTicket(h, r, fn, { role: 'debugger', kind: 'debug', build: (nonce, pack) => debugTicketText({ f: fn.f.id, nonce, pluginProject, failing, pack, method }), also: round.also })
  if (why) await blockFlow(h, r.flowId, why)
}
