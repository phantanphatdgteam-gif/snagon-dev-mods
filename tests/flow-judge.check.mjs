// Real-git checks for hooks/flow-judge.ts (plan v7.1 step 5), plus, when FLOW_JUDGE_PROJECT names a TypeScript project
// with vitest installed, one judged vitest run in the judge sandbox. Usage: node tests/flow-judge.check.mjs
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, lstatSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const G = await import('../hooks/flow-git.ts')
const J = await import('../hooks/flow-judge.ts')
const Src = await import('../hooks/flow-sources.ts')
const Sc = await import('../hooks/flow-scan.ts')
const S = await import('../hooks/flow-sandbox.ts')
const { TYPESCRIPT } = await import('../flow/data/stacks.ts')
const Pa = await import('../flow/parse.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-judge-check-')))
process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Check\n\temail = check@example.invalid\n')
const io = {
  read: async p => readFileSync(p, 'utf8'), write: async (p, t) => writeFileSync(p, t), exists: async p => existsSync(p),
  list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: 0, mtimeMs: lstatSync(join(d, e.name)).mtimeMs })),
  run: async (argv, init = {}) => { const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs ?? 30000, maxBuffer: 64 << 20 }); if (r.error) throw r.error; return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } },
  now: async () => Date.now(), pluginRoot: base,
}
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exitCode = 1; throw new Error(name) } console.log(`ok ${n}: ${name}`) }
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const put = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t) }

try {
  const A = join(base, 'repo'); mkdirSync(A); sh(A, 'init', '-q', '-b', 'main')
  put(join(A, 'src/add.ts'), 'export const add = (a: number, b: number) => a + b\n'); put(join(A, 'package.json'), '{"name":"app","scripts":{"test":"vitest run"}}\n')
  put(join(A, 'tsconfig.json'), '{}\n'); put(join(A, '.gitignore'), '.npmrc\nnode_modules/\n'); put(join(A, '.npmrc'), 'save-exact=true\n'); put(join(A, 'vitest.config.ts'), 'export default {}\n')
  sh(A, 'add', '-A'); sh(A, 'commit', '-q', '-m', 'start')
  const P = await G.gitPaths(io, A), start = sh(A, 'rev-parse', 'HEAD^{tree}')
  check('an export missing from a module at the start tree is absent; one it has is present; a new module is absent',
    (await J.symbolAbsent(io, P, start, 'src/add', 'sub')) && !(await J.symbolAbsent(io, P, start, 'src/add', 'add')) && (await J.symbolAbsent(io, P, start, 'src/mul', 'mul')))
  put(join(A, 'tests/a.test.ts'), "it('AC-001 adds', () => {})\nit('AC-003 x', () => {})\n"); sh(A, 'add', 'tests/a.test.ts'); put(join(A, 'tests/b.spec.ts'), "it('AC-002 subtracts', () => {})\n"); put(join(A, 'src/c.ts'), '// AC-009 is not a test\n')
  const ids = await J.evalIdsInTests(io, P, TYPESCRIPT.testFiles)
  check('eval ids are found in tracked and untracked test files only', JSON.stringify([...ids].sort()) === JSON.stringify([['AC-001', ['tests/a.test.ts']], ['AC-002', ['tests/b.spec.ts']], ['AC-003', ['tests/a.test.ts']]]), JSON.stringify([...ids]))
  const src0 = (await Src.commandSources(io, P)).hashes
  check('command sources include tracked configs and an ignored .npmrc, not source files', ['package.json', 'tsconfig.json', '.npmrc', 'vitest.config.ts', '.gitignore'].every(k => k === '.gitignore' ? !(k in src0) : k in src0) && !('src/add.ts' in src0), Object.keys(src0).join(','))
  put(join(A, '.npmrc'), 'registry=https://evil.example/\n'); const src1 = (await Src.commandSources(io, P)).hashes
  check('a change to an ignored .npmrc changes its hash (CMD-SRC)', src1['.npmrc'] !== src0['.npmrc'])
  sh(A, 'config', 'alias.t', '!echo hi'); check('a new git alias changes the git config hash', ((await Src.commandSources(io, P)).hashes)['git:config'] !== src1['git:config'])

  put(join(A, 'vitest.config.ts'), "import base from './config/test-base'\nexport default { ...base, test: { setupFiles: ['tests/setup-env.ts'] } }\n")
  put(join(A, 'config/test-base.ts'), 'export default {}\n'); put(join(A, 'tests/setup-env.ts'), 'globalThis.x = 1\n'); put(join(A, '.env.test'), 'A=1\n'); put(join(A, 'vitest.workspace.ts'), 'export default []\n')
  const src2 = (await Src.commandSources(io, P)).hashes
  check('files a config imports or names as setup, .env files and the vitest workspace are command sources', ['config/test-base.ts', 'tests/setup-env.ts', '.env.test', 'vitest.workspace.ts'].every(k => k in src2), Object.keys(src2).join(','))
  put(join(A, 'tests/setup-env.ts'), 'globalThis.it = globalThis.it.skip\n')
  check('a changed setup file changes its hash', ((await Src.commandSources(io, P)).hashes)['tests/setup-env.ts'] !== src2['tests/setup-env.ts'])
  put(join(A, 'package.json'), JSON.stringify({ name: 'app', main: 'src/add.ts', scripts: { test: 'vitest run', lint: 'node scripts/lint.mjs && eslint .' } }))
  put(join(A, 'scripts/lint.mjs'), 'process.exit(0)\n'); put(join(A, 'tools/check.mjs'), 'ok()\n')
  put(join(A, '.gitignore'), '.npmrc\nnode_modules/\nlocal/\n'); put(join(A, 'local/.env'), 'TOKEN_NAME_ONLY=1\n'); put(join(A, 'node_modules/pkg/.npmrc'), 'x=1\n')
  const got3 = await Src.commandSources(io, P, [['node', 'tools/check.mjs'], ['npm', 'run', 'lint']]), src3 = got3.hashes
  check('scripts and approved commands name command sources; an ignored .env inside an ignored folder counts; node_modules and the package entry point do not',
    ['scripts/lint.mjs', 'tools/check.mjs', 'local/.env'].every(k => k in src3) && !('src/add.ts' in src3) && !Object.keys(src3).some(k => k.startsWith('node_modules/')) && got3.reached.includes('scripts/lint.mjs'), Object.keys(src3).join(','))
  put(join(A, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest run', dev: 'tsx watch src/index.ts' } })); put(join(A, 'src/index.ts'), 'start()\n')
  put(join(A, 'tests/setup-env.ts'), "import './matchers'\n"); put(join(A, 'tests/matchers.ts'), "import { deep } from './deep/one'\nexpect.extend({})\n"); put(join(A, 'tests/deep/one.ts'), "export * from './two'\n"); put(join(A, 'tests/deep/two.ts'), 'export const deep = 1\n')
  const got4 = await Src.commandSources(io, P, [['npm', 'test']])
  check('a setup file\'s side-effect import and its re-export chain are command sources (reached); a dev script\'s entry point is not',
    ['tests/matchers.ts', 'tests/deep/one.ts', 'tests/deep/two.ts'].every(k => k in got4.hashes && got4.reached.includes(k)) && 'tests/setup-env.ts' in got4.hashes && !got4.reached.includes('tests/setup-env.ts') && ['tests/matchers.ts', 'tests/deep/one.ts', 'tests/deep/two.ts'].every(k => got4.setupChain.includes(k)) && !('src/index.ts' in got4.hashes) && !('closure:truncated' in got4.hashes), JSON.stringify({ reached: got4.reached, truncated: got4.hashes['closure:truncated'] }))
  put(join(A, '.gitignore'), '.npmrc\nnode_modules/\nlocal/\n*.tsbuildinfo\n.eslintcache\n'); put(join(A, 'tsconfig.tsbuildinfo'), '{}'); put(join(A, 'web/.eslintcache'), '[]'); put(join(A, 'node_modules/.cache/babel/x.json'), '{}')
  put(join(A, 'tsconfig.json'), '{ "compilerOptions": { "incremental": true, "tsBuildInfoFile": "./.cache/tsc/info" } }\n'); put(join(A, '.cache/tsc/info'), '{}')
  put(join(A, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint --cache --cache-location .cache/lint/ . && prettier --check .' } })); put(join(A, '.cache/lint/x'), '[]')
  const caches = await Src.cacheFiles(io, P)
  check('tool caches inside the project are listed for the judged run to move aside, custom locations included', JSON.stringify(caches.sort()) === JSON.stringify(['.cache/lint', '.cache/tsc/info', 'node_modules/.cache', 'tsconfig.tsbuildinfo', 'web/.eslintcache']), JSON.stringify(caches))
  put(join(A, '.env.example'), 'KEY=\n'); put(join(A, '__mocks__/axios.ts'), 'export default {}\n'); put(join(A, 'src/services/__mocks__/mailer.ts'), 'export {}\n')
  put(join(A, 'jest.config.js'), "module.exports = { roots: ['<rootDir>/src'] }\n"); put(join(A, 'src/__mocks__/fs.ts'), 'export {}\n')
  const src5 = (await Src.commandSources(io, P)).hashes
  check('.env.example is not a command source; a manual mock beside node_modules (root, jest roots) is; a nested one is not', !('.env.example' in src5) && '__mocks__/axios.ts' in src5 && 'src/__mocks__/fs.ts' in src5 && !('src/services/__mocks__/mailer.ts' in src5) && '.env.test' in src5, Object.keys(src5).join(','))
  put(join(A, 'tsconfig.json'), '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },\n}\n'); put(join(A, 'src/test-utils/patch.ts'), 'export {}\n')
  put(join(A, 'tests/setup-env.ts'), "import './matchers'\nimport '@/test-utils/patch'\n")
  const got6 = await Src.commandSources(io, P, [['npm', 'test']])
  check('a setup file\'s import through a tsconfig path alias is followed into the setup chain', 'src/test-utils/patch.ts' in got6.hashes && got6.setupChain.includes('src/test-utils/patch.ts') && !('closure:truncated' in got6.hashes), JSON.stringify({ keys: Object.keys(got6.hashes), chain: got6.setupChain }))
  put(join(A, 'tests/setup-env.ts'), "import './matchers'\nimport '#internal/patch'\n")
  check('an alias import the tsconfig cannot resolve marks the closure truncated', (await Src.commandSources(io, P, [['npm', 'test']])).hashes['closure:truncated'] === 'yes')
  const C = join(base, 'wctx'); mkdirSync(C); sh(C, 'init', '-q', '-b', 'main')
  const before = "import { describe, it, expect } from 'vitest'\ndescribe('w', () => {\n  it('one', () => {\n    expect(1).toBe(1)\n  })\n  it('two', () => {\n    const a = 1\n    const b = 2\n    const c = 3\n    const d = 4\n    expect(a + b).toBe(c)\n  })\n  it('three', () => {\n    return load().then(v => {\n      expect(v).toBe(1)\n    })\n  })\n})\n"
  put(join(C, 'tests/w.test.ts'), before); sh(C, 'add', '-A'); sh(C, 'commit', '-q', '-m', 'w')
  put(join(C, 'tests/w.test.ts'), before.replace('    const d = 4\n', '    const d = 4\n    if (!ready) {\n      return\n    }\n').replace('      expect(v).toBe(1)\n', '      expect(v).toBe(1)\n      expect(v).not.toBe(2)\n'))
  const wd = await G.git(io, C, [...Sc.SCAN_DIFF_ARGS])
  const ws = Sc.scan(wd.stdout, [], { stack: TYPESCRIPT, frozen: [] })
  check('a real git diff with SCAN_DIFF_ARGS shows the whole test: a guard deep in a test inside describe is HIGH; a promise-returning test is not flagged', JSON.stringify(ws.findings.map(f => `${f.rule}:${f.sev}`)) === JSON.stringify(['conditional-return:HIGH']), JSON.stringify(ws.findings))
  // RED in an existing test file: its imports sit far above the hunks, so the RED rules read the file's full text.
  const cartTop = "import { describe, it, expect } from 'vitest'\nimport { pricing } from '../src/pricing'\nimport { total } from '../src/cart'\n\ndescribe('old', () => {\n  it('keeps', () => {\n    expect(1).toBe(1)\n  })\n})\n"
  put(join(C, 'tests/cart.test.ts'), cartTop); sh(C, 'add', '-A'); sh(C, 'commit', '-q', '-m', 'cart')
  const redBlock = "\ndescribe('AC-004 cart', () => {\n  it('AC-004 totals', () => {\n    expect(total()).toBe(3)\n  })\n})\n"
  put(join(C, 'tests/cart.test.ts'), cartTop + redBlock)
  const redDiff = (await G.git(io, C, [...Sc.SCAN_DIFF_ARGS])).stdout
  const shape = Sc.redShape(Sc.parseDiff(redDiff), ['tests/cart.test.ts'])
  const green = cartTop + redBlock + "\nit('AC-004 more', () => {\n  pricing.discount = () => 0.1\n  expect(total()).toBe(3)\n})\n"
  put(join(C, 'tests/cart.test.ts'), green)
  const greenDiff = (await G.git(io, C, [...Sc.SCAN_DIFF_ARGS])).stdout
  const withText = Sc.scan(greenDiff, [], { stack: TYPESCRIPT, frozen: [], red: shape, texts: { 'tests/cart.test.ts': green } }).findings.filter(f => f.rule === 'mock-after-red')
  check('in an existing test file, a patch of an import added after RED is found through the file\'s full text (the import is out of the diff)', !redDiff.includes("from '../src/pricing'") && withText.length === 1 && withText[0]?.sev === 'HIGH', JSON.stringify(withText))
  put(join(A, 'tests/c.test.ts'), "it.each([['a', 1]])('AC-004 rows %s', () => {})\ntest.each`\n  a\n  ${1}\n`('AC-006 table $a', () => {})\nit.skip('AC-005 skipped', () => {})\ntest.failing('AC-008 failing', () => {})\nit .failing('AC-012 spaced', () => {})\n// it('AC-007 comment')\n")
  const ids2 = await J.evalIdsInTests(io, P, TYPESCRIPT.testFiles)
  check('eval ids in table tests count; a skipped test or a comment does not', ids2.has('AC-004') && ids2.has('AC-006') && !ids2.has('AC-005') && !ids2.has('AC-007') && !ids2.has('AC-008') && !ids2.has('AC-012'), JSON.stringify([...ids2]))
  const { symlinkSync, unlinkSync } = await import('node:fs')
  put(join(A, 'node_modules/vitest/package.json'), '{"name":"vitest","dependencies":{"tinypool":"1"}}'); put(join(A, 'node_modules/vitest/index.js'), 'run()\n')
  put(join(A, 'node_modules/tinypool/index.js'), 'pool()\n'); put(join(A, 'node_modules/left-pad/index.js'), 'pad()\n')
  mkdirSync(join(A, 'node_modules/.bin')); symlinkSync('../vitest/index.js', join(A, 'node_modules/.bin/vitest'))
  const r0 = await Src.runnerHash(io, A, ['vitest'])
  put(join(A, 'node_modules/left-pad/index.js'), 'changed()\n')
  check('the runner hash ignores packages the runner does not use', r0 === (await Src.runnerHash(io, A, ['vitest'])) && /^[0-9a-f]{64}$/.test(r0), r0)
  unlinkSync(join(A, 'node_modules/.bin/vitest')); put(join(A, 'node_modules/.bin/vitest'), '#!/bin/sh\necho " Tests  40 passed (40)"\n')
  const r1 = await Src.runnerHash(io, A, ['vitest'])
  check('a runner bin replaced by a script changes the runner hash', r1 !== r0)
  put(join(A, 'node_modules/tinypool/index.js'), 'patched()\n')
  check('a patched direct dependency of the runner changes the runner hash', r1 !== (await Src.runnerHash(io, A, ['vitest'])))
  check('no runner package installed gives "absent"', (await Src.runnerHash(io, A, ['jest'])) === 'absent')
  const B = join(base, 'pnpm'), store = join(B, 'node_modules/.pnpm')
  put(join(store, 'vitest@3/node_modules/vitest/package.json'), '{"name":"vitest","dependencies":{"@vitest/runner":"3"}}'); put(join(store, 'vitest@3/node_modules/vitest/index.js'), 'run()\n')
  put(join(store, '@vitest+runner@3/node_modules/@vitest/runner/package.json'), '{"name":"@vitest/runner","dependencies":{"pathe":"1"}}'); put(join(store, '@vitest+runner@3/node_modules/@vitest/runner/index.js'), 'runner()\n')
  put(join(store, 'pathe@1/node_modules/pathe/index.js'), 'pathe()\n')
  mkdirSync(join(store, 'vitest@3/node_modules/@vitest'), { recursive: true }); symlinkSync('../../../@vitest+runner@3/node_modules/@vitest/runner', join(store, 'vitest@3/node_modules/@vitest/runner'))
  mkdirSync(join(store, '@vitest+runner@3/node_modules'), { recursive: true }); symlinkSync('../../pathe@1/node_modules/pathe', join(store, '@vitest+runner@3/node_modules/pathe'))
  symlinkSync('.pnpm/vitest@3/node_modules/vitest', join(B, 'node_modules/vitest'))
  const q0 = await Src.runnerHash(io, B, ['vitest'])
  put(join(store, '@vitest+runner@3/node_modules/@vitest/runner/index.js'), 'everything passes\n'); const q1 = await Src.runnerHash(io, B, ['vitest'])
  put(join(store, 'pathe@1/node_modules/pathe/index.js'), 'patched\n'); const q2 = await Src.runnerHash(io, B, ['vitest'])
  check('pnpm layout: a patched @vitest/runner (found next to the real path) and a dependency of it both change the runner hash', q0 !== 'absent' && q0 !== q1 && q1 !== q2, [q0, q1, q2].join(' '))
  const Jt = join(base, 'jest'), nm = join(Jt, 'node_modules')
  for (const [name, deps] of [['jest', { '@jest/core': '30' }], ['@jest/core', { 'jest-runner': '30' }], ['jest-runner', { 'jest-circus': '30', 'graceful-fs': '4' }], ['jest-circus', { 'expect': '30' }], ['expect', {}], ['graceful-fs', { 'not-followed': '1' }], ['not-followed', {}]]) { put(join(nm, name, 'package.json'), JSON.stringify({ name, dependencies: deps })); put(join(nm, name, 'index.js'), name + '()\n') }
  const j0 = await Src.runnerHash(io, Jt, ['jest'])
  put(join(nm, 'jest-circus/index.js'), 'all passed\n'); const j1 = await Src.runnerHash(io, Jt, ['jest'])
  put(join(nm, 'not-followed/index.js'), 'changed\n'); const j2 = await Src.runnerHash(io, Jt, ['jest'])
  check('jest: the engine four packages deep (jest-circus) is hashed; a dependency of a non-runner package is not followed', j0 !== j1 && j1 === j2, [j0, j1, j2].join(' '))

  const project = process.env.FLOW_JUDGE_PROJECT
  if (project && existsSync(join(project, 'node_modules/.bin/vitest')) && process.platform === 'darwin') {
    const root = realpathSync(project), tmp = realpathSync(process.env.TMPDIR || '/tmp')
    const profile = S.judgeProfile({ root, tmpDir: tmp, commonDir: join(root, '.git'), denyRead: [join(homedir(), '.ssh')], loopbackPorts: [] })
    const argv = S.judgeArgv(profile, ['npx', 'vitest', 'run'], { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmp, emptyConfig: join(dirname(fileURLToPath(import.meta.url)), '../flow/empty.npmrc') })
    const ran = await J.runJudged(io, argv, root, J.timeoutFor(30_000))
    check('a real vitest run in the judge sandbox comes back with readable failures', ran.ok && (J.judgeRun({ id: 'test', runner: 'vitest', mode: 'no-new-failures' }, ran.run, null, TYPESCRIPT, [], new Map()).newFailures.length > 0 || ran.run.exitCode === 0), JSON.stringify(ran).slice(0, 300))
    const v = J.judgeRun({ id: 'test', runner: 'vitest', mode: 'no-new-failures' }, ran.run, null, TYPESCRIPT, [], new Map())
    const again = await J.runJudged(io, argv, root, J.timeoutFor(30_000))
    check('the same run judged against itself as baseline passes (nothing new fails)', again.ok && J.judgeRun({ id: 'test', runner: 'vitest', mode: 'no-new-failures' }, again.run, { signatures: v.newFailures, counts: v.counts, exitCode: ran.run.exitCode }, TYPESCRIPT, [], new Map()).pass)
    const runDir = mkdtempSync(join(tmp, 'flow-run-'))
    const judged = J.judgedArgv(['npx', 'vitest', 'run'], 'vitest', runDir), reportFile = judged.reportFile ?? ''
    const withReport = S.judgeArgv(profile, judged.argv, { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmp, emptyConfig: join(dirname(fileURLToPath(import.meta.url)), '../flow/empty.npmrc') })
    const ranR = await J.runJudged(io, withReport, root, J.timeoutFor(30_000))
    const report = existsSync(reportFile) ? Pa.readReport(readFileSync(reportFile, 'utf8'), root) : null
    rmSync(runDir, { recursive: true, force: true })
    const vr = ranR.ok ? J.judgeRun({ id: 'test', runner: 'vitest', mode: 'no-new-failures' }, ranR.run, null, TYPESCRIPT, ['AC-001', 'AC-002', 'AC-004'], new Map(), report) : null
    check('a judged vitest run writes its JSON report in the run folder; console and report agree; AC-001 passed, AC-002 failed, AC-004 skipped', Boolean(report) && vr?.note !== 'the report and the console disagree' && JSON.stringify(vr?.evalProblems) === JSON.stringify(['AC-002 failed', 'AC-004 not run']), JSON.stringify(vr))
    const tscArgv = S.judgeArgv(profile, J.judgedArgv(['npx', 'tsc', '--noEmit'], 'tsc', runDir).argv, { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmp, emptyConfig: join(dirname(fileURLToPath(import.meta.url)), '../flow/empty.npmrc') })
    const plainTsc = S.judgeArgv(profile, ['npx', 'tsc', '--noEmit'], { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmp, emptyConfig: join(dirname(fileURLToPath(import.meta.url)), '../flow/empty.npmrc') })
    const [t1, t2] = [await J.runJudged(io, tscArgv, root, J.timeoutFor(30_000)), await J.runJudged(io, plainTsc, root, J.timeoutFor(30_000))]
    check('tsc with the cache flags gives the same result as tsc as approved', t1.ok && t2.ok && t1.run.exitCode === t2.run.exitCode && t1.run.output === t2.run.output, JSON.stringify([t1, t2]).slice(0, 300))
  } else console.log('skip: set FLOW_JUDGE_PROJECT to a TypeScript project with vitest for the live judge run')
  console.log(`flow judge check: ${n} ok`)
} finally { rmSync(base, { recursive: true, force: true }) }
