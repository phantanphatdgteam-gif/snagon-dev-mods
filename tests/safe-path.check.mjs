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
const G = await import('../hooks/flow-git.ts')
const { runnerHash } = await import('../hooks/flow-sources.ts')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'safe-path-check-')))
const marks = join(root, 'marks')
const PLANTED = ['git', 'find', 'sort', 'xargs', 'readlink']
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }
const ioWith = path => ({
  read: async p => readFileSync(p, 'utf8'), write: async (p, t) => writeFileSync(p, t), exists: async p => existsSync(p),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: 0, mtimeMs: lstatSync(join(d, e.name)).mtimeMs })),
  // as register.ts ioOf does: a bare name through env, and the filtered PATH whatever PATH the caller gives
  run: async (argv, init = {}) => {
    const a = argv[0].includes('/') ? argv : ['/usr/bin/env', ...argv]
    const r = spawnSync(a[0], a.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env, PATH: path }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 })
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
  now: async () => Date.now(), pluginRoot: root,
})
const planted = () => (existsSync(marks) ? readdirSync(marks).sort() : [])
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
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`${n} checks passed`)
