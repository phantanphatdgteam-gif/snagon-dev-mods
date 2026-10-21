// Real-process check for hooks/flow-reap.ts (R2 step 7, GAP-R2-0.6-26; S-6). All fixtures are benign (a plain `sleep`):
// the launcher ends its own group on exit; reapRun ends a marked run's group; a process alive before a run is never a
// survivor while a new one holding the root is. The undetected class (a process that leaves its session and clears its
// environment) is a stated residual (F47-B, 0.9.0) and has no fixture here. Usage: node tests/flow-reap.check.mjs
// (macOS; exits non-zero on the first failed check).
import { registerHooks } from 'node:module'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const R = await import('../hooks/flow-reap.ts')

const io = {
  read: async p => readFileSync(p, 'utf8'),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => { const s = lstatSync(join(d, e.name)); return { name: e.name, kind: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs } }),
  run: async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 })
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
}
const base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-reap-check-')))
const started = []
const sleeper = (env = {}) => { const c = spawn('/bin/sh', ['-c', 'exec sleep 60'], { cwd: base, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' }); c.unref(); started.push(c.pid); return c.pid }
// a node leader for the marker test: ps -E can read a node process's environment but not a platform binary's (sleep),
// and detached makes it its own group leader (pgid === pid).
const nodeLeader = (env = {}) => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd: base, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' }); c.unref(); started.push(c.pid); return c.pid }
// a process whose parent has exited, so launchd adopts it: the shape a judged process has once the launcher returned
const orphan = () => { const r = spawnSync('/bin/sh', ['-c', '/bin/sleep 60 </dev/null >/dev/null 2>&1 & echo $!'], { cwd: base, encoding: 'utf8' }); const pid = Number(r.stdout.trim()); started.push(pid); return pid }
const alive = pid => spawnSync('/bin/kill', ['-0', String(pid)], { encoding: 'utf8' }).status === 0
const wait = ms => new Promise(r => setTimeout(r, ms))
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }

try {
  if (process.platform !== 'darwin') { console.log('flow reap check: skipped (not macOS)'); process.exit(0) }

  // 1. The launcher writes the group id and ends its own background child when the command returns (no sandbox needed).
  const d1 = mkdtempSync(join(base, 'run1-'))
  const wrapped = R.launcherArgv(['/bin/sh', '-c', 'sleep 60 & echo $! > child.pid'])
  spawnSync(wrapped[0], wrapped.slice(1), { cwd: d1, env: { ...process.env, TMPDIR: d1 }, encoding: 'utf8', timeout: 10000 })
  await wait(300)
  const child = Number(readFileSync(join(d1, 'child.pid'), 'utf8').trim())
  check('the launcher records the group id', existsSync(join(d1, 'pgid')) && Number(readFileSync(join(d1, 'pgid'), 'utf8').trim()) > 1)
  check('the launcher ends its background child when the command returns', !alive(child))

  // 2. reapRun ends the group of a run that is still marked (a benign node leader carrying a unique marker).
  const before2 = await R.livePids(io)
  const beforeG2 = await R.livePgids(io) // taken before the leader starts, so its new group is not pre-existing
  const MARK = `reapcheck2-${Date.now()}`
  const marked = nodeLeader({ [R.RUN_MARKER_VAR]: MARK })
  await wait(400)
  const d2 = mkdtempSync(join(base, 'run2-'))
  writeFileSync(join(d2, 'pgid'), String(marked)) // detached: pgid === pid
  const left2 = await R.reapRun(io, d2, base, MARK, before2, beforeG2)
  await wait(300)
  check('reapRun ends the marked run\'s group', !alive(marked))
  check('nothing marked remains, so no survivor', !left2.includes(marked))

  // 3. A process alive before the run is not a survivor; a new one whose cwd is under the root is, unless the host (this
  //    process, as Claude Code is for the mod) started it itself, as Claude Code starts caffeinate during a long run (M-1).
  const pre = sleeper(); await wait(300)
  const before3 = await R.livePids(io) // includes pre, not the next ones
  const beforeG3 = await R.livePgids(io)
  const fresh = orphan(), hostKid = sleeper(); await wait(300)
  const d3 = mkdtempSync(join(base, 'run3-'))
  writeFileSync(join(d3, 'pgid'), '') // no group to end
  const left3 = await R.reapRun(io, d3, base, 'no-such-marker', before3, beforeG3)
  check('a process alive before the run is not a survivor', !left3.includes(pre))
  check('a new process whose cwd is under the root is a survivor', fresh > 1 && left3.includes(fresh))
  check('a new direct child of the host whose cwd is under the root is not (M-1)', !left3.includes(hostKid))

  // 4. A pgid file that is not a small regular file (a FIFO) is not read: reapRun returns promptly and signals nothing.
  const d4 = mkdtempSync(join(base, 'run4-'))
  spawnSync('/usr/bin/mkfifo', [join(d4, 'pgid')])
  const before4 = await R.livePids(io), beforeG4 = await R.livePgids(io)
  const left4 = await Promise.race([R.reapRun(io, d4, base, 'none', before4, beforeG4), wait(8000).then(() => 'TIMEOUT')])
  check('a FIFO pgid file does not block reapRun', Array.isArray(left4))

  // 5. A marked daemon the run left in its own session (empty pgid file) is reported AND ended, not left for a retry.
  const before5 = await R.livePids(io), beforeG5 = await R.livePgids(io)
  const M5 = `reapcheck5-${Date.now()}`
  const daemon = nodeLeader({ [R.RUN_MARKER_VAR]: M5 })
  await wait(400)
  const d5 = mkdtempSync(join(base, 'run5-'))
  writeFileSync(join(d5, 'pgid'), '') // no group named, yet the marked daemon must still be ended (GAP-R2-0.6-83)
  const left5 = await R.reapRun(io, d5, base, M5, before5, beforeG5)
  await wait(300)
  check('a marked daemon with no group named is reported as a survivor', left5.includes(daemon))
  check('and the marked daemon is ended (a retry does not inherit it)', !alive(daemon))

  console.log(`flow reap check: ${n} ok`)
} finally {
  for (const pid of started) spawnSync('/bin/kill', ['-KILL', String(pid)], { encoding: 'utf8' })
  rmSync(base, { recursive: true, force: true })
}
