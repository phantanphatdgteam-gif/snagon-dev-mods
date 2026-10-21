// Verify (plan v7.1 §3 V1-V8): /flow-verify starts it. flow_check runs every approved command at the worktree against the
// baseline with every Required eval id of the plan (a red command gets a verify debug ticket, then waits for the owner's
// waiver), scans the whole flow diff for junk (a fix ticket, then a waiver), and writes docs/flow/verify.md in the
// owner's language. A report that would hold a secret is written redacted and blocks the flow (publish); a clean one
// freezes the verified tree and its hash, and the flow waits for /flow-ship.
import { debugRole } from '../flow/data/routing'
import { fill } from '../flow/data/templates'
import type { Role } from '../flow/data/types'
import { afterPass, pointerFields } from './flow'
import { blobsAt, flowTree, git, gitPaths, ignoredSet, remoteTip } from './flow-git'
import { keepTrees, neededTrees } from './flow-refs'
import { parseDiff, scan } from './flow-scan'
import { judgeRun, timeoutFor, MAX_RUN_MS } from './flow-judge'
import { debugTicketText, fixTicketText, newNonce, sha256 } from './flow-review'
import { globRe, type Plan } from './flow-plan'
import { viewText } from './flow-pack'
import { activeView, blockFlow, dropView, mutateSession, session, type FlowHost } from './flow-host'
import { dropEcho, visibleText } from './flow-owner'
import { CLOSED, updateRecord, type Blocked, type FlowRecord, type UpdateResult } from './flow-state'
import { issueTicket } from './flow-ticket'
import { lintNow, PLAN_FILE } from './flow-planning'
import { frozenBaseline, ignoredSkip, type BaselineFile } from './flow-baseline'
import { judgedBlock, judgedRun } from './flow-run'
import { capRound } from './flow-build'
import { methodText } from './flow-method'
import { mergeFindings, testTexts, unsettled, withSigs } from './flow-judging'
import { diffBetween } from './flow-reviewing'
import { flowCard } from './flow-turn'
import { stackOf } from './stacks/index'

export const VERIFY_FILE = 'docs/flow/verify.md'
const WAIVERS = '.snagon/flow/waivers.md'
/** A waivers view line: `- <FL-n|J-n|check:<cmdId>|allow red F-NN>: <reason>`. */
const WAIVER = /^- ((?:FL|J)-\d+|check:[\w-]+|allow red F-\d{2}): (.*)$/
const GO_ON = 'flow: verify starts. Call flow_check.'
const START_PROMPT = 'flow: a ticket is ready. Call flow_status and start the agent exactly as it says.'
/** The blocks /flow-verify answers: a report that held a secret or was changed after verify, a push the remote refused. */
const AGAIN = new Set(['publish', 'pushRejected', 'reportChanged'])
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }

/** §3.2 push-rejected: once the owner has taken in the moved remote branch, the scans start at merge-base(HEAD, remote
 * tip) when that descends from baseSha, so the remote's own commits are not judged as this flow's work. Null keeps
 * baseSha (no tip, a tip that is not here, a merge-base off the flow's history). */
async function mergeBaseAfterPull(h: FlowHost, r: FlowRecord): Promise<string | null> {
  const base = r.frozen.baseSha, url = r.frozen['remote.url']
  if (!base || base === 'none' || !url) return null
  const p = await gitPaths(h.io, r.root), tip = await remoteTip(h.io, p.top, url, r.setup?.branch ?? r.branch).catch(() => null)
  if (!tip) return null
  const mb = await git(h.io, p.top, ['merge-base', 'HEAD', tip]), at = mb.stdout.trim()
  if (mb.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(at)) return null
  return (await git(h.io, p.top, ['merge-base', '--is-ancestor', base, at])).exitCode === 0 ? at : null
}

/** Waiting at ship with no block: for /flow-ship at H0, or for the release approval at H1 (its echo shown). */
export const atShip = (r: FlowRecord): boolean => !r.blocked && ((r.task === 'H0' && r.awaiting === '/flow-ship') || (r.task === 'H1' && r.awaiting === '/flow-approve release'))

/** /flow-verify: at V1 waiting for it, after a blocked report or push, or while waiting at ship (/flow-ship says to verify
 * again when the files moved since V8, for one a reformatting commit hook, plan line 555), verify runs on the next
 * flow_check, using no round; leaving ship drops the release echo. */
export async function verifyCommand(h: FlowHost): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  const r = view.record, ship = atShip(r)
  if (!AGAIN.has(r.blocked?.reason ?? '') && !ship && (r.task !== 'V1' || r.awaiting !== '/flow-verify')) return (await flowCard(h)) ?? ''
  const scanBase = r.blocked?.reason === 'pushRejected' ? await mergeBaseAfterPull(h, r) : null
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => {
    const { awaiting: _a, blocked: _b, ...rest } = x
    return { ...rest, phase: 'verify', task: 'V1', ...(scanBase ? { frozen: { ...x.frozen, scanBase } } : {}) }
  }))
  if (ship) await mutateSession(h, s => ({ ...s, pending: dropEcho(s.pending, 'release'), shown: s.shown === 'release' ? null : s.shown, release: null }))
  await h.submit(GO_ON)
  return fill(h.language, 'verify.started', {})
}

type Ran = { id: string; runner: string; pass: boolean; waived: boolean; output: string }
/** V1 and V2: every command at the worktree; the test runner proves the eval id of every Required criterion. `trees`:
 * the two sides of `diffText`. */
async function runAll(h: FlowHost, r: FlowRecord, plan: Plan, base: BaselineFile, diffText: string, trees: { from: string; now: string }): Promise<Ran[] | Blocked> {
  const p = await gitPaths(h.io, r.root), files = parseDiff(diffText), { data, code } = stackOf(r), globs = data.testFiles.map(globRe)
  const required = plan.acs.filter(a => a.required).map(a => a.id), present = await code.evalIdsInTests(h.io, p, data.testFiles)
  const tests = files.filter(x => globs.some(t => t.test(x.path)))
  let texts: Awaited<ReturnType<typeof testTexts>>
  try { texts = await testTexts(h.io, p, trees.from, trees.now, tests) } catch (err) { return { reason: 'couldNotRun', vars: { detail: `verify: ${err instanceof Error ? err.message : String(err)}` } } }
  const decl = code.declChanges(files, tests.map(x => x.path), texts)
  const out: Ran[] = []
  for (const cmd of r.setup?.commands ?? []) {
    const b = base.commands[cmd.id]
    const run = await judgedRun(h, r, cmd, b ? timeoutFor(b.ms) : MAX_RUN_MS)
    if (!run.ok) return judgedBlock(cmd, run)
    const v = judgeRun(cmd, run.run, b ?? null, data, data.testRunners.includes(cmd.runner) ? required : [], present, run.report, decl)
    const output = [run.run.output, ...v.newFailures.map(s => `${s.file} > ${s.id}: ${s.message}`), ...v.evalProblems, v.note ?? ''].filter(Boolean).join('\n')
    out.push({ id: cmd.id, runner: cmd.runner, pass: v.pass, waived: false, output })
  }
  return out
}

/** V8: the report, in the owner's language, from the record and the views (never from an agent's reply). */
async function report(h: FlowHost, r: FlowRecord, plan: Plan, base: BaselineFile, ran: readonly Ran[]): Promise<string> {
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => fill(h.language, key, vars)
  const none = t('verify.none')
  const waivers = (await h.io.read(`${r.root}/${WAIVERS}`).catch(() => '')).split('\n').map(l => WAIVER.exec(l)).filter(m => m !== null)
    .map(m => t('verify.waiver', { target: m[1] ?? '', reason: m[2] ?? '', address: h.address }))
  const assumed = Object.entries(r.assumptions ?? {}).flatMap(([f, lines]) => lines.map(text => t('verify.assumption', { f, text })))
  const followups = r.seals.flatMap(s => s.followups)
  // a waived test runner proved nothing
  const testRunners = stackOf(r).data.testRunners, proven = ran.every(x => x.pass || !testRunners.includes(x.runner))
  return [
    t('verify.title'), '', t('verify.features'),
    ...r.seals.map(s => t('verify.seal', { f: s.f, tree: s.tree.slice(0, 12), ids: s.evalIds.join(', ') || '—', findings: Object.entries(s.findings).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || '0', followups: s.followups.join(', ') || '—' })),
    ...Object.keys(r.frozen).filter(k => k.startsWith('dep:')).sort().map(k => t('verify.dep', { f: k.slice(4) })),
    t('verify.self', { n: r.selfBlocks ?? 0 }),
    '', t('verify.commands'),
    ...ran.map(x => t('verify.cmd', { id: x.id, result: t(x.pass ? 'verify.passed' : 'verify.waived'), exit: base.commands[x.id]?.exitCode ?? '—', failed: base.commands[x.id]?.signatures.length ?? 0 })),
    '', t('verify.acs'), ...plan.acs.map(a => t('verify.ac', { id: a.id, state: t(!a.required ? 'verify.optional' : proven ? 'verify.passed' : 'verify.waived') })),
    '', t('verify.waivers'), ...(waivers.length ? waivers : [none]),
    '', t('verify.assumptions'), ...(assumed.length ? assumed : [none]),
    '', t('verify.followups'), ...(followups.length ? followups.map(id => `- ${id}`) : [none]), '',
  ].join('\n')
}

/** A verify ticket (debug or junk fix) for `role` in the verify scope's rounds, or `atCap` once they are used. */
async function verifyTicket(h: FlowHost, r: FlowRecord, kind: 'd' | 'e', role: Role, build: (nonce: string) => string | null, atCap: Blocked): Promise<void> {
  const round = capRound(r, 'verify', 'verify', 'verify', kind)
  if (!round.ok) return void (await blockFlow(h, r.flowId, atCap))
  const id = await issueTicket(h, r, { role, f: 'verify', kind: kind === 'd' ? 'debug' : 'fix', build, also: round.also })
  if (id === null) return void (await blockFlow(h, r.flowId, { reason: 'couldNotRun', vars: { detail: 'the verify ticket is over the ticket size cap' } }))
  await h.submit(START_PROMPT)
}

/** flow_check at V1: the run, the junk scan (V4), the report (V8). */
export async function verifyStep(h: FlowHost, r: FlowRecord): Promise<void> {
  const block = async (why: Blocked): Promise<void> => { await blockFlow(h, r.flowId, why) }
  const { lint } = await lintNow(h, r)
  if (lint.hash !== r.frozen.plan) return block({ reason: 'frozenChanged', vars: { what: PLAN_FILE } })
  const held = await frozenBaseline(h, r)
  if (!held) return
  const p = await gitPaths(h.io, r.root), now = await flowTree(h.io, p, 'worktree', newNonce())
  // the flow's whole change: from HEAD at S3 (or the merge-base after a pulled remote), or from the first feature's start
  // tree when the branch had no commit then
  const from = r.frozen.scanBase ?? (r.frozen.baseSha && r.frozen.baseSha !== 'none' ? r.frozen.baseSha : r.frozen[`start:${r.features?.[0]?.id ?? ''}`])
  if (!from) return block({ reason: 'couldNotRun', vars: { detail: 'verify: the flow has no start tree to compare with' } })
  const diffText = await diffBetween(h, p, from, now)
  const runs = await runAll(h, r, lint.plan, held.base, diffText, { from, now })
  if (!Array.isArray(runs)) return block(runs)
  // the baseline once more after the runs (a change while they ran blocks), and the newest record for the owner's
  // waivers and decisions taken while the commands ran
  if (!(await frozenBaseline(h, r))) return
  dropView()
  const fresh = await activeView(h)
  if (fresh.mode !== 'on') return
  const r2 = fresh.record, ran = runs.map(x => ({ ...x, waived: !x.pass && r2.frozen[`waive:check:${x.id}`] === 'yes' }))
  const red = ran.find(x => !x.pass && !x.waived)
  const pluginProject = r.setup?.pluginProject ?? false
  // the first red command routes the debug ticket: a typecheck, build or lint to the stack's build fixer, a test to the
  // debugger (R2 plan §4.4)
  if (red) {
    const role = debugRole(red.id), method = await methodText(h.io, role)
    return verifyTicket(h, r2, 'd', role, nonce => debugTicketText({ f: 'verify', nonce, pluginProject, command: red.id, failing: red.output, pack: '', method }), { reason: 'redCheck', vars: { command: red.id, cmdId: red.id } })
  }
  // V4: junk in the whole change, minus what the owner already settled in a feature.
  const stack = stackOf(r), ignoredNow = (await ignoredSet(h.io, p, ignoredSkip(stack.data))).hash
  // the changed code files whole, from the diff's own new tree (a hunk can start inside a string)
  let texts: Record<string, string>
  try { texts = await blobsAt(h.io, p, now, parseDiff(diffText).filter(x => x.status !== 'deleted' && stack.code.lex(x.path, []) !== null).map(x => x.path)) } catch (err) { return block({ reason: 'couldNotRun', vars: { detail: `scan: ${err instanceof Error ? err.message : String(err)}` } }) }
  const s = scan(diffText, [], { stack, frozen: [], texts, ignored: { before: r.frozen.ignored ?? ignoredNow, after: ignoredNow } })
  if (s.status === 'error') return block({ reason: 'couldNotRun', vars: { detail: `scan: ${s.error ?? ''}` } })
  // junk a feature already settled (on the newest record, so a decision taken while the commands ran counts) is left out,
  // wherever a later change moved its line (535 trial M-3)
  const scanned = withSigs(s.findings.filter(y => y.kind === 'J'), texts)
  const found = (x: FlowRecord) => unsettled(x.findings.filter(y => y.f !== 'verify' && CLOSED.has(y.status)), scanned, x.findings.filter(y => y.f === 'verify'))
  // merged into the newest record: an owner decision taken while the commands ran stays, and decides what blocks
  const after = settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, findings: mergeFindings(x.findings, 'verify', found(x), x.lastIds) })))
  const junk = after.findings.filter(x => x.f === 'verify' && x.status === 'open' && x.sev === 'HIGH')
  if (junk.length) {
    const details = (await session(h)).value.details, first = junk[0]
    return verifyTicket(h, after, 'e', 'author', nonce => fixTicketText({ f: 'verify', nonce, pluginProject, findings: junk.map(x => ({ ...x, ...details[x.id] })) }), { reason: 'junk', vars: { id: first?.id ?? '', rule: first?.rubricId ?? '', location: first?.loc ?? '' } })
  }
  const text = viewText(await report(h, after, lint.plan, held.base, ran)), written = visibleText(text.text)
  await h.io.write(`${r.root}/${VERIFY_FILE}`, written)
  if (text.leak) return block({ reason: 'publish', vars: { detail: VERIFY_FILE } })
  const hash = await sha256(written)
  const verified = settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, verifiedTree: now, verifyMdHash: hash, ...pointerFields(afterPass({ phase: 'verify', task: 'V8' }, { features: [], baselineRed: false })) })))
  await keepTrees(h.io, p, r.flowId, neededTrees(verified)) // A1: the verified and last-seal trees, which the release echo reads
}
