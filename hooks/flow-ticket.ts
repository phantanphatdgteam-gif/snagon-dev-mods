// Tickets (plan v7.1 §4.6, F35): the mod writes every agent prompt flow needs; the record keeps its hash, nonce, routed
// type and tree, and this session alone its text. main starts one with exactly `TICKET <id>`: the spawn hook claims the
// ticket and rewrites the spawn to the held text, the routed type and model, in the foreground at the root. When the
// Agent call answers, the run is attested at once (completed, the nonce line last, the tree unchanged for review
// tickets, plugin-authoring loaded first in a plugin project); only the verdict is kept, never the reply.
import { ROUTING, routedAgent } from '../flow/data/routing'
import { fill } from '../flow/data/templates'
import type { Routing } from '../flow/data/types'
import type { FlowSession } from '../types'
import { flowTree, gitPaths } from './flow-git'
import { attest, newNonce, sha256, spawnDecision, TREE_CHANGERS, type AgentRun, type SpawnOut } from './flow-review'
import { activeView, dropView, mutateSession, session, type FlowHost } from './flow-host'
import { updateRecord, type FlowRecord, type TicketKind, type TicketRecord, type UpdateResult } from './flow-state'

export type SpawnEvent = {
  tool_use_id: string; prompt: string; description?: string; subagentType: string; model?: string; fork?: boolean; isTeammate?: true
  name?: string; workflow?: unknown; parentAgentId?: string; isolation?: unknown; resume?: unknown; cwd?: string
}
export type Issue = { role: keyof Routing['agents']; f: string; kind?: TicketKind; typescriptShare?: number; build: (nonce: string) => string | null; also?: (r: FlowRecord) => FlowRecord }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const nextId = (r: FlowRecord): string => `T-${Math.max(0, ...r.tickets.map(t => Number(/^T-(\d+)$/.exec(t.id)?.[1] ?? 0))) + 1}`

/** Issues a ticket built with a fresh nonce (`also` changes the record in the same write); null when it is over the cap. */
export async function issueTicket(h: FlowHost, r: FlowRecord, i: Issue): Promise<string | null> {
  const nonce = newNonce(), text = i.build(nonce)
  if (text === null) return null
  const sha = await sha256(text), tree = await flowTree(h.io, await gitPaths(h.io, r.root), 'worktree', newNonce())
  let id = ''
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => {
    id = nextId(x)
    const t = { id, f: i.f, sha, nonce, tree, routedType: routedAgent(i.role, i.typescriptShare ?? 0), model: ROUTING.agents[i.role].model, used: false, ...(i.kind ? { kind: i.kind } : {}) }
    return (i.also ?? (y => y))({ ...x, tickets: [...x.tickets, t] })
  }))
  await mutateSession(h, s => ({ ...s, tickets: { ...s.tickets, [id]: text } }))
  return id
}

/** agent.spawn: null outside flow (the spawn goes on as asked). A rewrite claims its ticket first, so a second spawn of
 * the same ticket, even at once, is refused. */
export async function spawnHook(h: FlowHost, e: SpawnEvent): Promise<SpawnOut | null> {
  const view = await activeView(h)
  if (view.mode === 'off') return null
  if (view.mode === 'unknown') return { deny: `flow: the flow state cannot be read (${view.why}); no agent starts` }
  const s = (await session(h)).value, r = view.record
  // no agent before this session's sandbox probe passed, free spawns included: a subagent's Bash would run where the
  // sandbox is not confirmed (security review of step 13, SEC13R3-1)
  if (s.sandbox !== 'on') return { deny: "flow: no agent starts until this session's sandbox probe passed; run the probe first (flow_status shows it)" }
  const d = await spawnDecision(
    { prompt: e.prompt, subagentType: e.subagentType, fork: e.fork === true, isTeammate: e.isTeammate, name: e.name, workflow: e.workflow, parentAgentId: e.parentAgentId, isolation: e.isolation, resume: e.resume, cwd: e.cwd, ...(e.model ? { model: e.model } : {}) },
    { tickets: r.tickets, textOf: id => s.tickets[id], root: r.root, freeSpawn: ROUTING.freeSpawn },
  )
  if (!('ticketId' in d)) return d
  let taken = false
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, tickets: x.tickets.map(t => (t.id === d.ticketId && !t.used ? ((taken = true), { ...t, used: true, toolUseId: e.tool_use_id }) : t)) })))
  if (!taken) return { deny: `flow: ticket ${d.ticketId} was not issued or is already used` }
  // plan line 223: the text leaves $.state once the ticket is used (the rewrite above already holds it)
  await mutateSession(h, x => { const { [d.ticketId]: _t, ...tickets } = x.tickets; return { ...x, tickets } })
  return d
}

/** After a restart an unused ticket's text is gone ($.state is the session's). It is closed as lost: used with no
 * toolUseId, so no run can be attested for it. The step then issues it again as for a run that did not report back, and
 * that re-issue takes no round (plan line 223; lostReissue). True when one was found. */
export async function recoverLost(h: FlowHost, r: FlowRecord): Promise<boolean> {
  const s = (await session(h)).value, lost = new Set(r.tickets.filter(t => !t.used && s.tickets[t.id] === undefined).map(t => t.id))
  if (!lost.size) return false
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, tickets: x.tickets.map(t => (lost.has(t.id) && !t.used ? { ...t, used: true } : t)) })))
  return true
}
/** The round a kind's ticket takes; a review or delta ticket is re-issued without one. */
const ROUND_OF: Readonly<Record<string, 'e' | 'd'>> = { planner: 'e', red: 'e', author: 'e', fix: 'e', debug: 'd' }
/** Whether the newest ticket of `f` was lost in a restart (used, never started) and took the round `kind`: its re-issue
 * is then free. */
export function lostReissue(r: FlowRecord, f: string, kind: 'e' | 'r' | 'd'): boolean {
  const t = [...r.tickets].reverse().find(x => x.f === f)
  return t !== undefined && t.used && t.toolUseId === undefined && ROUND_OF[t.kind ?? 'planner'] === kind
}
/** After the engine started the agent: its id, which the attestation checks. */
export async function noteSpawned(h: FlowHost, ticketId: string, toolUseId: string, agentId: string | undefined): Promise<void> {
  const view = await activeView(h)
  if (view.mode !== 'on' || agentId === undefined) return
  const at = await h.io.now()
  startedAgents.set(ticketId, agentId)
  startedAt.set(ticketId, at)
  settled(await updateRecord(h.io, h.home, view.record.flowId, h.sessionId, x => ({ ...x, tickets: x.tickets.map(t => (t.id === ticketId && t.toolUseId === toolUseId ? { ...t, agentId } : t)) })))
  // this session started it, and when: its turn end comes here (D4) and its silence has a deadline (settleRunning); a
  // restarted session has no such entry
  await mutateSession(h, s => ({ ...s, started: { ...s.started, [ticketId]: agentId }, startedAt: { ...s.startedAt, [ticketId]: at } }))
}

type AgentEvent = { agentId: string; tool: string; skill?: string; ok: boolean }
const events = new Map<string, AgentEvent[]>()
const EVENTS_PER_AGENT = 8, AGENTS_KEPT = 64
/** The tickets this session started (id to agent id), module memory beside the session's `started`: a spawn is known
 * here at once, whatever the session store does under concurrent writes (dry run of step 13, run 11). */
const startedAgents = new Map<string, string>()
/** When each ticket's agent was started (ms), for the deadline: module memory beside the session's `startedAt`; a ticket
 * known from neither (a reload, a lost write) gets its clock started at the first look (S13-6). */
const startedAt = new Map<string, number>()
/** Tests: a fresh world forgets the agents of the one before (their ids repeat). */
export function forgetAgents(): void { events.clear(); endedAgents.clear(); startedAgents.clear(); startedAt.clear() }
/** A subagent's tool call (tool.call after): the first few per agent, which the attestation reads. */
export function noteAgentTool(agentId: string, tool: string, skill: string | undefined, ok: boolean): void {
  const list = events.get(agentId) ?? []
  if (list.length >= EVENTS_PER_AGENT) return
  events.set(agentId, [...list, { agentId, tool, ...(skill ? { skill } : {}), ok }])
  if (events.size > AGENTS_KEPT) events.delete(events.keys().next().value ?? '')
}

/** tool.call after an Agent call that started a ticket: the run attested; the verdict goes to the session. An attested
 * run's ticket and reply come back for parsing (the caller keeps only what it parses, never the reply). */
export async function afterAgentCall(h: FlowHost, e: Record<string, unknown>, out: unknown): Promise<{ t: TicketRecord; text: string } | null> {
  const view = await activeView(h) // after the spawn changed the record: looked up again
  if (view.mode !== 'on' || typeof e.tool_use_id !== 'string') return null
  const r = view.record, t = r.tickets.find(x => x.toolUseId === e.tool_use_id)
  if (!t || t.attested || (await session(h)).value.runs[t.id] !== undefined) return null // judged once (SEC13-4)
  const res = isObj(out) && isObj(out.result) ? out.result : {}
  const text = textOf(isObj(out) ? out.result : undefined)
  if (isLaunch(res, text)) return null // 2.1.302: the run goes on in the background; its answer comes to afterAgentTurn
  const agentId = typeof res.agentId === 'string' ? res.agentId : '', toolUseId = e.tool_use_id
  return whileJudging(h, agentId, () => judged(h, r, t, { toolUseId, status: typeof res.status === 'string' ? res.status : 'error', agentId, text, events: events.get(agentId) ?? [] }))
}
/** The text of a tool result as the engine answers it: a string, content blocks (the Agent tool's launch on 2.1.302 is
 * `[{ type: 'text', text }]`, no record around it), or a record holding either. */
const textOf = (v: unknown): string => typeof v === 'string' ? v
  : Array.isArray(v) ? v.map(c => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('\n')
  : isObj(v) ? textOf(v.content ?? v.text) : ''
/** The Agent tool's answer on 2.1.302 (dry run of step 13, D4): the launch of a background run, not the run's answer. The
 * hook sees `{ isAsync: true, status: 'async_launched', agentId, … }`; the model sees the text "Async agent launched". */
const isLaunch = (res: Record<string, unknown>, text: string): boolean =>
  res.status === 'async_launched' || res.isAsync === true || /^Async agent launched/m.test(text)
/** The agents whose end this session heard (module memory, as `events`): a run that ended is never waited for, even
 * when its verdict could not be kept (then its step asks again). */
const endedAgents = new Set<string>()
/** The agents whose verdict is being written now: flow_check leaves their tickets alone until it is (S13-5). */
const judgingNow = new Set<string>()
/** The end of an agent, heard or taken: module memory and the session, which a reload keeps. */
async function markEnded(h: FlowHost, agentId: string): Promise<void> {
  if (!agentId) return
  endedAgents.add(agentId)
  await mutateSession(h, s => (s.ended[agentId] ? null : { ...s, ended: { ...s.ended, [agentId]: true } }))
}
/** The judging of an agent's run: its end is recorded after it, whatever happened (S13-1), so flow_check can neither
 * wait for the agent again nor settle a run whose verdict is still being written (S13-5). */
async function whileJudging<T>(h: FlowHost, agentId: string, work: () => Promise<T>): Promise<T> {
  judgingNow.add(agentId)
  try { return await work() } finally { judgingNow.delete(agentId); await markEnded(h, agentId) }
}
/** The run attested; the session keeps why one did not attest, and the record marks an attested one together with what
 * its reply produced (onReply), so a reply whose results were not kept never counts. */
async function judged(h: FlowHost, r: FlowRecord, t: TicketRecord, run: AgentRun): Promise<{ t: TicketRecord; text: string } | null> {
  const treeNow = TREE_CHANGERS.has(t.kind ?? '') ? t.tree : await flowTree(h.io, await gitPaths(h.io, r.root), 'worktree', newNonce())
  const v = attest(t, run, { treeNow, pluginProject: r.setup?.pluginProject ?? false })
  await mutateSession(h, s => ({ ...s, runs: { ...s.runs, [t.id]: v.ok ? { ok: true } : { ok: false, reason: v.reason } } }))
  return v.ok ? { t, text: run.text } : null
}

/** turn.complete of a subagent (D4): the ticket started as that agent is attested from the turn's final text, `answer`
 * being the run's completed answer, any other reason a run that did not complete. */
export async function afterAgentTurn(h: FlowHost, agentId: string, answer: string, reason: string): Promise<{ t: TicketRecord; text: string } | null> {
  return whileJudging(h, agentId, async () => {
    const view = await activeView(h)
    if (view.mode !== 'on') return null
    const r = view.record, t = r.tickets.find(x => x.agentId === agentId && x.used && !x.attested)
    if (!t || t.toolUseId === undefined) return null
    if ((await session(h)).value.runs[t.id] !== undefined) return null // judged already (SEC13-4: never twice)
    return judged(h, r, t, { toolUseId: t.toolUseId, status: reason === 'answer' ? 'completed' : reason, agentId, text: answer, events: events.get(agentId) ?? [] })
  })
}

/** The tickets started (toolUseId, agentId) and neither attested nor judged in this session. */
const unsettled = (r: FlowRecord, s: FlowSession): TicketRecord[] =>
  r.tickets.filter(t => t.used && t.toolUseId !== undefined && t.agentId !== undefined && !t.attested && s.runs[t.id] === undefined)
/** The tickets whose agents run now: unsettled, started by this session (whose turn end this session will hear) and
 * not ended yet. The engine's agent list is not asked (dry run of step 13, D6: it did not name a reviewer still running,
 * and the ticket was issued again beside it). */
const startedHere = (t: TicketRecord, s: FlowSession): boolean => s.started[t.id] !== undefined || startedAgents.has(t.id)
const ended = (t: TicketRecord, s: FlowSession): boolean => endedAgents.has(t.agentId ?? '') || s.ended[t.agentId ?? ''] === true
export const runningTickets = (r: FlowRecord, s: FlowSession): TicketRecord[] =>
  unsettled(r, s).filter(t => startedHere(t, s) && !ended(t, s))
/** How long a ticket's agent may run before its silence counts as no answer (an agent that died without a turn end,
 * security review of step 13, SEC13-3): past the judge's own 10-minute limit with room for the reviewers. */
export const RUN_DEADLINE_MS = 20 * 60_000
/** Milliseconds since a ticket's agent started: the session's time, else module memory, else the clock starts now. */
const sinceStart = (t: TicketRecord, s: FlowSession, now: number): number => {
  const at = s.startedAt[t.id] ?? startedAt.get(t.id)
  if (at === undefined) startedAt.set(t.id, now)
  return now - (at ?? now)
}
/** flow_check: an unsettled ticket another session started (a restart), one whose end was heard but whose verdict
 * could not be kept, or one silent past the deadline, can get no answer here: judged as a run that did not report
 * back, so its step issues it again (plan line 223: that takes a round), and the journal says so. A verdict being
 * written now is left to finish (S13-5), and one written meanwhile is never overwritten. */
export async function settleRunning(h: FlowHost, r: FlowRecord): Promise<void> {
  const s = (await session(h)).value, now = await h.io.now()
  const why = (t: TicketRecord): string | null => judgingNow.has(t.agentId ?? '') ? null
    : !startedHere(t, s) ? 'started by an earlier session; its answer never reached this one'
    : ended(t, s) ? 'the run ended but its verdict could not be kept'
    : sinceStart(t, s, now) > RUN_DEADLINE_MS ? 'the run gave no answer within the deadline' : null
  const gone = unsettled(r, s).map(t => ({ t, reason: why(t) })).filter((x): x is { t: TicketRecord; reason: string } => x.reason !== null)
  if (!gone.length) return
  // only the tickets this very write settled get the journal line: a verdict or another flow_check that landed
  // meanwhile is left alone (S13-10, S13-12)
  let wrote: string[] = []
  await mutateSession(h, x => {
    const fresh = gone.filter(g => x.runs[g.t.id] === undefined)
    wrote = fresh.map(g => g.t.id)
    return fresh.length ? { ...x, runs: { ...x.runs, ...Object.fromEntries(fresh.map(g => [g.t.id, { ok: false, reason: g.reason }])) } } : null
  })
  for (const id of wrote) await h.journal(fill(h.language, 'journal.settled', { id }))
}
