// Real-git checks for hooks/flow-refs.ts (R2 plan step 9): A1 keeps the flow's trees through a real `git gc --prune=now`
// with refs under refs/snagon/flow/<id8>/ that the owner's daily git commands do not show (AC-A1-1); a tree lost anyway
// comes back as lost, never as a git error (AC-A1-2); NK-10 names the refs moved outside the flow. Each run works in its
// own temp folder (TMPDIR is shared). Usage: node tests/flow-refs.check.mjs   (exits non-zero on the first failed check)
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, lstatSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const G = await import('../hooks/flow-git.ts')
const R = await import('../hooks/flow-refs.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-refs-check-')))
process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Check\n\temail = check@example.invalid\n')
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
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env })
const sh = (cwd, ...args) => { const r = git(cwd, ...args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const has = (cwd, oid) => git(cwd, 'cat-file', '-e', oid).status === 0
/** What the owner sees day to day (AC-A1-1). */
const daily = cwd => ['log --all --oneline', 'status --porcelain', 'branch -a', 'tag'].map(c => sh(cwd, ...c.split(' '))).join('\n--\n')
const ID = 'a1b2c3d4', KEPT = `refs/snagon/flow/${ID}/`

try {
  const A = join(base, 'repo'); mkdirSync(A); sh(A, 'init', '-q', '-b', 'main')
  writeFileSync(join(A, 'a.ts'), 'export const a = 1\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'one')
  const P = await G.gitPaths(io, A), head = sh(A, 'rev-parse', 'HEAD')
  sh(A, 'branch', 'keep') // the owner's other branch
  writeFileSync(join(A, 'b.ts'), 'export const b = 2\n') // the RED run's change, never committed
  const red = await G.flowTree(io, P, 'worktree', 'r1')
  writeFileSync(join(A, 'c.ts'), 'export const c = 3\n') // the author's change, reviewed
  const round = await G.flowTree(io, P, 'worktree', 'r2')
  rmSync(join(A, 'c.ts')); rmSync(join(A, 'b.ts'))
  const seen = daily(A)

  check('the flow trees are loose objects no ref reaches (what gc used to prune)', has(A, red) && has(A, round) && !sh(A, 'for-each-ref').includes(red))
  check('keepTrees keeps them: nothing lost', (await R.keepTrees(io, P, ID, { start: red, round })).length === 0)
  check('the refs point straight at the trees', sh(A, 'rev-parse', `${KEPT}start`) === red && sh(A, 'cat-file', '-t', `${KEPT}round`) === 'tree')
  check('AC-A1-1: git log --all, status, branch -a and tag show nothing new', daily(A) === seen)
  sh(A, 'gc', '--prune=now', '-q')
  check('AC-A1-1: the kept trees survive a real git gc --prune=now', has(A, red) && has(A, round))
  check('AC-A1-1: after gc the daily commands still show nothing new', daily(A) === seen)
  check('git fsck stays clean (no dangling tree)', !/dangling/.test(git(A, 'fsck').stdout + git(A, 'fsck').stderr))
  check('a commit is reachable already: no ref is made for it (git log --all would walk it)', (await R.keepTrees(io, P, ID, { start: red, round, first: head })).length === 0 && git(A, 'rev-parse', '--verify', '-q', `${KEPT}first`).status !== 0)

  sh(A, 'update-ref', '-d', `${KEPT}round`) // deleted by hand
  sh(A, 'gc', '--prune=now', '-q')
  check('a tree whose ref was deleted by hand is pruned by gc', !has(A, round) && has(A, red))
  check('present() says the pruned tree is gone and the kept one is there', !(await R.present(io, P, round)) && (await R.present(io, P, red)))
  let lost
  try { lost = await R.keepTrees(io, P, ID, { start: red, round }) } catch (err) { lost = String(err) }
  check('AC-A1-2: the pruned tree comes back lost, not as a git error', Array.isArray(lost) && lost.join() === 'round', String(lost))
  check('AC-A1-2: the base anchor is the baseline commit while it exists', (await R.baseOf(io, P, { frozen: { baseSha: head } })) === head)
  const empty = await R.baseOf(io, P, { frozen: { baseSha: 'none' } })
  check('AC-A1-2: without a base commit the anchor is the empty tree, which git diffs from', sh(A, 'cat-file', '-t', empty) === 'tree' && git(A, 'diff', '--name-only', empty, red).stdout.split('\n').includes('b.ts'))

  // a symbolic ref under the prefix (planted): deleting the flow's refs never follows it to the branch
  sh(A, 'symbolic-ref', `${KEPT}prev`, 'refs/heads/keep')
  await R.dropTrees(io, P, ID)
  check('dropTrees deletes every ref of the flow in one transaction', sh(A, 'for-each-ref', 'refs/snagon/') === '')
  check('dropTrees never follows a symbolic ref: the branch it named stays', sh(A, 'rev-parse', 'refs/heads/keep') === head)
  check('after the end the daily commands are as before the flow', daily(A) === seen)

  // NK-10 with real git: every ref but the flow branch, the remote-tracking refs and the flow's own refs
  sh(A, 'checkout', '-q', '-b', 'flow'); sh(A, 'tag', 'v1'); sh(A, 'update-ref', 'refs/remotes/origin/main', head)
  await R.keepTrees(io, P, ID, { start: red })
  const frozen = R.refsFrozen(await R.refsNow(io, P, 'flow', ID))
  const changed = async () => R.refsChanged(frozen, await R.refsNow(io, P, 'flow', ID))
  writeFileSync(join(A, 'd.ts'), 'export const d = 4\n'); sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'flow work')
  const two = sh(A, 'rev-parse', 'HEAD')
  sh(A, 'update-ref', 'refs/remotes/origin/main', two) // a fetch
  await R.keepTrees(io, P, ID, { start: red, red: await G.flowTree(io, P, 'worktree', 'r3') })
  check('NK-10: commits on the flow branch, a fetch and the kept trees moving change nothing', (await changed()) === null)
  sh(A, 'branch', '-f', 'main', two); sh(A, 'tag', '-f', 'v1', two)
  check('NK-10: git branch -f main and git tag -f are named', JSON.stringify(await changed()) === JSON.stringify(['refs/heads/main', 'refs/tags/v1']))
  sh(A, 'branch', '-f', 'main', head); sh(A, 'tag', '-f', 'v1', head)
  check('NK-10: both back where they were frozen: no change', (await changed()) === null)
  sh(A, 'branch', 'twin', head); sh(A, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/keep') // keep and twin: one commit
  const symFrozen = R.refsFrozen(await R.refsNow(io, P, 'flow', ID))
  sh(A, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/twin')
  check('NK-10: a symbolic ref given another target at the same object is named', JSON.stringify(R.refsChanged(symFrozen, await R.refsNow(io, P, 'flow', ID))) === JSON.stringify(['refs/heads/alias']))
  await R.dropTrees(io, P, ID)

  // a kept-ref folder that is a symbolic link to the branches: refused before any ref is listed or written
  const heads = sh(A, 'for-each-ref', 'refs/heads/'), OTHER = 'b2c3d4e5', L = join(A, '.git', 'refs', 'snagon', 'flow', OTHER)
  mkdirSync(join(A, '.git', 'refs', 'snagon', 'flow'), { recursive: true }); symlinkSync(join(A, '.git', 'refs', 'heads'), L)
  const refused = async f => { try { await f(); return '' } catch (err) { return String(err) } }
  const keepErr = await refused(() => R.keepTrees(io, P, OTHER, { start: red })), dropErr = await refused(() => R.dropTrees(io, P, OTHER))
  check('a kept-ref folder that is a symbolic link is refused, and the branches stay', /not a plain folder/.test(keepErr) && /not a plain folder/.test(dropErr) && sh(A, 'for-each-ref', 'refs/heads/') === heads, `${keepErr} | ${dropErr}`)
  rmSync(L)
  mkdirSync(L); symlinkSync(join(A, '.git', 'refs', 'heads'), join(L, 'x')) // a linked folder one level inside the prefix
  const keepErr2 = await refused(() => R.keepTrees(io, P, OTHER, { start: red })), dropErr2 = await refused(() => R.dropTrees(io, P, OTHER))
  check('a linked folder inside the prefix is refused, and the branches stay', /not a ref flow writes/.test(keepErr2) && /not a ref flow writes/.test(dropErr2) && sh(A, 'for-each-ref', 'refs/heads/') === heads, `${keepErr2} | ${dropErr2}`)
  rmSync(join(L, 'x')); rmSync(L, { recursive: true })
  console.log(`\nall ${n} checks passed`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
