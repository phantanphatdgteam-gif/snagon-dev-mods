// Real-process check for hooks/flow-tree.ts and the stacks' runner integrity (R2 step 6; AC-RI-1, AC-RI-2, AC-PY-7,
// AC-STK-9; security review S-13): real trees with links in and out, a FIFO, odd names, unreadable files, a venv with
// .pth files and pytest11 plugins, node_modules folders; and no program planted on the PATH runs.
// Usage: node tests/flow-tree.check.mjs   (macOS; exits non-zero on the first failed check)
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync, chmodSync, symlinkSync, unlinkSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const { treeDigest, TreeError } = await import('../hooks/flow-tree.ts')
const { venvState, venvRebaseBlock } = await import('../hooks/stacks/python-runner.ts')
const { nodeModulesState, nodeModulesRebaseBlock } = await import('../hooks/stacks/typescript-sources.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-tree-check-')))
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }
const put = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t) }
const planted = join(base, 'planted'), marks = join(base, 'marks')
const io = {
  exists: async p => existsSync(p),
  read: async p => readFileSync(p, 'utf8'),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isSymbolicLink() ? 'other' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' })),
  run: async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, PATH: `${planted}:/usr/bin:/bin` }, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 })
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
}
const spec = (roots, o = {}) => ({ roots, prune: o.prune ?? [], outside: o.outside ?? [], pinned: o.pinned ?? [], ...(o.report ? { report: o.report } : {}), ...(o.lines ? { lines: o.lines } : {}) })
const hashOf = async (roots, o) => (await treeDigest(io, spec(roots, o))).hash
const fails = async (roots, o, kind) => { try { await treeDigest(io, spec(roots, o)); return 'passed' } catch (e) { return e instanceof TreeError && e.kind === kind ? true : `${e.kind ?? ''} ${e.message}` } }

try {
  // programs planted first on the PATH never run: every tool is named by its absolute path (NK-02)
  mkdirSync(marks, { recursive: true })
  for (const name of ['find', 'stat', 'awk', 'sort', 'sed', 'openssl', 'xargs', 'realpath', 'grep', 'tr', 'printf']) put(join(planted, name), `#!/bin/sh\ntouch ${marks}/${name}\nexit 0\n`), chmodSync(join(planted, name), 0o755)

  const T = join(base, 'tree'), O = join(base, 'out')
  put(join(T, 'a.py'), 'a\n'); put(join(T, 'sub/b.py'), 'b\n'); put(join(T, '__pycache__/a.cpython-314.pyc'), 'pyc\n'); put(join(O, 'o.py'), 'o\n')
  symlinkSync('a.py', join(T, 'la.py')); symlinkSync('sub', join(T, 'ld')); symlinkSync('nowhere.py', join(T, 'lm.py'))
  const h0 = await hashOf([T])
  check('the same tree hashes the same, and no planted program ran', /^[0-9a-f]{64}$/.test(h0) && h0 === (await hashOf([T])) && spawnSync('/bin/ls', [marks], { encoding: 'utf8' }).stdout.trim() === '', h0)
  put(join(T, '__pycache__/a.cpython-314.pyc'), 'changed\n')
  check('a bytecode cache folder left out (prune) does not count; with it in, it does', h0 !== (await hashOf([T])) && (await hashOf([T], { prune: ['__pycache__'] })) === (await hashOf([T], { prune: ['__pycache__'] })))
  const p0 = await hashOf([T], { prune: ['__pycache__'] })
  put(join(T, 'sub/b.py'), 'b2\n'); const p1 = await hashOf([T], { prune: ['__pycache__'] })
  put(join(T, 'sub/c.py'), 'c\n'); const p2 = await hashOf([T], { prune: ['__pycache__'] })
  unlinkSync(join(T, 'sub/c.py')); unlinkSync(join(T, 'la.py')); symlinkSync('sub/b.py', join(T, 'la.py')); const p3 = await hashOf([T], { prune: ['__pycache__'] })
  check('a changed, added or removed file and a changed link text each change the hash', new Set([p0, p1, p2, p3]).size === 4)
  put(join(T, 'nowhere.py'), 'now here\n')
  check('a dangling link counts as one; its target appearing changes the hash', p3 !== (await hashOf([T], { prune: ['__pycache__'] })))
  unlinkSync(join(T, 'nowhere.py'))

  symlinkSync(join(O, 'o.py'), join(T, 'lo.py'))
  check('a file link out of the tree is refused (S-13)', (await fails([T], {}, 'link')) === true)
  const q0 = await hashOf([T], { outside: [O] }); put(join(O, 'o.py'), 'o2\n')
  check('a file link into an allowed folder (a cache) passes, and its target\'s content counts', q0 !== (await hashOf([T], { outside: [O] })))
  unlinkSync(join(T, 'lo.py')); symlinkSync(O, join(T, 'lod'))
  check('a folder link out of the tree is refused even into an allowed folder (GAP-R2-0.6-64)', (await fails([T], { outside: [O] }, 'link')) === true)
  unlinkSync(join(T, 'lod')); symlinkSync('__pycache__', join(T, 'lp'))
  check('a folder link into a left-out folder is refused', (await fails([T], { prune: ['__pycache__'] }, 'link')) === true)
  unlinkSync(join(T, 'lp'))
  symlinkSync(join(O, 'o.py'), join(T, 'pin'))
  const pinned = await treeDigest(io, spec([T], { pinned: [join(T, 'pin')] }))
  check('a pinned link may lead anywhere: its real path and its content hash come back', pinned.pinned[join(T, 'pin')]?.real === join(O, 'o.py') && /^[0-9a-f]{64}$/.test(pinned.pinned[join(T, 'pin')]?.hash ?? ''), JSON.stringify(pinned.pinned))
  unlinkSync(join(T, 'pin'))

  spawnSync('/usr/bin/mkfifo', [join(T, 'fifo')])
  check('a FIFO in the tree is refused', (await fails([T], {}, 'file')) === true)
  unlinkSync(join(T, 'fifo')); put(join(T, 'odd\nname.py'), 'x\n')
  check('a name with a line break is refused', (await fails([T], {}, 'file')) === true)
  unlinkSync(join(T, 'odd\nname.py')); put(join(T, 'secret.py'), 's\n'); chmodSync(join(T, 'secret.py'), 0o000)
  check('an unreadable file fails the hash (S-13)', (await fails([T], {}, 'read')) === true)
  chmodSync(join(T, 'secret.py'), 0o644); mkdirSync(join(T, 'locked')); chmodSync(join(T, 'locked'), 0o000)
  check('an unreadable folder fails the hash (S-13)', (await fails([T], {}, 'read')) === true)
  chmodSync(join(T, 'locked'), 0o755)
  check('no root present is absent', (await hashOf([join(base, 'none')])) === 'absent')
  mkdirSync(join(base, 'nl\nroot')); symlinkSync(join(base, 'nl\nroot'), join(base, 'rootlink'))
  check('a root whose real path holds a line break is refused', (await fails([join(base, 'rootlink')], {}, 'file')) === true)
  mkdirSync(join(base, 'trail\n')); symlinkSync(join(base, 'trail\n'), join(base, 'traillink')); mkdirSync(join(base, 'trail'))
  check('a root whose real path ends in a line break is refused, not read as its decoy', (await fails([join(base, 'traillink')], {}, 'file')) === true)
  // security review, step 6: a link text or a link target that holds a line break or a tab cannot forge output lines
  symlinkSync(`x\n${'0'.repeat(64)} *${T}/a.py`, join(T, 'forge'))
  check('a link whose text holds a line break is refused', (await fails([T], {}, 'file')) === true)
  unlinkSync(join(T, 'forge')); put(join(O, 'a\tb.py'), 'tab\n'); symlinkSync(join(O, 'a\tb.py'), join(O, 'hop')); symlinkSync(join(O, 'hop'), join(T, 'viahop'))
  check('a link whose real target holds a tab is refused (sentinel field)', (await fails([T], { outside: [O] }, 'link')) === true)
  unlinkSync(join(T, 'viahop'))
  // a pinned interpreter that is a plain file (a --copies venv) still has its bytes hashed
  const copied = await treeDigest(io, spec([T], { pinned: [join(T, 'a.py')] }))
  check('a pinned plain file has its content hash', /^[0-9a-f]{64}$/.test(copied.pinned[join(T, 'a.py')]?.hash ?? ''), JSON.stringify(copied.pinned))

  // the Python stack: a venv whose interpreter lies outside, a .pth into the project, pytest-cov's entry points
  const P = join(base, 'proj'), V = join(P, '.venv'), S = join(V, 'lib/python3.14/site-packages'), PY = join(base, 'py/bin/python3.14')
  put(PY, 'interpreter\n'); put(join(V, 'pyvenv.cfg'), `home = ${dirname(PY)}\ninclude-system-site-packages = false\n`)
  mkdirSync(join(V, 'bin'), { recursive: true }); symlinkSync(PY, join(V, 'bin/python'))
  put(join(S, '_proj.pth'), `${P}/src\n`); put(join(S, 'a1.pth'), 'import os; os.getenv("X")\n'); put(join(S, '_pytest/junitxml.py'), 'real\n')
  put(join(S, 'pytest_cov-7.1.0.dist-info/entry_points.txt'), '[pytest11]\npytest_cov = pytest_cov.plugin\n'); put(join(S, 'x/__pycache__/m.pyc'), 'pyc\n')
  const v0 = await venvState(io, P, [], '/nonexistent-home')
  check('a venv: hashed, its pytest11 plugin loaded by name, no refusal', /^[0-9a-f]{64}$/.test(v0.hash) && v0.load.join() === 'pytest_cov' && v0.problems.length === 0, JSON.stringify(v0))
  check('the interpreter pinned by real path and bytes', JSON.parse(v0.facts).interp['.venv'].startsWith(`${PY} `))
  put(join(S, '_pytest/junitxml.py'), 'patched to pass\n'); const v1 = await venvState(io, P, [], '/nonexistent-home')
  check('AC-PY-7: a patched _pytest/junitxml.py changes the hash; a toolchain file never re-baselines', v1.hash !== v0.hash && venvRebaseBlock(v0.facts, v1.facts) === '.venv/lib/python3.14/site-packages/_pytest (toolchain)', venvRebaseBlock(v0.facts, v1.facts))
  put(join(S, 'requests/api.py'), 'r\n'); put(join(S, 'typing_extensions.py'), 't\n'); put(join(S, '3f2a__mypyc.cpython-314-darwin.so'), 'rt\n'); const r0 = await venvState(io, P, [], '/nonexistent-home')
  put(join(S, 'requests/api.py'), 'patched\n'); const r1 = await venvState(io, P, [], '/nonexistent-home')
  check('a dependency that is not the toolchain may re-baseline', r1.hash !== r0.hash && venvRebaseBlock(r0.facts, r1.facts) === null, venvRebaseBlock(r0.facts, r1.facts))
  put(join(S, 'typing_extensions.py'), 'patched\n'); const r2 = await venvState(io, P, [], '/nonexistent-home'); put(join(S, '3f2a__mypyc.cpython-314-darwin.so'), 'patched\n'); const r3 = await venvState(io, P, [], '/nonexistent-home')
  check('a one-file toolchain module and mypy\'s compiled runtime are pinned too', venvRebaseBlock(r1.facts, r2.facts) === '.venv/lib/python3.14/site-packages/typing_extensions (toolchain)' && venvRebaseBlock(r2.facts, r3.facts) === '.venv/lib/python3.14/site-packages/3f2a__mypyc.cpython-314-darwin.so (toolchain)', JSON.stringify([venvRebaseBlock(r1.facts, r2.facts), venvRebaseBlock(r2.facts, r3.facts)]))
  for (const x of ['typing_extensions.py', '3f2a__mypyc.cpython-314-darwin.so']) unlinkSync(join(S, x)); rmSync(join(S, 'requests'), { recursive: true })
  put(join(S, 'evil.pth'), 'import evil\n'); const v2 = await venvState(io, P, [], '/nonexistent-home')
  check('AC-PY-7, AC-RI-3: an added .pth changes the hash and blocks the re-baseline', v2.hash !== v1.hash && venvRebaseBlock(v1.facts, v2.facts) === '.venv/lib/python3.14/site-packages/evil.pth')
  unlinkSync(join(S, 'evil.pth')); put(join(S, 'evil-1.0.dist-info/entry_points.txt'), '[pytest11]\nevil = evil.plugin\n'); const v3 = await venvState(io, P, [], '/nonexistent-home')
  check('AC-PY-7, AC-RI-3: an added pytest11 plugin changes the hash and blocks the re-baseline', v3.hash !== v1.hash && venvRebaseBlock(v1.facts, v3.facts) === 'pytest11 evil=evil.plugin' && v3.load.join() === 'evil,pytest_cov')
  rmSync(join(S, 'evil-1.0.dist-info'), { recursive: true }); put(join(S, 'sitecustomize.py'), 'import evil\n'); const v4 = await venvState(io, P, [], '/nonexistent-home')
  check('AC-STK-9, AC-RI-3: an added sitecustomize changes the hash and blocks the re-baseline', v4.hash !== v1.hash && venvRebaseBlock(v1.facts, v4.facts) === '.venv/lib/python3.14/site-packages/sitecustomize.py')
  unlinkSync(join(S, 'sitecustomize.py')); put(join(V, 'pyvenv.cfg'), `home = ${dirname(PY)}\ninclude-system-site-packages = true\n`); const v5 = await venvState(io, P, [], '/nonexistent-home')
  check('S-4: include-system-site-packages = true is a refusal and blocks the re-baseline', v5.problems.some(x => x.key === 'setup.venvSystem') && venvRebaseBlock(v1.facts, v5.facts) === '.venv/pyvenv.cfg')
  put(join(V, 'pyvenv.cfg'), `home = ${dirname(PY)}\ninclude-system-site-packages = false\n`); put(join(S, 'bad.pth'), '/tmp/elsewhere\n'); const v6 = await venvState(io, P, [], '/nonexistent-home')
  check('A-6: a .pth line outside the project, the venv and the interpreter is a refusal', v6.problems.some(x => x.key === 'setup.venvPath' && x.vars.path === '/tmp/elsewhere'), JSON.stringify(v6.problems))
  unlinkSync(join(S, 'bad.pth')); put(join(S, '__editable___x_1_0_finder.py'), "MAPPING = {'x': '/tmp/x'}\n"); const v7 = await venvState(io, P, [], '/nonexistent-home')
  check('A-6: an editable finder mapping outside is a refusal', v7.problems.some(x => x.key === 'setup.venvPath' && x.vars.path === '/tmp/x'))
  unlinkSync(join(S, '__editable___x_1_0_finder.py')); unlinkSync(join(V, 'bin/python')); symlinkSync(join(base, 'py/bin/python3.15'), join(V, 'bin/python')); put(join(base, 'py/bin/python3.15'), 'other\n')
  const v8 = await venvState(io, P, [], '/nonexistent-home')
  check('AC-RI-3: another interpreter blocks the re-baseline', venvRebaseBlock(v1.facts, v8.facts) === '.venv/bin/python')
  put(join(P, 'binonly/bin/pyvenv.cfg'), 'include-system-site-packages = true\n'); symlinkSync(PY, join(P, 'binonly/bin/python'))
  const bo = await venvState(io, P, [{ id: 'test', argv: ['binonly/bin/pytest'], runner: 'pytest', mode: 'must-pass' }], '/nonexistent-home')
  check('a venv known by its bin/pyvenv.cfg only is a venv (its settings checked)', bo.problems.some(x => x.key === 'setup.venvSystem' && x.vars.venv === 'binonly'), JSON.stringify(bo.problems))
  rmSync(join(P, 'binonly'), { recursive: true })
  put(join(P, 'other/pyvenv.cfg'), `home = ${dirname(PY)}\n`); mkdirSync(join(P, 'other/bin')); symlinkSync(PY, join(P, 'other/bin/python')); put(join(P, 'other/lib/python3.14/site-packages/m.py'), 'm\n')
  const v9 = await venvState(io, P, [{ id: 'test', argv: ['other/bin/pytest'], runner: 'pytest', mode: 'must-pass' }], '/nonexistent-home')
  check('a venv a command names is hashed too', Object.keys(JSON.parse(v9.facts).interp).sort().join() === '.venv,other' && v9.hash !== v8.hash)
  put(join(P, 'tools/py/bin/python'), 'standalone\n'); put(join(P, 'tools/py/lib/python3.14/site-packages/m.py'), 'm\n')
  const cmdT = [{ id: 'test', argv: ['tools/py/bin/python', '-m', 'pytest'], runner: 'pytest', mode: 'must-pass' }]
  const w0 = await venvState(io, P, cmdT, '/nonexistent-home'); put(join(P, 'tools/py/lib/python3.14/site-packages/m.py'), 'patched\n')
  const w1 = await venvState(io, P, cmdT, '/nonexistent-home')
  check('an interpreter folder inside the project with no pyvenv.cfg is hashed too, and never re-baselines', w0.hash !== w1.hash && venvRebaseBlock(w0.facts, w1.facts) === 'tools/py', venvRebaseBlock(w0.facts, w1.facts))
  put(join(V, 'bin/pytest'), '#!/x/python\nimport pytest\n'); const b0 = await venvState(io, P, [{ id: 'test', argv: ['.venv/bin/pytest'], runner: 'pytest', mode: 'must-pass' }], '/nonexistent-home')
  put(join(V, 'bin/pytest'), '#!/x/python\nimport evil\n'); const b1 = await venvState(io, P, [{ id: 'test', argv: ['.venv/bin/pytest'], runner: 'pytest', mode: 'must-pass' }], '/nonexistent-home')
  check('a rewritten bin/<program> the commands run blocks the re-baseline', venvRebaseBlock(b0.facts, b1.facts) === '.venv/bin/pytest', venvRebaseBlock(b0.facts, b1.facts))
  for (const [name, text, path] of [['cr.pth', `${P}/src\r/Users/elsewhere\n`, '/Users/elsewhere'], ['bom.pth', '\ufeff/outside/dir\n', '(a line Python versions read apart)'], ['ff.pth', `${P}/a\fx/../../../../tmp/evil\n`, '(a line Python versions read apart)']]) {
    put(join(S, name), text); const s = await venvState(io, P, [], '/nonexistent-home'); unlinkSync(join(S, name))
    check(`a .pth read as site.py reads it (${name}): the hidden path is refused`, s.problems.some(x => x.key === 'setup.venvPath' && x.vars.path === path), JSON.stringify(s.problems))
  }
  // PEP 405: <venv>/bin/pyvenv.cfg is read first; the modules a .pth import line runs are start code
  const pre = await venvState(io, P, [], '/nonexistent-home'); put(join(V, 'bin/pyvenv.cfg'), 'include-system-site-packages = true\n'); const bc = await venvState(io, P, [], '/nonexistent-home')
  check('a bin/pyvenv.cfg with the system site-packages is refused and blocks the re-baseline', bc.problems.some(x => x.key === 'setup.venvSystem') && venvRebaseBlock(pre.facts, bc.facts) === '.venv/bin/pyvenv.cfg', JSON.stringify([bc.problems, venvRebaseBlock(pre.facts, bc.facts)]))
  unlinkSync(join(V, 'bin/pyvenv.cfg')); put(join(S, 'hack.pth'), 'import _hack\n'); put(join(S, '_hack/__init__.py'), 'ok\n')
  const m0 = await venvState(io, P, [], '/nonexistent-home'); put(join(S, '_hack/__init__.py'), 'import evil\n'); const m1 = await venvState(io, P, [], '/nonexistent-home')
  check('a changed module a .pth import line runs blocks the re-baseline', venvRebaseBlock(m0.facts, m1.facts) === '.venv/lib/python3.14/site-packages/_hack/__init__.py', venvRebaseBlock(m0.facts, m1.facts))
  unlinkSync(join(S, 'hack.pth')); rmSync(join(S, '_hack'), { recursive: true })
  // round 3: an extension module of a start module, __import__ in setuptools' .pth, a venv known by bin/pyvenv.cfg only
  put(join(S, 'distutils-precedence.pth'), "import os; var = 'X'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_dh').add_shim();\n"); put(join(S, '_dh/__init__.py'), 'shim\n')
  const d0 = await venvState(io, P, [], '/nonexistent-home'); put(join(S, '_dh/__init__.py'), 'import evil\n'); const d1 = await venvState(io, P, [], '/nonexistent-home')
  check('a module a .pth runs through __import__ is start code', venvRebaseBlock(d0.facts, d1.facts) === '.venv/lib/python3.14/site-packages/_dh/__init__.py', venvRebaseBlock(d0.facts, d1.facts))
  unlinkSync(join(S, 'distutils-precedence.pth')); rmSync(join(S, '_dh'), { recursive: true })
  put(join(S, 'ext.pth'), 'import _ext\n'); put(join(S, '_ext.py'), 'py\n'); const e0 = await venvState(io, P, [], '/nonexistent-home')
  put(join(S, '_ext.cpython-314-darwin.so'), 'native\n'); const e1 = await venvState(io, P, [], '/nonexistent-home')
  check('an extension module added beside a start module blocks the re-baseline', venvRebaseBlock(e0.facts, e1.facts) === '.venv/lib/python3.14/site-packages/_ext.cpython-314-darwin.so', venvRebaseBlock(e0.facts, e1.facts))
  for (const x of ['ext.pth', '_ext.py', '_ext.cpython-314-darwin.so']) unlinkSync(join(S, x))
  put(join(V, 'pyvenv.cfg'), `home = ${dirname(PY)}\rinclude-system-site-packages = true\n`); const cr = await venvState(io, P, [], '/nonexistent-home')
  put(join(V, 'pyvenv.cfg'), `home = ${dirname(PY)}\ninclude-system-site-pac\u212Aages = true\n`); const kel = await venvState(io, P, [], '/nonexistent-home')
  put(join(V, 'pyvenv.cfg'), `home = ${dirname(PY)}\ninclude-system-site-packages = false\n`)
  check('pyvenv.cfg read as site.py reads it: a \\r line end, a non-ASCII key', cr.problems.some(x => x.key === 'setup.venvSystem') && kel.problems.some(x => x.key === 'setup.venvCfg'), JSON.stringify([cr.problems, kel.problems]))
  put(join(S, 'us.pth'), '/private/tmp/venv/..\x1f\n'); const us = await venvState(io, P, [], '/nonexistent-home'); unlinkSync(join(S, 'us.pth'))
  check('a .pth line ending in \\x1f (Python strips it, JavaScript does not) is refused', us.problems.some(x => x.key === 'setup.venvPath'), JSON.stringify(us.problems))
  put(join(S, '__editable___y_finder.py'), "MAPPING = {'y': '/proj/src\\x2f..\\x2fetc'}\n"); const esc = await venvState(io, P, [], '/nonexistent-home'); unlinkSync(join(S, '__editable___y_finder.py'))
  check('an editable finder path with an escape is refused', esc.problems.some(x => x.key === 'setup.venvPath' && x.vars.path.includes('\\x2f')), JSON.stringify(esc.problems))
  // security review round 4. uv's symlink link mode: a toolchain file is a link into uv's cache, edited there in place
  const HOME2 = join(base, 'home'), C = join(HOME2, '.cache/uv/archive/x/_pytest/python.py'); put(C, 'cached\n'); symlinkSync(C, join(S, '_pytest/python.py'))
  const u0 = await venvState(io, P, [], HOME2); put(C, 'patched in the cache\n'); const u1 = await venvState(io, P, [], HOME2)
  check('a toolchain file linked into a package cache: an edit in the cache never re-baselines', u0.problems.length === 0 && u1.hash !== u0.hash && venvRebaseBlock(u0.facts, u1.facts) === '.venv/lib/python3.14/site-packages/_pytest (toolchain)', JSON.stringify([u0.problems, venvRebaseBlock(u0.facts, u1.facts)]))
  unlinkSync(join(S, '_pytest/python.py'))
  // a plugin's whole distribution, read from its RECORD: the library beside the shim the entry names
  put(join(S, 'myplug-1.0.dist-info/entry_points.txt'), '[pytest11]\nmyplug = _myplug_shim\n'); put(join(S, 'myplug-1.0.dist-info/RECORD'), '_myplug_shim.py,sha256=x,1\nmyplug_core/__init__.py,sha256=y,1\nmyplug-1.0.dist-info/RECORD,,\n../../../bin/myplug,sha256=z,1\n')
  put(join(S, '_myplug_shim.py'), 'import myplug_core\n'); put(join(S, 'myplug_core/__init__.py'), 'core\n')
  const g0 = await venvState(io, P, [], '/nonexistent-home'); put(join(S, 'myplug_core/__init__.py'), 'patched\n'); const g1 = await venvState(io, P, [], '/nonexistent-home')
  check('a pytest11 plugin\'s library (in its RECORD, not named by the entry) is pinned', venvRebaseBlock(g0.facts, g1.facts) === '.venv/lib/python3.14/site-packages/myplug_core (toolchain)', venvRebaseBlock(g0.facts, g1.facts))
  rmSync(join(S, 'myplug-1.0.dist-info'), { recursive: true }); rmSync(join(S, 'myplug_core'), { recursive: true }); unlinkSync(join(S, '_myplug_shim.py'))
  // a .pth import found in a folder a .pth path line put on sys.path inside the venv (pip install -e git+… → <venv>/src)
  put(join(V, 'src/eggpkg/__init__.py'), 'egg\n'); put(join(S, 'egg.pth'), `${V}/src\nimport eggpkg\n`)
  const e2 = await venvState(io, P, [], '/nonexistent-home'); put(join(V, 'src/eggpkg/__init__.py'), 'patched\n'); const e3 = await venvState(io, P, [], '/nonexistent-home')
  check('a start module found through a .pth path line inside the venv is a start fact', e2.problems.length === 0 && venvRebaseBlock(e2.facts, e3.facts) === '.venv/src/eggpkg/__init__.py', JSON.stringify([e2.problems, venvRebaseBlock(e2.facts, e3.facts)]))
  unlinkSync(join(S, 'egg.pth')); rmSync(join(V, 'src'), { recursive: true })
  // one pyvenv.cfg of two gone: site.py reads the other
  put(join(V, 'bin/pyvenv.cfg'), `home = ${dirname(PY)}\n`); const c0 = await venvState(io, P, [], '/nonexistent-home'); unlinkSync(join(V, 'bin/pyvenv.cfg')); const c1 = await venvState(io, P, [], '/nonexistent-home')
  check('a removed bin/pyvenv.cfg never re-baselines', venvRebaseBlock(c0.facts, c1.facts) === '.venv/bin/pyvenv.cfg', venvRebaseBlock(c0.facts, c1.facts))
  // a folder link out of the venv in a toolchain package is refused by the tree; a link loop there is walked once
  put(join(base, 'shared/assert.py'), 'a\n'); symlinkSync(join(base, 'shared'), join(S, '_pytest/inner'))
  const l0 = await venvState(io, P, [], '/nonexistent-home').catch(e => e); unlinkSync(join(S, '_pytest/inner'))
  const k1 = await venvState(io, P, [], '/nonexistent-home'); symlinkSync('.', join(S, '_pytest/loop')); const k2 = await venvState(io, P, [], '/nonexistent-home'); unlinkSync(join(S, '_pytest/loop'))
  const pyt = s => JSON.parse(s.facts).tool['.venv/lib/python3.14/site-packages/_pytest']
  check('a folder link out of the venv in a toolchain package is refused; a link loop there adds nothing to load', l0 instanceof TreeError && l0.kind === 'link' && pyt(k2) === pyt(k1) && typeof pyt(k1) === 'string', `${l0?.kind} ${l0?.message}`)

  // the TypeScript stack: every node_modules folder outside hidden ones, the moved-out caches left out
  const J = join(base, 'js')
  put(join(J, 'node_modules/vitest/index.js'), 'v\n'); put(join(J, 'packages/a/node_modules/dep/index.js'), 'd\n'); put(join(J, '.hidden/node_modules/x/index.js'), 'x\n')
  put(join(J, 'node_modules/.vite/vitest/results.json'), '{}\n'); put(join(J, 'node_modules/dep/node_modules/inner/index.js'), 'i\n')
  mkdirSync(join(J, 'node_modules/.bin'), { recursive: true }); symlinkSync('../vitest/index.js', join(J, 'node_modules/.bin/vitest'))
  const j0 = (await nodeModulesState(io, J, '/nonexistent-home')).hash
  put(join(J, 'node_modules/.vite/vitest/results.json'), '{"x":1}\n'); put(join(J, '.hidden/node_modules/x/index.js'), 'y\n')
  check('node_modules: a moved-out cache and a hidden folder do not count', j0 === (await nodeModulesState(io, J, '/nonexistent-home')).hash)
  put(join(J, 'packages/a/node_modules/dep/index.js'), 'patched\n'); const j1 = (await nodeModulesState(io, J, '/nonexistent-home')).hash
  put(join(J, 'node_modules/dep/node_modules/inner/index.js'), 'patched\n'); const j2 = (await nodeModulesState(io, J, '/nonexistent-home')).hash
  check('AC-RI-1: a file in a workspace package\'s node_modules or a nested one changes the hash', new Set([j0, j1, j2]).size === 3)
  // owner decision 2026-10-19: the toolchain and assertion packages are pinned at a re-baseline (scoped and pnpm's store too)
  put(join(J, 'node_modules/@types/node/index.d.ts'), 'n\n'); put(join(J, 'node_modules/.pnpm/chai@5.1.0/node_modules/chai/index.js'), 'c\n')
  const t0 = await nodeModulesState(io, J, '/nonexistent-home'); put(join(J, 'node_modules/vitest/index.js'), 'patched\n'); const t1 = await nodeModulesState(io, J, '/nonexistent-home')
  check('a patched toolchain package (vitest) never re-baselines', nodeModulesRebaseBlock(t0.facts, t1.facts) === 'node_modules/vitest (toolchain)', nodeModulesRebaseBlock(t0.facts, t1.facts))
  put(join(J, 'node_modules/dep/index.js'), 'patched\n'); const t2 = await nodeModulesState(io, J, '/nonexistent-home')
  check('a patched dependency that is not the toolchain may re-baseline', t2.hash !== t1.hash && nodeModulesRebaseBlock(t1.facts, t2.facts) === null, nodeModulesRebaseBlock(t1.facts, t2.facts))
  put(join(J, 'node_modules/.pnpm/chai@5.1.0/node_modules/chai/index.js'), 'patched\n'); const t3 = await nodeModulesState(io, J, '/nonexistent-home'); put(join(J, 'node_modules/@types/node/index.d.ts'), 'patched\n'); const t4 = await nodeModulesState(io, J, '/nonexistent-home')
  check('an assertion package in pnpm\'s store and a scoped @types package are pinned', nodeModulesRebaseBlock(t2.facts, t3.facts) === 'node_modules/.pnpm/chai@5.1.0/node_modules/chai (toolchain)' && nodeModulesRebaseBlock(t3.facts, t4.facts) === 'node_modules/@types/node (toolchain)', JSON.stringify([nodeModulesRebaseBlock(t2.facts, t3.facts), nodeModulesRebaseBlock(t3.facts, t4.facts)]))
  // security review round 4, the same mechanism on this stack: a toolchain file linked into a package cache
  const JH = join(base, 'jhome'), JC = join(JH, '.npm/_cacache/x/runner.js'); put(JC, 'cached\n'); symlinkSync(JC, join(J, 'node_modules/vitest/runner.js'))
  const n0 = await nodeModulesState(io, J, JH); put(JC, 'patched in the cache\n'); const n1 = await nodeModulesState(io, J, JH)
  check('a TypeScript toolchain file linked into a package cache: an edit in the cache never re-baselines', n1.hash !== n0.hash && nodeModulesRebaseBlock(n0.facts, n1.facts) === 'node_modules/vitest (toolchain)', nodeModulesRebaseBlock(n0.facts, n1.facts))
  unlinkSync(join(J, 'node_modules/vitest/runner.js'))
  rmSync(join(J, 'node_modules/@types'), { recursive: true }); rmSync(join(J, 'node_modules/.pnpm'), { recursive: true }); rmSync(join(J, 'node_modules/dep/index.js'))
  // a workspace package's link leads into the project: recorded by its real path, its files are the project's own
  put(join(J, 'packages/pkg/index.js'), 'p\n'); mkdirSync(join(J, 'node_modules/@x'), { recursive: true }); symlinkSync('../../packages/pkg', join(J, 'node_modules/@x/pkg'))
  symlinkSync('../../packages/pkg/index.js', join(J, 'node_modules/.bin/pkg'))
  const k0 = (await nodeModulesState(io, J, '/nonexistent-home')).hash; put(join(J, 'packages/pkg/index.js'), 'edited in a feature\n')
  check('workspace links into the project pass; editing the package (project code) does not touch the runner hash', k0 === (await nodeModulesState(io, J, '/nonexistent-home')).hash)
  unlinkSync(join(J, 'node_modules/@x/pkg')); symlinkSync('../../packages', join(J, 'node_modules/@x/pkg'))
  check('a workspace link retargeted changes the hash', k0 !== (await nodeModulesState(io, J, '/nonexistent-home')).hash)
  check('no node_modules folder is absent', (await nodeModulesState(io, join(base, 'proj/other'), '/nonexistent-home')).hash === 'absent')
  check('still no planted program ran', spawnSync('/bin/ls', [marks], { encoding: 'utf8' }).stdout.trim() === '')
} finally {
  spawnSync('/bin/chmod', ['-R', 'u+rwx', base])
  rmSync(base, { recursive: true, force: true })
}
