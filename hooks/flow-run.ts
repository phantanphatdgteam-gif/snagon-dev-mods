// Judged runs (plan v7.1 §5.1, F30): an approved command run outside Claude Code's sandbox, in the judge's: a fresh run
// folder as its TMPDIR and report folder, the project's tool caches moved into it first, the runner's JSON report asked
// for when it can be, sandbox-exec with the judge profile, an empty environment and the PATH frozen at S2; the folder is
// removed after. Before every judged run the command sources and the runner code must be as frozen at S2.
import { hashOf } from './session'
import { gitPaths } from './flow-git'
import { cacheFiles, commandSources, runnerHash, scriptNames } from './flow-sources'
import { judgedArgv, runJudged, MAX_RUN_MS, type RunOutput } from './flow-judge'
import { flowDenyRead, judgeArgv, judgeProfile } from './flow-sandbox'
import { readReport, type Report } from '../flow/parse'
import { realOf, staticsOf, type FlowHost } from './flow-host'
import { beat } from './flow-spend'
import { safePath, TEMP_PLACES } from './safe-path'
import type { FlowCommand, FlowRecord } from './flow-state'
import { TYPESCRIPT } from '../flow/data/stacks'

/** `report`: absent when none was asked for; null when one was asked for and is missing or unreadable. */
export type Judged = { ok: true; run: RunOutput; report?: Report | null } | { ok: false; reason: 'tooSlow' | 'couldNotRun'; detail: string }

/** The npm package that holds each runner, for the runner hash. */
const RUNNER_PACKAGE: Readonly<Record<string, string>> = { tsc: 'typescript' }
export const runnerPackages = (commands: readonly FlowCommand[]): string[] => [...new Set(commands.map(c => RUNNER_PACKAGE[c.runner] ?? c.runner))]

/** What changed since S2 (or the last accepted change) among the command sources (by name, `git:config` included) and
 * the runner code (`runner`), with the sources as they are now: their hashes, those reached through an import or a
 * script, and those a setup chain pulls in. */
export type Drift = { changed: string[]; now: Record<string, string>; reached: string[]; setupChain: string[] }
export async function sourcesDrift(h: FlowHost, r: FlowRecord): Promise<Drift> {
  const p = await gitPaths(h.io, r.root), commands = r.setup?.commands ?? []
  const src = await commandSources(h.io, p, commands.map(c => c.argv)), now = src.hashes
  const frozen = Object.fromEntries(Object.entries(r.frozen).filter(([k]) => k.startsWith('src:')).map(([k, v]) => [k.slice(4), v]))
  const changed = [...new Set([...Object.keys(now), ...Object.keys(frozen)])].filter(k => now[k] !== frozen[k]).sort()
  if ((await runnerHash(h.io, p.top, runnerPackages(commands))) !== r.frozen.runner) changed.push('runner')
  return { changed, now, reached: src.reached, setupChain: src.setupChain }
}

async function scriptBody(h: FlowHost, root: string, argv: readonly string[]): Promise<string | undefined> {
  const name = scriptNames([argv])[0]
  if (name === undefined) return undefined
  const pkg: unknown = JSON.parse(await h.io.read(`${root}/package.json`).catch(() => '{}'))
  const body = typeof pkg === 'object' && pkg !== null ? (pkg as { scripts?: Record<string, unknown> }).scripts?.[name] : undefined
  return typeof body === 'string' ? body : undefined
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
  const paths = frozenSandboxList(r, 'denyRead') ?? [...TYPESCRIPT.sandbox.denyRead, ...flowDenyRead(h.home, h.claudeDir)]
  return [...new Set(await Promise.all(paths.map(x => realOf(h, tilde(h, x)))))]
}

const couldNotRun = (detail: string): Judged => ({ ok: false, reason: 'couldNotRun', detail })
/** One judged run of an approved command, killed at `timeoutMs` (or when the person interrupts). */
export async function judgedRun(h: FlowHost, r: FlowRecord, cmd: FlowCommand, timeoutMs = MAX_RUN_MS): Promise<Judged> {
  if (!(await staticsOf(h)).darwin) return couldNotRun('the judge sandbox needs macOS (sandbox-exec)')
  const p = await gitPaths(h.io, r.root)
  const made = await h.io.run(['/bin/sh', '-c', 'd=$(/usr/bin/mktemp -d "$1/flow-run.XXXXXX") && cd "$d" && pwd -P', 'sh', (h.env.TMPDIR || '/tmp').replace(/\/+$/, '')])
  const runDir = made.stdout.trim()
  if (made.exitCode !== 0 || !runDir.startsWith('/')) return couldNotRun(`no run folder (${made.stderr.trim().slice(0, 200)})`)
  try {
    for (const f of await cacheFiles(h.io, p)) {
      // F30: an edited cache would change results with no diff, so caches leave the project before the run.
      if ((await h.io.run(['/bin/mv', '-f', `${p.top}/${f}`, `${runDir}/cache-${hashOf(f)}`])).exitCode !== 0) return couldNotRun(`the cache ${f} could not be moved out of the project`)
    }
    const j = judgedArgv(cmd.argv, cmd.runner, runDir, await scriptBody(h, r.root, cmd.argv))
    const profile = judgeProfile({ root: r.root, tmpDir: runDir, commonDir: await realOf(h, p.commonDir), denyRead: await denyReadOf(h, r), loopbackPorts: TYPESCRIPT.loopbackPorts })
    // the frozen PATH, filtered again: a record frozen before 0.5.4 holds the host PATH as it was (NK-02)
    const env = { PATH: safePath(r.frozen['env.PATH'] ?? h.env.PATH, [r.root, h.env.TMPDIR, ...TEMP_PLACES].filter(Boolean)).path, HOME: h.home, TMPDIR: runDir, ...(h.env.LANG ? { LANG: h.env.LANG } : {}), ...(h.env.TZ ? { TZ: h.env.TZ } : {}), emptyConfig: `${h.io.pluginRoot}/flow/empty.npmrc` }
    const io = { ...h.io, run: (argv: string[], init?: { cwd?: string; timeoutMs?: number }) => h.runLong(argv, { ...(init?.cwd ? { cwd: init.cwd } : {}), timeoutMs: init?.timeoutMs ?? timeoutMs }) }
    await beat(h, true) // plan line 233: the heartbeat before and after every judge run
    const res = await runJudged(io, judgeArgv(profile, j.argv, env), r.root, timeoutMs)
    if (!res.ok) return res
    return j.reportFile === null ? { ok: true, run: res.run } : { ok: true, run: res.run, report: readReport(await h.io.read(j.reportFile).catch(() => ''), r.root) }
  } catch (err) { return couldNotRun(String(err).slice(0, 300)) } finally { await h.io.run(['/bin/rm', '-rf', runDir]).catch(() => null); await beat(h, true).catch(() => null) }
}
