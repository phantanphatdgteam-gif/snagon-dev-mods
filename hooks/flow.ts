// The machine side of flow (plan v7.1 §3, §5.2, §6): the task pointer, the blocked reasons and their owner exits, the
// ESCALATE block and its hash, the one ordered Stop block, the card and the cost line. Owner-facing text is in
// config.language, addressed with config.address; text the model reads (the Stop block, the cost line) is English.
import { TASKS } from '../flow/data/phases'
import { fill } from '../flow/data/templates'
import type { Caps, Language, Phase } from '../flow/data/types'
import { sha256 } from './flow-review'
import { redactSecrets } from './secrets'

export type Pointer = { phase: Phase; task: string; feature?: string }
export type Next = { pointer: Pointer } | { awaiting: string; pointer: Pointer } | { done: true }
/** The record fields a Next sets: the pointer (no feature outside build) and the owner command awaited, if any. */
export function pointerFields(next: Next): Pointer & { awaiting?: string } {
  if ('done' in next) throw new Error('flow: this step cannot finish the flow')
  return { phase: next.pointer.phase, task: next.pointer.task, ...(next.pointer.feature ? { feature: next.pointer.feature } : {}), ...('awaiting' in next ? { awaiting: next.awaiting } : {}) }
}
const ORDER = TASKS.map(t => t.id)
function at(task: string, feature?: string): Pointer {
  const t = TASKS.find(x => x.id === task)
  if (!t) throw new Error(`flow: unknown task ${task}`)
  return feature ? { phase: t.phase, task, feature } : { phase: t.phase, task }
}
/** Where the chain stops for the owner, with the next command to type. S1 runs inside /flow-setup and H0 inside /flow-ship,
 * which show their echoes, so the approval comes next; after P2 (lint) /flow-plan shows the plan echo, and after a red S3
 * /flow-status shows the baseline echo. */
const WAIT: Readonly<Record<string, readonly [string, string]>> = { S1: ['/flow-approve setup', 'S2'], P2: ['/flow-plan', 'P3'], S4: ['/flow-plan', 'P1'], V8: ['/flow-ship', 'H0'], H0: ['/flow-approve release', 'H1'] }
/** §3: what follows a passed task. The owner starts each phase and approves each echo; features run B1–B5 in plan order. */
export function afterPass(p: Pointer, ctx: { features: readonly string[]; baselineRed: boolean }): Next {
  if (!ORDER.includes(p.task)) throw new Error(`flow: unknown task ${p.task}`)
  if (p.task.startsWith('B') && !ctx.features.includes(p.feature ?? '')) throw new Error(`flow: ${p.task} needs a feature of the plan (got ${p.feature ?? 'none'})`)
  const wait = WAIT[p.task]
  if (wait) return { awaiting: wait[0], pointer: at(wait[1]) }
  if (p.task === 'S3') return ctx.baselineRed ? { awaiting: '/flow-status', pointer: at('S4') } : { awaiting: '/flow-plan', pointer: at('P1') }
  if (p.task === 'P3') { const first = ctx.features[0]; if (!first) throw new Error('flow: an approved plan has no feature'); return { awaiting: '/flow-build', pointer: at('B1', first) } }
  if (p.task === 'B5') { const next = ctx.features[ctx.features.indexOf(p.feature ?? '') + 1]; return next ? { pointer: at('B1', next) } : { awaiting: '/flow-verify', pointer: at('V1') } }
  if (p.task === 'H2') return { done: true }
  return { pointer: at(ORDER[ORDER.indexOf(p.task) + 1] ?? '', p.feature) }
}

const DECIDE = ['/flow-decide <X-n> fix|reject|followup', '/flow-retry <scope>', '/flow-reject plan']
/** §3.2: the owner commands that leave each blocked reason; `{name}` comes from the reason's values (`{command}`: the
 * command to repeat or the one awaited; `{id}`, `{cmdId}`: the finding or command to waive). */
export const BLOCKED_EXITS: Readonly<Record<string, readonly string[]>> = {
  cap: DECIDE, dispute: DECIDE, frozenChanged: ['/flow-reject plan'], cmdSrc: ['/flow-setup'], remoteChanged: ['/flow-setup'], tooSlow: ['/flow-setup'],
  sandboxMismatch: ['/flow-setup'], probeInconclusive: ['/flow-setup'], sandboxKey: ['/flow-setup'], tampered: ['/flow-setup', '/flow-off'], couldNotRun: ['/flow-retry check'],
  cost: ['/flow-retry cost', '/flow-off'], redCheck: ['/flow-waive check:{cmdId} <reason>'], floor: ['/flow-waive {id} <reason>'], junk: ['/flow-waive {id} <reason>'],
  injection: ['/flow-waive {id} <reason>'], redTestChanged: ['/flow-waive {id} <reason>'], pushRejected: ['/flow-verify', '/flow-off'], reportChanged: ['/flow-verify', '/flow-off'], viewOnly: ['/flow-status'],
  awaitingOwner: ['{command}'], split: ['/flow-reject plan'], noSurface: ['{command}'], planLint: ['/flow-reject plan'], publish: ['/flow-verify', '/flow-ship', '/flow-off'],
}
export function exitsFor(reason: string, vars: Readonly<Record<string, string>>): string[] {
  const exits = BLOCKED_EXITS[reason]
  if (!exits) throw new Error(`flow: no owner exit for blocked reason ${reason}`)
  return exits.map(x => x.replace(/\{(\w+)\}/g, (_, name: string) => { const v = vars[name]; if (!v) throw new Error(`flow: ${reason} needs {${name}}`); return v }))
}

/** The ESCALATE text at a cap (§3), in config.language with config.address, between the markers the Stop check knows. */
export function escalateBlock(lang: Language, address: string, i: { scope: string; kind: 'edit' | 'review' | 'debug'; options: readonly [string, string, string] }): string {
  const [o1, o2, o3] = i.options
  return ['[flow-escalate]', fill(lang, 'escalate.head', { scope: i.scope, kind: fill(lang, `kind.${i.kind}`, {}), address }), fill(lang, 'escalate.options', { o1, o2, o3 }), '[/flow-escalate]'].join('\n')
}
export const escalateHash = (block: string): Promise<string> => sha256(block)

/** R6: a claim that the work is done (English and Vietnamese, whole words), or a check mark (always a claim). */
const CLAIM = /(?<![\p{L}\p{N}])(?:done|completed|finished|all tests pass(?:ed)?|ready to ship|xong|hoàn thành|đã sửa|đã pass)(?![\p{L}\p{N}])|[✅✔☑✓]/giu
/** What cancels a claim word just before it: an English negation right before it ("not done", "isn't finished", "not yet
 * done"), a Vietnamese one up to two words before ("chưa xong", "chưa làm xong"), or work still to do ("to be done"). */
const NEGATED = /(?:(?<![\p{L}])(?:not(?: yet)?|never)|n['’]t|(?<![\p{L}])(?:chưa|không)(?: [\p{L}\p{N}]+)?|(?<![\p{L}])to (?:be|get)) $/iu
/** Whether the text claims done: compatibility forms folded, format characters dropped and spaces collapsed first, so none
 * of them splits or disguises a claim word. */
export function claims(text: string): boolean {
  const t = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ')
  return [...t.matchAll(CLAIM)].some(m => /[✅✔☑✓]/u.test(m[0]) || !NEGATED.test(t.slice(Math.max(0, m.index - 40), m.index)))
}
/** Removes only the ESCALATE block the mod wrote (its hash was stored), leaving a line break so the text around it does
 * not join into one word; a block the agent wrote itself stays. */
async function stripEscalate(message: string, stored: string | undefined): Promise<string> {
  let out = message
  for (const m of message.matchAll(/\[flow-escalate\][\s\S]*?\[\/flow-escalate\]/g)) if (stored && (await sha256(m[0])) === stored) out = out.replace(m[0], '\n')
  return out
}
/** judge: 'none' when no judge applies to the current task (setup and plan phases). */
export type StopIn = { message: string; escalateHash?: string; judge: 'green' | 'none' | 'red' | 'missing' | 'stale'; claimHeld: boolean; hits: readonly string[]; pressure?: string; journal?: string; stopHookActive: boolean }
/** claimRepeat: a done claim that was not held this time (a repeat, or inside stop_hook_active): flag it on the card. */
export type StopOut = { block?: string; claimHeld: boolean; claimRepeat: boolean }
/** §5.2 / §6: one Stop block, numbered in order — 1 a done claim while the judge is not green (held once; a repeat only
 * flags the card and the journal), 2 unresolved floor or junk hits, 3 flow pressure, 4 the journal reminder (alone, as
 * today). No block when stop_hook_active, but a repeated claim is still flagged. `claimHeld` resets once the judge is green. */
export async function stopBlock(i: StopIn): Promise<StopOut> {
  const claimed = i.judge !== 'green' && i.judge !== 'none' && claims(await stripEscalate(i.message, i.escalateHash))
  // A claim not held now (a repeat, or one inside stop_hook_active, which cannot block) is flagged on the card and journal.
  const held = { claimHeld: i.judge === 'green' ? false : i.claimHeld || (claimed && !i.stopHookActive), claimRepeat: claimed && (i.claimHeld || i.stopHookActive) }
  if (i.stopHookActive) return held
  const reasons = [
    ...(claimed && !i.claimHeld ? [`The last reply claims the work is done, but the judge is ${i.judge}. Run flow_check and report its result; do not claim done until it passes.`] : []),
    ...(i.hits.length ? [`Unresolved floor or junk findings: ${i.hits.join(', ')}. Fix them, or ask the project owner to waive them.`] : []),
    ...(i.pressure ? [`The current task is not passed and rounds are left: ${i.pressure}.`] : []),
    ...(i.journal ? [i.journal] : []),
  ]
  const block = reasons.length === 1 && i.journal ? i.journal : reasons.length ? reasons.map((r, k) => `${k + 1}. ${r}`).join('\n') : undefined
  return { ...(block ? { block } : {}), ...held }
}

export type Cost = { session: number; sessionCap: number; flow: number; flowCap: number }
export const CARD_MAX_LINES = 12
const OPEN_SHOWN = 10
export type CardIn = {
  lang: Language; address: string; pointer: Pointer; used: Caps; caps: Caps; open: readonly string[]; blocked?: { reason: string; vars: Readonly<Record<string, string>> }
  claim?: 'red' | 'missing' | 'stale'; sandbox: string; runnerAbsent?: boolean; cost: Cost; next: { step: string; command: string }
}
const usd = (n: number): string => n.toFixed(2)
/** The most characters of one blocked value on the card (git or remote stderr can be long). */
const CAUSE_CHARS = 160
/** A blocked cause's values as the card shows them (the card goes into the model's context): a line that looks like a
 * secret removed, credentials in a URL masked, then one line (control and format characters and line breaks become
 * spaces) of at most CAUSE_CHARS characters; a cap kind in the owner's language; the address never overridden. */
function causeVars(lang: Language, address: string, vars: Readonly<Record<string, string>>): Record<string, string> {
  const line = (v: string): string => { const t = redactSecrets(v).replace(/(\/\/)[^\s/@]+@/g, '$1***@').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim(); return t.length > CAUSE_CHARS ? `${t.slice(0, CAUSE_CHARS)}…` : t }
  const safe = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, line(v)]))
  return { ...safe, ...(vars.kind ? { kind: fill(lang, `kind.${vars.kind}`, {}) } : {}), address }
}
/** §6 card (≤12 lines): phase and task, caps used, open ids, the blocked cause, a repeated done claim, sandbox, cost and
 * the next step with its exact command (the owner's exits when blocked). */
export function card(c: CardIn): string[] {
  const { lang, address } = c, more = c.open.length - OPEN_SHOWN
  const lines = [
    fill(lang, 'card.head', { phase: c.pointer.phase, task: [c.pointer.task, c.pointer.feature].filter(Boolean).join(' ') }),
    fill(lang, 'card.caps', { e: c.used.e, eMax: c.caps.e, r: c.used.r, rMax: c.caps.r, d: c.used.d, dMax: c.caps.d }),
    ...(c.open.length ? [fill(lang, 'card.open', { ids: `${c.open.slice(0, OPEN_SHOWN).join(', ')}${more > 0 ? ` +${more}` : ''}` })] : []),
    ...(c.blocked ? [fill(lang, 'card.blocked', { cause: fill(lang, `blocked.${c.blocked.reason}`, causeVars(lang, address, c.blocked.vars)) })] : []),
    ...(c.claim ? [fill(lang, 'card.claim', { state: fill(lang, `judge.${c.claim}`, {}) })] : []),
    fill(lang, 'card.sandbox', { state: c.sandbox }),
    ...(c.runnerAbsent ? [fill(lang, 'card.runner', {})] : []), // F30: never counted as integrity
    fill(lang, 'card.cost', { session: usd(c.cost.session), sessionCap: usd(c.cost.sessionCap), flow: usd(c.cost.flow), flowCap: usd(c.cost.flowCap) }),
    c.blocked ? fill(lang, 'card.next', { step: fill(lang, 'card.ownerChooses', { address }), command: exitsFor(c.blocked.reason, c.blocked.vars).join(' · ') }) : fill(lang, 'card.next', c.next),
  ]
  return lines.slice(0, CARD_MAX_LINES)
}

/** §6 usage line for the model: spend against the frozen caps. */
export const flowCostLine = (c: Cost & { phase: Phase; phaseUsd: number; noticeAt: number }): string =>
  `flow: session $${usd(c.session)} / cap $${usd(c.sessionCap)}; flow $${usd(c.flow)} / cap $${usd(c.flowCap)}; phase ${c.phase} $${usd(c.phaseUsd)} (notice at $${usd(c.noticeAt)})`
/** Which cap the spend reached (no more tickets, `blocked: cost`), or null. A spend that cannot be read counts as reached. */
export const costCapHit = (c: Cost): 'session' | 'flow' | null => (!(c.session < c.sessionCap) ? 'session' : !(c.flow < c.flowCap) ? 'flow' : null)
