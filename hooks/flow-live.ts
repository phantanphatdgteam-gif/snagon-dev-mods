// Live flow guards (plan v7.1 §2.3, F40): the tool.check verdict for a call, with its working directory and the permission
// mode its loop last reported; the tool.call rewrite before the tool runs (stripCall) and the checks after it answered
// (recheck for the Edit family, recheckRead for reads): a change during the call withholds the result and blocks the flow
// as tampered. The S2b window closes atomically on the first call that names the settings file. Outside flow nothing acts.
import { checkCall, guardUnknown, placeEdit, recheck, recheckRead, stripCall, type Placed } from './flow-guard'
import { activeView, blockFlow, guardCtx, mutateSession, placeCtx, readCtx, session, type FlowHost } from './flow-host'
import { afterSetupCall } from './flow-freeze'
import { afterAgentCall, noteAgentTool } from './flow-ticket'
import { onReply } from './flow-reviewing'
import { PLAN_FILE } from './flow-planning'
import { PROBE_COMMAND } from './flow-sandbox'
import type { FlowRecord } from './flow-state'
import type { FlowSession } from '../types'

// On 2.1.301 classic.PreToolUse carries only the tool call; the mode comes from the classic events that carry
// `permission_mode` (UserPromptSubmit, PostToolUse, SessionStart, Stop), per loop. A subagent inherits its parent's mode
// until it reports its own.
let mainMode: string | undefined
const agentModes = new Map<string, string>()
const MODES_KEPT = 256
export function noteMode(agentId: string | undefined, mode: unknown): void {
  if (typeof mode !== 'string' || !mode) return
  if (agentId === undefined) { mainMode = mode; return }
  agentModes.delete(agentId)
  agentModes.set(agentId, mode)
  if (agentModes.size > MODES_KEPT) agentModes.delete(agentModes.keys().next().value ?? '')
}
const modeFor = (agentId: string | undefined): string | undefined => (agentId !== undefined ? agentModes.get(agentId) : undefined) ?? mainMode
/** Tests: forget every reported mode. */
export function forgetModes(): void { mainMode = undefined; agentModes.clear() }

const EDIT_PATH: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const READS = new Set(['Read', 'Grep', 'Glob', 'LSP'])
const NO_MODE = 'the permission mode was not reported yet (the classic hooks did not run)'
const USED = 'flow: the one settings Write was already used; the owner runs /flow-setup again'

export type CheckIn = { tool: string; input: unknown; agentId?: string }
const inputOf = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {})
const PROBE_FIRST = "flow: until this session's sandbox probe passed, Bash runs nothing but main's probe command (flow_status shows it)"
/** A call from the agent of a ticket already settled (attested, judged, or given up past its deadline) is refused, so a
 * run that outlived its ticket cannot edit beside the ticket's next run (security review of step 13, SEC13R2-3). */
function settledTicket(r: FlowRecord, s: FlowSession, agentId: string | undefined): string | null {
  if (agentId === undefined) return null
  const t = r.tickets.find(x => x.agentId === agentId)
  return t && (t.attested || s.runs[t.id] !== undefined) ? `flow: ticket ${t.id} is settled; this run is over` : null
}
/** The planner ticket's agent (it has Write and Edit since step 13) writes the plan file and nothing else: any other
 * path, spelling or tool of the Edit family is refused (security review of step 13, SEC13-2). An agent the record does
 * not name yet (its launch is still being recorded) is held to the ticket in flight (SEC13R2-2). */
function plannerScope(r: FlowRecord, s: FlowSession, e: CheckIn): string | null {
  const key = EDIT_PATH[e.tool]
  if (!key || e.agentId === undefined) return null
  // an agent the record does not name is held to a planner ticket in flight (used, started, not yet named, not
  // settled), whichever session issued it; a stale ticket of another kind cannot stand in for it (SEC13R3-3)
  const inFlight = r.tickets.filter(x => x.used && x.toolUseId !== undefined && x.agentId === undefined && !x.attested && s.runs[x.id] === undefined)
  const t = r.tickets.find(x => x.agentId === e.agentId) ?? inFlight.find(x => x.f === 'plan')
  if (!t || t.f !== 'plan') return null
  const p = inputOf(e.input)[key]
  return p === `${r.root}/${PLAN_FILE}` || p === PLAN_FILE ? null : `flow: the planner writes ${PLAN_FILE} and nothing else`
}
/** tool.check: null leaves the call to the engine (always, when no flow is active); a string is the denial. */
export async function checkVerdict(h: FlowHost, e: CheckIn): Promise<string | null> {
  const view = await activeView(h)
  if (view.mode === 'off') return null
  const s = (await session(h)).value
  // until this session's probe passed, Bash runs nothing but main's probe, from any agent: a Bash the sandbox does not
  // wrap could otherwise plant a shell startup file that fakes the probe's answer (security review of step 13,
  // SEC13R2-1 and SEC13R3-1; GAP-step13-11)
  if (e.tool === 'Bash' && s.sandbox !== 'on' && !(e.agentId === undefined && inputOf(e.input).command === PROBE_COMMAND)) return PROBE_FIRST
  const mode = modeFor(e.agentId), cwd = await h.cwd()
  const call = { tool: e.tool, input: e.input, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }
  if (view.mode === 'unknown' || mode === undefined) {
    const v = await guardUnknown(call, await readCtx(h, { cwd }), view.mode === 'unknown' ? view.why : NO_MODE)
    return v.decision === 'deny' ? v.reason : null
  }
  const over = settledTicket(view.record, s, e.agentId)
  if (over) return over
  const scope = plannerScope(view.record, s, e)
  if (scope) return scope
  const v = await checkCall(call, await guardCtx(h, view.record, { cwd, mode }, s))
  // §2.2: the window closes after the first call naming the file, allowed or not; of two at once only the closer passes.
  if (v.closeS2b && !(await mutateSession(h, s => (s.s2b ? { ...s, s2b: null } : null)))) return v.decision === 'deny' ? v.reason : USED
  return v.decision === 'deny' ? v.reason : null
}

export type Live = { e: Record<string, unknown>; after(out: unknown): Promise<string | null> }
const answered = (out: unknown): boolean => typeof out === 'object' && out !== null && (out as { deny?: unknown }).deny === undefined && (out as { isError?: unknown }).isError !== true
const NOTHING = async (): Promise<null> => null
/** tool.call: the call as it goes on (the sandbox switch off), and `after`, which checks a call the tool answered: a reason
 * withholds the result (the caller returns it as a deny) and, with a record, blocks the flow as tampered. */
export async function liveCall(h: FlowHost, e: Record<string, unknown>): Promise<Live> {
  const view = await activeView(h)
  if (view.mode === 'off') return { e, after: NOTHING }
  const tool = String(e.tool), record = view.mode === 'on' ? view.record : undefined
  const place = record ? await placeCtx(h, record) : undefined
  const key = EDIT_PATH[tool]
  // Placed before the call, so the check after it sees a move; a path that cannot be placed is denied by tool.check.
  const placed = place && key ? await placeEdit(e[key], place) : null
  const before: Placed | null = placed !== null && typeof placed === 'object' ? placed : null
  return {
    e: stripCall(e),
    async after(out) {
      const reason = !answered(out) ? null
        : before && place ? await recheck(before, place, tool === 'Write' && typeof e.content === 'string' ? e.content : undefined)
        : READS.has(tool) ? await recheckRead({ tool, input: e }, await readCtx(h, { cwd: await h.cwd() }))
        : null
      if (reason && record) await blockFlow(h, record.flowId, { reason: 'tampered', vars: { file: reason } })
      // S2b and the sandbox probe move on from what the call did (a failed probe is an error result).
      if (!reason && record) await afterSetupCall(h, record, tool, e, out)
      const done = !reason && record && tool === 'Agent' ? await afterAgentCall(h, e, out) : null
      if (done) await onReply(h, done.t, done.text)
      // a subagent's first calls, for the attestation of its ticket (plugin-authoring first, §4.6)
      if (record && typeof e.agentId === 'string') noteAgentTool(e.agentId, tool, tool === 'Skill' && typeof e.skill === 'string' ? e.skill : undefined, answered(out))
      return reason
    },
  }
}
