// snagon-dev-mods module: a coding-agent harness as a Claude Code mod that needs nothing but Claude Code.
// It loads the instruction files and path rules, keeps a per-project memory (SQLite FTS5 over a JSONL file, outside
// git), guards tool calls (fact-forcing gate, git hook bypass, lint configs, secrets before git commit or push), keeps
// the session journal honest (stop reminder, compaction entry, journal tail after compaction), writes the handoff at
// session end, and shows cost and context. Per-user data lives in `<project>/.snagon/` (never in git).
// The engine's `$` is used only in this file; the side modules get `io`, plain functions over it.
import type { CoreEngineInterface, Register } from 'claude-code'
import { computeFacts, localNow, appendText, dataDir, type Io, type SessionFacts } from './session'
import { instructionFiles, loadRules, matching, ruleText, FILE_TOOLS } from './instructions'
import { save, search, get, startDigest, importJournal, TOOL_SPECS } from './memory'
import { journalDir, journalFiles, editsAfter, withEdit, stopReason, compactEntry, compactContext, shortcutPhrase, display, TAIL_LINES, type Edit } from './journal'
import { planHandoff, spawnHandoff, latestHandoff } from './handoff'
import { ensureSqlite, installNotice, agentNotice } from './install'
import { bareAddressCount, addressReminder } from './address'
import { gateDecision, noVerifyReason, gitIntent, gitAliasReason, gitSecretReason, isProtectedConfig, configReason, PUSH_REMINDER, SPLIT_REASON, OTHER_REPO_REASON, INDIRECT_REASON } from './gate'
import { usageNotices, statusText, subagentReminder } from './usage'
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

const S = 'snagon-dev-mods'
const APPENDED = { plugin: 'snagon-dev-mods', key: 'appendedRules' } as const
const EDITS = { plugin: 'snagon-dev-mods', key: 'edits' } as const
const CHECKED = { plugin: 'snagon-dev-mods', key: 'gateChecked' } as const
const DENIALS = { plugin: 'snagon-dev-mods', key: 'gateDenials' } as const
const NOTICES = { plugin: 'snagon-dev-mods', key: 'notices' } as const
const INSTALL_NOTICE = { plugin: 'snagon-dev-mods', key: 'installNotice' } as const
const ADDRESS_SLIPS = { plugin: 'snagon-dev-mods', key: 'addressSlips' } as const
const FLOW = { plugin: 'snagon-dev-mods', key: 'flow' } as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const JOURNAL_IMPORT_DAYS = 7

function ioOf($: Host): Io {
  return {
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    list: path => $.fs.list(path),
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
    pluginRoot: $.plugin.root,
  }
}

type FlowEnv = Pick<FlowHost, 'sessionId' | 'claudeDir' | 'pluginDirs' | 'env'>
let flowEnv: Promise<FlowEnv> | undefined
let beatTimer: { cancel(): void } | undefined // F7: the flow lock's heartbeat every 60 s (a reload replaces it)
/** The flow modules' view of `$` (flow-host.ts): what never changes in a session is read once. */
async function hostOf($: Host): Promise<FlowHost> {
  const f = await facts($), io = ioOf($), language = f.config.language
  flowEnv ??= (async () => {
    const lang = await $.env.get('LANG'), tz = await $.env.get('TZ'), xdg = await $.env.get('XDG_CONFIG_HOME'), gGlobal = await $.env.get('GIT_CONFIG_GLOBAL'), gSystem = await $.env.get('GIT_CONFIG_SYSTEM')
    const opt = (k: string, v: string | undefined): Record<string, string> => (v ? { [k]: v } : {})
    const env = { PATH: (await $.env.get('PATH')) ?? '', TMPDIR: (await $.env.get('TMPDIR')) ?? '', ...opt('LANG', lang), ...opt('TZ', tz), ...opt('XDG_CONFIG_HOME', xdg), ...opt('GIT_CONFIG_GLOBAL', gGlobal), ...opt('GIT_CONFIG_SYSTEM', gSystem) }
    return { sessionId: await $.session.id(), claudeDir: (await $.env.get('CLAUDE_CONFIG_DIR')) || `${f.home}/.claude`, pluginDirs: (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '', env }
  })()
    .catch(err => { flowEnv = undefined; throw err })
  return {
    ...(await flowEnv), io, root: f.root, home: f.home, language, address: addressFor(language, f.config.address), cwd: () => $.session.cwd(),
    stat: async path => { try { return await $.fs.stat(path, { resolve: true }) } catch (err) { if (/ENOENT/.test(String(err))) return null; throw err } },
    readSession: () => $.state.get(FLOW),
    writeSession: async (value, ifVersion) => (await $.state.set(FLOW, value, { ifVersion })).isSet,
    open: pane => $.ui.open(pane), submit: async text => { submitLater($, text) }, usd: async () => (await $.session.usage()).cost?.usd,
    journalDir: f.config.journalDir, settings: async source => (await $.settings.read(source ? { source } : undefined)) as FlowSettings,
    runLong: (argv, init) => collectRun($.process.spawn({ argv, ...(init.cwd ? { cwd: init.cwd } : {}) }), (ms, fn) => $.clock.after(ms, fn), init.timeoutMs),
    journal: async line => { const day = await localNow(io); await appendText(io, `${await journalDir(io, f.root, f.config.journalDir)}/${day.date}.md`, `- ${line}\n`) },
  }
}
const GUARD_FAILED = 'flow: the guard could not check this call, so it is refused'

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

let cached: SessionFacts | undefined
async function facts($: Host, refresh = false): Promise<SessionFacts> {
  if (!cached || refresh) cached = await computeFacts(ioOf($), await $.session.root(), (await $.env.get('HOME')) ?? '')
  return cached
}

// One log line per kind of failure, so a broken folder does not log on every call.
const noted = new Set<string>()
function note($: Host, kind: string, text: string): void {
  if (noted.has(kind)) return
  noted.add(kind)
  try { $.ui.log(`${S}: ${text}`) } catch { /* no surface */ }
}

const answer = (text: string) => (text.startsWith('refused:') ? { deny: text } : { result: text as never })
const wordsOf = (f: SessionFacts) => ({ decision: f.config.decisionWord, lesson: f.config.lessonWord })
const fileOf = (e: Record<string, unknown>): string | undefined =>
  typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : undefined

/** Appends the path rules `file` matches that this session has not seen; parallel calls never append one twice. */
async function appendPathRules($: Host, file: string): Promise<void> {
  const rules = await loadRules(ioOf($))
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const held = await $.state.get(APPENDED)
    const done = new Set(held.value ?? [])
    const fresh = matching(rules, done, file)
    if (fresh.length === 0) return
    const set = await $.state.set(APPENDED, [...done, ...fresh.map(rule => rule.id)], { ifVersion: held.version })
    if (!set.isSet) continue
    try {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: ruleText(fresh, file) }] } })
    } catch (err) {
      // Give the claim back so a later matching call appends the rule.
      const now = await $.state.get(APPENDED)
      const ids = new Set(fresh.map(rule => rule.id))
      await $.state.set(APPENDED, (now.value ?? []).filter(id => !ids.has(id)))
      throw err
    }
    return
  }
  // ponytail: two lost races in a row; the rule loads on the next matching call
}

async function guard($: Host, e: Record<string, unknown>, tool: string): Promise<string | null> {
  const f = await facts($)
  if (tool === 'Bash' && typeof e.command === 'string') {
    const bypass = noVerifyReason(e.command)
    if (bypass) return bypass
    const intent = gitIntent(e.command)
    if (intent.commit && intent.staging) return SPLIT_REASON
    if (intent.otherRepo) return OTHER_REPO_REASON
    if (intent.indirect) return INDIRECT_REASON
    const alias = await gitAliasReason(ioOf($), f.root, intent.aliases)
    if (alias) return alias
    if (intent.commit || intent.push) {
      const leak = await gitSecretReason(ioOf($), f.root, intent)
      if (leak) return leak
    }
  }
  if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && typeof e.file_path === 'string') {
    if (isProtectedConfig(e.file_path) && (await $.fs.exists(e.file_path))) return configReason(e.file_path)
  }
  const checked = (await $.state.get(CHECKED)).value ?? []
  const denials = (await $.state.get(DENIALS)).value ?? 0
  const out = gateDecision({ ...e, tool }, { checked, denials }, f.root)
  if (out.mark.length) await $.state.set(CHECKED, [...checked, ...out.mark].slice(-500))
  if (out.denials !== denials) await $.state.set(DENIALS, out.denials)
  return out.deny ?? null
}

async function afterCall($: Host, e: Record<string, unknown>, tool: string): Promise<string[]> {
  const extra: string[] = []
  const file = fileOf(e)
  if (file && EDIT_TOOLS.has(tool)) {
    const held = (await $.state.get(EDITS)).value ?? []
    await $.state.set(EDITS, withEdit(held, file, await $.clock.now()))
  }
  if (file && FILE_TOOLS.has(tool)) {
    try { await appendPathRules($, file) } catch (err) { note($, 'path-rules', `path rules not loaded: ${String(err)}`) }
  }
  if (tool === 'Bash' && typeof e.command === 'string' && gitIntent(e.command).push) extra.push(PUSH_REMINDER)
  if (tool === 'Agent' || tool === 'Task') extra.push(subagentReminder(e))
  try {
    const usage = await $.session.usage()
    const fired = (await $.state.get(NOTICES)).value ?? []
    const n = usageNotices(usage.cost?.usd ?? 0, usage.context.percent, fired)
    if (n.lines.length) { extra.push(...n.lines); await $.state.set(NOTICES, n.fired) }
  } catch (err) { note($, 'usage', `usage not read: ${String(err)}`) }
  return extra
}

const IMPORT_MIN_MS = 400 // the journal import runs only with this much of the session-end budget left; it catches up next time
const SPAWN_MIN_MS = 250 // below this the handoff is left for the next session end (state.json is not moved, so it retries)

async function sessionEnd($: Host, sessionId: string, remainingMs: () => number): Promise<void> {
  const f = await facts($)
  if (f.exempt) return
  const io = ioOf($)
  const jdir = await journalDir(io, f.root, f.config.journalDir)
  const files = await journalFiles(io, jdir)
  const latest = files[0]
  if (latest) try {
    const dir = `${await dataDir(io, f.root)}/handoff`
    let last = 0
    try { last = Number(JSON.parse(await $.fs.read(`${dir}/state.json`)).journalMtime) || 0 } catch { last = 0 }
    // This project's addendum (`.snagon/handoff-prompt.md`), else the user's own for every project (`~/.snagon/handoff-prompt.md`).
    let addendum = ''
    for (const file of [`${f.root}/.snagon/handoff-prompt.md`, ...(f.home ? [`${f.home}/.snagon/handoff-prompt.md`] : [])]) {
      try { addendum = await $.fs.read(file) } catch { addendum = '' }
      if (addendum.trim()) break
    }
    const day = await localNow(io)
    const plan = planHandoff(await $.fs.read(latest.file), latest.mtimeMs, last, addendum, dir, day.date, sessionId)
    if (plan && remainingMs() < SPAWN_MIN_MS) note($, 'handoff-time', 'handoff left for the next session end (time budget)')
    else if (plan) {
      await spawnHandoff(io, f.root, plan)
      await $.fs.write(`${dir}/state.json`, JSON.stringify({ journalMtime: latest.mtimeMs })) // only once the worker has started
    }
  } catch (err) { note($, 'handoff', `handoff not started: ${String(err)}`) }
  if (remainingMs() < IMPORT_MIN_MS) { note($, 'import-time', 'journal import left for the next session end (time budget)'); return }
  const now = await $.clock.now()
  const recent = files.filter(x => now - x.mtimeMs < JOURNAL_IMPORT_DAYS * 86_400_000).map(x => x.file)
  const decision = [...new Set([f.config.decisionWord, 'Decision', 'Quyết định'])]
  const lesson = [...new Set([f.config.lessonWord, 'Lesson', 'Bài học'])]
  try { await importJournal(io, f.root, recent, { decision, lesson }) } catch (err) { note($, 'import', `journal not copied to memory: ${String(err)}`) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await facts($, true) } catch (err) { note($, 'facts', `session facts not read: ${String(err)}`) }
    try {
      const f = await facts($)
      if (!f.exempt) {
        const status = await ensureSqlite(ioOf($), f.root, f.config.autoInstall)
        const line = installNotice(status)
        if (line) $.ui.log(line)
        // the agent passes it on in its first reply (prompt.context below), so the user cannot miss it
        const forAgent = agentNotice(status)
        if (forAgent) await $.state.set(INSTALL_NOTICE, forAgent)
      }
    } catch (err) { note($, 'install', `sqlite3 check failed: ${String(err)}`) }
    for (const spec of [...TOOL_SPECS, ...FLOW_TOOL_SPECS]) {
      try { await $.tool.register(spec) } catch (err) { note($, `tool-${spec.name}`, `tool ${spec.name} not registered: ${String(err)}`) }
    }
    for (const c of FLOW_COMMANDS) { try { await $.command.register(c) } catch (err) { note($, `cmd-${c.name}`, `/${c.name} not registered: ${String(err)}`) } }
    beatTimer?.cancel()
    beatTimer = $.clock.every(60_000, () => { void hostOf($).then(h => beat(h)).catch(err => note($, 'beat', `flow heartbeat not written: ${String(err)}`)) })
    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    const current = below.instructionFiles ?? e.instructionFiles
    if (current === undefined) return below // a hook above rewrote the claudeMd text: the files are unknown
    const io = ioOf($)
    const added: { path: string; kind: 'project' | 'memory'; content: string }[] = []
    try {
      let known: SessionFacts | undefined
      try { known = await facts($) } catch { known = undefined }
      added.push(...(await instructionFiles(io, known?.root, known?.home)))
    } catch (err) { note($, 'instructions', `instructions not loaded: ${String(err)}`) }
    try {
      const f = await facts($)
      const text = await startDigest(io, f.root)
      if (text) added.push({ path: `${f.root}/.snagon/memory/MEMORY.md`, kind: 'memory', content: text })
      const missing = (await $.state.get(INSTALL_NOTICE)).value
      if (missing && !f.exempt) added.push({ path: `${f.root}/.snagon/install-notice.md`, kind: 'project', content: missing })
      if (!f.exempt) {
        const h = await latestHandoff(io, `${f.root}/.snagon/handoff`)
        if (h) added.push({ path: h.path, kind: 'memory', content: `# Handoff from an earlier session (${h.path.slice(h.path.lastIndexOf('/') + 1, -3)})\n\n${h.content}` })
      }
    } catch (err) { note($, 'memory', `memory or handoff not loaded: ${String(err)}`) }
    return added.length ? { ...below, instructionFiles: [...current, ...added] } : below
  })

  // The address reminder rides with the next prompt: prompt.context runs once per conversation, so it cannot carry it.
  on('prompt.submit', async ($, e, next) => {
    // D13: this mod's own ticket prompt, when no unstarted ticket waits for it any more (main started the ticket while the
    // prompt waited for its turn), is dropped as it enters; submitLater knows the reason as not a loss
    if (e.origin.kind === 'plugin' && e.text.startsWith(TICKET_PROMPT)) {
      try { if (!(await ticketWaiting(await hostOf($)))) return { drop: STALE_TICKET_PROMPT } } catch (err) { note($, 'ticket-prompt', `ticket prompt not checked: ${String(err)}`) }
    }
    // D13: the owner's own prompt starts the push count again: a main that stopped to ask the owner was not refusing
    if (OWNER_ORIGINS.has(e.origin.kind)) {
      try { await ownerSpoke(await hostOf($)) } catch (err) { note($, 'nudges', `push count not reset: ${String(err)}`) }
    }
    const extra: string[] = []
    try {
      const slips = (await $.state.get(ADDRESS_SLIPS)).value ?? 0
      if (slips > 0) {
        await $.state.set(ADDRESS_SLIPS, 0) // once per slip: the reminder goes with the next prompt only
        const f = await facts($)
        if (f.config.address && !f.exempt) extra.push(addressReminder(f.config.address, slips))
      }
    } catch (err) { note($, 'address', `address reminder not added: ${String(err)}`) }
    // flow (plan §6): the card, after the address reminder
    try { const c = await flowCard(await hostOf($)); if (c) extra.push(c) } catch (err) { note($, 'flow-card', `flow card not added: ${String(err)}`) }
    return next(extra.length ? { ...e, context: [...(e.context ?? []), ...extra] } : e)
  })

  // flow owner commands (plan §2.5, F37): the release code is masked before anything else, so the command line never keeps it
  on('command.run', async ($, e, next) => {
    if (!e.command.startsWith('flow-')) return next(e)
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

  // The memory tools: refusals go back as errors, answers as the tool result.
  on('tool.call', { tool: 'mcp__snagon-dev-mods__memory_save' }, async ($, e) => answer(await save(ioOf($), (await facts($)).root, e as unknown as Record<string, unknown>)))
    .catch(($, e, next) => ({ deny: `memory_save failed: ${next.error.message ?? next.error.kind}` }))
  on('tool.call', { tool: 'mcp__snagon-dev-mods__memory_search' }, async ($, e) => answer(await search(ioOf($), (await facts($)).root, e as unknown as Record<string, unknown>)))
    .catch(($, e, next) => ({ deny: `memory_search failed: ${next.error.message ?? next.error.kind}` }))
  on('tool.call', { tool: 'mcp__snagon-dev-mods__memory_get' }, async ($, e) => answer(await get(ioOf($), (await facts($)).root, e as unknown as Record<string, unknown>)))
    .catch(($, e, next) => ({ deny: `memory_get failed: ${next.error.message ?? next.error.kind}` }))

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    if (tool.startsWith(`mcp__${S}__`)) return next(e)
    let reason: string | null = null
    try { reason = await guard($, call, tool) } catch (err) { note($, 'gate', `gate check failed: ${String(err)}`) }
    if (reason) return { deny: reason }
    // flow (plan §2.3, F40), fail-closed: the sandbox switch off before the call; after it, the target placed again (a
    // change withholds the result and blocks the flow). Outside flow the call goes on as it came.
    let live: Live
    try { live = await liveCall(await hostOf($), call) } catch (err) { note($, 'flow', `flow check failed: ${String(err)}`); return { deny: GUARD_FAILED } }
    const out = await next(live.e as unknown as typeof e)
    if ((out as { deny?: unknown }).deny !== undefined) return out
    const withheld = await live.after(out).catch(() => GUARD_FAILED)
    if (withheld) return { deny: withheld }
    let extra: string[] = []
    try { extra = await afterCall($, call, tool) } catch (err) { note($, 'after', `after-call step failed: ${String(err)}`) }
    if (!extra.length) return out
    const ctx = (out as { context?: readonly string[] }).context ?? []
    return { ...out, context: [...ctx, ...extra] } as typeof out
  })

  // The permission mode each loop runs in (F26): the classic events that carry it; tool.check decides fail-closed.
  on('classic.UserPromptSubmit', ($, e, next) => { noteMode(e.agent_id, e.permission_mode); return next(e) })
  on('classic.PostToolUse', ($, e, next) => { noteMode(e.agent_id, e.permission_mode); return next(e) })
  on('tool.check', async ($, e, next) => {
    const deny = await checkVerdict(await hostOf($), e)
    return deny ? { decision: 'deny', reason: deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { decision: 'deny', reason: GUARD_FAILED }))

  on('classic.Stop', async ($, e, next) => {
    noteMode(e.agent_id, e.permission_mode)
    let reason: string | null = null
    try {
      const f = await facts($)
      const phrase = shortcutPhrase(e.last_assistant_message)
      if (f.config.address && !f.exempt) {
        const slips = bareAddressCount(String(e.last_assistant_message ?? ''), f.config.address)
        if (slips > 0) await $.state.set(ADDRESS_SLIPS, slips)
      }
      if (phrase) { try { $.ui.toast(`Possible shortcut in the last reply: "${phrase}"`) } catch { /* no surface */ } }
      if (!f.exempt && !e.stop_hook_active) {
        const io = ioOf($)
        const jdir = await journalDir(io, f.root, f.config.journalDir)
        const latest = (await journalFiles(io, jdir))[0]
        const edits: Edit[] = (await $.state.get(EDITS)).value ?? []
        const changed = editsAfter(edits, latest ? latest.mtimeMs : 0, f.root, jdir)
        if (changed.length) {
          const now = await localNow(io)
          reason = stopReason(changed, f.root, `${jdir}/${now.date}.md`, now.clock, wordsOf(f))
        }
      }
    } catch (err) { note($, 'stop', `stop check failed: ${String(err)}`) }
    // flow (plan §6): one ordered block (claim, floor/junk, pressure, then this journal reminder); outside flow, as today
    let flow: { block?: string } | null = null
    try { flow = await flowStop(await hostOf($), { message: String(e.last_assistant_message ?? ''), stopHookActive: e.stop_hook_active === true, ...(reason ? { journal: reason } : {}) }) } catch (err) { note($, 'flow-stop', `flow stop check failed: ${String(err)}`) }
    const block = flow ? flow.block : reason
    return block ? { block } : next(e)
  })

  on('classic.PreCompact', async ($, e, next) => {
    try { await $.state.set(APPENDED, []) } catch { /* the rules then load once more at most */ }
    try {
      const f = await facts($)
      if (!f.exempt) {
        const io = ioOf($)
        const jdir = await journalDir(io, f.root, f.config.journalDir)
        const latest = (await journalFiles(io, jdir))[0]
        const edits: Edit[] = (await $.state.get(EDITS)).value ?? []
        const files = editsAfter(edits, latest ? latest.mtimeMs : 0, f.root, jdir).map(x => display(x.file, f.root))
        const now = await localNow(io)
        await appendText(io, `${jdir}/${now.date}.md`, compactEntry(now.clock, String(e.session_id ?? ''), files, e.trigger === 'manual', f.config.language))
      }
    } catch (err) { note($, 'precompact', `compaction entry not written: ${String(err)}`) }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    noteMode(e.agent_id, e.permission_mode)
    const below = await next(e)
    if (e.source !== 'compact') return below
    try {
      const f = await facts($)
      if (f.exempt) return below
      const latest = (await journalFiles(ioOf($), await journalDir(ioOf($), f.root, f.config.journalDir)))[0]
      if (!latest) return below
      const tail = await $.process.run(['/usr/bin/tail', '-n', String(TAIL_LINES), latest.file])
      return { ...below, additionalContext: [...(below.additionalContext ?? []), compactContext(tail.stdout, display(latest.file, f.root))] }
    } catch (err) { note($, 'compact-context', `journal tail not loaded: ${String(err)}`); return below }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // a subagent's turn end (heard since 2.1.301): on 2.1.302 the Agent tool answers only the launch of a background
      // run, so a ticket's run is attested here, from the turn's final text (dry run of step 13, D4)
      try {
        const h = await hostOf($), done = await afterAgentTurn(h, e.agentId, e.answer, e.reason)
        if (done) await onReply(h, done.t, done.text)
      } catch (err) { note($, 'agent-turn', `ticket run not attested: ${String(err)}`) }
      return next(e)
    }
    try {
      const f = await facts($)
      const usage = await $.session.usage(), h = await hostOf($)
      await turnEnd(h).catch(err => note($, 'spend', `flow spend not kept: ${String(err)}`))
      const text = (await flowUsageLine(h)) ?? statusText(usage.cost?.usd, usage.context.percent)
      if (text) $.ui.status(`${S} ${text}`)
      const row = { ts: new Date(await $.clock.now()).toISOString(), session: await $.session.id(), usd: usage.cost?.usd ?? null, contextPercent: usage.context.percent ?? null, tokens: usage.context.tokens ?? null }
      await appendText(ioOf($), `${await dataDir(ioOf($), f.root)}/cost.jsonl`, `${JSON.stringify(row)}\n`)
    } catch (err) { note($, 'cost', `cost row not written: ${String(err)}`) }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try { await sessionEnd($, e.sessionId, () => next.budget.remainingMs) } catch (err) { note($, 'session-end', `session-end work failed: ${String(err)}`) }
    return next(e)
  })
}
