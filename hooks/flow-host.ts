// Flow's view of the engine (plan v7.1 §2.3, §2.4, F14, F40, F41): register.ts builds a FlowHost of plain functions over
// `$` (the only file that uses `$`); this module finds the repository's active flow (cached ACTIVE_TTL_MS), keeps the
// session's flow state, builds the guard's contexts from the record, that state and a call's facts, and blocks the flow.
// What never changes within a load (the platform, the repository key, the plugin roots) is read once.
import type { FlowSession } from '../types'
import type { Io, RunResult } from './session'
import type { Layer, Settings } from './flow-sandbox'
import { git, gitPaths } from './flow-git'
import { flowDir, listActive, repoKeyOf, updateRecord, type Blocked, type FlowRecord, type LockHolder, type UpdateResult, withBlock } from './flow-state'
import { activeLookup, viewOf, type FlowView, type GuardCtx, type GuardFs } from './flow-guard'
import { ROUTING } from '../flow/data/routing'
import { TYPESCRIPT } from '../flow/data/stacks'
import type { Language } from '../flow/data/types'

/** A call's working directory (`$.session.cwd()` read in its hook: a subagent's own; Bash cd moves it) and the permission
 * mode last reported for its loop (F26). */
export type Facts = { cwd: string; mode?: string }
export type FlowHost = {
  io: Io
  home: string
  /** The session folder as the engine gives it. */
  root: string
  sessionId: string
  /** `$.session.cwd()` as this hook reads it. */
  cwd(): Promise<string>
  /** CLAUDE_CONFIG_DIR, else HOME/.claude: its projects folder holds the transcripts (F41). */
  claudeDir: string
  /** CLAUDE_CODE_PLUGIN_DIRS as set ('' when not). */
  pluginDirs: string
  /** `$.fs.stat(path, { resolve: true })`; null when the path is missing, any other failure throws. */
  stat(path: string): Promise<{ realPath?: string; kind?: 'file' | 'dir' | 'other' } | null>
  readSession(): Promise<{ value?: FlowSession; version: number }>
  /** Writes the session's flow state if it still stands at `ifVersion`; false when another write came first. */
  writeSession(value: FlowSession, ifVersion: number): Promise<boolean>
  /** The owner's language and how the owner is addressed (config.address, else the language's fallback). */
  language: Language
  address: string
  /** `$.ui.open` for the focused echo pane. */
  open(pane: { id: string; title: string; focus: true }): Promise<{ isPlaced: boolean }>
  /** `$.prompt.submit`: queues a turn for main (a registered command does not start one, spike 6). */
  submit(text: string): Promise<void>
  /** The session's spend so far (`$.session.usage().cost.usd`). */
  usd(): Promise<number | undefined>
  /** Appends one line to today's journal file. */
  journal(line: string): Promise<void>
  /** The journal folder from config (root-relative), frozen at S2. */
  journalDir: string
  /** `$.settings.read`: one source as loaded, or the merge with no source. */
  settings(source?: Layer): Promise<Settings>
  /** What a judged run's environment keeps (plan §5.1): PATH (frozen at S2), the temp folder, language and time zone. */
  env: { PATH: string; TMPDIR: string; LANG?: string; TZ?: string; XDG_CONFIG_HOME?: string; GIT_CONFIG_GLOBAL?: string; GIT_CONFIG_SYSTEM?: string }
  /** A long command (a judged run): killed at `timeoutMs` (it then throws) or when the person interrupts (F30). */
  runLong(argv: string[], init: { cwd?: string; timeoutMs: number }): Promise<RunResult>
}

export const MOD_TOOLS: readonly string[] = ['memory_save', 'memory_search', 'memory_get', 'flow_status', 'flow_check'].map(n => `mcp__snagon-dev-mods__${n}`)
export const emptySession = (): FlowSession => ({ pending: {}, s2b: null, tickets: {}, started: {}, startedAt: {}, ended: {}, details: {}, claimHeld: false, claim: null, shown: null, sandbox: null, notes: [], setupArgs: null, intent: null, runs: {}, disputes: {}, waive: null, release: null, spend: null, costBoost: false })

type Statics = { rootReal: string; caseFold: boolean; darwin: boolean; linkArgv: readonly string[]; repoKey: string | null; hasGit: boolean; protectedRoots: string[] }
const statics = new Map<string, Promise<Statics>>()
/** Read once per load and folder; a failed read is retried on the next call. */
export function staticsOf(h: FlowHost): Promise<Statics> {
  const key = `${h.home}\0${h.root}`
  let held = statics.get(key)
  if (!held) {
    held = computeStatics(h)
    statics.set(key, held)
    held.catch(() => statics.delete(key))
  }
  return held
}
async function computeStatics(h: FlowHost): Promise<Statics> {
  const os = (await h.io.run(['/usr/bin/uname', '-s'])).stdout.trim()
  const real = async (p: string): Promise<string> => (await h.stat(p))?.realPath ?? p
  const rootReal = await real(h.root)
  let repoKey: string | null = null, git: string[] = []
  try {
    const p = await gitPaths(h.io, rootReal)
    git = [await real(p.commonDir), await real(p.gitDir)]
    repoKey = repoKeyOf(git[0] ?? '')
  } catch { repoKey = null }
  return {
    rootReal, caseFold: os !== 'Linux', darwin: os === 'Darwin', linkArgv: os === 'Linux' ? ['/usr/bin/stat', '-c', '%h'] : ['/usr/bin/stat', '-f', '%l'],
    repoKey, hasGit: await h.io.exists(`${rootReal}/.git`), protectedRoots: [...new Set([...git, ...(await pluginRoots(h))])],
  }
}

/** The realpath of the longest existing prefix, so a link anywhere in a path counts. */
export async function realOf(h: FlowHost, p: string): Promise<string> {
  const st = await h.stat(p).catch(() => null)
  if (st) return st.realPath ?? p
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : `${await realOf(h, p.slice(0, i))}/${p.slice(i + 1)}`
}

/** Every loaded plugin's root (spike 7: no API lists them): this mod's, CLAUDE_CODE_PLUGIN_DIRS, every install path in
 * installed_plugins.json, and the engine's mods folder (`dev-mods`, which loading plugin-authoring watches for hot reload;
 * under CLAUDE_CONFIG_DIR and under ~/.claude, since whether the engine moves it is not known), each as its realpath (a
 * folder not made yet through its existing parent's, `realOf`). More than are loaded is fine: they are only ever protected. */
export async function pluginRoots(h: FlowHost): Promise<string[]> {
  const listed = [h.io.pluginRoot, ...h.pluginDirs.split(':').filter(Boolean), `${h.claudeDir}/dev-mods`, `${h.home}/.claude/dev-mods`]
  try {
    const data = JSON.parse(await h.io.read(`${h.claudeDir}/plugins/installed_plugins.json`)) as { plugins?: Record<string, unknown> }
    for (const entries of Object.values(data.plugins ?? {})) for (const e of Array.isArray(entries) ? entries : []) if (typeof e?.installPath === 'string') listed.push(e.installPath)
  } catch { /* no plugins installed this way */ }
  const out: string[] = []
  for (const p of listed) out.push(await realOf(h, p))
  return [...new Set(out)]
}

let latest: FlowHost | undefined
async function loadView(): Promise<FlowView> {
  const h = latest
  if (!h) throw new Error('no session yet')
  if (!(await h.io.exists(flowDir(h.home)))) return { mode: 'off' } // no flow ever ran: nothing to look up, no git
  const s = await staticsOf(h)
  if (s.repoKey === null) return s.hasGit ? { mode: 'unknown', why: 'git could not name this repository' } : { mode: 'off' }
  return viewOf(await listActive(h.io, h.home, s.repoKey))
}
const lookup = activeLookup(loadView)
/** Whether this repository has one active flow, none, or a state the guard cannot know (F14: looked up again every 5 s). */
export async function activeView(h: FlowHost): Promise<FlowView> {
  latest = h
  return lookup.get(await h.io.now())
}
/** After the mod changes a record, the next call looks it up again. */
export const dropView = (): void => lookup.drop()
/** Tests: forget every cache of this load. */
export function forgetFlowCaches(): void { statics.clear(); lookup.drop() }

/** The session's flow state, with every field present. */
export async function session(h: FlowHost): Promise<{ value: FlowSession; version: number }> {
  const held = await h.readSession()
  return { value: { ...emptySession(), ...held.value }, version: held.version }
}
/** Applies `change` to the session's flow state, again on a lost race; `change` returning null writes nothing (null back). */
export async function mutateSession(h: FlowHost, change: (s: FlowSession) => FlowSession | null): Promise<FlowSession | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const held = await session(h)
    const next = change(held.value)
    if (next === null) return null
    if (await h.writeSession(next, held.version)) return next
  }
  throw new Error('flow: the session state kept changing under this write')
}

function guardFs(h: FlowHost, s: Statics): GuardFs {
  return {
    stat: p => h.stat(p),
    async links(p) {
      const r = await h.io.run([...s.linkArgv, p])
      const count = Number(r.stdout.trim())
      if (r.exitCode !== 0 || !Number.isInteger(count)) throw new Error(`the link count of ${p} could not be read (${r.stderr.trim().slice(0, 200)})`)
      return count
    },
    async read(p) {
      try { return await h.io.read(p) } catch (err) { if (await h.io.exists(p)) throw err; return null }
    },
  }
}
/** Where an Edit-family path may land: the flow's root (record), also as this session spells it. */
export async function placeCtx(h: FlowHost, r: FlowRecord): Promise<Pick<GuardCtx, 'root' | 'rootAliases' | 'home' | 'caseFold' | 'fs'>> {
  const s = await staticsOf(h)
  return { root: r.root, rootAliases: [...new Set([r.root, s.rootReal, h.root])], home: h.home, caseFold: s.caseFold, fs: guardFs(h, s) }
}
/** What a read check needs: the call's cwd, where a Grep or Glob without a path searches. */
export async function readCtx(h: FlowHost, f: Facts): Promise<Pick<GuardCtx, 'cwd' | 'home' | 'caseFold' | 'fs' | 'claudeDir' | 'modTools'>> {
  const s = await staticsOf(h)
  return { cwd: f.cwd, home: h.home, caseFold: s.caseFold, fs: guardFs(h, s), claudeDir: h.claudeDir, modTools: MOD_TOOLS }
}

/** §2.3 red scope: while the active feature's last judge run is red, only its Files change (in verify: every feature's). */
function redScopeOf(r: FlowRecord): string[] | undefined {
  const j = r.judge
  if (!j || j.green) return undefined
  if (r.phase === 'build' && r.feature !== undefined && j.f === r.feature) return r.features?.find(f => f.id === r.feature)?.files ?? []
  return r.phase === 'verify' ? [...new Set((r.features ?? []).flatMap(f => f.files))] : undefined
}
/** The guard's context for one call (F40): the record's frozen lists, this session's S2b window, the call's facts. */
export async function guardCtx(h: FlowHost, r: FlowRecord, f: Facts, s: FlowSession): Promise<GuardCtx> {
  const red = redScopeOf(r)
  return {
    ...(await placeCtx(h, r)), ...(await readCtx(h, f)),
    allowTools: r.setup?.allowTools ?? [], allowMcp: r.setup?.allowMcp ?? [], freeSpawn: ROUTING.freeSpawn,
    // only what a ticket loads with the Skill tool: the vendored methods reach agents as ticket text (plan §8) and are no
    // skills, so their names could only load a same-named skill from somewhere else (step-11 security review)
    skills: r.setup?.pluginProject ? ROUTING.pluginProjectSkills : [],
    protectedRoots: (await staticsOf(h)).protectedRoots, publish: TYPESCRIPT.publish,
    ...(red ? { redScope: red } : {}), ...(r.setup ? { journalDir: r.setup.journalDir } : {}), ...(s.s2b ? { s2b: s.s2b } : {}), ...(f.mode ? { permissionMode: f.mode } : {}),
  }
}

/** This session's branch ('' on a detached HEAD); the lock names it. */
export async function branchOf(h: FlowHost): Promise<string> {
  const r = await git(h.io, (await staticsOf(h)).rootReal, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return r.exitCode === 0 ? r.stdout.trim() : ''
}
/** Who holds the lock when this session takes it. */
export const holderOf = async (h: FlowHost): Promise<LockHolder> => ({ sessionId: h.sessionId, root: (await staticsOf(h)).rootReal, branch: await branchOf(h) })

const OUT_CAP = 4 * 1024 * 1024
type Ended = { code: number | null; signal: string | null }
type Spawned = AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> & { result: Promise<Ended>; return(value: Ended): Promise<unknown> }
/** A spawned child read to its end like `$.process.run` (4 Mi characters kept per stream), closed at `timeoutMs`, which
 * kills it and throws. Escape kills it too: the engine aborts the hook's loop (F30). */
export async function collectRun(run: Spawned, after: (ms: number, fn: () => void) => { cancel(): void }, timeoutMs: number): Promise<RunResult> {
  let late = false
  const timer = after(timeoutMs, () => { late = true; void run.return({ code: null, signal: 'timeout' }).catch(() => null) })
  const kept = { stdout: '', stderr: '' }, cut = { stdout: false, stderr: false }
  try {
    for await (const c of run) {
      const room = OUT_CAP - kept[c.stream].length
      if (c.text.length > room) cut[c.stream] = true
      if (room > 0) kept[c.stream] += c.text.slice(0, room)
    }
  } finally { timer.cancel() }
  if (late) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)
  const end = await run.result
  return { exitCode: end.code ?? 1, stdout: kept.stdout, stderr: kept.stderr, isStdoutTruncated: cut.stdout, isStderrTruncated: cut.stderr }
}

/** Records a blocked reason on the flow (the card shows it with the owner's exits). */
export async function blockFlow(h: FlowHost, flowId: string, blocked: Blocked): Promise<UpdateResult> {
  const out = await updateRecord(h.io, h.home, flowId, h.sessionId, r => withBlock(r, blocked))
  dropView()
  return out
}
