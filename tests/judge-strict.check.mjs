// F28 trial (R2 plan §4.6, AC-F28-1): the strict judge profile (judgeProfileStrict, inactive) under the real
// sandbox-exec. Always: it loads, a run's denials reach the system log under the run's tag, the live judge's closures
// hold under it, and flow never uses it. With FLOW_STRICT_TABLE=1 it also builds the TypeScript eval fixture
// (`run.sh fixture`) and a small Python fixture (a uv venv with pytest, ruff, mypy; needs the network or the caches),
// runs each stack's judged commands as the judge does under the live and the strict profile, and prints the AC-F28-1
// table for evals/flow/dry-run.md (GAP-R2-0.6-102…104).
// Usage: [FLOW_STRICT_TABLE=1] node tests/judge-strict.check.mjs   (macOS; exits non-zero on the first failed check)
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, lstatSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const S = await import('../hooks/flow-sandbox.ts')
const G = await import('../hooks/flow-git.ts')
const J = await import('../hooks/flow-judge.ts')
const R = await import('../hooks/flow-reap.ts')
const { safePath, TEMP_PLACES } = await import('../hooks/safe-path.ts')
const { TYPESCRIPT_STACK } = await import('../hooks/stacks/typescript.ts')
const { PYTHON_STACK } = await import('../hooks/stacks/python.ts')

const MOD = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'judge-strict-check-')))
const tmp = realpathSync(tmpdir())
process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig')
const io = {
  read: async p => readFileSync(p, 'utf8'), write: async (p, t) => writeFileSync(p, t), exists: async p => existsSync(p),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: lstatSync(join(d, e.name)).size, mtimeMs: lstatSync(join(d, e.name)).mtimeMs })),
  run: async (argv, init = {}) => { const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 }); if (r.error) throw r.error; return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } },
  now: async () => Date.now(), pluginRoot: base,
}
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }
const put = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t) }
const sh = (cwd, argv, env = {}) => spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 600000, maxBuffer: 64 << 20 })
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
let tags = 0
const newTag = () => `flowstrict${process.pid}n${(tags += 1)}`
const runFolders = []
/** A fresh run folder under the shared TMPDIR; the final cleanup removes every one, whatever failed. */
const runFolder = () => { const d = realpathSync(mkdtempSync(join(tmp, 'flow-run.'))); runFolders.push(d); return d }
const cleanup = () => { for (const d of [base, ...runFolders]) rmSync(d, { recursive: true, force: true }) }
// an interrupted run (a table run lasts minutes) still removes its folders: the steps run synchronously, so the handler
// runs where the table part yields to the event loop (`turn`), between its long steps
for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => { cleanup(); process.exit(130) })
const turn = () => new Promise(resolve => setImmediate(resolve))

/** The denials the system log holds for one run: `operation target` → the process names, paths shortened. Only the
 * profile's `(deny default)` carries the run's tag, so the tagged ones are exactly what deny-default took away; the
 * judge's own deny rules log untagged (they refuse the same under the live profile), found by the process id instead
 * (GAP-R2-0.6-103). */
function denials(tag, short = x => x, pid = null) {
  const predicate = pid === null ? `eventMessage ENDSWITH "${tag}"` : `eventMessage CONTAINS "(${pid}) deny("`
  // the kernel's reports reach the log store a moment after the run: read until two reads agree
  let last = null
  for (let i = 0; i < 6; i += 1) {
    sleep(last === null ? 1500 : 1000)
    const r = spawnSync('/usr/bin/log', ['show', '--last', '10m', '--style', 'compact', '--predicate', predicate], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 << 20 })
    if (r.status !== 0) throw new Error(`log show failed: ${(r.stderr || r.error?.message || '').slice(0, 200)}`)
    const out = new Map()
    for (const line of r.stdout.split('\n')) {
      const m = /Sandbox: (.+?)\(\d+\) deny\(\d+\) (\S+)(?: (.*))?$/.exec(line)
      if (!m || line.includes('duplicate report')) continue
      const key = m[3] ? `${m[2]} ${short(m[3].trim())}` : m[2]
      out.set(key, [...new Set([...(out.get(key) ?? []), m[1]])].sort())
    }
    if (last !== null && JSON.stringify([...out].sort()) === JSON.stringify([...last].sort())) return out
    last = out
  }
  throw new Error(`the log for ${pid === null ? tag : `pid ${pid}`} did not settle in six reads`)
}
const shortener = pairs => x => pairs.reduce((s, [from, to]) => s.split(from).join(to), x)
/** A refusal by the sandbox (EPERM), not any other failure such as a missing path (ENOENT). */
const refused = r => r.status !== 0 && /Operation not permitted/.test(r.stderr ?? '')
/** The same failures as the judge counts them: none new either way under its normalized key (newFailures). */
const sameFailures = (a, b) => J.newFailures(a, b).length === 0 && J.newFailures(b, a).length === 0

try {
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Check\n\temail = check@example.invalid\n')
  // ---------------------------------------------------------------- the profile itself, always
  const A = join(base, 'repo'); mkdirSync(A); sh(A, ['git', 'init', '-q', '-b', 'main']); put(join(A, 'src/a.ts'), 'export const a = 1\n')
  put(join(A, '.claude/settings.json'), '{}\n')
  const HOME = join(base, 'home'); mkdirSync(HOME)
  const runDir = runFolder()
  const opts = { root: A, tmpDir: runDir, commonDir: join(A, '.git'), denyRead: [HOME], loopbackPorts: [] }
  const strictRun = (argv, tag = newTag(), profile = S.judgeProfileStrict({ ...opts, tag })) => { const a = S.judgeArgv(profile, argv, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME, TMPDIR: runDir, stack: [] }); return { ...spawnSync(a[0], a.slice(1), { cwd: A, encoding: 'utf8', timeout: 60000 }), tag } }
  const ok = strictRun(['/bin/sh', '-c', 'echo ok > src/strict.txt && cat src/strict.txt'])
  check('sandbox-exec takes the strict profile; a write inside the root works under deny default', ok.status === 0 && ok.stdout.trim() === 'ok' && existsSync(join(A, 'src/strict.txt')), ok.stderr.slice(0, 300))
  const sys = strictRun(['/usr/sbin/sysctl', '-n', 'kern.boottime']), sysSeen = denials(sys.tag)
  // sysctl(8) asks for the name's format first (kern.boottime is oid 1.21)
  check('a sysctl outside the base\'s list is refused by deny default, and the log names it under the run\'s tag', sys.status !== 0 && [...sysSeen.keys()].some(k => /^sysctl-read (kern\.boottime|sysctl\.oidfmt\.1\.21)$/.test(k)), JSON.stringify([...sysSeen.keys()]))
  const out = join(base, 'outside.txt'), wrote = strictRun(['/bin/sh', '-c', `echo x > ${out}`])
  const untagged = denials(wrote.tag, x => x, wrote.pid), tagged = denials(wrote.tag)
  // the tagged query is anchored by what it did find for this run (a tag is unique to one run)
  check('a write outside the root is refused by the judge\'s own rule: logged for its process, never under the tag', wrote.status !== 0 && !existsSync(out) && [...untagged.keys()].some(k => k.startsWith('file-write') && k.endsWith(out)) && tagged.size > 0 && ![...tagged.keys()].some(k => k.endsWith(out)), JSON.stringify([[...untagged.keys()], [...tagged.keys()]]))
  const writes = { '.git/config': 'echo x >> .git/config', '.claude/': 'echo x > .claude/x.json', home: `echo x > ${join(HOME, 'x')}`, '.VSCODE': 'mkdir -p .VSCODE' }
  const leaked = Object.entries(writes).filter(([, c]) => !refused(strictRun(['/bin/sh', '-c', c]))).map(([k]) => k)
  check('the live judge\'s write closures hold: .git/config, .claude/, a denied folder, a protected name in another case', existsSync(join(A, '.git/config')) && leaked.length === 0, leaked.join(', '))
  // the base's bare (allow file-read*) comes before the judge's filtered (deny file-read* (subpath …)): the filter wins
  const secret = join(HOME, 'secret'); writeFileSync(secret, 'flow-secret\n')
  const peek = strictRun(['/bin/cat', secret]), peekSeen = denials(peek.tag, x => x, peek.pid), peekTagged = denials(peek.tag)
  check('a denyRead folder cannot be read: the judge\'s filtered deny wins over the base\'s bare read allow', peek.status !== 0 && !peek.stdout.includes('flow-secret') && peekSeen.has(`file-read-data ${secret}`) && peekTagged.size > 0 && ![...peekTagged.keys()].some(k => k.endsWith(secret)), JSON.stringify([[...peekSeen.keys()], [...peekTagged.keys()]]))
  const tty = strictRun(['/bin/cat', '/dev/tty']), ttySeen = denials(tty.tag, x => x, tty.pid)
  check('the terminal cannot be opened: the sandbox refuses /dev/tty', refused(tty) && ttySeen.has('file-read-data /dev/tty'), JSON.stringify([...ttySeen.keys()]))
  const sleeper = spawnSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim()
  const reachable = /^\d+$/.test(sleeper) && spawnSync('/bin/kill', ['-0', sleeper]).status === 0 // control: from outside it can
  const signalled = strictRun(['/bin/kill', '-0', sleeper]); spawnSync('/bin/kill', [sleeper])
  check('a process outside the sandbox cannot be signalled (from outside it can)', reachable && refused(signalled), signalled.stderr)
  const net = strictRun(['/usr/bin/curl', '-s', '-m', '5', 'https://example.com']), netSeen = denials(net.tag, x => x, net.pid)
  check('no network: the sandbox refuses the way out (the name lookup\'s socket included)', net.status !== 0 && [...netSeen.keys()].some(k => k.startsWith('network-outbound')), JSON.stringify([...netSeen.keys()]))
  check('a hard link inside the root works; one from a protected file does not', strictRun(['/bin/sh', '-c', 'ln src/strict.txt hl-in']).status === 0 && refused(strictRun(['/bin/sh', '-c', 'ln .git/config hl-cfg'])) && !existsSync(join(A, 'hl-cfg')))
  // an app no machine has: open still asks LaunchServices for it, and nothing can ever start (nothing to end after)
  const noApp = `FlowNoSuchApp${process.pid}`
  const launched = strictRun(['/usr/bin/open', '-g', '-j', '-a', noApp])
  const ls = denials(launched.tag, x => x, launched.pid), lsTagged = denials(launched.tag)
  // the live judge closes LaunchServices with its own rule (logged untagged), and the base names none of it
  const lsName = k => /^mach-lookup com\.apple\.(coreservices\.launchservicesd|lsd\.)/.test(k)
  // the baseline names com.apple.lsd.mapdb itself, the name the control below puts back
  check('LaunchServices stays closed: open -a\'s lookup is refused by the judge\'s own rule (logged for the process, untagged)', launched.status !== 0 && ls.has('mach-lookup com.apple.lsd.mapdb') && lsTagged.size > 0 && ![...lsTagged.keys()].some(lsName), JSON.stringify([[...ls.keys()], [...lsTagged.keys()]]))
  // control (spike P6): the runtime's LaunchServices name put back in the base: the judge's bare (deny mach-lookup) after
  // it no longer refuses it (a rule with a filter wins whatever the order), which is why the base leaves it out
  const backTag = newTag(), back = S.judgeProfileStrict({ ...opts, tag: backTag }).replace('\n(allow process-exec)', '\n(allow mach-lookup (global-name "com.apple.lsd.mapdb"))\n(allow process-exec)')
  const ctl = strictRun(['/usr/bin/open', '-g', '-j', '-a', noApp], backTag, back)
  const ctlSeen = denials(backTag, x => x, ctl.pid)
  check('control: with com.apple.lsd.mapdb put back in the base, the later bare deny does not refuse it', back.includes('com.apple.lsd.mapdb') && ctlSeen.size > 0 && !ctlSeen.has('mach-lookup com.apple.lsd.mapdb'), JSON.stringify([...ctlSeen.keys()]))
  const osa = strictRun(['/usr/bin/osascript', '-e', 'tell application "Finder" to get name of startup disk']), osaSeen = denials(osa.tag, x => x, osa.pid)
  check('Apple Events do not reach other apps: the sandbox refuses the way there', osa.status !== 0 && [...osaSeen.keys()].some(k => /^(appleevent-send|mach-lookup com\.apple\.(coreservices\.(appleevents|launchservicesd)|lsd\.))/.test(k)), JSON.stringify([...osaSeen.keys()].slice(0, 20)))
  const users = sh(MOD, ['/usr/bin/grep', '-rl', 'judgeProfileStrict', 'hooks', 'flow']).stdout.trim().split('\n').filter(Boolean)
  check('flow never uses the strict profile (inactive in R2): only flow-sandbox.ts names it', users.join() === 'hooks/flow-sandbox.ts', users.join(', '))
  const sig = m => ({ runner: 'vitest', file: 'tests/a.test.ts', id: 'adds', message: m, collection: false })
  check('the table compares failures as the judge does: durations and run folders do not count, the message does', sameFailures([sig(`expected 1 (12ms) at ${tmp}/flow-run.AAA/x.ts`)], [sig(`expected 1 (31ms) at ${tmp}/flow-run.BBB/x.ts`)]) && !sameFailures([sig('expected 1')], [sig('expected 2')]))

  // ---------------------------------------------------------------- AC-F28-1: the fixtures' judged commands
  if (process.env.FLOW_STRICT_TABLE === '1' && process.platform === 'darwin') {
    const TS = join(base, 'ts'), PY = join(base, 'py')
    await turn()
    const built = sh(MOD, ['/bin/sh', 'evals/flow/run.sh', 'fixture', TS])
    check('the TypeScript eval fixture builds (run.sh fixture: npm install)', built.status === 0 && existsSync(join(TS, 'node_modules/.bin/vitest')), built.stderr.slice(-400))
    await turn()
    const builtPy = sh(MOD, ['/bin/sh', 'evals/flow/run.sh', 'fixture', PY, 'python'])
    check('the Python eval fixture builds (run.sh fixture python: uv sync with pytest, ruff, mypy)', builtPy.status === 0 && ['pytest', 'ruff', 'mypy'].every(t => existsSync(join(PY, `.venv/bin/${t}`))), builtPy.stderr.slice(-400))
    const rows = [], details = []
    for (const [stack, root] of [[TYPESCRIPT_STACK, realpathSync(TS)], [PYTHON_STACK, realpathSync(PY)]]) {
      const names = readdirSync(root), manager = S.detectManagers(stack.data, names)[0] ?? stack.data.packageManagers[0]?.id ?? ''
      const manifest = existsSync(join(root, stack.data.manifest)) ? readFileSync(join(root, stack.data.manifest), 'utf8') : null
      for (const cmd of stack.code.proposeCommands(manifest, manager, {}, names).commands) {
        const live = await judged(stack, root, cmd, 'live')
        // the live run must be one judgedRun would accept, else the fixture or the harness is broken; the strict run's
        // outcome, whatever it is, is what the table records
        if (!live.ok || live.survivors > 0 || !live.reportOk) throw new Error(`${stack.data.id} ${cmd.id}: the live judged run is not one the judge accepts (${live.shown})`)
        const strict = await judged(stack, root, cmd, 'strict')
        const missing = [...strict.denied], same = live.shown === strict.shown && live.verdict === strict.verdict && sameFailures(live.failures, strict.failures)
        const ops = [...missing.reduce((m, [k]) => m.set(k.split(' ')[0], (m.get(k.split(' ')[0]) ?? 0) + 1), new Map())].map(([op, c]) => `${op} ×${c}`).join(', ') || '—'
        rows.push(`| ${stack.data.id} | ${cmd.id}: \`${cmd.argv.join(' ')}\` | ${live.shown} | ${strict.shown} | ${same ? 'yes' : '**no**'} | ${ops} |`)
        details.push(`- ${stack.data.id} ${cmd.id}: ${missing.map(([k, p]) => `\`${k}\` (${p.join(', ')})`).join('; ') || 'nothing refused by deny default'}`)
        if (!same) details.push(`  - strict output (first lines): ${JSON.stringify(strict.output.split('\n').slice(0, 6).join(' / ').slice(0, 400))}`)
      }
    }
    console.log(['', '<!-- judge-strict table -->', `Base: ${S.STRICT_BASE_SOURCE}. ${versions(TS, PY)}`, '',
      '| Stack | Command (as the judge runs it) | Live profile | Strict profile | Same result | Refused by deny default (distinct targets) |',
      '|---|---|---|---|---|---|', ...rows, '', ...details, '<!-- /judge-strict table -->', ''].join('\n'))
  } else console.log('skip: set FLOW_STRICT_TABLE=1 to build both fixtures and print the AC-F28-1 table (npm install and uv need the network or their caches)')
  console.log(`judge strict check: ${n} ok`)
} finally { cleanup() }

/** One judged run as flowRun.judgedRun makes it (the caches moved out of the project, the stack's judged argv and env,
 * the launcher, the filtered PATH, the run folder as TMPDIR, the reap before the folder goes), under the live profile or
 * the strict one with a fresh tag. `shown` holds the whole outcome the table compares. */
async function judged(stack, root, cmd, kind) {
  const { data, code } = stack
  await turn()
  const runDir = runFolder(), marker = basename(runDir), tag = newTag()
  try {
    const p = await G.gitPaths(io, root)
    for (const [i, f] of (await code.cacheFiles(io, p)).entries()) if (spawnSync('/bin/mv', ['-f', join(p.top, f), join(runDir, `cache-${i}`)]).status !== 0) throw new Error(`the cache ${f} could not be moved out of the project`)
    const j = code.judged(cmd.argv, cmd.runner, runDir, await code.judgeInput(io, root, cmd.argv), [])
    const denyRead = S.stackDenyRead(data, S.flowDenyRead(homedir(), join(homedir(), '.claude'))).map(x => (x.startsWith('~/') ? join(homedir(), x.slice(2)) : x)).map(x => { try { return realpathSync(x) } catch { return x } })
    const o = { root, tmpDir: runDir, commonDir: join(root, '.git'), denyRead, loopbackPorts: data.loopbackPorts }
    const profile = kind === 'strict' ? S.judgeProfileStrict({ ...o, tag }) : S.judgeProfile(o)
    const env = { PATH: safePath(process.env.PATH ?? '', [root, tmp, ...TEMP_PLACES]).path, HOME: homedir(), TMPDIR: runDir, ...(process.env.LANG ? { LANG: process.env.LANG } : {}), ...(process.env.TZ ? { TZ: process.env.TZ } : {}), marker, stack: code.judgeEnv({ pluginRoot: MOD, runDir }) }
    const before = await R.livePids(io), beforeGroups = await R.livePgids(io)
    const res = await J.runJudged(io, S.judgeArgv(profile, R.launcherArgv(j.argv), env), root, 300_000)
    const survivors = await R.reapRun(io, runDir, root, marker, before, beforeGroups)
    const text = j.reportFile !== null && existsSync(j.reportFile) ? readFileSync(j.reportFile, 'utf8') : null
    const parsed = j.reportFile === null ? undefined : res.ok && text !== null ? code.readReport(text, root, res.run) : null
    const report = parsed !== undefined && parsed !== null
    // what the judge acts on, as judgeRun reads the run against an empty baseline (no-new-failures lists every failure
    // it can read; must-pass lists none): pass, counts and the note here, the failures compared in the table as the
    // judge compares them (sameFailures)
    const v = res.ok ? J.judgeRun({ ...cmd, mode: 'no-new-failures' }, res.run, null, data, [], new Map(), parsed) : null
    const verdict = v ? JSON.stringify([v.pass, v.counts, v.note ?? '']) : ''
    const denied = kind === 'strict' ? denials(tag, shortener([[runDir, '<run>'], [root, '<root>'], [base, '<check>'], [tmp, '<tmp>'], [homedir(), '~']])) : new Map()
    // every process logs one denial under the tag as it starts (kern.iossupportversion): none means the log was not read
    if (kind === 'strict' && denied.size === 0) throw new Error(`${cmd.id}: no denial of the strict run reached the log under ${tag}`)
    const counted = Object.entries(v?.counts ?? {}).filter(([, c]) => typeof c === 'number' && c > 0).map(([k, c]) => `${c} ${k}`).join(' ')
    const shown = `${res.ok ? `exit ${res.run.exitCode}` : res.reason}${j.reportFile !== null ? `, report ${report ? 'read' : 'none'}` : ''}${counted ? `, ${counted}` : ''}${v?.newFailures.length ? `, ${v.newFailures.length} failure(s)` : ''}${survivors.length ? `, ${survivors.length} survivor(s)` : ''}`
    return { ok: res.ok, survivors: survivors.length, reportOk: j.reportFile === null || report, shown, verdict, failures: v?.newFailures ?? [], denied, output: res.ok ? res.run.output : res.detail }
  } finally { rmSync(runDir, { recursive: true, force: true }) }
}

/** The tool versions the table was taken with. */
function versions(ts, py) {
  const pkg = name => { try { return JSON.parse(readFileSync(join(ts, 'node_modules', name, 'package.json'), 'utf8')).version } catch { return '?' } }
  const ver = (d, argv) => (sh(d, argv).stdout || '?').trim().split('\n')[0]
  return `macOS ${ver(ts, ['/usr/bin/sw_vers', '-productVersion'])}; node ${process.version}, vitest ${pkg('vitest')}, eslint ${pkg('eslint')}, typescript ${pkg('typescript')}; ${ver(py, ['.venv/bin/python', '--version'])}, ${ver(py, ['.venv/bin/pytest', '--version'])}, ${ver(py, ['.venv/bin/ruff', '--version'])}, ${ver(py, ['.venv/bin/mypy', '--version'])}`
}
