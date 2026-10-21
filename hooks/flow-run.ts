// Judged runs (plan v7.1 §5.1, F30): an approved command run outside Claude Code's sandbox, in the judge's: a fresh run
// folder as its TMPDIR and report folder, the project's tool caches moved into it first, the runner's JSON report asked
// for when it can be, sandbox-exec with the judge profile, an empty environment and the PATH frozen at S2; the folder is
// removed after. Before every judged run the command sources and the runner code must be as frozen at S2. What is
// particular to a stack (its caches, report flags, environment, report reader) is its code's (hooks/stacks/).
import { hashOf } from './session'
import { gitPaths } from './flow-git'
import { runJudged, MAX_RUN_MS, type RunOutput } from './flow-judge'
import { flowDenyRead, judgeArgv, judgeProfile, stackDenyRead } from './flow-sandbox'
import { launcherArgv, livePids, livePgids, reapRun, reapDetail } from './flow-reap'
import type { Report } from '../flow/parse'
import { realOf, staticsOf, type FlowHost } from './flow-host'
import { beat } from './flow-spend'
import { safePath, TEMP_PLACES } from './safe-path'
import type { Blocked, FlowCommand, FlowRecord } from './flow-state'
import { stackOf } from './stacks/index'
import { TreeError, type RunnerState } from './flow-tree'

/** `report`: absent when none was asked for; null when one was asked for and is missing or unreadable. `tampered`: a
 * command source or the runner is not as the check left it (an earlier judged run of the step changed it). */
export type Judged = { ok: true; run: RunOutput; report?: Report | null } | { ok: false; reason: 'tooSlow' | 'couldNotRun' | 'tampered'; detail: string }
/** The block a failed judged run gives, naming its command. */
export function judgedBlock(cmd: FlowCommand, run: Extract<Judged, { ok: false }>, limit = 'its time limit'): Blocked {
  if (run.reason === 'tampered') return { reason: 'tampered', vars: { file: run.detail } }
  return run.reason === 'tooSlow' ? { reason: 'tooSlow', vars: { command: cmd.id, limit } } : { reason: 'couldNotRun', vars: { detail: `${cmd.id}: ${run.detail}` } }
}

/** The runner against its freeze (R2 step 6): `state` as it is now (none for a record frozen before 0.6.0, compared the
 * old way, GAP-R2-0.6-27); `error` when the tree cannot be pinned (a read error, a link out of it: S-13). */
export type RunnerDrift = { changed: boolean; state?: RunnerState; error?: string }
/** What changed since S2 (or the last accepted change) among the command sources (by name, `git:config` included), with
 * the sources as they are now: their hashes, those reached through an import or a script, and those a setup chain pulls
 * in; and the runner. */
export type Drift = { changed: string[]; now: Record<string, string>; reached: string[]; setupChain: string[]; runner: RunnerDrift }
export async function sourcesDrift(h: FlowHost, r: FlowRecord): Promise<Drift> {
  const p = await gitPaths(h.io, r.root), commands = r.setup?.commands ?? [], { code } = stackOf(r)
  const src = await code.commandSources(h.io, p, commands.map(c => c.argv)), now = src.hashes
  const frozen = Object.fromEntries(Object.entries(r.frozen).filter(([k]) => k.startsWith('src:')).map(([k, v]) => [k.slice(4), v]))
  const changed = [...new Set([...Object.keys(now), ...Object.keys(frozen)])].filter(k => now[k] !== frozen[k]).sort()
  return { changed, now, reached: src.reached, setupChain: src.setupChain, runner: await runnerDrift(h, r, p.top, commands) }
}
async function runnerDrift(h: FlowHost, r: FlowRecord, top: string, commands: readonly FlowCommand[]): Promise<RunnerDrift> {
  const { code } = stackOf(r), frozen = r.frozen['runner:v2']
  if (frozen === undefined) return { changed: !code.runnerV1 || (await code.runnerV1(h.io, top, commands)) !== r.frozen.runner }
  try {
    const state = await code.runnerIntegrity(h.io, top, commands, h.home)
    // a refusal of S1 seen now (a .pth path created since, a finder that leads out): the runner is not as approved
    const problem = state.problems[0]
    if (problem) return { changed: true, state, error: Object.values(problem.vars).join(' ') || problem.key }
    return { changed: state.hash !== frozen, state }
  } catch (err) {
    if (err instanceof TreeError) return { changed: true, error: `${err.path}${err.detail ? ` (${err.detail})` : ''}` }
    throw err
  }
}
/** A path list of the approved sandbox block (frozen at the first probe) as written, or null when it holds none. */
export function frozenSandboxList(r: FlowRecord, key: 'allowWrite' | 'denyRead'): string[] | null {
  let listed: unknown
  try { listed = (JSON.parse(r.frozen.sandbox ?? '{}') as { sandbox?: { filesystem?: Record<string, unknown> } }).sandbox?.filesystem?.[key] } catch { listed = undefined }
  return Array.isArray(listed) ? listed.filter((x): x is string => typeof x === 'string') : null
}
export const tilde = (h: FlowHost, x: string): string => (x === '~' || x.startsWith('~/') ? `${h.home}${x.slice(1)}` : x)
/** The folders the judge may not read: the approved block's denyRead (frozen with the sandbox), as realpaths. */
async function denyReadOf(h: FlowHost, r: FlowRecord): Promise<string[]> {
  const paths = frozenSandboxList(r, 'denyRead') ?? stackDenyRead(stackOf(r).data, flowDenyRead(h.home, h.claudeDir))
  return [...new Set(await Promise.all(paths.map(x => realOf(h, tilde(h, x)))))]
}

const couldNotRun = (detail: string): Judged => ({ ok: false, reason: 'couldNotRun', detail })
/** The most a runner's report may hold (the JUnit reader's own cap). */
const MAX_REPORT_BYTES = 16 * 1024 * 1024
/** The report a judged run wrote into its run folder, or '' (unreadable, so never a pass) when it is missing, is not a
 * plain file (a link to a device, a pipe) or is over MAX_REPORT_BYTES: the judged process could write that folder. */
async function reportText(h: FlowHost, file: string): Promise<string> {
  const at = file.lastIndexOf('/'), item = (await h.io.list(file.slice(0, at)).catch(() => [])).find(i => i.name === file.slice(at + 1))
  return item?.kind === 'file' && item.size <= MAX_REPORT_BYTES ? h.io.read(file).catch(() => '') : ''
}
/** One judged run of an approved command, killed at `timeoutMs` (or when the person interrupts). */
export async function judgedRun(h: FlowHost, r: FlowRecord, cmd: FlowCommand, timeoutMs = MAX_RUN_MS): Promise<Judged> {
  if (!(await staticsOf(h)).darwin) return couldNotRun('the judge sandbox needs macOS (sandbox-exec)')
  // F30, AC-STK-9: before every judged run, not once per check: a judged run can change the runner or a command source
  // for the next one and put it back after (code review, step 6)
  const drift = await sourcesDrift(h, r)
  if (drift.runner.changed) return { ok: false, reason: 'tampered', detail: drift.runner.error ?? stackOf(r).data.dependencyDirs[0] ?? 'runner' }
  if (drift.changed.length) return { ok: false, reason: 'tampered', detail: drift.changed[0] ?? '' }
  const p = await gitPaths(h.io, r.root)
  const made = await h.io.run(['/bin/sh', '-c', 'd=$(/usr/bin/mktemp -d "$1/flow-run.XXXXXX") && cd "$d" && pwd -P', 'sh', (h.env.TMPDIR || '/tmp').replace(/\/+$/, '')])
  const runDir = made.stdout.trim()
  if (made.exitCode !== 0 || !runDir.startsWith('/')) return couldNotRun(`no run folder (${made.stderr.trim().slice(0, 200)})`)
  const marker = runDir.slice(runDir.lastIndexOf('/') + 1) // unique to this run (the mktemp suffix); set in the judged env
  const before = await livePids(h.io) // pids alive before the run never count as survivors of it (GAP-R2-0.6-26)
  const beforeGroups = await livePgids(h.io) // groups alive before the run are never ended (the mod's own among them)
  const rootReal = (await staticsOf(h)).rootReal
  try {
    const { data, code } = stackOf(r)
    for (const f of await code.cacheFiles(h.io, p)) {
      // F30: an edited cache would change results with no diff, so caches leave the project before the run.
      if ((await h.io.run(['/bin/mv', '-f', `${p.top}/${f}`, `${runDir}/cache-${hashOf(f)}`])).exitCode !== 0) return couldNotRun(`the cache ${f} could not be moved out of the project`)
    }
    const j = code.judged(cmd.argv, cmd.runner, runDir, await code.judgeInput(h.io, r.root, cmd.argv), (r.frozen['runner:v2.load'] ?? '').split('\n').filter(Boolean))
    const profile = judgeProfile({ root: r.root, tmpDir: runDir, commonDir: await realOf(h, p.commonDir), denyRead: await denyReadOf(h, r), loopbackPorts: data.loopbackPorts })
    // the frozen PATH, filtered again: a record frozen before 0.5.4 holds the host PATH as it was (NK-02)
    const env = { PATH: safePath(r.frozen['env.PATH'] ?? h.env.PATH, [r.root, h.env.TMPDIR, ...TEMP_PLACES].filter(Boolean)).path, HOME: h.home, TMPDIR: runDir, ...(h.env.LANG ? { LANG: h.env.LANG } : {}), ...(h.env.TZ ? { TZ: h.env.TZ } : {}), marker, stack: code.judgeEnv({ pluginRoot: h.io.pluginRoot, runDir }) }
    const io = { ...h.io, run: (argv: string[], init?: { cwd?: string; timeoutMs?: number }) => h.runLong(argv, { ...(init?.cwd ? { cwd: init.cwd } : {}), timeoutMs: init?.timeoutMs ?? timeoutMs }) }
    await beat(h, true) // plan line 233: the heartbeat before and after every judge run
    const res = await runJudged(io, judgeArgv(profile, launcherArgv(j.argv), env), r.root, timeoutMs)
    // ASSUMPTION(GAP-R2-0.6-82): a run that leaves a process behind is never trusted, so a survivor outranks tooSlow and
    // a passing report. Reap (end the run's group, then scan) runs before the run folder is removed, on every path.
    let survivors: number[]
    try { survivors = await reapRun(h.io, runDir, rootReal, marker, before, beforeGroups) }
    catch (e) { return couldNotRun(`the survivor scan could not run: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`) }
    if (survivors.length) return couldNotRun(reapDetail(survivors))
    if (!res.ok) return res
    return j.reportFile === null ? { ok: true, run: res.run } : { ok: true, run: res.run, report: code.readReport(await reportText(h, j.reportFile), r.root, res.run) }
  } catch (err) {
    const survivors = await reapRun(h.io, runDir, rootReal, marker, before, beforeGroups).catch(() => [] as number[])
    return survivors.length ? couldNotRun(reapDetail(survivors)) : couldNotRun(String(err).slice(0, 300))
  } finally { await h.io.run(['/bin/rm', '-rf', runDir]).catch(() => null); await beat(h, true).catch(() => null) }
}
