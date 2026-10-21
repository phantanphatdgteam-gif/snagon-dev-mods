import { describe, expect, test } from 'claude-code/testing'
import { STACK_ENTRIES, stackById, stackOf, unknownStack } from '../hooks/stacks/index'
import { STACKS } from '../flow/data/stacks'
import { COMMON_DENY_READ, PUBLISH_UNION } from '../flow/data/common'
import { debugRole, routedAgent, ROUTING, STACK_SHARE } from '../flow/data/routing'
import { TEXTS } from '../flow/data/templates'
import type { DiffFile, Line } from '../hooks/flow-scan'
import { codeReviewerFor } from '../hooks/flow-reviewing'
import { FLOW_DENY_READ, proposeBlock, stackDenyRead } from '../hooks/flow-sandbox'
import { canonical } from '../hooks/flow-owner'
import { gitPaths } from '../hooks/flow-git'
import { emptySession, guardCtx } from '../hooks/flow-host'
import { ROOT } from './flow-fakes'
import { HEAD, toS3, world } from './flow-drive'
import { RECORD_053 } from './fixtures/record-053'

describe('the stack registry (R2 plan §3.1)', () => {
  test('the registry pairs every data entry with its code, in the order S1 tries them', () => {
    expect(STACK_ENTRIES.map(s => s.data.id)).toEqual(STACKS.map(s => s.id))
    for (const s of STACK_ENTRIES) expect(stackById(s.data.id)).toBe(s)
  })

  test('an unknown or missing stack is never guessed: stackOf throws with the reason the card shows (AC-CORE-5)', () => {
    expect(stackById('cobol')).toBeNull()
    expect(stackById(undefined)).toBeNull()
    expect(() => stackOf({ setup: { stack: 'cobol' } })).toThrow(unknownStack('cobol'))
    expect(() => stackOf({})).toThrow('the record holds no stack')
    expect(stackOf({ setup: { stack: 'typescript' } }).data.id).toBe('typescript')
  })

  test('the guard denies every stack\'s publishing commands, whatever stack the flow froze (A-3, AC-STK-11)', () => {
    for (const s of STACKS) {
      for (const key of ['tools', 'subcommands', 'valueOptions', 'releaseTools'] as const) for (const x of s.publish[key]) expect(PUBLISH_UNION[key]).toContain(x)
      for (const [tool, words] of Object.entries(s.publish.prefixes)) for (const w of words) expect(PUBLISH_UNION.prefixes[tool]).toContain(w)
    }
    for (const key of ['tools', 'subcommands', 'valueOptions', 'releaseTools'] as const) expect(new Set(PUBLISH_UNION[key]).size).toBe(PUBLISH_UNION[key].length)
  })

  test('every stack\'s proposed block hides the shared credential files and flow\'s own data (A-3)', () => {
    for (const s of STACKS) {
      const deny = proposeBlock(s, s.packageManagers.map(m => m.id)).filesystem.denyRead
      for (const p of [...COMMON_DENY_READ, ...FLOW_DENY_READ]) expect(deny).toContain(p)
    }
  })

  test('the TypeScript block is the one a 0.5.3 flow froze, so the update shows no sandbox change', () => {
    const frozen = (JSON.parse(RECORD_053.frozen.sandbox ?? '{}') as { sandbox: unknown }).sandbox
    const ts = STACKS.find(s => s.id === 'typescript')
    expect(ts).toBeDefined()
    if (ts) expect(canonical(proposeBlock(ts, ['npm']))).toBe(canonical(frozen))
  })

  test('the reviewer goes to the stack\'s own from the share of changed lines in its files; its build fixer whatever the share (R2 plan §4.4)', () => {
    const own = { reviewer: 'typescript-reviewer', buildFixer: 'build-error-resolver' }
    expect(routedAgent('reviewer', STACK_SHARE, own)).toBe('typescript-reviewer')
    expect(routedAgent('reviewer', STACK_SHARE - 0.01, own)).toBe(ROUTING.agents.reviewer.agent)
    expect(routedAgent('reviewer', 1, {})).toBe(ROUTING.agents.reviewer.agent)
    expect(routedAgent('buildFixer', 0, own)).toBe('build-error-resolver')
    expect(routedAgent('buildFixer', 1, {})).toBe(ROUTING.agents.buildFixer.agent)
    expect(routedAgent('debugger', 1, own)).toBe(ROUTING.agents.debugger.agent)
    for (const s of STACKS) expect(() => new RegExp(s.ownsFile)).not.toThrow()
  })

  test('every stack names its build fixer; one with none of its own names the debugger, as the core does (AC-BF-2, AC-BF-3, GAP-R2-15)', () => {
    expect(Object.fromEntries(STACKS.map(s => [s.id, s.routing.buildFixer]))).toEqual({ typescript: 'build-error-resolver', python: ROUTING.agents.debugger.agent })
    // build-error-resolver is written for TypeScript: the core's own build fixer, for a stack that names none, is the debugger
    expect(ROUTING.agents.buildFixer).toEqual(ROUTING.agents.debugger)
  })

  test('a red typecheck, build or lint command goes to the stack\'s build fixer, a red test (or any other) to the debugger (AC-BF-1, AC-STK-14)', () => {
    const ids = ['test', 'typecheck', 'lint', 'build', 'e2e']
    expect(ids.map(debugRole)).toEqual(['debugger', 'buildFixer', 'buildFixer', 'buildFixer', 'debugger'])
    expect(Object.fromEntries(STACKS.map(s => [s.id, ids.map(id => routedAgent(debugRole(id), 0, s.routing))]))).toEqual({
      typescript: ['tdd-guide', 'build-error-resolver', 'build-error-resolver', 'build-error-resolver', 'tdd-guide'],
      python: ['tdd-guide', 'tdd-guide', 'tdd-guide', 'tdd-guide', 'tdd-guide'],
    })
  })

  test('the code reviewer of a change: the stack\'s own from 70% of its changed lines in the stack\'s files, else code-reviewer; context lines do not count (AC-STK-14)', () => {
    const changed = (path: string, n: number, context = 0): DiffFile => ({ path, status: 'modified', lines: [
      ...Array.from({ length: n }, (_, i): Line => ({ kind: i % 2 ? '-' : '+', n: i + 1, text: 'x' })),
      ...Array.from({ length: context }, (_, i): Line => ({ kind: ' ', n: n + i + 1, text: 'x' })),
    ] })
    const python = STACKS.find(s => s.id === 'python'), typescript = STACKS.find(s => s.id === 'typescript')
    if (!python || !typescript) throw new Error('a stack is missing')
    expect(codeReviewerFor(python, [changed('src/pkg/a.py', 6), changed('src/pkg/a.pyi', 1, 50), changed('README.md', 3)])).toBe('python-reviewer')
    expect(codeReviewerFor(python, [changed('src/pkg/a.py', 6), changed('README.md', 4)])).toBe('code-reviewer')
    expect(codeReviewerFor(python, [changed('src/a.ts', 10)])).toBe('code-reviewer')
    expect(codeReviewerFor(typescript, [changed('src/a.ts', 7), changed('src/b.tsx', 1), changed('docs/x.md', 2)])).toBe('typescript-reviewer')
    expect(codeReviewerFor(typescript, [changed('src/pkg/a.py', 10)])).toBe('code-reviewer')
    expect(codeReviewerFor(typescript, [])).toBe('code-reviewer')
  })

  test('every stack\'s command sources hold the git keys that run or route commands (GAP-R2-0.6-33)', async () => {
    const w = world({ gitOut: { ...HEAD } }), p = await gitPaths(w.host.io, ROOT)
    for (const s of STACK_ENTRIES) {
      const keys = Object.keys((await s.code.commandSources(w.host.io, p, [])).hashes)
      for (const k of ['git:config', 'git:info/exclude', 'git:config.worktree']) expect([s.data.id, keys.includes(k)]).toEqual([s.data.id, true])
    }
  })

  test('the guard context carries the publish union itself, whatever stack the record froze (A-3)', async () => {
    const w = world({ gitOut: { ...HEAD } }), r = await toS3(w)
    if (!r) throw new Error('no record at S3')
    expect((await guardCtx(w.host, r, { cwd: ROOT }, w.session().value ?? emptySession())).publish).toBe(PUBLISH_UNION)
  })

  test('denyRead keeps one order for the proposed block and the judge\'s fallback: the stack\'s files, COMMON_DENY_READ, flow\'s own', () => {
    for (const s of STACKS) {
      expect(stackDenyRead(s)).toEqual([...new Set([...s.sandbox.denyRead, ...COMMON_DENY_READ, ...FLOW_DENY_READ])])
      expect(proposeBlock(s, []).filesystem.denyRead).toEqual(stackDenyRead(s))
    }
  })

  test('every stack has its setup texts in both languages (what it needs, and how to add a test command)', () => {
    for (const s of STACKS) for (const lang of ['en', 'vi'] as const) {
      expect(TEXTS[lang][`setup.needs.${s.id}`]).toBeDefined()
      expect(TEXTS[lang][`setup.noTest.${s.id}`]).toBeDefined()
    }
  })
})
