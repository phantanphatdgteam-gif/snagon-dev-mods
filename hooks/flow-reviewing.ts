// B4 and B5 (plan v7.1 §3, §4.1-§4.6): the review. A green judge opens a round with one ticket per required reviewer (the
// routed code reviewer, and the security reviewer when Security is yes or forced). Replies are parsed when the Agent call
// answers: findings go to the record as digests and their words to the session; a fix reply moves findings and fills the
// FIX map. A complete round at the current tree goes through the gate: PASS seals the feature (B5) and starts the next
// one; an upheld dispute goes to the owner; open CRITICAL/HIGH findings get a fix ticket, whose change is judged again
// and then shown to the reviewers in a delta round.
import { ROUTING, routedAgent } from '../flow/data/routing'
import { CODE, SECURITY, SEVERITY_ORDER } from '../flow/data/rubrics'
import type { Rubric, Severity } from '../flow/data/types'
import { afterPass, pointerFields } from './flow'
import { git, gitPaths, type GitPaths } from './flow-git'
import { parseDiff, SCAN_DIFF_ARGS } from './flow-scan'
import { applyDelta, applyFix, assumptionsOf, changedHunks, deltaTicketText, fixTicketText, followUps, gate, parseFindings, parseReplies, reviewTicketText, upheld, type Finding } from './flow-review'
import { activeView, blockFlow, dropView, mutateSession, session, type FlowHost } from './flow-host'
import { CLOSED, updateRecord, usedIds, type Blocked, type FindingDigest, type FlowRecord, type ReviewRound, type TicketRecord, type UpdateResult } from './flow-state'
import { issueTicket } from './flow-ticket'
import { methodText } from './flow-method'
import { capRound, featureNow, startFeature, type FeatureNow } from './flow-build'
import { writeView } from './flow-setup'

export const START_PROMPT = 'flow: a ticket is ready. Call flow_status and start the agent exactly as it says.'
const TS = /\.(?:[cm]?ts|tsx)$/
const SCANNED = /^(?:FL|J)-\d+$/
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const isBlocked = (x: unknown): x is Blocked => typeof x === 'object' && x !== null && 'reason' in x && 'vars' in x
const order = (id: string): number => Number(/^T-(\d+)$/.exec(id)?.[1] ?? 0)
const SECURITY_TYPE = ROUTING.agents.securityReviewer.agent

/** The reviewers a round needs: the code reviewer routed by the TypeScript share of changed lines, the security reviewer
 * when the plan says Security: yes or the diff forced it. */
function reviewers(r: FlowRecord, fn: FeatureNow): string[] {
  const lines = fn.files.flatMap(f => f.lines.filter(l => l.kind !== ' ').map(() => TS.test(f.path)))
  const share = lines.length ? lines.filter(Boolean).length / lines.length : 0
  return [routedAgent('reviewer', share), ...(fn.f.security === true || r.frozen[`security:${fn.f.id}`] === 'forced' ? [SECURITY_TYPE] : [])]
}
const rubricsOf = (type: string): Rubric[] => (type === SECURITY_TYPE ? [SECURITY] : [CODE])
const prefixOf = (type: string): string => (type === SECURITY_TYPE ? 'SR' : 'CR')
const roleOf = (type: string): 'reviewer' | 'securityReviewer' => (type === SECURITY_TYPE ? 'securityReviewer' : 'reviewer')
/** The share that routes the reviewer role to `type` (issueTicket routes by share). */
const shareFor = (type: string): number => (type === routedAgent('reviewer', 1) ? 1 : 0)

export async function diffBetween(h: FlowHost, p: GitPaths, from: string, to: string): Promise<string> {
  if (from === to) return ''
  const d = await git(h.io, p.top, [...SCAN_DIFF_ARGS, from, to])
  if (d.exitCode !== 0 || d.isStdoutTruncated) throw new Error(`flow: git diff failed: ${d.stderr.trim().slice(0, 200)}`)
  return d.stdout
}
/** The findings of a feature with the reviewers' words this session holds. */
async function withDetails(h: FlowHost, r: FlowRecord, f: string): Promise<Finding[]> {
  const details = (await session(h)).value.details
  return r.findings.filter(x => x.f === f).map(x => ({ ...x, ...details[x.id] }))
}
const digest = (x: Finding): FindingDigest => ({ id: x.id, f: x.f, rubricId: x.rubricId, sev: x.sev, loc: x.loc, status: x.status })

/** One review (or delta) ticket per reviewer type, issued together at the current tree; `prev` is the tree of the round
 * before (a delta shows the change since it). The first ticket carries `also` (the round's count), when given. */
async function roundTickets(h: FlowHost, r: FlowRecord, fn: FeatureNow, kind: 'review' | 'delta', prev: string | undefined, types: readonly string[], also?: (x: FlowRecord) => FlowRecord): Promise<string[] | Blocked> {
  const s = (await session(h)).value, pluginProject = r.setup?.pluginProject ?? false
  const acs = fn.plan.acs.filter(a => fn.f.acs.includes(a.id)).map(a => `${a.id}: ${a.text}`)
  const redDiff = kind === 'review' ? await diffBetween(h, fn.p, fn.start, r.frozen[`red:${fn.f.id}`] ?? fn.start) : ''
  const since = kind === 'delta' && prev ? await diffBetween(h, fn.p, prev, fn.now) : ''
  const live = (await withDetails(h, r, fn.f.id)).filter(x => !CLOSED.has(x.status))
  // the round-1 ticket carries the reviewer's method (plan §4.1, §8), all read before any ticket is issued, so a file that
  // cannot be read fails the round whole; a delta round reviews the change only (§4.4)
  const methods = await Promise.all(types.map(type => (kind === 'review' ? methodText(h.io, roleOf(type)) : '')))
  const ids: string[] = []
  for (const [i, type] of types.entries()) {
    const method = methods[i] ?? ''
    const build = (nonce: string): string | null => kind === 'review'
      ? reviewTicketText({ f: fn.f.id, nonce, pluginProject, acs, rubrics: rubricsOf(type), diff: fn.diffText, redDiff, method })
      : deltaTicketText({ f: fn.f.id, nonce, pluginProject, findings: live, diff: since, fixMap: r.fixMap ?? {}, disputes: s.disputes, rubrics: rubricsOf(type) })
    const v = await activeView(h), base = v.mode === 'on' ? v.record : r
    const id = await issueTicket(h, base, { role: roleOf(type), f: fn.f.id, kind, typescriptShare: shareFor(type), build, ...(ids.length === 0 && also ? { also } : {}) })
    if (id === null) return { reason: 'split', vars: { id: fn.f.id } }
    ids.push(id)
  }
  return ids
}

/** A round: one ticket per required reviewer, one review round of the feature. A delta round reviews the change since
 * the round before. */
async function openRound(h: FlowHost, r: FlowRecord, fn: FeatureNow, kind: 'review' | 'delta', again = false): Promise<Blocked | null> {
  const round = capRound(r, fn.key, 'feature', fn.f.id, 'r')
  if (!round.ok) return round.blocked
  // a delta shows the change since the last reviewed tree; the gate's re-ask (`again`: nothing open, the same tree)
  // keeps the round's last real `prev`, so its ticket and hunks still show the fix (review, rounds 4 and 5); a delta
  // after a fix that left the tree as it was shows no change, as before
  const prev = kind !== 'delta' ? undefined : again ? r.round?.prev ?? r.round?.tree : r.round?.tree
  const ids = await roundTickets(h, r, fn, kind, prev, reviewers(r, fn), round.also)
  if (!Array.isArray(ids)) return ids
  // a scope correction's claims (FL ids) served their round: they cover nothing in the round that opens now (D11-1, D11-4)
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, y => ({ ...y, task: 'B4', round: { f: fn.f.id, tree: fn.now, ...(prev ? { prev } : {}), tickets: ids }, ...(y.fixMap ? { fixMap: Object.fromEntries(Object.entries(y.fixMap).filter(([id]) => !/^FL-\d+$/.test(id))) } : {}) })))
  await h.submit(START_PROMPT)
  return null
}

/** The fix ticket for the open CRITICAL/HIGH findings: one edit round. */
async function fixTicket(h: FlowHost, r: FlowRecord, fn: FeatureNow): Promise<Blocked | null> {
  const round = capRound(r, fn.key, 'feature', fn.f.id, 'e')
  if (!round.ok) return round.blocked
  const findings = await withDetails(h, r, fn.f.id), pluginProject = r.setup?.pluginProject ?? false
  const id = await issueTicket(h, r, { role: 'author', f: fn.f.id, kind: 'fix', build: nonce => fixTicketText({ f: fn.f.id, nonce, pluginProject, findings }), also: round.also })
  if (id === null) return { reason: 'split', vars: { id: fn.f.id } }
  await h.submit(START_PROMPT)
  return null
}

/** A reply of a run that attested (tool.call after the Agent call): review and delta findings, fix and dispute lines, the
 * author's assumptions; every kind marks its ticket attested in the record with them. Only the parsed, redacted parts are
 * kept: digests and assumptions in the record, the reviewers' words and the disputes in the session. */
export async function onReply(h: FlowHost, t: TicketRecord, text: string): Promise<void> {
  const view = await activeView(h)
  if (view.mode !== 'on') return
  // the ticket is marked attested in the same write as what its reply produced: if that is not kept, the run is not
  // attested and its step asks again (security review of step 10)
  const write = async (change: (x: FlowRecord) => FlowRecord): Promise<FlowRecord> => settled(await updateRecord(h.io, h.home, view.record.flowId, h.sessionId, x => {
    const y = change(x)
    return { ...y, tickets: y.tickets.map(z => (z.id === t.id ? { ...z, attested: true } : z)) }
  }))
  if (t.kind === 'author') return void (await write(x => ({ ...x, assumptions: { ...x.assumptions, [t.f]: assumptionsOf(text, t.nonce) } })))
  if (t.kind !== 'review' && t.kind !== 'delta' && t.kind !== 'fix') return void (await write(x => x))
  const r = view.record, files = r.features?.find(x => x.id === t.f)?.files ?? [], details = (await session(h)).value.details
  const roots = [r.root, (await h.stat(r.root))?.realPath ?? r.root] // an agent may spell the root either way (SEC13-5)
  const replies = parseReplies(text, roots), prev = r.round?.prev
  // a feature fix answers the findings its ticket named: at least one FIX or DISPUTE or REVERT on an open blocking finding
  // of the feature, and a REVERT only on an open fix-scope finding; else the run is not attested and the ticket comes
  // again (security review of D11, round 2: an invented id would earn a free correction)
  if (t.kind === 'fix' && t.f !== 'verify') {
    const open = r.findings.filter(x => x.f === t.f && (x.sev === 'CRITICAL' || x.sev === 'HIGH') && (x.status === 'open' || x.status === 'reopened'))
    const named = replies.named // every FIX, DISPUTE or REVERT line's id, whether or not its range could be read
    const bad = !named.some(id => open.some(x => x.id === id)) || replies.reverts.some(id => !open.some(x => x.id === id && x.rubricId === 'fix-scope'))
    if (bad) return void (await mutateSession(h, s => ({ ...s, runs: { ...s.runs, [t.id]: { ok: false, reason: 'the fix names no finding of its ticket' } } })))
  }
  // a delta reviewer rules on every fixed or disputed blocking finding of its own prefix (the ticket asks for one line
  // each): a reply that skips one is not attested and the round is asked again, as any review run that did not report
  // back (dry run 18, D15: a verdict the parser dropped left a finding fixed-unconfirmed, and a fix ticket with nothing
  // to fix went out)
  if (t.kind === 'delta') {
    const mine = `${prefixOf(t.routedType)}-`
    const unruled = r.findings.filter(x => x.f === t.f && x.id.startsWith(mine) && (x.sev === 'CRITICAL' || x.sev === 'HIGH') && (x.status === 'fixed-unconfirmed' || x.status === 'disputed') && !(x.id in replies.status)).map(x => x.id)
    if (unruled.length) return void (await mutateSession(h, s => ({ ...s, runs: { ...s.runs, [t.id]: { ok: false, reason: `the delta reply gives no verdict on ${unruled.join(', ')}` } } })))
  }
  const hunks = t.kind === 'delta' && prev && r.round ? changedHunks(parseDiff(await diffBetween(h, await gitPaths(h.io, r.root), prev, r.round.tree))) : []
  // the findings are worked out inside the write, on the newest record: two replies at once (the code and the security
  // reviewer) both keep theirs, and the new ids follow every id already there
  const box: { next: Finding[] } = { next: [] }
  await write(x => {
    const mine = x.findings.filter(y => y.f === t.f).map((y): Finding => ({ ...y, ...details[y.id] }))
    let fixMap: Record<string, string[]> = {}
    if (t.kind === 'fix') {
      const fixed = applyFix(mine, replies, files)
      box.next = fixed.findings
      fixMap = fixed.fixMap
    } else {
      const prefix = prefixOf(t.routedType), n = usedIds(x.findings, x.lastIds)[prefix] ?? 0
      const fresh = parseFindings(text, t.nonce, { f: t.f, rubrics: rubricsOf(t.routedType), artifactFiles: files, prefix, next: n + 1, roots }).findings
      box.next = t.kind === 'review' ? [...mine, ...fresh] : applyDelta(mine, replies, fresh, hunks)
    }
    return { ...x, ...(t.kind === 'fix' ? { fixMap: { ...x.fixMap, ...fixMap } } : {}), findings: [...x.findings.filter(y => y.f !== t.f || SCANNED.test(y.id)), ...box.next.filter(y => !SCANNED.test(y.id)).map(digest)] }
  })
  // the reviewers' words and the author's disputes, under the ids that write kept (session only)
  const words = Object.fromEntries(box.next.filter(x => x.evidence || x.scenario || x.expected).map(x => [x.id, { ...(x.evidence ? { evidence: x.evidence } : {}), ...(x.scenario ? { scenario: x.scenario } : {}), ...(x.expected ? { expected: x.expected } : {}) }]))
  await mutateSession(h, s => ({ ...s, details: { ...s.details, ...words }, ...(t.kind === 'fix' ? { disputes: { ...s.disputes, ...replies.disputes } } : {}) }))
}

/** B5: the seal (§3 B5), the feature's tickets and closed findings compacted (a waived one stays: verify must not raise it
 * again), its view, then the next feature or verify. */
async function seal(h: FlowHost, r: FlowRecord, fn: FeatureNow): Promise<void> {
  const mine = r.findings.filter(x => x.f === fn.f.id)
  const counts = Object.fromEntries(SEVERITY_ORDER.map((sev: Severity) => [sev, mine.filter(x => x.sev === sev).length])) as Record<Severity, number>
  const sealed = { f: fn.f.id, tree: fn.now, evalIds: fn.f.acs, tickets: r.tickets.filter(t => t.f === fn.f.id).length, findings: counts, followups: followUps(mine).map(x => x.id) }
  await writeView(h, `.snagon/flow/${fn.f.id}.json`, `${JSON.stringify(sealed, null, 1)}\n`)
  const next = pointerFields(afterPass({ phase: 'build', task: 'B5', feature: fn.f.id }, { features: (r.features ?? []).map(f => f.id), baselineRed: false }))
  const after = settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => {
    const { round: _r, fixMap: _m, feature: _f, ...rest } = x
    // the closed findings go; their numbers stay used (lastIds), so no later finding takes one
    return { ...rest, ...next, lastIds: usedIds(x.findings, x.lastIds), seals: [...x.seals, sealed], tickets: x.tickets.filter(t => t.f !== fn.f.id), findings: x.findings.filter(y => y.f !== fn.f.id || !CLOSED.has(y.status) || y.status === 'waived') }
  }))
  const gone = new Set(r.tickets.filter(t => t.f === fn.f.id).map(t => t.id))
  await mutateSession(h, s => ({ ...s, tickets: Object.fromEntries(Object.entries(s.tickets).filter(([id]) => !gone.has(id))) }))
  if (after.task === 'B1') await startFeature(h, after)
}

/** Unattested round tickets go out again for the same reviewers, rebuilt (a used ticket's text has left $.state). A run
 * that did not report back takes a review round, so a reviewer that never attests reaches the cap; tickets lost in a
 * restart (never started) come back free. */
async function reissue(h: FlowHost, r: FlowRecord, fn: FeatureNow, round: ReviewRound, tickets: readonly TicketRecord[]): Promise<Blocked | null> {
  const charge = tickets.every(t => t.toolUseId === undefined) ? { ok: true as const, also: undefined } : capRound(r, fn.key, 'feature', fn.f.id, 'r')
  if (!charge.ok) return charge.blocked
  const ids = await roundTickets(h, r, fn, tickets[0]?.kind === 'delta' ? 'delta' : 'review', round.prev, tickets.map(t => t.routedType), charge.also)
  if (!Array.isArray(ids)) return ids
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, ...(x.round ? { round: { ...x.round, tickets: [...x.round.tickets.filter(id => !tickets.some(t => t.id === id)), ...ids] } } : {}) })))
  await h.submit(START_PROMPT)
  return null
}

/** flow_check at B4. Returns 'judge' when the change a fix made must be judged before the delta round. */
const openScanned = (r: FlowRecord, f: string): boolean => r.findings.some(x => x.f === f && SCANNED.test(x.id) && x.status === 'open' && x.sev === 'HIGH')
/** A blocking finding of the feature the author still has to answer: the only kind a fix ticket lists. */
const openBlocking = (r: FlowRecord, f: string): boolean => r.findings.some(x => x.f === f && (x.sev === 'CRITICAL' || x.sev === 'HIGH') && (x.status === 'open' || x.status === 'reopened'))
export async function reviewStep(h: FlowHost, r: FlowRecord): Promise<'judge' | null> {
  const block = async (why: Blocked | null): Promise<null> => { if (why) await blockFlow(h, r.flowId, why); return null }
  const fn = await featureNow(h, r)
  if (isBlocked(fn)) return block(fn)
  const s = (await session(h)).value, round = r.round?.f === fn.f.id ? r.round : undefined
  if (!round) return block(await openRound(h, r, fn, 'review'))
  const last = Math.max(...round.tickets.map(order))
  const fix = [...r.tickets].reverse().find(t => t.f === fn.f.id && t.kind === 'fix' && order(t.id) > last)
  if (fix) {
    if (!fix.used) return null
    // an unattested fix run comes again while a blocking finding is open; with none open (a correction that reverted
    // its hunk and reported nothing) a fix ticket would list nothing, and no reply to it could be attested (review of
    // D11, round 3): the change is judged and reviewed as it stands
    if (!fix.attested && openBlocking(r, fn.f.id)) return block(await fixTicket(h, r, fn))
    // judged again while a scanned HIGH finding is open: a scope correction may have reported ranges without a change
    if (!r.judge?.green || r.judge.tree !== fn.now || openScanned(r, fn.f.id)) return 'judge'
    return block(await openRound(h, r, fn, 'delta'))
  }
  const tickets = round.tickets.map(id => r.tickets.find(t => t.id === id)).filter((t): t is TicketRecord => t !== undefined)
  if (tickets.some(t => !t.used)) return null
  // files changed during the round with no fix ticket: judged, then reviewed as a delta (the judge's fix-scope check
  // flags lines outside the FIX map)
  if (round.tree !== fn.now) return r.judge?.green && r.judge.tree === fn.now ? block(await openRound(h, r, fn, 'delta')) : 'judge'
  const unattested = tickets.filter(t => !t.attested)
  if (unattested.length) return block(await reissue(h, r, fn, round, unattested))
  const mine = r.findings.filter(x => x.f === fn.f.id)
  const g = gate({ judge: r.judge ?? { tree: '', green: false }, currentTree: fn.now, lastRound: { tree: round.tree, reviewers: tickets.map(t => t.routedType) }, required: reviewers(r, fn), findings: mine })
  if (g.pass) { await seal(h, r, fn); return null }
  const up = upheld(mine)
  if (up.length) return block({ reason: 'dispute', vars: { id: up[0] ?? '' } })
  // live findings with none open are fixed or disputed ones the delta round gave no verdict on: the reviewer rules on
  // them, not the author (a fix ticket would list nothing), so the delta round is asked again
  return block(openBlocking(r, fn.f.id) ? await fixTicket(h, r, fn) : await openRound(h, r, fn, 'delta', true))
}
