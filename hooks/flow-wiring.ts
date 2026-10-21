// Flow's share of the hooks (R2 plan step 1a, architect review A-11): moved out of register.ts unchanged, so
// register.ts keeps the harness. register.ts still registers every hook in the same order and calls in here for flow's
// part. Like register.ts, this file holds the engine's `$`; the flow modules get a FlowHost (flow-host.ts).
import type { CoreEngineInterface, On } from 'claude-code'
import { localNow, appendText } from './session'
import { journalDir } from './journal'
import { facts, ioOf, safeEnvOf, resetSafeEnv, childEnv, note, answer, S } from './engine-io'
import { checkVerdict, liveCall, noteMode, type Live } from './flow-live'
import { collectRun, mutateSession, type FlowHost } from './flow-host'
import type { Settings as FlowSettings } from './flow-sandbox'
import { FLOW_COMMANDS, maskedArgs, ownerCommand } from './flow-cmd'
import { FLOW_TOOL_SPECS, flowCard, flowStatus, flowStop, ownerSpoke, TICKET_PROMPT, ticketWaiting } from './flow-turn'
import { paneView } from './flow-pane'
import { flowCheck } from './flow-check'
import { afterAgentTurn, noteSpawned, spawnHook } from './flow-ticket'
import { onReply } from './flow-reviewing'
import { ECHO_PANE, OWNER_ORIGINS } from './flow-owner'
import { addressFor, fill } from '../flow/data/templates'
import { beat, flowUsageLine, turnEnd } from './flow-spend'

type Host = CoreEngineInterface

const FLOW = { plugin: 'snagon-dev-mods', key: 'flow' } as const
export const GUARD_FAILED = 'flow: the guard could not check this call, so it is refused'

type FlowEnv = Pick<FlowHost, 'sessionId' | 'claudeDir' | 'pluginDirs' | 'env' | 'pathDropped'>
let flowEnv: Promise<FlowEnv> | undefined
let beatTimer: { cancel(): void } | undefined // F7: the flow lock's heartbeat every 60 s (a reload replaces it)
/** The flow modules' view of `$` (flow-host.ts): what never changes in a session is read once. */
async function hostOf($: Host): Promise<FlowHost> {
  const f = await facts($), io = ioOf($), language = f.config.language
  flowEnv ??= (async () => {
    const lang = await $.env.get('LANG'), tz = await $.env.get('TZ'), xdg = await $.env.get('XDG_CONFIG_HOME'), gGlobal = await $.env.get('GIT_CONFIG_GLOBAL'), gSystem = await $.env.get('GIT_CONFIG_SYSTEM')
    const opt = (k: string, v: string | undefined): Record<string, string> => (v ? { [k]: v } : {})
    const safe = await safeEnvOf($)
    const env = { PATH: safe.path, TMPDIR: (await $.env.get('TMPDIR')) ?? '', ...opt('LANG', lang), ...opt('TZ', tz), ...opt('XDG_CONFIG_HOME', xdg), ...opt('GIT_CONFIG_GLOBAL', gGlobal), ...opt('GIT_CONFIG_SYSTEM', gSystem) }
    return { sessionId: await $.session.id(), claudeDir: (await $.env.get('CLAUDE_CONFIG_DIR')) || `${f.home}/.claude`, pluginDirs: (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '', env, pathDropped: safe.dropped }
  })()
    .catch(err => { flowEnv = undefined; throw err })
  return {
    ...(await flowEnv), io, root: f.root, home: f.home, language, address: addressFor(language, f.config.address), cwd: () => $.session.cwd(),
    stat: async path => { try { return await $.fs.stat(path, { resolve: true }) } catch (err) { if (/ENOENT/.test(String(err))) return null; throw err } },
    readSession: () => $.state.get(FLOW),
    writeSession: async (value, ifVersion) => (await $.state.set(FLOW, value, { ifVersion })).isSet,
    open: pane => $.ui.open(pane), submit: async text => { submitLater($, text) }, usd: async () => (await $.session.usage()).cost?.usd,
    journalDir: f.config.journalDir, settings: async source => (await $.settings.read(source ? { source } : undefined)) as FlowSettings,
    runLong: async (argv, init) => collectRun($.process.spawn({ argv, ...(init.cwd ? { cwd: init.cwd } : {}), env: await childEnv($) }), (ms, fn) => $.clock.after(ms, fn), init.timeoutMs),
    journal: async line => { const day = await localNow(io); await appendText(io, `${await journalDir(io, f.root, f.config.journalDir)}/${day.date}.md`, `- ${line}\n`) },
  }
}

// A prompt the flow asks main to act on (S2b, the probe, a ticket, a commit) is submitted after the hook that asked
// has answered: the engine refuses `$.prompt.submit` from inside a `command.run` hook, which holds the turn the
// prompt would wait on (host check, 2.1.302; dry run of step 13, D1). A refusal is tried again a few times, then logged.
const SUBMIT_RETRY_MS = [50, 300, 1000, 3000]
// The texts waiting to be submitted, with the time they were queued: a second copy of one is not queued (one "ticket
// is ready" reached main twice in dry runs 18 and 19); an entry older than PENDING_MS no longer counts, so a submit that
// never settles cannot swallow the next prompt silently (security review of D13).
const PENDING = new Map<string, number>()
// a plugin prompt settles only once the session is idle, after a main turn that may run minutes: the bound is a safety
// net for a submit that never settles, not the normal end of an entry (security review of D13, round 2)
const PENDING_MS = 10 * 60_000
/** The drop reason of this mod's own prompt.submit hook for a ticket prompt no ticket waits for: not a lost prompt. */
const STALE_TICKET_PROMPT = 'flow: no unstarted ticket waits for this prompt'
function submitLater($: Host, text: string, attempt = 0): void {
  const now = Date.now()
  if (attempt === 0) { if (now - (PENDING.get(text) ?? -Infinity) < PENDING_MS) return; PENDING.set(text, now) }
  $.clock.after(SUBMIT_RETRY_MS[attempt] ?? 3000, () => {
    void $.prompt.submit({ text })
      .then(r => { PENDING.delete(text); if (r.drop !== undefined && r.drop !== STALE_TICKET_PROMPT) submitLost($, text, 'a prompt.submit hook dropped it') })
      .catch(err => {
        if (attempt + 1 < SUBMIT_RETRY_MS.length) submitLater($, text, attempt + 1)
        else { PENDING.delete(text); submitLost($, text, String(err)) }
      })
  })
}
/** A prompt the flow needed and could not deliver (code review of step 13, S13-2): every loss is logged, shown as a
 * toast, and put on the next card, so the owner knows why main sits still and types /flow-status. */
function submitLost($: Host, text: string, why: string): void {
  try { $.ui.log(`${S}: prompt not submitted (${why}): ${text.slice(0, 80)}`) } catch { /* no surface */ }
  try { $.ui.toast(`${S}: a flow prompt was not delivered; type /flow-status`) } catch { /* no surface */ }
  void hostOf($).then(h => mutateSession(h, s => ({ ...s, notes: [...s.notes, fill(h.language, 'note.submitLost', { why })] }))).catch(() => undefined)
}

/** session.start: the flow tools and commands, and the flow lock's heartbeat. */
export async function flowStart($: Host): Promise<void> {
  for (const spec of FLOW_TOOL_SPECS) {
    try { await $.tool.register(spec) } catch (err) { note($, `tool-${spec.name}`, `tool ${spec.name} not registered: ${String(err)}`) }
  }
  for (const c of FLOW_COMMANDS) { try { await $.command.register(c) } catch (err) { note($, `cmd-${c.name}`, `/${c.name} not registered: ${String(err)}`) } }
  beatTimer?.cancel()
  beatTimer = $.clock.every(60_000, () => { void hostOf($).then(h => beat(h)).catch(err => note($, 'beat', `flow heartbeat not written: ${String(err)}`)) })
}

/** prompt.submit, first: the drop reason for a ticket prompt nothing waits for; the owner's own prompt resets the push
 * count. */
export async function flowPromptIn($: Host, e: { readonly origin: { readonly kind: string }; readonly text: string }): Promise<string | null> {
  // D13: this mod's own ticket prompt, when no unstarted ticket waits for it any more (main started the ticket while the
  // prompt waited for its turn), is dropped as it enters; submitLater knows the reason as not a loss
  if (e.origin.kind === 'plugin' && e.text.startsWith(TICKET_PROMPT)) {
    try { if (!(await ticketWaiting(await hostOf($)))) return STALE_TICKET_PROMPT } catch (err) { note($, 'ticket-prompt', `ticket prompt not checked: ${String(err)}`) }
  }
  // D13: the owner's own prompt starts the push count again: a main that stopped to ask the owner was not refusing
  if (OWNER_ORIGINS.has(e.origin.kind)) {
    try { await ownerSpoke(await hostOf($)) } catch (err) { note($, 'nudges', `push count not reset: ${String(err)}`) }
  }
  return null
}

/** prompt.submit, last: the flow card (plan §6), after the address reminder. */
export async function flowCardLine($: Host): Promise<string | null> {
  try { return await flowCard(await hostOf($)) } catch (err) { note($, 'flow-card', `flow card not added: ${String(err)}`); return null }
}

/** The hooks that are flow's alone, registered where register.ts registered them. */
export function wireFlowOwner(on: On): void {
  // flow owner commands (plan §2.5, F37): the release code is masked before anything else, so the command line never keeps it
  on('command.run', async ($, e, next) => {
    if (!e.command.startsWith('flow-')) return next(e)
    if (e.command === 'flow-setup') { resetSafeEnv(); flowEnv = undefined } // the PATH filter reads the settings as they are now
    const args = maskedArgs(e.command, e.args)
    if (args !== undefined) await next({ ...e, args })
    return { text: (await ownerCommand(await hostOf($), e)).text }
  }).catch(($, e, next) => (e.command.startsWith('flow-') ? { text: `flow: ${next.error.message ?? next.error.kind}` } : next(e)))
  on('ui.render', { component: 'Pane', requestId: ECHO_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e), view = await paneView(await hostOf($))
    return h(Box, { flexDirection: 'column' }, ...view.lines.map(line => h(Text, null, line))) as never
  })
  on('tool.call', { tool: 'mcp__snagon-dev-mods__flow_status' }, async $ => answer(await flowStatus(await hostOf($))))
    .catch(($, e, next) => ({ deny: `flow_status failed: ${next.error.message ?? next.error.kind}` }))
  on('tool.call', { tool: 'mcp__snagon-dev-mods__flow_check' }, async $ => answer(await flowCheck(await hostOf($))))
    .catch(($, e, next) => ({ deny: `flow_check failed: ${next.error.message ?? next.error.kind}` }))
  // §4.6 tickets: `TICKET <id>` becomes the held text, the routed type and model; nothing may throw once the agent started
  on('agent.spawn', async ($, e, next) => {
    const h = await hostOf($), d = await spawnHook(h, e)
    if (!d || 'free' in d) return next(e)
    if ('deny' in d) return { deny: d.deny }
    const out = await next({ ...e, prompt: d.rewrite.prompt, subagentType: d.rewrite.subagentType, model: d.rewrite.model, background: false, cwd: d.rewrite.cwd })
    await noteSpawned(h, d.ticketId, e.tool_use_id, out.agentId).catch(err => note($, 'spawn', `ticket ${d.ticketId}: agent id not kept: ${String(err)}`))
    return out
  }).catch(() => ({ deny: GUARD_FAILED }))
}

/** tool.call, around the call (plan §2.3, F40), fail-closed: the sandbox switch off before it, the target placed again
 * after it (a change withholds the result and blocks the flow). */
export async function flowLive($: Host, call: Record<string, unknown>): Promise<Live> {
  return liveCall(await hostOf($), call)
}

/** The permission mode each loop runs in (F26): the classic events that carry it; tool.check decides fail-closed. */
export function wireFlowChecks(on: On): void {
  on('classic.UserPromptSubmit', ($, e, next) => { noteMode(e.agent_id, e.permission_mode); return next(e) })
  on('classic.PostToolUse', ($, e, next) => { noteMode(e.agent_id, e.permission_mode); return next(e) })
  on('tool.check', async ($, e, next) => {
    const deny = await checkVerdict(await hostOf($), e)
    return deny ? { decision: 'deny', reason: deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { decision: 'deny', reason: GUARD_FAILED }))
}

/** classic.Stop (plan §6): one ordered block (claim, floor/junk, pressure, then the journal reminder). */
export async function flowStopBlock($: Host, i: Parameters<typeof flowStop>[1]): Promise<{ block?: string } | null> {
  return flowStop(await hostOf($), i)
}

/** turn.complete of a subagent (heard since 2.1.301): on 2.1.302 the Agent tool answers only the launch of a
 * background run, so a ticket's run is attested here, from the turn's final text (dry run of step 13, D4). */
export async function flowAgentTurn($: Host, agentId: string, finalText: string, reason: string): Promise<void> {
  const h = await hostOf($), done = await afterAgentTurn(h, agentId, finalText, reason)
  if (done) await onReply(h, done.t, done.text)
}

/** turn.complete of main: the flow's spend kept, and its usage line when a flow is active. */
export async function flowTurnLine($: Host): Promise<Awaited<ReturnType<typeof flowUsageLine>>> {
  const h = await hostOf($)
  await turnEnd(h).catch(err => note($, 'spend', `flow spend not kept: ${String(err)}`))
  return flowUsageLine(h)
}
