import { describe, expect, test } from 'claude-code/testing'
import { lintPlan, featureKey, carryCounters, LINT_CODES, type LintCtx } from '../hooks/flow-plan'
import { TEXTS } from '../flow/data/templates'
import { TYPESCRIPT } from '../flow/data/stacks/typescript'

const ROOT = '/Users/u/dev/app'
const EXISTING = new Set(['src/a.ts', 'tests/a.test.ts', 'src/old.ts', '.env'])
const DIRS = new Set(['src', 'tests'])
const ctx = (over: Partial<LintCtx> = {}): LintCtx => ({
  root: ROOT, kind: async (rel: string) => (EXISTING.has(rel) ? 'file' : DIRS.has(rel) ? 'dir' : null), pluginRoots: [`${ROOT}/mods/tool`], testGlobs: TYPESCRIPT.testFiles, ...over,
})
const GOOD = `# Plan

## Acceptance
- AC-001 (Required): adding two numbers returns their sum. Verification: test name contains \`AC-001\`
- AC-002 (Required): negative numbers work. Verification: test name contains \`AC-002\`
- AC-003 (Optional): a CLI prints the sum. Verification: test name contains \`AC-003\`

## Features
### F-01: Add numbers
- ACs: AC-001, AC-002
- Files: src/a.ts, tests/a.test.ts, src/b.ts (new)
- Security: no

### F-02: Print the sum
- ACs: AC-003
- Files: src/cli.ts (new), tests/cli.test.ts (new)
- Security: yes
`
const codes = async (text: string, c = ctx()): Promise<string[]> => (await lintPlan(text, c)).issues.map(i => i.code).sort()

describe('flow plan lint', () => {
  test('a good plan has no issues, a stable hash, and the features it describes', async () => {
    const r = await lintPlan(GOOD, ctx())
    expect(r.issues).toEqual([])
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/)
    expect((await lintPlan(GOOD, ctx())).hash).toBe(r.hash)
    expect((await lintPlan(GOOD.replace('their sum', 'the sum'), ctx())).hash).not.toBe(r.hash)
    expect(r.plan.features.map(f => [f.id, f.title, f.acs, f.files.map(x => `${x.path}${x.isNew ? '+' : ''}`), f.security])).toEqual([
      ['F-01', 'Add numbers', ['AC-001', 'AC-002'], ['src/a.ts', 'tests/a.test.ts', 'src/b.ts+'], false],
      ['F-02', 'Print the sum', ['AC-003'], ['src/cli.ts+', 'tests/cli.test.ts+'], true],
    ])
    expect(r.plan.acs.map(a => [a.id, a.required])).toEqual([['AC-001', true], ['AC-002', true], ['AC-003', false]])
  })

  test('a plan in another format (such as plan-mode output) fails with one readable issue', async () => {
    const r = await lintPlan('# Implementation plan\n\n1. Add a function\n2. Write tests\n', ctx())
    expect(r.issues.map(i => i.code)).toEqual(['format'])
  })

  test('acceptance rules: unique ids, a Verification each, every Required AC in a feature, no unknown AC in a feature', async () => {
    const dup = GOOD.replace('- AC-003 (Optional)', '- AC-002 (Optional)')
    expect(await codes(dup)).toContain('ac.duplicate')
    expect(await codes(GOOD.replace('negative numbers work. Verification: test name contains `AC-002`', 'negative numbers work.'))).toEqual(['ac.verification'])
    expect(await codes(GOOD.replace('- ACs: AC-001, AC-002', '- ACs: AC-001'))).toEqual(['ac.uncovered'])
    expect(await codes(GOOD.replace('- ACs: AC-003', '- ACs: AC-003, AC-009'))).toEqual(['ac.unknown'])
    expect(await codes(GOOD.replace('- AC-003 (Optional): a CLI', '- AC-3 (Maybe): a CLI'))).toContain('ac.syntax')
  })

  test('feature rules: sequential ids, at most 50, at least one AC and one test file, Security yes or no', async () => {
    expect(await codes(GOOD.replace('### F-02:', '### F-03:'))).toEqual(['f.sequence'])
    expect(await codes(GOOD.replace('- ACs: AC-003\n', '- ACs:\n'))).toContain('f.noAc')
    expect(await codes(GOOD.replace('tests/cli.test.ts (new)', 'src/cli2.ts (new)'))).toEqual(['f.noTest'])
    expect(await codes(GOOD.replace('- Security: yes\n', ''))).toEqual(['f.security'])
    expect(await codes(GOOD.replace('- Security: yes', '- Security: maybe'))).toEqual(['f.security'])
    const many = Array.from({ length: 51 }, (_, i) => `### F-${String(i + 1).padStart(2, '0')}: Feature ${i + 1}\n- ACs: AC-001\n- Files: tests/f${i}.test.ts (new)\n- Security: no\n`).join('\n')
    expect(await codes(`## Acceptance\n- AC-001 (Required): x. Verification: test name contains \`AC-001\`\n\n## Features\n${many}`)).toEqual(['f.tooMany'])
  })

  test('file rules: exists or (new); never outside the root, in a plugin root, in flow data, protected, or private', async () => {
    const files = (list: string): Promise<string[]> => codes(GOOD.replace('- Files: src/cli.ts (new), tests/cli.test.ts (new)', `- Files: ${list}, tests/cli.test.ts (new)`))
    expect(await files('src/gone.ts')).toEqual(['file.missing'])
    expect(await files('src/old.ts (new)')).toEqual(['file.newExists'])
    expect(await files('../outside.ts (new)')).toEqual(['file.outside'])
    expect(await files('/etc/hosts (new)')).toEqual(['file.outside'])
    expect(await files('mods/tool/hooks/x.ts (new)')).toEqual(['file.plugin'])
    expect(await files('.snagon/memory/x.md (new)')).toEqual(['file.flowData'])
    for (const p of ['.claude/settings.json', '.Claude/agents/x.md', '.GIT/config', '.github/../.mcp.json', 'docs/flow/verify.md', '.husky/pre-commit']) expect([p, await files(`${p} (new)`)]).toEqual([p, ['file.protected']])
    expect(await files('.env (new)')).toEqual(['file.private'])
    expect(await files('keys/id_ed25519 (new)')).toEqual(['file.private'])
  })

  test('hostile variants a planner could write are each caught, not skipped', async () => {
    const cases: Array<[string, string, string[]]> = [
      ['star bullet AC', GOOD.replace('- AC-002 (Required)', '* AC-002 (Required)'), ['ac.syntax', 'ac.unknown']],
      ['numbered AC', GOOD.replace('- AC-002 (Required)', '1. AC-002 (Required)'), ['ac.syntax', 'ac.unknown']],
      ['indented AC', GOOD.replace('- AC-002 (Required)', '  - AC-002 (Required)'), ['ac.syntax', 'ac.unknown']],
      ['extra bullet in a feature', GOOD.replace('- Security: no', '- Security: no\n- Notes: also touch .git/config'), ['f.syntax']],
      ['Security twice', GOOD.replace('- Security: yes', '- Security: yes\n- Security: no'), ['f.syntax']],
      ['backticked path', GOOD.replace('src/cli.ts (new)', '`.git/config` (new)'), ['file.badPath']],
      ['quoted path', GOOD.replace('src/cli.ts (new)', '".claude/settings.json" (new)'), ['file.badPath']],
      ['glob path', GOOD.replace('src/cli.ts (new), tests/cli.test.ts (new)', '**/*.test.ts (new)'), ['f.noTest', 'file.badPath']],
      ['a folder as a file', GOOD.replace('src/cli.ts (new)', 'src'), ['file.badPath']],
      ['private file in capitals', GOOD.replace('src/cli.ts (new)', '.ENV'), ['file.private']],
      ['key file in capitals', GOOD.replace('src/cli.ts (new)', 'ID_RSA (new)'), ['file.private']],
      ['dot slash and double slash stay inside', GOOD.replace('src/cli.ts (new)', './src//cli.ts (new)'), []],
      ['two features with the same content', GOOD.replace('### F-02: Print the sum\n- ACs: AC-003', '### F-02: Add numbers\n- ACs: AC-002, AC-001'), ['f.duplicate']],
      ['a tilde line does not close a backtick fence', GOOD.replace('## Features\n', '## Features\n\`\`\`\n~~~\n### F-09: hidden\n- Files: .git/config\n\`\`\`\n'), []],
      ['a continuation line inside a feature', GOOD.replace('- Files: src/a.ts, tests/a.test.ts, src/b.ts (new)', '- Files: src/a.ts, tests/a.test.ts, src/b.ts (new),\n  .github/workflows/release.yml'), ['f.syntax']],
      ['a feature header under another section', GOOD + '\n## Notes\n### F-03: Extra\n- ACs: AC-003\n', ['f.syntax']],
      ['right-to-left override hides TODO', GOOD.replace('a CLI prints the sum', 'a CLI prints the sum \u202eODOT'), ['text.invisible']],
      ['zero-width character inside TODO', GOOD.replace('a CLI prints the sum', 'a CLI prints the sum TO\u200bDO'), ['text.invisible', 'text.vague']],
    ]
    for (const [name, text, want] of cases) expect([name, await codes(text)]).toEqual([name, want])
  })

  test('Windows line ends lint the same; a fenced example is ignored; a link into a plugin is caught through the resolver', async () => {
    const crlf = await lintPlan(GOOD.replace(/\n/g, '\r\n'), ctx())
    expect([crlf.issues, crlf.hash]).toEqual([[], (await lintPlan(GOOD, ctx())).hash])
    const fenced = GOOD.replace('## Features\n', '## Features\n\`\`\`\n## Example\n### F-09: sample\n- Notes: x\n\`\`\`\n')
    expect(await codes(fenced)).toEqual([])
    const linked = ctx({ resolve: async (abs: string) => (abs === `${ROOT}/src/lib.ts` ? `${ROOT}/mods/tool/hooks/x.ts` : abs) })
    expect(await codes(GOOD.replace('src/cli.ts (new)', 'src/lib.ts (new)'), linked)).toEqual(['file.plugin'])
    const away = ctx({ resolve: async (abs: string) => (abs === `${ROOT}/src/lib.ts` ? '/etc/hosts' : abs) })
    expect(await codes(GOOD.replace('src/cli.ts (new)', 'src/lib.ts (new)'), away)).toEqual(['file.outside'])
    const viaLink = ctx({ resolve: async (abs: string) => abs.replace(`${ROOT}/cfg/`, `${ROOT}/.git/`) })
    expect(await codes(GOOD.replace('src/cli.ts (new)', 'cfg/hooks/pre-commit (new)'), viaLink)).toEqual(['file.protected'])
    const vague = await lintPlan(GOOD.replace('a CLI prints the sum', 'a CLI prints the sum TO\u200bDO'), ctx())
    expect(vague.issues.find(i => i.code === 'text.vague')?.detail).toBe('TODO')
  })

  test('vague words are refused anywhere in the plan, as whole words only', async () => {
    for (const w of ['TBD', 'todo', 'Deferred: the CLI', 'we do this later']) expect([w, await codes(GOOD.replace('a CLI prints the sum', `a CLI prints the sum (${w})`))]).toEqual([w, ['text.vague']])
    expect(await codes(GOOD.replace('a CLI prints the sum', 'a CLI prints the latest sum (todos list)'))).toEqual([])
  })

  test('every issue code has a message in both languages', () => {
    for (const c of LINT_CODES) { expect([c, typeof TEXTS.en[`lint.${c}`]]).toEqual([c, 'string']); expect([c, typeof TEXTS.vi[`lint.${c}`]]).toEqual([c, 'string']) }
  })
})

describe('feature keys across re-plans', () => {
  const f = (id: string, title: string, acs: string[]) => ({ id, title, acs, files: [], security: false })
  test('the key follows the content (title and ACs), not the number, so renumbering keeps counters and a real change resets them', () => {
    expect(featureKey(f('F-03', 'Print the sum', ['AC-003', 'AC-004']))).toBe(featureKey(f('F-02', ' print  the SUM ', ['AC-004', 'AC-003'])))
    expect(featureKey(f('F-02', 'Print the sum', ['AC-003']))).not.toBe(featureKey(f('F-02', 'Print the total', ['AC-003'])))
    expect(featureKey(f('F-02', 'Print the sum', ['AC-003']))).not.toBe(featureKey(f('F-02', 'Print the sum', ['AC-003', 'AC-005'])))
    expect(featureKey(f('F-01', 'X', ['AC-001']))).toMatch(/^fk-[0-9a-f]{8}$/)
  })

  test('carry: counters of an unchanged feature move to its new number; changed and new features start at zero', () => {
    const old = [f('F-01', 'Add numbers', ['AC-001']), f('F-02', 'Old idea', ['AC-002']), f('F-03', 'Print the sum', ['AC-003'])]
    const counters = { [featureKey(old[0]!)]: { e: 2, r: 1, d: 0, retried: false }, [featureKey(old[1]!)]: { e: 3, r: 3, d: 4, retried: true }, [featureKey(old[2]!)]: { e: 1, r: 0, d: 0, retried: false } }
    const next = [f('F-01', 'Add numbers', ['AC-001']), f('F-02', 'Print the sum', ['AC-003']), f('F-03', 'New idea', ['AC-004'])]
    const r = carryCounters(counters, next)
    expect(r.carried).toEqual(['F-01', 'F-02'])
    expect(r.reset).toEqual(['F-03'])
    expect(r.counters).toEqual({ [featureKey(next[0]!)]: { e: 2, r: 1, d: 0, retried: false }, [featureKey(next[1]!)]: { e: 1, r: 0, d: 0, retried: false }, [featureKey(next[2]!)]: { e: 0, r: 0, d: 0, retried: false } })
    expect(Object.keys(r.counters)).not.toContain(featureKey(old[1]!)) // a dropped feature's counters leave the plan
  })
})
