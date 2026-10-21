// The plan (plan v7.1 §3, §3.1): P1 a planner ticket with what the owner asked for; P2 the mod lints docs/flow/plan.md and
// sends its issues back to the planner, up to the plan's edit cap; P3 the owner approves the echo of the plan file, which
// freezes it with the feature keys and files, the counters carried over, the rubrics and the routing.
import { fill } from '../flow/data/templates'
import { ROUTING } from '../flow/data/routing'
import { RUBRICS } from '../flow/data/rubrics'
import { CAPS, RETRY } from '../flow/data/phases'
import { hashOf } from './session'
import { afterPass, pointerFields } from './flow'
import { carryCounters, featureKey, lintPlan, type LintIssue } from './flow-plan'
import { canonical, dropEcho, makeEcho, refusalText, showEcho, type EchoContent, type Origin } from './flow-owner'
import { freezeRubric, planTicketText } from './flow-review'
import { methodText } from './flow-method'
import { viewText } from './flow-pack'
import { activeView, blockFlow, dropView, mutateSession, pluginRoots, realOf, session, type FlowHost } from './flow-host'
import { updateRecord, type Approval, type FlowRecord, type UpdateResult } from './flow-state'
import { issueTicket, lostReissue } from './flow-ticket'
import { writeView } from './flow-setup'
import { flowCard } from './flow-turn'
import { stackOf } from './stacks/index'

export const PLAN_FILE = 'docs/flow/plan.md'
export const BOUNDARY_P2 = '.snagon/flow/boundary-P2.md'
// Agent-facing (English): a registered command starts no turn (spike 6), so main is asked to act.
const START_PROMPT = 'flow: a ticket is ready. Call flow_status and start the agent exactly as it says.'
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }

/** Lint issues in English for the planner, with the line when the lint has one. */
const issueText = (i: LintIssue): string => `${i.line > 0 ? `line ${i.line}: ` : ''}${fill('en', `lint.${i.code}`, { detail: i.detail })}`

export async function lintNow(h: FlowHost, r: FlowRecord): Promise<{ text: string; lint: Awaited<ReturnType<typeof lintPlan>> }> {
  const text = await h.io.read(`${r.root}/${PLAN_FILE}`).catch(() => '')
  const roots = await pluginRoots(h)
  const kind = async (rel: string) => (await h.stat(`${r.root}/${rel}`))?.kind ?? null
  return { text, lint: await lintPlan(text, { root: r.root, kind, pluginRoots: roots, testGlobs: stackOf(r).data.testFiles, resolve: abs => realOf(h, abs) }) }
}

/** A P1 ticket: one plan edit round, unless the plan's edit cap is used: then the lint issues block the flow, or, when
 * there are none (the owner rejected clean plans), the used-up rounds do (owner decision 2026-10-20: a lint block with
 * nothing in it misled the owner, S7 run 1). True when the ticket went out. */
async function planTicket(h: FlowHost, r: FlowRecord, intent: string, issues: readonly LintIssue[]): Promise<boolean> {
  const used = r.counters.plan ?? { e: 0, r: 0, d: 0, retried: false }
  const cap = (r.setup?.caps.plan ?? CAPS.plan).e + (used.retried ? RETRY.plan.e : 0)
  const free = lostReissue(r, 'plan', 'e'), first = issues[0]
  if (!free && used.e >= cap) {
    await blockFlow(h, r.flowId, first ? { reason: 'planLint', vars: { count: String(issues.length), first: issueText(first) } } : { reason: 'cap', vars: { scope: 'plan', kind: 'edit' } })
    return false
  }
  const method = await methodText(h.io, 'planner')
  const id = await issueTicket(h, r, {
    role: 'planner', f: 'plan',
    build: nonce => planTicketText({ f: 'plan', nonce, pluginProject: r.setup?.pluginProject ?? false, intent, issues: issues.map(issueText), method, exampleFiles: stackOf(r).data.exampleFiles, planRule: stackOf(r).data.planRule }),
    also: x => { const { awaiting: _a, ...rest } = x; return { ...rest, phase: 'plan', task: 'P1', counters: free ? x.counters : { ...x.counters, plan: { ...used, e: used.e + 1 } } } },
  })
  if (id === null) throw new Error('flow: the planner ticket is over the ticket cap')
  await h.submit(START_PROMPT)
  return true
}

/** The plan echo (§2.5): the plan file as the owner reads it, bound to its lint hash. */
type Lint = Awaited<ReturnType<typeof lintPlan>>
const planEcho = (h: FlowHost, text: string, lint: Lint): EchoContent => ({
  kind: 'plan', title: fill(h.language, 'echo.plan', { address: h.address }), lines: viewText(text.replace(/\n+$/, '')).text.split('\n'), fields: { lint: lint.hash }, files: { [PLAN_FILE]: lint.hash },
})

/** /flow-plan: at P1 what to build starts the planner; at P3 the plan echo is shown; anywhere else the card. */
export async function planCommand(h: FlowHost, intent: string | undefined, origin: Origin): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  const r = view.record
  if (r.task === 'P3' && r.awaiting === '/flow-plan') return showPlan(h, r, origin)
  if (r.task !== 'P1' || r.awaiting !== '/flow-plan') return (await flowCard(h)) ?? ''
  if (!intent) return fill(h.language, 'plan.intent', {})
  await mutateSession(h, s => ({ ...s, intent }))
  // past the plan's edit cap no planner starts: the owner gets the card with the block (code review of the plan-cap fix)
  return (await planTicket(h, r, intent, [])) ? fill(h.language, 'plan.started', {}) : (await flowCard(h)) ?? ''
}

async function showPlan(h: FlowHost, r: FlowRecord, origin: Origin): Promise<string> {
  const { text, lint } = await lintNow(h, r)
  if (lint.issues.length) return refusalText(h.language, h.address, 'hash', 'plan')
  const echo = await makeEcho(planEcho(h, text, lint))
  const s = await mutateSession(h, x => ({ ...x, pending: { ...x.pending, plan: echo }, shown: 'plan' }))
  return (await showEcho(h, s?.pending ?? {}, echo, origin)).shown ? fill(h.language, 'echo.shown', { address: h.address }) : fill(h.language, 'blocked.noSurface', {})
}

/** flow_check at P1, after the planner's run: unattested, ask again; P2 lint; issues back to the planner; else wait for
 * the owner at P3 with the boundary view written. */
export async function planCheck(h: FlowHost, r: FlowRecord): Promise<void> {
  const t = [...r.tickets].reverse().find(x => x.f === 'plan')
  if (!t?.used) return
  const s = (await session(h)).value, intent = s.intent ?? '(not held by this session: keep the scope of the plan as it is)'
  if (!t.attested) { await planTicket(h, r, intent, []); return }
  const { text, lint } = await lintNow(h, r)
  if (lint.issues.length) { await planTicket(h, r, intent, lint.issues); return }
  const echo = planEcho(h, text, lint)
  await writeView(h, BOUNDARY_P2, [echo.title, ...echo.lines].join('\n'))
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, ...pointerFields(afterPass({ phase: 'plan', task: 'P2' }, { features: [], baselineRed: false })) })))
}

/** The plan echo rebuilt from the file as it is now (it must still lint clean): its hash, or undefined. */
export async function planHash(h: FlowHost): Promise<string | undefined> {
  const view = await activeView(h)
  if (view.mode !== 'on' || view.record.task !== 'P3') return undefined
  const { text, lint } = await lintNow(h, view.record)
  return lint.issues.length ? undefined : (await makeEcho(planEcho(h, text, lint))).hash
}

/** P3: the plan frozen (its hash and the acceptance criteria), the features with their keys and files, the counters
 * carried over, the rubrics and the routing; then B1 of the first feature waits for /flow-build. */
export async function applyPlan(h: FlowHost, a: Approval): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  const r = view.record, { lint } = await lintNow(h, r)
  if (lint.issues.length) return refusalText(h.language, h.address, 'hash', 'plan')
  const features = lint.plan.features.map(f => ({ id: f.id, key: featureKey(f), files: f.files.map(x => x.path) }))
  const rubrics = await Promise.all(RUBRICS.map(freezeRubric))
  // the routing frozen whole: the core's agents and the stack's own (its data's `routing`)
  const routing = hashOf(canonical({ ...ROUTING, stack: stackOf(r).data.routing }))
  const frozen = { plan: lint.hash, acceptance: hashOf(canonical(lint.plan.acs)), routing, ...Object.fromEntries(rubrics.map(x => [`rubric:${x.id}`, x.hash])) }
  const next = pointerFields(afterPass({ phase: 'plan', task: 'P3' }, { features: features.map(f => f.id), baselineRed: false }))
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => {
    const kept = Object.fromEntries(Object.entries(x.counters).filter(([k]) => !k.startsWith('fk-')))
    const { redAllow: _a, ...rest } = x // a new plan starts with no /flow-allow red left over
    return { ...rest, ...next, features, counters: { ...kept, ...carryCounters(x.counters, lint.plan.features).counters }, frozen: { ...x.frozen, ...frozen }, approvals: [...x.approvals, a] }
  }))
  return fill(h.language, 'plan.approved', { count: features.length })
}

/** /flow-reject plan: back to P1, waiting for what to build; the plan echo is dropped. */
export async function rejectPlan(h: FlowHost): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  settled(await updateRecord(h.io, h.home, view.record.flowId, h.sessionId, x => {
    const { blocked: _b, feature: _f, ...rest } = x
    return { ...rest, phase: 'plan', task: 'P1', awaiting: '/flow-plan' }
  }))
  await mutateSession(h, s => ({ ...s, pending: dropEcho(s.pending, 'plan'), shown: s.shown === 'plan' ? null : s.shown, intent: null }))
  return fill(h.language, 'plan.rejected', {})
}
