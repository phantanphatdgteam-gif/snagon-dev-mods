import { describe, expect, test } from 'claude-code/testing'
import { TYPESCRIPT } from '../flow/data/stacks/typescript'
import { depsVerdict, cmdSourceVerdict, nodeModulesRebaseBlock, referencedPaths, scriptOperands, argvOperands, scriptNames } from '../hooks/stacks/typescript-sources'

describe('flow command sources', () => {
  const before = JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: { a: '1' } })
  const deps = JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: { a: '1', b: '^2.0.0' }, devDependencies: { c: '~3' } })
  test('dependency-only package.json: registry versions of packages that are not the runner or the toolchain', () => {
    expect(depsVerdict(before, deps)).toEqual({ ok: true, changed: ['b', 'c'] })
    for (const [name, spec] of [['b', 'file:./tools/b'], ['b', 'npm:evil@1'], ['b', 'github:x/y'], ['b', 'https://x/y.tgz'], ['vitest', '^3.0.0'], ['@vitest/runner', '3'], ['typescript', '5'], ['@types/node', '22']] as const) expect([name, spec, depsVerdict(before, JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: { a: '1', [name]: spec } })).ok]).toEqual([name, spec, false])
    expect(depsVerdict(before, JSON.stringify({ name: 'app', scripts: { test: 'vitest run --passWithNoTests' }, dependencies: { a: '1' } })).ok).toBe(false)
    expect(depsVerdict(before, '{ broken').ok).toBe(false)
  })

  test('lockfiles are compared entry by entry: a peer range, a funding link or a runtime helper is not a toolchain change; a runner entry is', () => {
    const lockBefore = '"node_modules/vitest": {\n  "resolved": "https://registry.npmjs.org/vitest/-/vitest-3.2.4.tgz"\n}\n"node_modules/a": {}\n'
    const lockAdd = `${lockBefore}"node_modules/b": {\n  "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz",\n  "peerDependencies": {\n    "typescript": ">=5"\n  }\n}\n`
    const texts = (lock: string) => ({ 'package.json': { before, after: deps }, 'package-lock.json': { before: lockBefore, after: lock } })
    const both = ['package.json', 'package-lock.json']
    expect(cmdSourceVerdict(both, texts(lockAdd), both, TYPESCRIPT)).toEqual({ cmdSrc: [], dependencyOnly: both, declared: [], forceSecurity: false })
    const swap = lockAdd.replace('https://registry.npmjs.org/vitest/-/vitest-3.2.4.tgz', 'https://evil.example/x.tgz')
    const elsewhere = lockAdd.replace('https://registry.npmjs.org/b/-/b-2.0.0.tgz', 'https://evil.example/b-2.0.0.tgz')
    const local = lockAdd.replace('https://registry.npmjs.org/b/-/b-2.0.0.tgz', 'file:../b')
    const babel = `${lockAdd}"node_modules/@babel/core": {\n  "resolved": "https://registry.npmjs.org/@babel/core/-/core-8.tgz"\n}\n`
    const resolutionSwap = '"vitest@npm:^3":\n  version: 3.2.4\n  resolution: "vitest@npm:3.2.4"\n'
    expect(cmdSourceVerdict(both, { ...texts(lockAdd), 'package-lock.json': { before: resolutionSwap, after: resolutionSwap.replace('resolution: "vitest@npm:3.2.4"', 'resolution: "evil@npm:1.0.0"') } }, both, TYPESCRIPT).cmdSrc).toEqual(['package-lock.json'])
    const expectSwap = lockAdd.replace('"node_modules/a": {}', '"node_modules/expect": {\n  "resolved": "https://registry.npmjs.org/expect/-/expect-30.0.0.tgz"\n}')
    expect(cmdSourceVerdict(both, { ...texts(lockAdd), 'package-lock.json': { before: expectSwap, after: expectSwap.replace('expect-30.0.0.tgz', 'expect-30.0.1.tgz') } }, both, TYPESCRIPT).cmdSrc).toEqual(['package-lock.json'])
    const funded = lockAdd.replace('"peerDependencies": {', '"funding": { "url": "https://opencollective.com/b" },\n  "peerDependencies": {')
    const helpers = `${lockAdd}"node_modules/@babel/runtime": {\n  "resolved": "https://registry.npmjs.org/@babel/runtime/-/runtime-7.tgz"\n}\n"node_modules/@swc/helpers": {\n  "resolved": "https://registry.npmjs.org/@swc/helpers/-/helpers-0.5.tgz"\n}\n`
    for (const lock of [funded, helpers]) expect(cmdSourceVerdict(both, texts(lock), both, TYPESCRIPT).cmdSrc).toEqual([])
    for (const lock of [swap, elsewhere, local, babel]) expect(cmdSourceVerdict(both, texts(lock), both, TYPESCRIPT)).toEqual({ cmdSrc: ['package-lock.json'], dependencyOnly: ['package.json'], declared: [], forceSecurity: false })
    const yarn4 = `${lockAdd}"resolve@patch:resolve@npm%3A^1.22#optional!builtin<compat/resolve>":\n  version: 1.22.8\n`
    expect(cmdSourceVerdict(both, texts(yarn4), both, TYPESCRIPT).cmdSrc).toEqual([])
    const yarnBuiltin = `${lockAdd}"resolve@patch:resolve@^1.22#~builtin<compat/resolve>":\n  version: 1.22.8\n`
    expect(cmdSourceVerdict(both, texts(yarnBuiltin), both, TYPESCRIPT).cmdSrc).toEqual([])
    expect(cmdSourceVerdict(both, texts(lockAdd), ['src/a.ts'], TYPESCRIPT).cmdSrc).toEqual(both)
    expect(cmdSourceVerdict(['package-lock.json'], { 'package-lock.json': { before: lockBefore, after: lockAdd } }, ['package-lock.json'], TYPESCRIPT).cmdSrc).toEqual(['package-lock.json'])
    expect(cmdSourceVerdict(['.npmrc'], {}, ['.npmrc'], TYPESCRIPT).cmdSrc).toEqual(['.npmrc'])
    expect(cmdSourceVerdict(['tests/mocks/handlers.ts', 'vitest.config.ts'], {}, ['tests/mocks/handlers.ts', 'vitest.config.ts'], TYPESCRIPT, ['tests/mocks/handlers.ts'])).toEqual({ cmdSrc: ['vitest.config.ts'], dependencyOnly: [], declared: ['tests/mocks/handlers.ts'], forceSecurity: false })
    expect(cmdSourceVerdict(['tests/mocks/handlers.ts'], {}, ['src/a.ts'], TYPESCRIPT, ['tests/mocks/handlers.ts']).cmdSrc).toEqual(['tests/mocks/handlers.ts'])
    expect(cmdSourceVerdict(['tests/matchers.ts'], {}, ['tests/matchers.ts'], TYPESCRIPT, ['tests/matchers.ts'], ['tests/matchers.ts'])).toEqual({ cmdSrc: [], dependencyOnly: [], declared: ['tests/matchers.ts'], forceSecurity: true })
  })

  test('a monorepo feature may start using a workspace package: workspace specs and in-repo pnpm links are dependency-only', () => {
    const web0 = JSON.stringify({ name: 'web', dependencies: { a: '1' } })
    const web1 = JSON.stringify({ name: 'web', dependencies: { a: '1', '@acme/utils': 'workspace:*', '@acme/ui': 'workspace:^' } })
    expect(depsVerdict(web0, web1)).toEqual({ ok: true, changed: ['@acme/ui', '@acme/utils'] })
    expect(depsVerdict(web0, JSON.stringify({ name: 'web', dependencies: { a: '1', x: 'link:../x' } })).ok).toBe(false)
    const lock0 = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: '1'\n        version: 1.0.0\n\n  apps/web:\n    dependencies:\n      a:\n        specifier: '1'\n        version: 1.0.0\n\npackages:\n\n  a@1.0.0:\n    resolution: {integrity: sha512-x}\n"
    const lock1 = lock0.replace("  apps/web:\n    dependencies:\n", "  apps/web:\n    dependencies:\n      '@acme/utils':\n        specifier: workspace:*\n        version: link:../../packages/utils\n")
    const files = ['apps/web/package.json', 'pnpm-lock.yaml']
    const texts = (lock: string) => ({ 'apps/web/package.json': { before: web0, after: web1 }, 'pnpm-lock.yaml': { before: lock0, after: lock } })
    expect(cmdSourceVerdict(files, texts(lock1), files, TYPESCRIPT)).toEqual({ cmdSrc: [], dependencyOnly: files, declared: [], forceSecurity: false })
    const escape = lock1.replace('link:../../packages/utils', 'link:../../../outside')
    expect(cmdSourceVerdict(files, texts(escape), files, TYPESCRIPT).cmdSrc).toEqual(['pnpm-lock.yaml'])
  })

  test('a runner config refers to its imports and its setup, reporter and environment files; a package entry point is not a command source', () => {
    const cfg = "import base from './config/base'\nimport { defineConfig } from 'vitest/config'\nexport default defineConfig({ ...base, build: { lib: { entry: 'src/index.ts' } }, test: {\n  setupFiles: [\n    './tests/setup-env.ts',\n    'tests/more.ts',\n  ],\n  globalSetup: '<rootDir>/tests/global.ts',\n  reporters: ['default', './tools/reporter.ts'],\n  environment: 'node',\n} })\n"
    expect(referencedPaths('tests/setup.ts', "import '@/test-utils/patch'\nimport x from 'lodash'\n", { '@/': 'src/' })).toEqual(['src/test-utils/patch'])
    expect(referencedPaths('tests/setup.ts', "import './customMatchers'\nexport * from '../tools/match'\nexport { a } from \"./a.js\"\n").sort()).toEqual(['tests/a.js', 'tests/customMatchers', 'tools/match'])
    expect(referencedPaths('web/vitest.config.ts', cfg).sort()).toEqual(['web/config/base', 'web/tests/more.ts', 'web/tests/setup-env.ts', 'web/tests/global.ts', 'web/tools/reporter.ts'].sort())
    expect(referencedPaths('package.json', JSON.stringify({ main: 'src/index.ts', types: 'dist/index.d.ts', exports: { '.': './src/index.ts' }, jest: { setupFilesAfterEnv: ['<rootDir>/jest.setup-dom.ts'], testEnvironment: './tools/env.js' } }))).toEqual(['jest.setup-dom.ts', 'tools/env.js'])
  })

  test('the files package scripts and approved commands run are command sources', () => {
    const pkg = JSON.stringify({ scripts: { dev: 'tsx watch src/index.ts', seed: 'tsx prisma/seed.ts', pretest: 'node scripts/pre.mjs', test: 'npm run lint && tsx tools/run-tests.ts --config=./cfg/test.json', lint: 'node scripts/lint.mjs && eslint .', posttest: 'node scripts/post', build: 'tsc -p tsconfig.build.json' } })
    expect(scriptOperands('pkg/a/package.json', pkg, ['test']).sort()).toEqual(['pkg/a/cfg/test.json', 'pkg/a/scripts/lint.mjs', 'pkg/a/scripts/post', 'pkg/a/scripts/pre.mjs', 'pkg/a/tools/run-tests.ts'])
    expect(scriptOperands('package.json', pkg, ['build'])).toEqual(['tsconfig.build.json'])
    expect(scriptOperands('package.json', '{ broken', ['test'])).toEqual([])
    expect(scriptNames([['npm', 'test'], ['npm', 'run', 'lint'], ['pnpm', 'run', 'typecheck'], ['yarn', 'test'], ['npx', 'tsc']])).toEqual(['test', 'lint', 'typecheck'])
    expect(argvOperands(['node', 'scripts/check.mjs', '--fix', './x.sh', 'src', '--config=vitest.ci.mts', '--import=./reg.mjs', 'scripts/check'])).toEqual(['scripts/check.mjs', 'x.sh', 'vitest.ci.mts', 'reg.mjs', 'scripts/check'])
  })
})

describe('the TypeScript runner at a re-baseline (owner decision 2026-10-19)', () => {
  test('a toolchain or assertion package whose files changed blocks; the same files, empty facts pass; facts that cannot be read block', () => {
    const f = (tool: Record<string, string>) => JSON.stringify({ tool })
    expect([nodeModulesRebaseBlock('', ''), nodeModulesRebaseBlock(f({ 'node_modules/vitest': 'a' }), f({ 'node_modules/vitest': 'a' })), nodeModulesRebaseBlock(f({ 'node_modules/vitest': 'a' }), f({ 'node_modules/vitest': 'b' })), nodeModulesRebaseBlock('{', f({}))]).toEqual([null, null, 'node_modules/vitest (toolchain)', 'node_modules'])
  })
})
