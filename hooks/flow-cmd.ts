// Owner commands (plan v7.1 §2.5, §3, F9, F37): the /flow-* commands the owner types (command.run), checked for their
// origin, each taking the flow lock for this session (GAP-step7-4); /flow-approve goes straight to the approval (a release
// attempt spends its code before the origin is checked), and the code never stays on the command line.
import { fill } from '../flow/data/templates'
import { approve, dropEcho, originOk, parseOwner, refusalText, takeCode, type ApproveCmd, type EchoKind, type OwnerCmd, type OwnerName, type Origin } from './flow-owner'
import { activeView, dropView, emptySession, holderOf, mutateSession, session, staticsOf, type FlowHost } from './flow-host'
import { claimLock, listActive, removeRecord, updateRecord, type Approval } from './flow-state'
import { flowCard } from './flow-turn'
import { applySetup, pastedCheck, setupCommand, setupHash } from './flow-freeze'
import { applyBaseline, baselineHash, showBaseline } from './flow-baseline'
import { applyPlan, planCommand, planHash, rejectPlan } from './flow-planning'
import { buildCommand } from './flow-build'
import { applyWaive, decideCommand, retryCommand, waiveCommand, waiveHash } from './flow-decide'
import { verifyCommand } from './flow-verify'
import { applyRelease, releaseHash, shipCommand } from './flow-ship'

export const FLOW_COMMANDS: readonly { name: OwnerName; description: string; argumentHint?: string }[] = [
  { name: 'flow-setup', description: 'flow: start or re-freeze (commands, sandbox, tools); the owner approves what the pane shows', argumentHint: '[test|lint|typecheck|build="<argv>"] [tools=+<Tool>] [mcp=+<name>]' },
  { name: 'flow-plan', description: 'flow: plan the work, or show the linted plan for approval' },
  { name: 'flow-build', description: 'flow: build the approved plan, feature by feature' },
  { name: 'flow-verify', description: 'flow: verify everything before shipping' },
  { name: 'flow-ship', description: 'flow: show the release and its code for approval' },
  { name: 'flow-approve', description: 'flow: approve what the flow pane shows', argumentHint: 'setup|baseline|plan|waive <hash8> · release <hash8> <code>' },
  { name: 'flow-decide', description: 'flow: decide a finding that blocks', argumentHint: '<X-n> fix|reject|followup' },
  { name: 'flow-retry', description: 'flow: one more round for a scope at its cap', argumentHint: 'plan|F-NN|verify|check|cost' },
  { name: 'flow-waive', description: 'flow: waive a red check or a floor or junk finding', argumentHint: 'check:<cmdId>|FL-n|J-n <reason>' },
  { name: 'flow-reject', description: 'flow: reject the plan and plan again', argumentHint: 'plan' },
  { name: 'flow-off', description: 'flow: end the flow', argumentHint: '[<id8>]' },
  { name: 'flow-status', description: 'flow: show where the flow stands' },
]

export type CommandIn = { command: string; args: string; origin: Origin }
/** `args`: what the command line keeps instead of what was typed (the caller passes it on with next). */
export type CommandOut = { text: string; args?: string }
const CODE_WORD = /^[A-Za-z0-9]{6}$/ // a release code; no kind word or hash8 has six characters

/** §2.5: a release code is never left on the command line, which reaches the transcript, the model and the history. */
export function maskedArgs(command: string, args: string): string | undefined {
  if (command !== 'flow-approve') return undefined
  const words = args.trim().split(/\s+/)
  return words.some(w => CODE_WORD.test(w)) ? words.map(w => (CODE_WORD.test(w) ? '******' : w)).join(' ') : undefined
}

export async function ownerCommand(h: FlowHost, e: CommandIn): Promise<CommandOut> {
  const args = maskedArgs(e.command, e.args)
  const text = await answer(h, parseOwner(e.command, e.args), e)
  return args === undefined ? { text } : { text, args }
}

async function answer(h: FlowHost, cmd: OwnerCmd | { error: string }, e: CommandIn): Promise<string> {
  const lang = h.language, address = h.address
  if ('error' in cmd) {
    if (e.command === 'flow-approve') takeCode(undefined) // a malformed attempt is still an attempt
    return fill(lang, 'refuse.usage', { usage: cmd.error })
  }
  if (cmd.name === 'flow-approve') return approveCommand(h, cmd, e.origin)
  if (!originOk(cmd, e.origin)) return refusalText(lang, address, 'originCommand', 'setup')
  if (cmd.name === 'flow-off') return flowOff(h, cmd.id)
  await takeLock(h)
  switch (cmd.name) {
    case 'flow-setup': return setupCommand(h, { overrides: cmd.overrides, tools: cmd.tools, mcp: cmd.mcp }, e.origin)
    case 'flow-plan': return planCommand(h, cmd.intent, e.origin)
    case 'flow-reject': return rejectPlan(h)
    case 'flow-build': return buildCommand(h)
    case 'flow-verify': return verifyCommand(h)
    case 'flow-ship': return shipCommand(h, e.origin)
    case 'flow-decide': return decideCommand(h, cmd.id, cmd.choice)
    case 'flow-retry': return retryCommand(h, cmd.scope)
    case 'flow-waive': return waiveCommand(h, cmd.target, cmd.reason, e.origin)
    case 'flow-status': {
      const view = await activeView(h)
      const shown = view.mode === 'on' ? (await pastedCheck(h, view.record)) ?? (await showBaseline(h, view.record, e.origin)) : null
      return shown ?? (await flowCard(h)) ?? fill(lang, 'status.none', { address })
    }
    default: { const unwired: never = cmd; throw new Error(`flow: ${JSON.stringify(unwired)} is not wired`) }
  }
}

/** An owner command takes the lock for this session at once (§2.4), refreshing its heartbeat when it already holds it. */
async function takeLock(h: FlowHost): Promise<void> {
  const view = await activeView(h)
  if (view.mode !== 'on') return
  await updateRecord(h.io, h.home, view.record.flowId, h.sessionId, claimLock(await holderOf(h), await h.io.now(), true))
  dropView()
}

/** The echo of `kind` rebuilt from the current draft and files, as its hash; undefined while no builder exists for it. */
async function recomputeEcho(h: FlowHost, kind: EchoKind): Promise<string | undefined> {
  return kind === 'setup' ? setupHash(h) : kind === 'baseline' ? baselineHash(h) : kind === 'plan' ? planHash(h) : kind === 'waive' ? waiveHash(h) : kind === 'release' ? releaseHash(h) : undefined
}
async function applyApproval(h: FlowHost, a: Approval): Promise<string> {
  if (a.kind === 'setup') return applySetup(h, a)
  if (a.kind === 'baseline') return applyBaseline(h, a)
  if (a.kind === 'plan') return applyPlan(h, a)
  if (a.kind === 'waive') return applyWaive(h, a)
  if (a.kind === 'release') return applyRelease(h, a)
  throw new Error(`flow: the ${a.kind} approval is not wired yet`)
}

/** §2.5 /flow-approve: the one gate (approve spends a release code first). A release attempt from another origin leaves a
 * journal line and a card line. On success the approved kind leaves the pending echoes as they are now. */
async function approveCommand(h: FlowHost, cmd: ApproveCmd, origin: Origin): Promise<string> {
  const res = await approve(cmd, { origin, pending: (await session(h)).value.pending, at: await h.io.now(), recompute: kind => recomputeEcho(h, kind) })
  if (!res.ok) {
    if (res.refuse === 'originRelease') {
      const line = fill(h.language, 'origin.release', { kind: origin.kind })
      await h.journal(line)
      await mutateSession(h, s => ({ ...s, notes: [...s.notes, line].slice(-3) }))
    }
    return refusalText(h.language, h.address, res.refuse, cmd.kind)
  }
  await mutateSession(h, s => ({ ...s, pending: dropEcho(s.pending, cmd.kind), shown: s.shown === cmd.kind ? null : s.shown }))
  await takeLock(h)
  return applyApproval(h, res.approval)
}

/** /flow-off [<id8>]: ends this repository's flow (or the one named, F9; a flow that cannot be read counts), drops this
 * session's flow state and the release code. Views stay as history. */
async function flowOff(h: FlowHost, id: string | undefined): Promise<string> {
  const lang = h.language, s = await staticsOf(h)
  const list = s.repoKey === null ? { ok: true as const, active: [], invalid: [] } : await listActive(h.io, h.home, s.repoKey)
  if (!list.ok) return fill(lang, 'off.failed', { id: id ?? '?', detail: list.reason })
  const ids = [...list.active.map(r => r.flowId), ...list.invalid]
  const target = id ?? (ids.length === 1 ? ids[0] : undefined)
  if (target === undefined || !ids.includes(target)) return ids.length ? fill(lang, 'off.which', { commands: ids.map(x => `/flow-off ${x}`).join(' · ') }) : fill(lang, 'status.none', { address: h.address })
  const out = await removeRecord(h.io, h.home, target, 'off')
  dropView()
  if (!out.ok) return fill(lang, 'off.failed', { id: target, detail: out.reason })
  takeCode(undefined)
  await mutateSession(h, () => emptySession())
  return fill(lang, 'off.done', { id: target })
}
