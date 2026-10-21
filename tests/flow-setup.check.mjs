// Real-tool checks for R2 step 10 (hooks/flow-setup.ts, hooks/stacks/python-runner.ts): the registry-URL check reads
// each value only inside its own /bin/sh, which prints names and never values (AC-STK-10, F19); the hash of the base
// interpreter's standard library (GAP-R2-0.6-7) leaves the base's site-packages out. Each run works in its own temp
// folder (TMPDIR is shared). Usage: node tests/flow-setup.check.mjs   (exits non-zero on the first failed check)
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, realpathSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const S = await import('../hooks/flow-setup.ts')
const P = await import('../hooks/stacks/python-runner.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-setup-check-')))
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

try {
  // the registry-URL check, with the real sh, printenv and grep
  const env = {
    PATH: '/usr/bin:/bin', PIP_INDEX_URL: 'https://u:s3cret@pypi.corp/simple', UV_INDEX: 'corp=https://__token__:pypi-x@pypi.corp/simple',
    PIP_EXTRA_INDEX_URL: 'https://pypi.corp/simple', UV_DEFAULT_INDEX: 'https://u@pypi.corp/simple', UV_INDEX_URL: 'https://pypi.corp/simple?q=a:b@c',
    PIP_FIND_LINKS: 'file:///tmp/wheels\nhttps://v:w0rd@links.corp/wheels', PIP_TRUSTED_URL: 'https://:pypi-x@pypi.corp/simple',
    PIP_EMAIL_URL: 'https://me@corp.com:t0k@pypi.corp/simple',
  }
  const names = Object.keys(env).filter(k => k !== 'PATH')
  const r = spawnSync('/bin/sh', ['-c', S.URL_AUTH_SCRIPT, 'sh', ...names], { env, encoding: 'utf8' })
  check('the URL check runs with the real tools', r.status === 0, r.stderr)
  check('only the names whose URL holds a password come back, then the end mark (an empty user or one holding @ too; a user alone, a query, a plain URL pass)', r.stdout === 'PIP_INDEX_URL\nUV_INDEX\nPIP_FIND_LINKS\nPIP_TRUSTED_URL\nPIP_EMAIL_URL\n=\n', JSON.stringify(r.stdout))
  // an inherited noexec runs nothing: the output then never carries the end mark of a full run (security review r4)
  for (const [what, script, args] of [['URL check', S.URL_AUTH_SCRIPT, ['PIP_INDEX_URL']], ['name listing', S.ENV_NAMES_SCRIPT, []]]) {
    const x = spawnSync('/bin/sh', ['-c', script, 'sh', ...args], { env: { ...env, SHELLOPTS: 'noexec' }, encoding: 'utf8' })
    check(`the ${what} under an inherited noexec ends with its mark only when it ran in full`, !x.stdout.endsWith('=\n') || (what === 'URL check' ? x.stdout === 'PIP_INDEX_URL\n=\n' : x.stdout.split('\n').includes('PATH')), JSON.stringify(x.stdout).slice(0, 200))
  }
  const dash = spawnSync('/bin/sh', ['-c', S.ENV_NAMES_SCRIPT], { env: { PATH: '/usr/bin:/bin', '-X_TOKEN': 't' }, encoding: 'utf8' })
  check('a name that starts with - is listed, not dropped as an option (security review r4)', dash.status === 0 && dash.stdout.split('\n').includes('-X_TOKEN'), JSON.stringify(dash))
  const traced = spawnSync('/bin/sh', ['-c', S.URL_AUTH_SCRIPT, 'sh', 'PIP_INDEX_URL'], { env: { ...env, SHELLOPTS: 'xtrace' }, encoding: 'utf8' })
  check('an inherited xtrace is turned off before any value is read (security review r2)', traced.status === 0 && /set \+xv/.test(traced.stderr) && !/s3cret/.test(traced.stderr), JSON.stringify(traced.stderr).slice(0, 300))
  check('no value leaves the child', !/s3cret|pypi-x|w0rd|corp/.test(r.stdout + r.stderr), r.stdout + r.stderr)
  const unset = spawnSync('/bin/sh', ['-c', S.URL_AUTH_SCRIPT, 'sh', 'PIP_NOT_SET_HERE'], { env, encoding: 'utf8' })
  check('a name that is not set fails the check instead of passing', unset.status === 3, String(unset.status))
  // grep failing (an error, or not there) fails the check too (security review r1)
  const stub = join(base, 'grep-err')
  writeFileSync(stub, '#!/bin/sh\nexit 2\n')
  chmodSync(stub, 0o755)
  for (const [what, grep] of [['errs', stub], ['is missing', join(base, 'no-such-grep')]]) {
    const x = spawnSync('/bin/sh', ['-c', S.URL_AUTH_SCRIPT.replace('/usr/bin/grep', grep), 'sh', 'PIP_INDEX_URL'], { env, encoding: 'utf8' })
    check(`the URL check fails when grep ${what}, printing no name`, x.status !== 0 && x.stdout === '', `${x.status} ${JSON.stringify(x.stdout)}`)
  }
  // the name listing keeps only variables that are set: a NAME= line inside a value is not a name (security review r1)
  const listed = spawnSync('/bin/sh', ['-c', S.ENV_NAMES_SCRIPT], { env: { PATH: '/usr/bin:/bin', X: 'a\nPIP_FAKE=https://u:p@h/simple', PIP_REAL: 'https://pypi.corp/simple' }, encoding: 'utf8' })
  const got = listed.stdout.split('\n')
  check('the name listing drops a NAME= line inside a value and keeps the names that are set', listed.status === 0 && !got.includes('PIP_FAKE') && got.includes('X') && got.includes('PIP_REAL'), JSON.stringify(listed))
  // a name with characters outside [A-Za-z0-9_] (npm's per-registry token) is listed: /bin/sh passes it on (security
  // review r3); a redirection that cannot be opened never drops the names as "not set"
  const npm = 'npm_config_//registry.npmjs.org/:_authToken'
  const odd = spawnSync('/bin/sh', ['-c', S.ENV_NAMES_SCRIPT], { env: { PATH: '/usr/bin:/bin', [npm]: 'tok', X: '1' }, encoding: 'utf8' })
  check('a name with / and : in it is listed', odd.status === 0 && odd.stdout.split('\n').includes(npm) && !/tok/.test(odd.stdout.replace(npm, '')), JSON.stringify(odd))
  const redirected = spawnSync('/bin/sh', ['-c', S.ENV_NAMES_SCRIPT.replace('>/dev/null', `>${join(base, 'no-such-dir/x')}`)], { env: { PATH: '/usr/bin:/bin', X: '1' }, encoding: 'utf8' })
  check('a redirection that fails never drops the names', redirected.status === 0 ? redirected.stdout.split('\n').includes('X') : redirected.stdout === '', JSON.stringify(redirected))
  // the name listing fails when sed or printenv fails, listing no name (reviews r2)
  for (const [tool, what] of [['/usr/bin/sed', 'errs'], ['/usr/bin/sed', 'is missing'], ['/usr/bin/printenv', 'errs']]) {
    const x = spawnSync('/bin/sh', ['-c', S.ENV_NAMES_SCRIPT.replace(tool, what === 'errs' ? stub : join(base, 'no-such-tool'))], { env: { PATH: '/usr/bin:/bin', X: '1' }, encoding: 'utf8' })
    check(`the name listing fails when ${tool.slice(9)} ${what}, listing no name`, x.status !== 0 && x.stdout === '', `${x.status} ${JSON.stringify(x.stdout)}`)
  }

  // the base interpreter's standard library: found from pyvenv.cfg, hashed without the base's site-packages
  const lib = join(base, 'py/lib/python3.14'), root = join(base, 'proj')
  for (const d of [join(base, 'py/bin'), join(lib, 'json'), join(lib, 'site-packages'), join(root, '.venv')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(lib, 'os.py'), 'x = 1\n')
  writeFileSync(join(lib, 'json/__init__.py'), '')
  writeFileSync(join(lib, 'site-packages/extra.py'), '')
  writeFileSync(join(root, '.venv/pyvenv.cfg'), `home = ${join(base, 'py/bin')}\nversion_info = 3.14.0\n`)
  const a = await P.baseLibraries(io, root, [])
  check('the base library is found from pyvenv.cfg and hashed', a.length === 1 && a[0].path === lib && /^[0-9a-f]{64}$/.test(a[0].hash ?? ''), JSON.stringify(a))
  writeFileSync(join(lib, 'site-packages/extra.py'), 'changed')
  check('a change in the base site-packages leaves the hash as it was', (await P.baseLibraries(io, root, []))[0]?.hash === a[0].hash)
  writeFileSync(join(lib, 'os.py'), 'x = 2\n')
  check('a change in the standard library changes the hash', (await P.baseLibraries(io, root, []))[0]?.hash !== a[0].hash)
  // a home whose interpreter is a link into a framework, as Homebrew's: the library is the link target's (code review r2)
  const fw = join(base, 'fw'), brew = join(base, 'brew'), root2 = join(base, 'proj2')
  for (const d of [join(fw, 'bin'), join(fw, 'lib/python3.14'), join(brew, 'bin'), join(root2, '.venv')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(fw, 'bin/python3.14'), '')
  writeFileSync(join(fw, 'lib/python3.14/os.py'), '')
  symlinkSync(join(fw, 'bin/python3.14'), join(brew, 'bin/python3.14'))
  writeFileSync(join(root2, '.venv/pyvenv.cfg'), `home = ${join(brew, 'bin')}\nversion = 3.14.0\n`)
  const linked = await P.baseLibraries(io, root2, [])
  check('a linked interpreter takes its library from the link target', linked.length === 1 && linked[0].path === join(fw, 'lib/python3.14') && /^[0-9a-f]{64}$/.test(linked[0].hash ?? ''), JSON.stringify(linked))
} finally {
  rmSync(base, { recursive: true, force: true })
}
