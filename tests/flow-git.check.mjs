// Real-git checks for hooks/flow-git.ts, hooks/gate.ts publishReason and the judge profile (plan v7.1 step 3
// acceptance). Runs git and sandbox-exec in a temp folder; the user's global git config is replaced by a temp file for
// the whole run. Usage: node tests/flow-git.check.mjs   (macOS; exits non-zero on the first failed check)
import { registerHooks } from 'node:module'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, lstatSync, rmSync, realpathSync, utimesSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const G = await import('../hooks/flow-git.ts')
const { publishReason } = await import('../hooks/gate.ts')
const S = await import('../hooks/flow-sandbox.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-git-check-')))
process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Check\n\temail = check@example.invalid\n')
const HOME = join(base, 'home'); mkdirSync(HOME)
const io = {
  read: async p => readFileSync(p, 'utf8'),
  write: async (p, t) => writeFileSync(p, t),
  exists: async p => existsSync(p),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: 0, mtimeMs: lstatSync(join(d, e.name)).mtimeMs })),
  run: async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 })
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
  now: async () => Date.now(),
  pluginRoot: base,
}
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const put = (p, t) => { mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); writeFileSync(p, t) }
let daemon = null
const token = `ghp_${'A1b2C3d4'.repeat(4)}EfGh` // shaped like a GitHub token, built at run time

try {
  const A = join(base, 'repo'); mkdirSync(A); sh(A, 'init', '-q', '-b', 'main')
  put(join(A, 'src/a.ts'), 'export const a = 1\n'); put(join(A, 'docs/flow/plan.md'), '# plan\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'one')
  const P = await G.gitPaths(io, A)
  check('paths come from git (common dir, index)', P.commonDir === join(A, '.git') && P.index === join(A, '.git/index'))
  const indexBefore = readFileSync(P.index)
  const head = await G.flowTree(io, P, 'head', 't1'), work = await G.flowTree(io, P, 'worktree', 't2')
  check('a clean worktree has the same flow tree as HEAD (a tracked excluded file is left out of both)', head === work)
  put(join(A, 'docs/flow/verify.md'), 'v\n'); put(join(A, '.snagon/journal/x.md'), 'j\n'); put(join(A, '.claude/settings.local.json'), '{}\n'); put(join(A, 'docs/flow/plan.md'), '# plan v2\n')
  check('verify.md, the journal, settings.local.json and plan.md do not change the tree', (await G.flowTree(io, P, 'worktree', 't3')) === head)
  put(join(A, 'src/b.ts'), 'export const b = 2\n')
  check('a new source file changes the tree', (await G.flowTree(io, P, 'worktree', 't4')) !== head)
  check('the real index is untouched and no temp index is left', Buffer.compare(indexBefore, readFileSync(P.index)) === 0 && !readdirSync(P.commonDir).some(f => f.includes('.flow-')))

  const WT = join(base, 'wt'); sh(A, 'worktree', 'add', '-q', '-b', 'feature', WT)
  const PW = await G.gitPaths(io, WT)
  check('a linked worktree shares the common dir and has its own git dir', PW.commonDir === P.commonDir && PW.gitDir !== P.gitDir && PW.top === WT)
  check('the flow tree works in a linked worktree', (await G.flowTree(io, PW, 'worktree', 't5')) === (await G.flowTree(io, PW, 'head', 't6')))

  put(join(A, '.gitignore'), 'node_modules/\ndist/\n*.log\n*.tsbuildinfo\n.snagon/\n'); put(join(A, 'node_modules/x/i.js'), '1'); put(join(A, 'dist/o.js'), '1'); put(join(A, 'debug.log'), '1'); put(join(A, 'a.tsbuildinfo'), '1')
  const skip = { dirs: ['node_modules', 'dist/', 'coverage/'], globs: ['*.tsbuildinfo'] }
  const ig = await G.ignoredSet(io, P, skip)
  check('the ignored set leaves out dependencies, build output and flow data', JSON.stringify(ig.names) === JSON.stringify(['debug.log']), JSON.stringify(ig.names))
  put(join(A, 'trace.log'), '1')
  check('a new ignored file changes the ignored set', (await G.ignoredSet(io, P, skip)).hash !== ig.hash)

  const c0 = await G.cfgHash(io, A, P, HOME)
  sh(A, 'config', 'core.editor', 'vi'); const c1 = await G.cfgHash(io, A, P, HOME)
  check('H_cfg changes with .git/config and names it', c1.hash !== c0.hash && c1.parts[join(P.commonDir, 'config')] !== c0.parts[join(P.commonDir, 'config')])
  put(join(P.commonDir, 'hooks/pre-push'), '#!/bin/sh\n'); const c2 = await G.cfgHash(io, A, P, HOME)
  check('H_cfg changes when a hook appears', c2.hash !== c1.hash)
  put(join(HOME, 'inc.gitconfig'), '[core]\n\tpager = less\n'); sh(A, 'config', 'include.path', '~/inc.gitconfig')
  const c3 = await G.cfgHash(io, A, P, HOME); put(join(HOME, 'inc.gitconfig'), '[core]\n\tpager = cat\n'); const c4 = await G.cfgHash(io, A, P, HOME)
  check('H_cfg follows include.path into the included file', c3.hash !== c4.hash && join(HOME, 'inc.gitconfig') in c4.parts)
  put(join(A, '.claude/settings.json'), '{"hooks":{}}\n')
  check('H_cfg covers the project Claude settings', (await G.cfgHash(io, A, P, HOME)).hash !== c4.hash)
  // NK-01: husky 9 points core.hooksPath at .husky/_, which it ignores itself; git runs those files for the owner's commits
  sh(A, 'config', 'core.hooksPath', '.husky/_'); put(join(A, '.husky/_/.gitignore'), '*'); put(join(A, '.husky/_/h'), '#!/bin/sh\n'); put(join(A, '.husky/_/pre-commit'), '#!/bin/sh\n. "$(dirname "$0")/h"\n')
  const k0 = await G.cfgHash(io, A, P, HOME); put(join(A, '.husky/_/h'), '#!/bin/sh\necho planted\n'); const k1 = await G.cfgHash(io, A, P, HOME)
  check('H_cfg covers the core.hooksPath folder though git ignores it (husky 9 .husky/_) and names the file', k1.hash !== k0.hash && k1.parts[join(A, '.husky/_/h')] !== k0.parts[join(A, '.husky/_/h')])
  sh(A, 'config', 'core.hooksPath', '/dev/null')
  check('a hooksPath that is not a folder (/dev/null) is taken as it is, not an error', (await G.cfgHash(io, A, P, HOME)).hash !== k1.hash)
  sh(A, 'config', 'core.hooksPath', '.husky/_')
  const target = join(dirname(A), 'hook-target.sh'), hk = name => join(A, '.husky/_', name)
  writeFileSync(target, '#!/bin/sh\n'); symlinkSync(target, hk('pre-push')); spawnSync('/usr/bin/mkfifo', [hk('pipe')]); symlinkSync(join(A, '.husky'), hk('up'))
  const l0 = await G.cfgHash(io, A, P, HOME); writeFileSync(target, '#!/bin/sh\necho planted\n'); const l1 = await G.cfgHash(io, A, P, HOME); rmSync(target)
  check('in the hooks folder a link to a file is read through; a FIFO and a link to a folder are named, never opened',
    l1.parts[hk('pre-push')] !== l0.parts[hk('pre-push')] && l0.parts[hk('pipe')] === 'Fifo File' && l0.parts[hk('up')] === `Directory -> ${join(A, '.husky')}`,
    JSON.stringify([l0.parts[hk('pipe')], l0.parts[hk('up')], l0.parts[hk('pre-push')]]))
  sh(A, 'config', '--unset', 'core.hooksPath')
  const globalText = readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, `${globalText}[core]\n\thooksPath = .githooks\n`); put(join(A, '.githooks/pre-commit'), '#!/bin/sh\n')
  const g1 = await G.cfgHash(io, A, P, HOME)
  check('a relative hooksPath from the user\'s global config is read against the worktree top', join(A, '.githooks/pre-commit') in g1.parts)
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, `${globalText}[core]\n\thooksPath = many\n`); mkdirSync(join(A, 'many'))
  for (let i = 0; i <= 5000; i += 1) writeFileSync(join(A, 'many', `f${i}`), '')
  const capped = await G.cfgHash(io, A, P, HOME).then(() => '', e => String(e))
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, globalText); for (const d of ['.husky', '.githooks', 'many']) rmSync(join(A, d), { recursive: true })
  check('a hooks folder over the cap is an error that names the cap', /5000/.test(capped), capped)

  check('the flow tree still works once .snagon is ignored (it always is in a real project)', (await G.flowTree(io, P, 'worktree', 'g1')) === (await G.flowTree(io, P, 'worktree', 'g2')))
  const U = join(base, 'unborn'); mkdirSync(U); sh(U, 'init', '-q'); put(join(U, 'a.txt'), 'a\n')
  const PU = await G.gitPaths(io, U)
  check('a repository without commits: HEAD is the empty tree and the worktree is not', (await G.flowTree(io, PU, 'head', 'u1')) === '4b825dc642cb6eb9a060e54bf8d69288fbee4904' && (await G.flowTree(io, PU, 'worktree', 'u2')) !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  const N = join(A, 'src/vendor'); mkdirSync(N, { recursive: true }); sh(N, 'init', '-q'); put(join(N, 'v.js'), 'x\n'); sh(N, 'add', '-A'); sh(N, 'commit', '-q', '-m', 'v')
  const nested = await G.flowTree(io, P, 'worktree', 'n1').then(() => 'no error', e => String(e))
  check('a nested repository the tree cannot see is an error, not a quiet gitlink', /nested repository appeared at src\/vendor/.test(nested), nested)
  rmSync(N, { recursive: true, force: true })
  const SRC = join(base, 'lib-src'); mkdirSync(SRC); sh(SRC, 'init', '-q'); put(join(SRC, 'l.js'), 'l\n'); sh(SRC, 'add', '-A'); sh(SRC, 'commit', '-q', '-m', 'l')
  const X = join(base, 'with-sub'); mkdirSync(X); sh(X, 'init', '-q'); put(join(X, 'a.txt'), 'a\n'); sh(X, 'add', '-A'); sh(X, 'commit', '-q', '-m', 'a'); sh(X, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', SRC, 'lib'); sh(X, 'commit', '-q', '-m', 'sub')
  const PX = await G.gitPaths(io, X)
  const trap = join(base, 'filter-ran') // a clean filter the agent could plant in the submodule: it must never run
  sh(join(X, 'lib'), 'config', 'filter.trap.clean', `touch ${trap}; cat`); put(join(X, 'lib/.gitattributes'), '* filter=trap\n')
  utimesSync(join(X, 'lib/l.js'), new Date(Date.now() + 5000), new Date(Date.now() + 5000)) // same bytes, new time: git must re-hash it through the filter
  const checkedOut = await G.flowTree(io, PX, 'worktree', 's1').then(() => 'no error', e => String(e))
  check('a checked-out submodule is an error: git never runs inside it and its files are unseen', /submodule lib is checked out/.test(checkedOut), checkedOut)
  check('no git command ran inside the submodule (its planted clean filter never fired)', !existsSync(trap))
  const ti = join(PX.commonDir, 'index.check.tmp'); await G.git(io, X, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: ti } })
  await G.git(io, X, ['add', '-A', '--', '.', ':(exclude,literal)lib'], { env: { GIT_INDEX_FILE: ti } }); rmSync(ti, { force: true })
  check('even if a folder is swapped after the check, add with the gitlink excluded never enters it', !existsSync(trap))
  const T2 = join(base, 'nested-trap'); mkdirSync(join(X, 'tools')); sh(join(X, 'tools'), 'init', '-q'); put(join(X, 'tools/t.js'), 't\n'); sh(join(X, 'tools'), 'add', '-A'); sh(join(X, 'tools'), 'commit', '-q', '-m', 't')
  sh(join(X, 'tools'), 'config', 'filter.trap.clean', `touch ${T2}; cat`); put(join(X, 'tools/.gitattributes'), '* filter=trap\n'); utimesSync(join(X, 'tools/t.js'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  sh(X, 'submodule', 'deinit', '-q', '-f', 'lib')
  const nestedNew = await G.flowTree(io, PX, 'worktree', 's4').then(() => 'no error', e => String(e))
  mkdirSync(join(X, 'deep/inner'), { recursive: true }); sh(join(X, 'deep/inner'), 'init', '-q'); put(join(X, 'deep/inner/z.js'), 'z\n'); put(join(X, 'deep/y.js'), 'y\n')
  const deep = await G.flowTree(io, PX, 'worktree', 's5').then(() => 'no error', e => String(e))
  check('a nested repository two levels down inside an untracked folder is refused too', /nested repository appeared at deep\/inner/.test(deep), deep)
  rmSync(join(X, 'deep'), { recursive: true, force: true })
  check('a new nested repository (with a commit, a planted filter and a touched file) is refused and git ran nothing inside it', /nested repository appeared at tools/.test(nestedNew) && !existsSync(T2), nestedNew)
  rmSync(join(X, 'tools'), { recursive: true, force: true })
  rmSync(join(X, 'lib'), { recursive: true, force: true }); symlinkSync(join(base, 'elsewhere'), join(X, 'lib'))
  const linked = await G.flowTree(io, PX, 'worktree', 's6').then(() => 'no error', e => String(e))
  check('a submodule path replaced by a link (even a dangling one) is refused, not skipped', /is not a folder/.test(linked), linked)
  rmSync(join(X, 'lib')); mkdirSync(join(X, 'lib'))
  check('an uninitialised submodule (empty folder) is fine', (await G.flowTree(io, PX, 'worktree', 's2')) === (await G.flowTree(io, PX, 'head', 's3')))
  sh(A, 'config', 'includeIf.gitdir:/tmp/My Dir/.path', '~/inc2.gitconfig'); put(join(HOME, 'inc2.gitconfig'), '[core]\n\tpager = more\n')
  check('an includeIf key with a space in it still leads H_cfg to its file', join(HOME, 'inc2.gitconfig') in (await G.cfgHash(io, A, P, HOME)).parts)
  process.env.GIT_DIR = '/nonexistent'; process.env.GIT_CONFIG_PARAMETERS = "'user.name'='Injected'"
  const injected = await G.git(io, A, ['config', 'user.name']); const injectedPaths = await G.gitPaths(io, A).then(x => x.top, e => String(e))
  delete process.env.GIT_DIR; delete process.env.GIT_CONFIG_PARAMETERS
  check('git variables inherited from the host (GIT_DIR, GIT_CONFIG_PARAMETERS) do not reach hardened calls', injectedPaths === A && injected.stdout.trim() !== 'Injected', injectedPaths + ' / ' + injected.stdout)
  sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'two')
  const R = join(base, 'remote.git'); sh(base, 'init', '-q', '--bare', R)
  // The remote is served over git:// on loopback: flow refuses local and file remotes (their hooks would run unsandboxed).
  const port = await new Promise(r => { const t = createServer().listen(0, '127.0.0.1', () => { const n = t.address().port; t.close(() => r(n)) }) })
  daemon = spawn('git', ['daemon', '--reuseaddr', '--listen=127.0.0.1', `--port=${port}`, `--base-path=${base}`, '--export-all', '--enable=receive-pack', base], { stdio: 'ignore', env: process.env })
  const RURL = `git://127.0.0.1:${port}/remote.git`
  for (let i = 0; i < 50 && spawnSync('git', ['ls-remote', RURL], { env: process.env }).status !== 0; i += 1) await new Promise(r => setTimeout(r, 100))
  sh(A, 'remote', 'add', 'origin', RURL)
  const freeze = async () => ({ remote: 'origin', branch: 'main', hCfg: (await G.cfgHash(io, A, P, HOME)).hash, facts: await G.pushFacts(io, P, 'origin') })
  let frozen = await freeze()
  const echo = await G.release(io, A, P, HOME, frozen, false)
  check('the release echo scans a branch the remote does not have yet', echo.ok, JSON.stringify(echo))
  const pushed = await G.release(io, A, P, HOME, { ...frozen, revsHash: echo.revsHash }, true)
  check('the release push lands and the remote points at HEAD', pushed.ok && sh(R, 'rev-parse', 'main') === sh(A, 'rev-parse', 'HEAD'), JSON.stringify(pushed))

  put(join(A, 'src/key.ts'), `export const k = "${token}"\n`); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'add key')
  put(join(A, 'src/key.ts'), 'export const k = process.env.K\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'remove key')
  const mid = await G.release(io, A, P, HOME, frozen, false)
  check('a secret only in an intermediate commit is caught', !mid.ok && mid.reason === 'publish' && /possible secret in src\/key\.ts/.test(mid.detail), JSON.stringify(mid).slice(0, 200))
  sh(A, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const moved = await G.release(io, A, P, HOME, frozen, false)
  check('a moved refs/remotes/* does not shrink the range (the real remote tip is used)', !moved.ok && moved.reason === 'publish')
  check('the Bash guard path (publishReason with --remotes) is fooled by the moved ref, which is why release never uses it', (await publishReason(G.hardenedRead(io, A), ['HEAD', '--not', '--remotes'])) === null)

  sh(A, 'reset', '-q', '--hard', 'HEAD~2'); sh(A, 'checkout', '-q', '-b', 'side'); put(join(A, 'src/s.ts'), 'export const s = 1\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'side')
  sh(A, 'checkout', '-q', 'main'); put(join(A, 'src/m.ts'), 'export const m = 1\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'main')
  sh(A, 'merge', '-q', '--no-commit', 'side'); put(join(A, 'src/merge-only.ts'), `export const t = "${token}"\n`); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'merge')
  const merged = await publishReason(G.hardenedRead(io, A), ['HEAD', '--not', sh(R, 'rev-parse', 'main')])
  check('content that exists only in a merge commit is scanned (first parent)', merged !== null && /merge-only\.ts/.test(merged))
  sh(A, 'reset', '-q', '--hard', sh(R, 'rev-parse', 'main'))
  writeFileSync(join(A, 'src/blob.bin'), Buffer.concat([Buffer.from(`k="${token}"\n`), Buffer.from([0, 1, 2])])); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'bin')
  sh(A, 'rm', '-q', 'src/blob.bin'); sh(A, 'commit', '-q', '-m', 'unbin')
  const bin = await G.release(io, A, P, HOME, frozen, false)
  check('a secret in a file git calls binary is still scanned', !bin.ok && bin.reason === 'publish' && /blob\.bin/.test(bin.detail), JSON.stringify(bin).slice(0, 200))
  sh(A, 'reset', '-q', '--hard', sh(R, 'rev-parse', 'main'))
  put(join(A, 'we"ird/.env'), 'A=1\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'q'); sh(A, 'rm', '-q', '-r', 'we"ird'); sh(A, 'commit', '-q', '-m', 'unq')
  const quoted = await publishReason(G.hardenedRead(io, A), ['HEAD', '--not', sh(R, 'rev-parse', 'main')])
  check('a private file whose path git would quote is still named', quoted !== null && /private path: we"ird\/\.env/.test(quoted), String(quoted))
  sh(A, 'reset', '-q', '--hard', sh(R, 'rev-parse', 'main'))
  // M-10 (535 trial): a .pem of certificates alone is released; a key in it, now or earlier in the range, is not
  const certPem = ['-----BEGIN CERTIFICATE-----', 'MIIB'.repeat(16), 'AA==', '-----END CERTIFICATE-----', ''].join('\n')
  const keyPem = ['-----BEGIN EC ' + 'PRIVATE KEY-----', 'MHcC'.repeat(16), '-----END EC ' + 'PRIVATE KEY-----', ''].join('\n')
  put(join(A, 'tests/fixtures/ca.pem'), certPem); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'ca')
  const ca = await G.release(io, A, P, HOME, frozen, false)
  check('a .pem of certificates alone is released (M-10)', ca.ok === true, JSON.stringify(ca).slice(0, 300))
  put(join(A, 'tests/fixtures/ca.pem'), certPem + keyPem); sh(A, 'commit', '-q', '-am', 'ca and key')
  const both = await G.release(io, A, P, HOME, frozen, false)
  check('a .pem that also holds a private key is refused (M-10)', !both.ok && both.reason === 'publish' && /private path: tests\/fixtures\/ca\.pem/.test(both.detail), JSON.stringify(both).slice(0, 300))
  put(join(A, 'tests/fixtures/ca.pem'), certPem); sh(A, 'commit', '-q', '-am', 'ca again')
  const earlier = await G.release(io, A, P, HOME, frozen, false)
  check('a key earlier in the range is refused though HEAD holds certificates alone (M-10)', !earlier.ok && earlier.reason === 'publish' && /tests\/fixtures\/ca\.pem/.test(earlier.detail), JSON.stringify(earlier).slice(0, 300))
  sh(A, 'reset', '-q', '--hard', sh(R, 'rev-parse', 'main'))
  // security review of M-10: a repository diff prefix and a name with a space do not hide what the range added
  sh(A, 'config', 'diff.dstPrefix', 'z/')
  put(join(A, 'tests/fixtures/my ca.pem'), 'db_password=hunter2-prod\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'leak')
  put(join(A, 'tests/fixtures/my ca.pem'), certPem); sh(A, 'commit', '-q', '-am', 'cert')
  const spaced = await publishReason(G.hardenedRead(io, A), ['HEAD', '--not', sh(R, 'rev-parse', 'main')], { headTree: true })
  check('text added earlier in the range is read under a repo diff prefix and a name with a space (M-10 review)', spaced !== null && /private path: tests\/fixtures\/my ca\.pem/.test(spaced), String(spaced))
  sh(A, 'config', '--unset', 'diff.dstPrefix'); sh(A, 'reset', '-q', '--hard', sh(R, 'rev-parse', 'main'))

  frozen = await freeze()
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8') + '[url "https://example.invalid/"]\n\tinsteadOf = origin-alias:\n')
  const glob = await G.release(io, A, P, HOME, frozen, false)
  check('a change to the global url/credential keys after setup blocks the release', !glob.ok && glob.reason === 'remoteChanged' && /globalKeys/.test(glob.detail), JSON.stringify(glob))
  sh(A, 'config', 'credential.helper', 'store'); frozen = await freeze()
  const cred = await G.release(io, A, P, HOME, frozen, false)
  check('a repository credential helper blocks the release', !cred.ok && cred.reason === 'remoteChanged' && /credential\.helper/.test(cred.detail))
  sh(A, 'config', 'include.path', '../tools/git.inc'); put(join(A, 'tools/git.inc'), '[core]\n\tabbrev = 8\n'); frozen = await freeze()
  const incl = await G.release(io, A, P, HOME, frozen, false)
  check('a config include that points into the worktree blocks the release', !incl.ok && incl.reason === 'tampered' && /include points into a folder Bash can write/.test(incl.detail), JSON.stringify(incl))
  sh(A, 'config', '--unset', 'include.path', '../tools/git.inc'); rmSync(join(A, 'tools'), { recursive: true, force: true })
  const globalBefore = readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')
  put(join(A, 'tools/user.inc'), '[core]\n\tabbrev = 7\n')
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, `${globalBefore}[include]\n\tpath = ${join(A, 'tools/user.inc')}\n`); frozen = await freeze()
  const userInc = await G.release(io, A, P, HOME, frozen, false)
  check('a global config include in a folder Bash can write blocks the release', !userInc.ok && userInc.reason === 'tampered' && /config file the push reads is in a folder Bash can write/.test(userInc.detail), JSON.stringify(userInc))
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, `${globalBefore}[include]\n\tpath = ${join(A, 'tools/later.inc')}\n`); rmSync(join(A, 'tools'), { recursive: true, force: true }); frozen = await freeze()
  const later = await G.release(io, A, P, HOME, frozen, false)
  check('a global include whose file does not exist yet, in a folder Bash can write, blocks the release', !later.ok && later.reason === 'tampered' && /later\.inc/.test(later.detail), JSON.stringify(later))
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, globalBefore); frozen = await freeze()
  sh(A, 'config', '--unset', 'credential.helper'); frozen = await freeze(); sh(A, 'config', 'core.abbrev', '9')
  check('a config change after setup is tampering', (await G.release(io, A, P, HOME, frozen, false)).reason === 'tampered')
  sh(A, 'config', '--unset', 'core.abbrev'); sh(A, 'remote', 'set-url', 'origin', 'https://ghp_abc@example.invalid/r.git')
  const tok = await freeze().then(() => 'frozen', e => String(e))
  check('a token in the remote URL is refused at setup, so it is never stored', /token/.test(tok) && !tok.includes('ghp_abc'), tok)
  sh(A, 'remote', 'set-url', 'origin', RURL)
  check('a URL with a token in it counts as a credential', G.urlProblem('https://u:tok@github.com/x/y.git') !== null && G.urlProblem('git@github.com:x/y.git') === null && G.urlProblem('https://github.com/x/y.git') === null)

  const first = sh(A, 'rev-list', '--max-parents=0', 'HEAD'); const BW = join(base, 'base-wt')
  const seen = await G.withBaseWorktree(io, P, first, BW, async dir => existsSync(join(dir, 'src/a.ts')) && !existsSync(join(dir, 'src/b.ts')))
  check('the baseline worktree checks out the base commit and is removed afterwards', seen && !existsSync(BW) && !sh(A, 'worktree', 'list').includes('base-wt'))

  if (process.platform === 'darwin') {
    const sock = join(base, 's.sock'); const server = createServer(c => c.end('hi')); await new Promise(r => server.listen(sock, r))
    const tmp = realpathSync(process.env.TMPDIR || '/tmp')
    const emptyConfig = join(dirname(fileURLToPath(import.meta.url)), '../flow/empty.npmrc')
    const profileOf = ports => S.judgeProfile({ root: A, tmpDir: tmp, commonDir: P.commonDir, denyRead: [join(HOME)], loopbackPorts: ports })
    const judgeWith = (profile, argv) => { const a = S.judgeArgv(profile, argv, { PATH: process.env.PATH, HOME, TMPDIR: tmp, stack: ['npm_config_userconfig=/dev/null', `npm_config_globalconfig=${emptyConfig}`] }); return spawnSync(a[0], a.slice(1), { cwd: A, encoding: 'utf8', timeout: 60000 }) }
    const judge = (...argv) => judgeWith(profileOf([]), argv)
    const npm = judge('npm', 'config', 'get', 'registry')
    check('judge: npm runs with the shipped empty global config', npm.status === 0, npm.stderr.slice(0, 200))
    check('judge: a protected name in another letter case (.VSCODE) cannot be created', judge('/bin/sh', '-c', 'mkdir -p .VSCODE && echo x > .VSCODE/t.json').status !== 0 && !existsSync(join(A, '.VSCODE')))
    check('judge: the terminal cannot be opened', judge('/bin/sh', '-c', 'cat /dev/tty').status !== 0)
    const sleeper = spawnSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim()
    const signalled = judge('/bin/kill', '-0', sleeper).status; spawnSync('/bin/kill', [sleeper])
    check('judge: a process outside the sandbox cannot be signalled', signalled !== 0)
    const serve = port => `const s=require('net').createServer(c=>c.end('hi')).listen(${port},'127.0.0.1',()=>{require('net').connect(${port},'127.0.0.1').on('data',d=>{console.log('LOOP '+d);s.close();process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(3)})}).on('error',e=>{console.log('LISTEN '+e.code);process.exit(4)})`
    check('judge: a declared test port works on loopback', /LOOP hi/.test(judgeWith(profileOf([5181]), [process.execPath, '-e', serve(5181)]).stdout))
    check('judge: an undeclared port does not', judgeWith(profileOf([5181]), [process.execPath, '-e', serve(5182)]).status !== 0)
    check('judge: writes inside the root work', judge('/bin/sh', '-c', 'echo ok > src/judged.txt').status === 0 && existsSync(join(A, 'src/judged.txt')))
    const outside = join(homedir(), `.flow-judge-leak-${process.pid}`) // the real home: outside the root and the temp folder
    const writes = { '.git/config': 'echo x >> .git/config', '.claude/': 'echo x > .claude/x.json', home: `echo x > ${outside}` }
    const wrote = Object.entries(writes).filter(([, c]) => judge('/bin/sh', '-c', c).status === 0).map(([k]) => k)
    if (existsSync(outside)) rmSync(outside)
    check('judge: .git/config, .claude/ and the home folder are not writable', wrote.length === 0, wrote.join(', '))
    // Q-3a narrow rule: os.link works inside the tree and the run folder (the project's own, e.g. 535 ingest); a link
    // whose source the run may not write (a protected path, a file outside the root) is refused by macOS itself, which
    // the control shows holds even with no file-link rule at all (NK-03).
    put(join(A, '.claude/settings.json'), '{}')
    check('judge: a hard link to a writable file inside the root is allowed', judge('/bin/sh', '-c', 'ln src/judged.txt hl-in').status === 0 && existsSync(join(A, 'hl-in')))
    check('judge: a hard link inside the run folder is allowed', judge('/bin/sh', '-c', 'd="$TMPDIR/reaplink.$$"; mkdir -p "$d" && echo z > "$d/src" && ln "$d/src" "$d/hl"').status === 0)
    const self = fileURLToPath(import.meta.url) // outside the root and the temp folder
    const links = { 'a protected file (.git/config)': 'ln .git/config hl-cfg', 'a protected dir (.claude)': 'ln .claude/settings.json hl-cl', 'a file outside the root': `ln ${JSON.stringify(self)} hl-out` }
    const made = Object.entries(links).filter(([, c]) => judge('/bin/sh', '-c', c).status === 0).map(([k]) => k)
    check('judge: no hard link can be made from a protected file or one outside the root', made.length === 0, made.join(', '))
    const noRule = judgeWith(profileOf([]).replace(/\(deny file-link\)[^\n]*\n/, ''), ['/bin/sh', '-c', 'ln .git/config hl-cfg2'])
    check('control: even with no file-link rule, macOS refuses a link to a file the run may not write', noRule.status !== 0, noRule.stderr.slice(0, 200))
    check('judge: a non-loopback connection is refused', judge('/usr/bin/curl', '-s', '-m', '5', 'https://example.com').status !== 0)
    const unix = judge(process.execPath, '-e', `require('net').connect(${JSON.stringify(sock)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(3)})`)
    check('judge: a unix socket is refused', unix.status !== 0 && !/CONNECTED/.test(unix.stdout), unix.stdout + unix.stderr)
    const launched = judge('/usr/bin/open', '-g', '-j', '-a', 'Calculator')
    if (launched.status === 0) spawnSync('/usr/bin/pkill', ['-x', 'Calculator'])
    check('judge: open -a cannot start an app outside the sandbox', launched.status !== 0, launched.stderr)
    check('judge: Apple Events do not reach other apps', judge('/usr/bin/osascript', '-e', 'tell application "Finder" to get name of startup disk').status !== 0)
    server.close()
  }
  console.log(`flow git check: ${n} ok`)
} finally { daemon?.kill(); rmSync(base, { recursive: true, force: true }) }
