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
import { gateDecision, noVerifyReason, gitIntent, gitSecretReason, isProtectedConfig, configReason, PUSH_REMINDER, SPLIT_REASON, OTHER_REPO_REASON, INDIRECT_REASON } from './gate'
import { usageNotices, statusText, subagentReminder } from './usage'

type Host = CoreEngineInterface

const S = 'snagon-dev-mods'
const APPENDED = { plugin: 'snagon-dev-mods', key: 'appendedRules' } as const
const EDITS = { plugin: 'snagon-dev-mods', key: 'edits' } as const
const CHECKED = { plugin: 'snagon-dev-mods', key: 'gateChecked' } as const
const DENIALS = { plugin: 'snagon-dev-mods', key: 'gateDenials' } as const
const NOTICES = { plugin: 'snagon-dev-mods', key: 'notices' } as const
const INSTALL_NOTICE = { plugin: 'snagon-dev-mods', key: 'installNotice' } as const
const ADDRESS_SLIPS = { plugin: 'snagon-dev-mods', key: 'addressSlips' } as const
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
    for (const spec of TOOL_SPECS) {
      try { await $.tool.register(spec) } catch (err) { note($, `tool-${spec.name}`, `tool ${spec.name} not registered: ${String(err)}`) }
    }
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
      const slips = (await $.state.get(ADDRESS_SLIPS)).value ?? 0
      if (slips > 0 && f.config.address && !f.exempt) {
        added.push({ path: `${f.root}/.snagon/address-reminder.md`, kind: 'project', content: addressReminder(f.config.address, slips) })
        await $.state.set(ADDRESS_SLIPS, 0) // once per slip: the reminder goes with the next prompt only
      }
      if (!f.exempt) {
        const h = await latestHandoff(io, `${f.root}/.snagon/handoff`)
        if (h) added.push({ path: h.path, kind: 'memory', content: `# Handoff from an earlier session (${h.path.slice(h.path.lastIndexOf('/') + 1, -3)})\n\n${h.content}` })
      }
    } catch (err) { note($, 'memory', `memory or handoff not loaded: ${String(err)}`) }
    return added.length ? { ...below, instructionFiles: [...current, ...added] } : below
  })

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
    const out = await next(e)
    if ((out as { deny?: unknown }).deny !== undefined) return out
    let extra: string[] = []
    try { extra = await afterCall($, call, tool) } catch (err) { note($, 'after', `after-call step failed: ${String(err)}`) }
    if (!extra.length) return out
    const ctx = (out as { context?: readonly string[] }).context ?? []
    return { ...out, context: [...ctx, ...extra] } as typeof out
  })

  on('classic.Stop', async ($, e, next) => {
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
    return reason ? { block: reason } : next(e)
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
    try {
      const f = await facts($)
      const usage = await $.session.usage()
      const text = statusText(usage.cost?.usd, usage.context.percent)
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
