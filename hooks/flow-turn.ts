// Where the flow stands for this session (plan v7.1 §3, §3.2, §6, F37): what the card shows the owner and the model with
// every prompt, the one ordered Stop block, and what flow_status tells main to do next. Outside flow none of them speaks.
import type { FlowSession } from '../types'
import { CAPS, RETRY, TASKS } from '../flow/data/phases'
import { fill } from '../flow/data/templates'
import { dispatchType } from '../flow/data/routing'
import type { CapScope, Caps } from '../flow/data/types'
import { card, claims, exitsFor, stopBlock, type Cost } from './flow'
import { flowTree, gitPaths } from './flow-git'
import { newNonce } from './flow-review'
import { activeView, blockFlow, holderOf, mutateSession, session, type FlowHost } from './flow-host'
import { CLOSED, lockStatus, type FlowRecord } from './flow-state'
import { PROBE_COMMAND } from './flow-sandbox'
import { costOf } from './flow-spend'
import { runningTickets } from './flow-ticket'

/** The machine tools main calls while flow is active (§4.6). */
export const FLOW_TOOL_SPECS = [
  { name: 'flow_check', description: 'flow: run the check the active flow waits for (the baseline, a judge run, the gate) and say what comes next. Call it when flow_status says so.', inputSchema: { type: 'object', properties: {} } },
  { name: 'flow_status', description: 'flow: what to do next in the active flow: a ticket to start, a check to run, or the owner command to wait for. Call it whenever flow is active and the next step is not certain.', inputSchema: { type: 'object', properties: {} } },
]

type Where = { kind: 'blocked'; reason: string; vars: Record<string, string> } | { kind: 'owner'; command: string } | { kind: 'ticket'; id: string; type: string }
  | { kind: 'main'; step: 'write' | 'probe' } | { kind: 'check' } | { kind: 'running'; id: string; type: string }
/** §2.4 lock first (another session's flow is view-only here; ours moved to another folder or branch reads the same, and
 * any owner command here takes it, GAP-step10-5), then the blocked reason, the owner command awaited, an issued ticket,
 * else a check. */
export async function whereNow(h: FlowHost, r: FlowRecord, s: FlowSession): Promise<Where> {
  const lock = lockStatus(r, await holderOf(h), await h.io.now())
  if (lock === 'other' || lock === 'moved') return { kind: 'blocked', reason: 'viewOnly', vars: {} }
  if (r.blocked) return { kind: 'blocked', reason: r.blocked.reason, vars: r.blocked.vars }
  if (r.awaiting) return { kind: 'owner', command: r.awaiting }
  // §2.2: the approved settings written (S2b), then the probe, in setup and at the start of every later session.
  if (r.frozen.post !== undefined && r.frozen.sandbox === undefined) return { kind: 'main', step: s.s2b ? 'write' : 'probe' }
  if (r.frozen.sandbox !== undefined && s.sandbox !== 'on') return { kind: 'main', step: 'probe' }
  // D4: a ticket's agent runs in the background; nothing is started or checked until its turn ends (afterAgentTurn)
  const live = runningTickets(r, s)[0]
  if (live) return { kind: 'running', id: live.id, type: dispatchType(live.routedType) }
  const t = r.tickets.find(x => !x.used && s.tickets[x.id] !== undefined)
  return t ? { kind: 'ticket', id: t.id, type: dispatchType(t.routedType) } : { kind: 'check' }
}

/** The cap scope of the pointer and its counters key: a feature's key in build, `verify` in verify and ship, else `plan`. */
function scopeOf(r: FlowRecord): { scope: CapScope; key: string } {
  if (r.phase === 'build') return { scope: 'feature', key: r.features?.find(f => f.id === r.feature)?.key ?? r.feature ?? 'feature' }
  return r.phase === 'verify' || r.phase === 'ship' ? { scope: 'verify', key: 'verify' } : { scope: 'plan', key: 'plan' }
}
function capsOf(r: FlowRecord): { used: Caps; caps: Caps } {
  const { scope, key } = scopeOf(r), used = r.counters[key] ?? { e: 0, r: 0, d: 0, retried: false }
  const base = r.setup?.caps[scope] ?? CAPS[scope], plus = used.retried ? RETRY[scope] : { e: 0, r: 0, d: 0 }
  return { used, caps: { e: base.e + plus.e, r: base.r + plus.r, d: base.d + plus.d } }
}
const openIds = (r: FlowRecord): string[] => r.findings.filter(x => !CLOSED.has(x.status)).map(x => x.id)

/** §6 card for prompt.submit's context: null outside flow; one line when the flow state cannot be read. */
export async function flowCard(h: FlowHost): Promise<string | null> {
  const view = await activeView(h)
  if (view.mode === 'off') return null
  const lang = h.language, address = h.address
  if (view.mode === 'unknown') return fill(lang, 'status.unknown', { why: view.why })
  const r = view.record, s = (await session(h)).value, where = await whereNow(h, r, s), cost = await costOf(h, r)
  const next = where.kind === 'owner' ? { step: fill(lang, 'next.owner', { address }), command: where.command }
    : where.kind === 'ticket' ? { step: fill(lang, 'next.ticket', { type: where.type }), command: `TICKET ${where.id}` }
    : where.kind === 'running' ? { step: fill(lang, 'next.running', { id: where.id, type: where.type }), command: 'flow_check' }
    : where.kind === 'main' ? { step: fill(lang, where.step === 'write' ? 'next.s2b' : 'next.probe', {}), command: where.step === 'write' ? 'Write' : 'Bash' }
    : { step: fill(lang, 'next.check', {}), command: 'flow_check' }
  if (s.notes.length) await mutateSession(h, x => ({ ...x, notes: [] })) // shown once
  return [...card({
    lang, address, pointer: { phase: r.phase, task: r.task, ...(r.feature ? { feature: r.feature } : {}) }, ...capsOf(r), open: openIds(r),
    ...(where.kind === 'blocked' ? { blocked: { reason: where.reason, vars: where.vars } } : {}), ...(s.claim ? { claim: s.claim } : {}),
    sandbox: fill(lang, `sandbox.${s.sandbox ?? 'unchecked'}`, {}), runnerAbsent: (r.frozen['runner:v2'] ?? r.frozen.runner) === 'absent', rebased: Object.keys(r.frozen).filter(k => k.startsWith('rebase:')).map(k => k.slice(7)).sort(), reverified: Object.fromEntries(Object.entries(r.frozen).filter(([k]) => k.startsWith('reverify:')).map(([k, v]) => [k.slice(9), v])), cost, next,
  }), ...s.notes].join('\n')
}

/** R6's judge for the pointer: none in setup and plan; the feature's last judge run in build, the last V run after it. A
 * green run counts only for the tree it judged, computed only when the reply claims done (§5.4); a tree that cannot be
 * computed is stale. */
async function judgeOf(h: FlowHost, r: FlowRecord, message: string): Promise<'green' | 'none' | 'red' | 'missing' | 'stale'> {
  if (r.phase === 'setup' || r.phase === 'plan') return 'none'
  const j = r.judge && (r.phase === 'build' ? r.judge.f === r.feature : r.judge.task.startsWith('V')) ? r.judge : undefined
  if (!j) return 'missing'
  if (!j.green) return 'red'
  if (!claims(message)) return 'green'
  try { return (await flowTree(h.io, await gitPaths(h.io, r.root), 'worktree', newNonce())) === j.tree ? 'green' : 'stale' } catch { return 'stale' }
}
/** D13: how many times the Stop hook pushes main back to start the same ticket before the flow blocks for the owner
 * (dry run 16: main refused a ticket about 19 times, at about $0.1 a turn; nothing else ends such a loop). */
export const STALL_LIMIT = 3
/** The prompt that tells main a ticket was issued: an owner command's ticket needs it (main is idle); a ticket flow_check
 * issues is named in flow_check's own result and gets none. */
export const TICKET_PROMPT = 'flow: a ticket is ready'
/** Whether an issued ticket still waits for main to start it, as whereNow sees it: unused, its text in this session. */
export async function ticketWaiting(h: FlowHost): Promise<boolean> {
  const view = await activeView(h), s = (await session(h)).value
  return view.mode === 'on' && view.record.tickets.some(t => !t.used && s.tickets[t.id] !== undefined)
}
/** D13: the owner's own prompt starts the push count again: a main that stopped to ask the owner was not refusing. */
export async function ownerSpoke(h: FlowHost): Promise<void> {
  if (Object.keys((await session(h)).value.nudges).length) await mutateSession(h, s => ({ ...s, nudges: {} }))
}
/** D13: one more push back to the unstarted ticket `id`, or 'stalled' past the limit: the flow blocks for the owner
 * (the ticket stays issued; /flow-retry check offers it again), and this Stop carries no pressure. */
async function nudge(h: FlowHost, r: FlowRecord, s: FlowSession, id: string): Promise<'pushed' | 'stalled'> {
  const n = (s.nudges[id] ?? 0) + 1
  if (n > STALL_LIMIT) {
    await blockFlow(h, r.flowId, { reason: 'stalled', vars: { id, n: String(STALL_LIMIT) } })
    await mutateSession(h, x => ({ ...x, nudges: { ...x.nudges, [id]: 0 } }))
    return 'stalled'
  }
  await mutateSession(h, x => ({ ...x, nudges: { ...x.nudges, [id]: n } }))
  return 'pushed'
}
export type StopIn = { message: string; stopHookActive: boolean; journal?: string }
/** §6 Stop: null outside flow (the journal reminder stands alone, as today); in flow, stopBlock's one ordered block. A
 * repeated claim goes on the card and into the journal. */
export async function flowStop(h: FlowHost, i: StopIn): Promise<{ block?: string } | null> {
  const view = await activeView(h)
  if (view.mode !== 'on') return null
  const r = view.record, s = (await session(h)).value, where = await whereNow(h, r, s)
  const judge = await judgeOf(h, r, i.message)
  const running = where.kind === 'check' || where.kind === 'ticket' || where.kind === 'main'
  const task = TASKS.find(t => t.id === r.task)
  const pressure = running ? `${[r.task, r.feature].filter(Boolean).join(' ')} (${task?.title ?? r.task}); call flow_status for the next step` : undefined
  // D13: a push back to the same unstarted ticket counts, inside stop_hook_active too: the Stop after a push always is,
  // and a main that will not start its ticket gets no other wake-up (no agent runs, so no completion notice comes), so
  // counting only the first left the flow hanging at one push with nothing blocked (live runs 2026-10-20). Past the
  // limit the flow blocks for the owner and this Stop pushes no more, so a main that will not start its ticket cannot
  // loop for good; what else the Stop carries (a done claim, floor hits, the journal reminder) still goes through
  // stopBlock as on any Stop
  const push = where.kind === 'ticket' && pressure !== undefined ? await nudge(h, r, s, where.id) : 'none'
  const hits = r.findings.filter(x => /^(FL|J)-\d+$/.test(x.id) && !CLOSED.has(x.status)).map(x => x.id)
  const out = await stopBlock({ message: i.message, judge, claimHeld: s.claimHeld, hits, stopHookActive: i.stopHookActive, ...(pressure && push !== 'stalled' ? { pressure } : {}), ...(push === 'pushed' ? { ticketPush: true } : {}), ...(i.journal ? { journal: i.journal } : {}) })
  const claim = judge === 'green' || judge === 'none' ? null : out.claimRepeat ? judge : s.claim
  await mutateSession(h, x => ({ ...x, claimHeld: out.claimHeld, claim }))
  if (out.claimRepeat && judge !== 'green' && judge !== 'none') await h.journal(fill(h.language, 'journal.claim', { state: fill(h.language, `judge.${judge}`, {}) }))
  return out.block ? { block: out.block } : {}
}

/** §4.6 flow_status for main: what to do next, never ticket text or anything the pane alone shows. */
export async function flowStatus(h: FlowHost): Promise<string> {
  const view = await activeView(h)
  if (view.mode === 'off') return JSON.stringify({ next: 'No flow is active in this repository; the project owner starts one with /flow-setup.' })
  if (view.mode === 'unknown') return JSON.stringify({ next: `The flow state cannot be read (${view.why}); only reading is allowed. Stop and tell the project owner.` })
  const where = await whereNow(h, view.record, (await session(h)).value)
  if (where.kind === 'blocked') return JSON.stringify({ next: `Blocked, NOT done: ${where.reason}. Stop and tell the project owner, who chooses: ${exitsFor(where.reason, where.vars).join(' · ')}` })
  if (where.kind === 'owner') return JSON.stringify({ next: `Waiting for the project owner to type ${where.command}. Stop and tell them.` })
  if (where.kind === 'ticket') return JSON.stringify({ next: 'Start the agent with exactly this prompt and subagent_type, nothing else. It runs in the background: when its completion notice arrives, call flow_check.', ticket: `TICKET ${where.id}`, routedType: where.type })
  if (where.kind === 'running') return JSON.stringify({ next: `Ticket ${where.id} runs in the background as ${where.type}. Wait for its completion notice, then call flow_check. Do not start it again.` })
  const s2b = (await session(h)).value.s2b
  if (where.kind === 'main' && where.step === 'write' && s2b) return JSON.stringify({ next: `Call Write once with file_path ${s2b.path} and exactly this content (it ends with one newline), then nothing else on that file:\n${s2b.post}` })
  if (where.kind === 'main') return JSON.stringify({ next: `Run exactly this Bash command once, as it is (a refusal is the expected result): ${PROBE_COMMAND}` })
  return JSON.stringify({ next: 'Call flow_check.' })
}
