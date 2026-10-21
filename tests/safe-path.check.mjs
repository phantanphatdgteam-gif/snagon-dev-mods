// Real-process check for hooks/safe-path.ts (NK-02, plan 0.5.4 step 1): programs planted in <root>/bin, first on the
// host PATH, never run while the mod's git and runner hash run with the filtered PATH; with the host PATH as it is, they
// do (the control). Usage: node tests/safe-path.check.mjs   (macOS; exits non-zero on the first failed check)
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, lstatSync, rmSync, realpathSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const { filteredPath } = await import('../hooks/safe-path.ts')
const { childEnvWith, ioOf, resetSafeEnv, funcNamesOf, ENV_LIST_ARGV } = await import('../hooks/engine-io.ts')
const G = await import('../hooks/flow-git.ts')
const { runnerHash } = await import('../hooks/stacks/typescript-sources.ts')
const { ENV_NAMES_SCRIPT } = await import('../hooks/flow-setup.ts')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'safe-path-check-')))
const marks = join(root, 'marks')
const PLANTED = ['git', 'find', 'sort', 'xargs', 'readlink']
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }
const ioWith = path => ({
  read: async p => readFileSync(p, 'utf8'), write: async (p, t) => writeFileSync(p, t), exists: async p => existsSync(p),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: 0, mtimeMs: lstatSync(join(d, e.name)).mtimeMs })),
  // as engine-io.ts ioOf does: a bare name through env; over the host's environment, the caller's variables, the shell's
  // start-up variables empty and the filtered PATH whatever PATH the caller gives (childEnvWith)
  run: async (argv, init = {}) => {
    const a = argv[0].includes('/') ? argv : ['/usr/bin/env', ...argv]
    const r = spawnSync(a[0], a.slice(1), { cwd: init.cwd, env: { ...process.env, ...childEnvWith(path, init.env) }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 })
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
  now: async () => Date.now(), pluginRoot: root,
})
const planted = () => (existsSync(marks) ? readdirSync(marks).sort() : [])
// a host for engine-io.ts's own ioOf: $.process.run sets init.env over the host's environment, as the engine does
// (checked in a real session, owner decision after step 11)
const hostOf = () => ({
  fs: { ...ioWith(''), stat: async p => { try { return { realPath: realpathSync(p) } } catch { return null } } },
  settings: { read: async () => ({}) }, session: { root: async () => root }, plugin: { root }, clock: { now: async () => Date.now() },
  env: { get: async name => process.env[name] },
  process: { run: async (argv, init = {}) => { const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 }); return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } } },
})
const fresh = () => { rmSync(marks, { recursive: true, force: true }); mkdirSync(marks) }
async function runMod(path) {
  rmSync(marks, { recursive: true, force: true })
  const io = ioWith(path), p = await G.gitPaths(io, root)
  await G.flowTree(io, p, 'worktree', 'check')
  await runnerHash(io, root, ['vitest'])
  return planted()
}

try {
  spawnSync('git', ['init', '-q', root])
  writeFileSync(join(root, 'a.txt'), 'a\n')
  mkdirSync(join(root, 'node_modules/vitest/dist'), { recursive: true })
  writeFileSync(join(root, 'node_modules/vitest/package.json'), '{"name":"vitest","dependencies":{}}')
  writeFileSync(join(root, 'node_modules/vitest/dist/index.js'), 'export {}\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nbin/\nmarks/\n')
  mkdirSync(join(root, 'bin'))
  for (const name of PLANTED) {
    const real = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(root, 'bin', name), `#!/bin/sh\nmkdir -p '${marks}' && : > '${marks}/${name}'\nexec '${real}' "$@"\n`)
    chmodSync(join(root, 'bin', name), 0o755)
  }
  const host = `${root}/bin:${process.env.PATH}`
  const safe = await filteredPath(host, { root, tmp: tmpdir(), home: homedir(), extra: [] }, async p => { try { return realpathSync(p) } catch { return undefined } })
  check('the planted folder is dropped from the PATH', safe.dropped.includes(`${root}/bin`) && !safe.path.split(':').includes(`${root}/bin`), JSON.stringify(safe.dropped))
  const control = await runMod(host)
  check('control: with the host PATH as it is, the planted programs run', control.includes('git') && control.includes('find'), JSON.stringify(control))
  const filtered = await runMod(safe.path)
  check('with the filtered PATH, no planted program runs (git, flowTree, runnerHash)', filtered.length === 0, JSON.stringify(filtered))
  rmSync(marks, { recursive: true, force: true })
  await ioWith(safe.path).run(['git', '--version'], { env: { PATH: host } })
  check('a caller that passes its own PATH still gets the filtered one', planted().length === 0, JSON.stringify(planted()))
  // the owner's own environment (owner decision, step 11): bash, macOS's /bin/sh, reads SHELLOPTS and BASHOPTS as it
  // starts, and BASH_ENV and ENV name a file to run; with SHELLOPTS=noexec every sh -c exits 0 having run nothing
  const ranMark = join(root, 'bash-env-ran'), startFile = join(root, 'start.sh'); writeFileSync(startFile, `: > '${ranMark}'\n`)
  const hostile = { SHELLOPTS: 'noexec:xtrace', BASHOPTS: 'xpg_echo', BASH_ENV: startFile, ENV: startFile }
  const ctl = spawnSync('/bin/sh', ['-c', 'echo ok'], { env: { ...process.env, ...hostile }, encoding: 'utf8' })
  const ctlBash = spawnSync('/bin/bash', ['-c', 'true'], { env: { ...process.env, BASH_ENV: startFile }, encoding: 'utf8' })
  check('control: with that environment as it is, sh -c runs nothing and bash runs the BASH_ENV file', ctl.status === 0 && ctl.stdout === '' && ctlBash.status === 0 && existsSync(ranMark))
  rmSync(ranMark, { force: true })
  const io = ioWith(safe.path), p = await G.gitPaths(io, root)
  const clean = [await G.flowTree(io, p, 'worktree', 'clean'), await runnerHash(io, root, ['vitest'])]
  Object.assign(process.env, hostile)
  // the io before this change (the caller's variables and the PATH only), for the control on the mod's own code path
  const oldIo = { ...io, run: async (argv, init = {}) => { const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env, PATH: safe.path }, input: init.stdin, encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20 }); return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } } }
  let under, old
  try {
    under = [await G.flowTree(io, p, 'worktree', 'hostile'), await runnerHash(io, root, ['vitest'])]
    old = await runnerHash(oldIo, root, ['vitest']).catch(e => `threw: ${String(e).slice(0, 80)}`)
  } finally { for (const k of Object.keys(hostile)) delete process.env[k] }
  check('control: without the reset, the runner hash under that environment is not the real one', old !== clean[1], JSON.stringify([clean[1], old]))
  check('with it in the host environment, the mod\'s children get those variables empty: the same tree and runner hashes, the file never runs', JSON.stringify(under) === JSON.stringify(clean) && !existsSync(ranMark), JSON.stringify([clean, under]))
  // exported functions (owner decision after step 11): bash, macOS's /bin/sh, defines a function from each
  // BASH_FUNC_<name>%% as it starts, over a builtin (cd, printf) or a command found on PATH (find)
  const funcs = { 'BASH_FUNC_find%%': `() { : > '${marks}/fn-find'; echo forged; }`, 'BASH_FUNC_printf%%': `() { : > '${marks}/fn-printf'; builtin printf "$@"; }`, 'BASH_FUNC_cd%%': `() { : > '${marks}/fn-cd'; builtin cd "$@"; }` }
  resetSafeEnv()
  const ioClean = ioOf(hostOf())
  const cleanFn = [await G.flowTree(ioClean, await G.gitPaths(ioClean, root), 'worktree', 'fn-clean'), await runnerHash(ioClean, root, ['vitest'])]
  fresh()
  const ctlFn = spawnSync('/bin/sh', ['-c', 'cd / && printf ok'], { env: { ...process.env, ...funcs }, encoding: 'utf8' })
  check('control: with those functions in the environment, sh runs them for cd and printf', ctlFn.stdout === 'ok' && planted().join() === 'fn-cd,fn-printf', JSON.stringify([ctlFn.stdout, planted()]))
  Object.assign(process.env, funcs)
  let oldFn, listed, underFn
  try {
    fresh()
    await ioWith(safe.path).run(['/bin/sh', '-c', ENV_NAMES_SCRIPT])
    const namesMarks = planted()
    fresh()
    oldFn = { namesMarks, hash: await runnerHash(ioWith(safe.path), root, ['vitest']).catch(e => `threw: ${String(e).slice(0, 80)}`), marks: planted() }
    listed = funcNamesOf((await hostOf().process.run(ENV_LIST_ARGV)))
    resetSafeEnv(); fresh()
    const io = ioOf(hostOf())
    const names = await io.run(['/bin/sh', '-c', ENV_NAMES_SCRIPT]), nested = await io.run(['/bin/sh', '-c', '/bin/sh -c "cd / && printf ok"'])
    underFn = { hashes: [await G.flowTree(io, await G.gitPaths(io, root), 'worktree', 'fn-hostile'), await runnerHash(io, root, ['vitest'])], names: names.exitCode === 0 && names.stdout.endsWith('=\n'), nested: nested.stdout, marks: planted() }
  } finally { for (const k of Object.keys(funcs)) delete process.env[k]; resetSafeEnv() }
  check('control: without the function reset, the env-name script runs printf as the function, and the runner hash is forged by find', oldFn.namesMarks.includes('fn-printf') && oldFn.hash !== cleanFn[1] && oldFn.marks.includes('fn-find'), JSON.stringify([cleanFn[1], oldFn]))
  check('awk lists every function name of the environment', Object.keys(funcs).every(n => listed.includes(n)), JSON.stringify(listed))
  check('with them in the host environment, ioOf gives each child every function name empty: the same hashes, the env-name script ends, a grandchild shell too, no function runs', JSON.stringify(underFn.hashes) === JSON.stringify(cleanFn) && underFn.names && underFn.nested === 'ok' && underFn.marks.length === 0, JSON.stringify([cleanFn, underFn]))
  // every place the mod starts a process passes childEnv (engine-io.ts), so no child gets the host's shell variables
  const spawns = spawnSync('/usr/bin/grep', ['-rnE', '\\$\\.process\\.(run|spawn)\\(', join(import.meta.dirname, '../hooks')], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  // as its env, and all three sites known today (engine-io ioOf, flow-wiring runLong, register's journal tail); the one
  // other site is the names listing childEnv waits for, an awk child with the shell reset and the PATH (childEnvWith)
  const viaChildEnv = spawns.filter(l => /env:\s*await childEnv\(/.test(l)), listing = spawns.filter(l => /engine-io\.ts:\d+:.*\$\.process\.run\(ENV_LIST_ARGV, \{ env: childEnvWith\(/.test(l))
  check('every $.process.run and $.process.spawn in hooks/ passes childEnv as its env, but the names listing', spawns.length === 4 && viaChildEnv.length === 3 && listing.length === 1, spawns.join('\n'))
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`${n} checks passed`)
