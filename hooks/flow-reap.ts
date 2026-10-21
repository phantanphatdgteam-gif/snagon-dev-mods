// Reaping judged runs (R2 step 7, GAP-R2-0.6-26): a judged command leads its own process group and records that group
// id; after the run the mod ends the group and checks that nothing the run started is still alive holding the root.
// Pure helpers (the launcher argv, parsing ps and lsof, the decisions) are tested in tests/flow-reap.test.ts; the real
// process behaviour in tests/flow-reap.check.mjs. Invariants:
//   - the group end and the survivor scan run before the run folder is removed, on every exit path (flow-run.ts);
//   - the mod signals only an integer > 1 that a marked member confirms (its own group holds no marked member, so it is
//     never signalled; a sandboxed run cannot join the mod's group, across sessions);
//   - a process that was already alive before the run never counts as a survivor, nor does one only the root scan found
//     that the host started itself (Claude Code's `caffeinate`, 535 trial M-1);
//   - process environments read for the marker stay in this module: only pids ever leave it.
import type { Io } from './session'

/** Set by the core in every judged run's environment to a value unique to the run; a stack line may not set it (it is in
 * CORE_ENV). A process still carrying it after the run belongs to the run. */
export const RUN_MARKER_VAR = 'SNAGON_FLOW_RUN'

// set -m makes the backgrounded command a process-group leader; its group id goes to the run folder. The group is ended
// from inside the sandbox when the command returns on its own (signalling the same sandbox is allowed); the mod ends it
// again after a stop, from outside, for anything the stop left behind. `kill` here is the shell builtin (no PATH lookup).
const LAUNCHER = 'set -m; "$@" & p=$!; echo "$p" > "$TMPDIR/pgid"; wait "$p"; r=$?; kill -KILL "-$p" 2>/dev/null; exit $r'
/** Wraps the judged argv so it leads its own group and writes the group id to `$TMPDIR/pgid` (TMPDIR is the run folder). */
export const launcherArgv = (argv: readonly string[]): string[] => ['/bin/sh', '-c', LAUNCHER, 'sh', ...argv]

const firstInts = (text: string): number[] =>
  text.split('\n').map(l => Number(l.trim().split(/\s+/)[0])).filter(n => Number.isInteger(n) && n > 0)

/** Pids alive now (`ps -axo pid=`): the set taken before a run, so its own pre-existing processes never count after it. */
export async function livePids(io: Io): Promise<Set<number>> {
  const r = await io.run(['/bin/ps', '-axo', 'pid='], { cwd: '/' }).catch(() => null)
  return new Set(r && r.exitCode === 0 ? firstInts(r.stdout) : [])
}
/** Process-group ids alive now (`ps -axo pgid=`): taken before a run, so no group that already existed — the mod's own,
 * the owner's shell job, any other — is ever ended, even if a marked member is in it (S-HIGH, step-7 security review). */
export async function livePgids(io: Io): Promise<Set<number>> {
  const r = await io.run(['/bin/ps', '-axo', 'pgid='], { cwd: '/' }).catch(() => null)
  return new Set(r && r.exitCode === 0 ? firstInts(r.stdout) : [])
}

/** From `ps -E -ww -axo pid=,pgid=,command=`: the pid and pgid of each process whose environment carries `marker` for
 * RUN_MARKER_VAR. Only these two integers are kept; the rest of the line (other processes' environments) is dropped. */
export function markedProcs(psText: string, marker: string): { pid: number; pgid: number }[] {
  if (!marker) return []
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|\\s)${RUN_MARKER_VAR}=${esc}(?=\\s|$)`) // the whole value, not a prefix of a longer one
  const out: { pid: number; pgid: number }[] = []
  for (const line of psText.split('\n')) {
    if (!re.test(line)) continue
    const m = /^\s*(\d+)\s+(\d+)\s/.exec(line)
    if (m) out.push({ pid: Number(m[1]), pgid: Number(m[2]) })
  }
  return out
}

/** Pids from `lsof -nP -w -Fpn` with any path (cwd or an open file) at or under `rootReal`. The -F output is a `p<pid>`
 * line then `n<path>` lines until the next `p`. */
export function pidsUnderRoot(lsofText: string, rootReal: string): number[] {
  const under = rootReal.endsWith('/') ? rootReal : `${rootReal}/`
  const out = new Set<number>()
  let pid = 0
  for (const line of lsofText.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1)) || 0
    else if (line[0] === 'n' && pid > 0) { const p = line.slice(1); if (p === rootReal || p.startsWith(under)) out.add(pid) }
  }
  return [...out]
}

/** The group id to end after a stop, or null to signal nothing: an integer > 1 (0, 1 and negatives are special to kill)
 * that did NOT exist before the run (`beforeGroups`) and that a marked member confirms. Excluding pre-existing groups is
 * what keeps the mod's own group, the owner's shell job and every other prior group from ever being signalled, even
 * though the launcher's `/bin/sh` carries the marker and shares the mod's group (the pgid file is untrusted). */
export function groupToEnd(pgidFile: string, marked: readonly { pgid: number }[], beforeGroups: ReadonlySet<number>): number | null {
  // an empty before-set means the pgid scan failed; fail closed (a live system always has groups) so the confirmation
  // can never stand in for the exclusion the scan was meant to provide (round-2 security review)
  if (beforeGroups.size === 0) return null
  const pgid = Number((/^\s*(\d+)/.exec(pgidFile) ?? [])[1])
  if (!Number.isInteger(pgid) || pgid <= 1 || beforeGroups.has(pgid)) return null
  return marked.some(m => m.pgid === pgid) ? pgid : null
}

/** Survivors of a run: every marked process (its unique marker proves it is this run's, so a reused pid in the
 * before-set never hides it), plus processes holding the root that were not alive before the run and that are not the
 * host's own children (`hostKids`). Pids only, sorted. */
export function survivorPids(o: {
  marked: readonly { pid: number }[]; underRoot: readonly number[]; before: ReadonlySet<number>; hostKids: ReadonlySet<number>
}): number[] {
  const all = new Set<number>([...o.marked.map(m => m.pid), ...o.underRoot.filter(pid => !o.before.has(pid) && !o.hostKids.has(pid))])
  return [...all].sort((a, b) => a - b)
}

/** The couldNotRun detail for a run that left a process behind: pids only (never a command line or an environment). */
export const reapDetail = (pids: readonly number[]): string => `a process the judged command started is still active (pid ${pids.join(', ')})`

// ps/lsof/kill run from `/`, never the mod's cwd: the mod is launched from the project root, so a child that inherited
// that cwd would list its own cwd as under the root and count itself a survivor (step-7 code review). Each has a time
// limit so a blocked scan cannot leave reapRun pending and the run folder unremoved (round-2 security review).
const REAP_TIMEOUT_MS = 10_000
const AT_ROOT = { cwd: '/', timeoutMs: REAP_TIMEOUT_MS }
// null (not []) when the scan could not complete — rejected, timed out, wrong exit, or output truncated at 4 MiB
// (`ps -E` prints every owned process's environment and can pass that on a busy machine): the caller must fail closed,
// never read a scan that did not finish as "no survivors" (round-3 security review).
async function psMarked(io: Io, marker: string): Promise<{ pid: number; pgid: number }[] | null> {
  const r = await io.run(['/bin/ps', '-E', '-ww', '-axo', 'pid=,pgid=,command='], AT_ROOT).catch(() => null)
  return r && r.exitCode === 0 && !r.isStdoutTruncated ? markedProcs(r.stdout, marker) : null
}
async function lsofUnderRoot(io: Io, rootReal: string): Promise<number[] | null> {
  const r = await io.run(['/usr/sbin/lsof', '-nP', '-w', '-b', '-Fpn'], AT_ROOT).catch(() => null)
  return r && r.exitCode <= 1 && !r.isStdoutTruncated ? pidsUnderRoot(r.stdout, rootReal) : null
}
// The host (the Claude Code process the mod runs in) starts children of its own while a judged run is under way, with
// the root as their cwd: `caffeinate -i -t 300` during a long run (535 trial, M-1). A judged process is never one: it
// descends from the launcher, and is reparented to launchd once the launcher has exited. `$.process` starts argv with no
// shell between, so `$PPID` of the mod's own child is the host (probe on 2.1.304); BSD pgrep leaves out its own
// ancestors, that child among them. A scan that fails reads as none, so the survivor report only grows.
// ASSUMPTION(GAP-R2-0.6-138): only the host's direct children are left out; its grandchildren still count.
async function hostChildren(io: Io): Promise<Set<number>> {
  const r = await io.run(['/bin/sh', '-c', '/usr/bin/pgrep -P "$PPID"'], AT_ROOT).catch(() => null)
  return new Set(r && r.exitCode === 0 ? firstInts(r.stdout) : [])
}
/** The pgid file as text, but only when it is a small regular file, and read through a time-limited child so a FIFO a
 * surviving process swaps in (after the kind/size check, before the read) cannot block: the judged run can write the
 * run folder (`reportText` guards the same folder). Anything else reads as '' and nothing is signalled. */
async function pgidFileText(io: Io, runDir: string): Promise<string> {
  const item = (await io.list(runDir).catch(() => [])).find(i => i.name === 'pgid')
  if (!item || item.kind !== 'file' || item.size > 32) return ''
  const r = await io.run(['/usr/bin/head', '-c', '32', `${runDir}/pgid`], AT_ROOT).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : ''
}

/**
 * After a judged run, on every exit path and before the run folder is removed: end the run's own process group (only a
 * group that did not exist before the run and that a marked member confirms), end each marked process the run left (its
 * unique marker proves it is this run's), and report every survivor so the run is never trusted. Tools by absolute path
 * (NK-02). `before`/`beforeGroups` are the pid and pgid sets taken just before the run. Returns the survivor pids.
 */
export async function reapRun(io: Io, runDir: string, rootReal: string, marker: string, before: ReadonlySet<number>, beforeGroups: ReadonlySet<number>): Promise<number[]> {
  // the group end fails safe on a failed scan ([] → no confirmed member → nothing signalled); the survivor report fails
  // closed: a scan that did not finish throws, and judgedRun turns that into couldNotRun, so the run is never trusted.
  const end = groupToEnd(await pgidFileText(io, runDir), (await psMarked(io, marker)) ?? [], beforeGroups)
  if (end !== null) await io.run(['/bin/kill', '-KILL', `-${end}`], AT_ROOT).catch(() => null)
  const marked = await psMarked(io, marker)
  if (marked === null) throw new Error('the survivor scan (ps) did not finish')
  // the cwd/open-file scan means something only with a before-set to subtract (it would otherwise flag the owner's
  // shell, whose cwd is the root); without one, trust the marker alone.
  let underRoot: number[] = [], hostKids = new Set<number>()
  if (before.size) { const u = await lsofUnderRoot(io, rootReal); if (u === null) throw new Error('the survivor scan (lsof) did not finish'); underRoot = u; hostKids = await hostChildren(io) }
  const survivors = survivorPids({ marked, underRoot, before, hostKids })
  // GAP-R2-0.6-83: end the marked survivors too (not only the one named group), so a retry does not inherit a daemon
  // the run started in its own session; a process found only by lsof is reported, not signalled (we are less sure). One
  // signal call for all of them, so the pid-reuse window between the scan and the signal stays small (round-2 review).
  const toEnd = marked.map(m => m.pid).filter(p => !before.has(p))
  if (toEnd.length) await io.run(['/bin/kill', '-KILL', ...toEnd.map(String)], AT_ROOT).catch(() => null)
  return survivors
}
