// The vendored agent-skills methods as tickets quote them (plan v7.1 §8): the pure parts. The files on disk, their hashes
// and the headings §8.1 cites are checked by `node tests/vendor.check.mjs` (claude plugin test reads no real files).
import { describe, expect, test } from 'claude-code/testing'
import { RED_TESTING, ROUTING } from '../flow/data/routing'
import type { Role } from '../flow/data/types'
import { methodSection, methodText, sectionsOf, OVERRIDES, VENDOR_DIR, VENDOR_LOCK } from '../hooks/flow-method'
import { authorTicketText, debugTicketText, planTicketText, redTicketText, reviewTicketText } from '../hooks/flow-review'
import { fakeHost, METHOD_HEAD as HEAD, MOD_ROOT, OVERRIDES_TEXT, VENDOR_SHA } from './flow-fakes'

const N = 'abcd1234abcd1234'
const MD = [
  '# Testing', 'intro',
  '## Test Structure (Arrange-Act-Assert)', '```ts', '# not a heading', '## nor this', '```', 'structure',
  '## Test Naming Conventions', 'naming',
  '## Common Assertions', 'not sent',
  '## Mocking Patterns', '### Mock Functions', 'fns', '### Mock at Boundaries Only', 'boundaries',
  '## React/Component Testing', 'react',
  '## Test Anti-Patterns', 'anti', '',
].join('\n')

describe('vendored methods (plan §8)', () => {
  test('sectionsOf: a section runs from its heading to the next heading at its level or above, in the order asked; fenced code holds no heading', () => {
    expect(sectionsOf(MD, ['Mock at Boundaries Only', 'Test Structure', 'Test Anti-Patterns'])).toEqual([
      '### Mock at Boundaries Only\nboundaries',
      '## Test Structure (Arrange-Act-Assert)\n```ts\n# not a heading\n## nor this\n```\nstructure',
      '## Test Anti-Patterns\nanti',
    ])
    expect(sectionsOf(MD, ['Test Naming'])).toEqual(['## Test Naming Conventions\nnaming'])
  })

  test('sectionsOf: a cited heading starts the heading in whole words; a missing one fails loudly', () => {
    expect(() => sectionsOf(MD, ['Test Nam'])).toThrow('no section "Test Nam"')
    expect(() => sectionsOf(MD, ['nor this'])).toThrow('no section "nor this"')
    expect(() => sectionsOf(MD, ['Structure'])).toThrow()
    expect(sectionsOf('## A\n~~~\n## B inside a fence\n~~~\n## B\nb\n', ['B'])).toEqual(['## B\nb'])
  })

  test('methodSection: the heading names agent-skills, MIT and the locked commit, then the texts, then the overrides', () => {
    expect(methodSection(VENDOR_SHA, ['one\n', '\ntwo'], 'OVER\n')).toBe('## Reference method (agent-skills, MIT, aeac41d4)\n\none\n\ntwo\n\nOVER')
  })

  test('methodText: each role gets its routed skill under the heading, then the overrides; B1 gets the testing sections only', async () => {
    const { host } = fakeHost()
    const routed: [Role, string][] = [['planner', 'planning-and-task-breakdown'], ['author', 'incremental-implementation'], ['reviewer', 'code-review-and-quality'], ['securityReviewer', 'security-and-hardening'], ['debugger', 'debugging-and-error-recovery'], ['buildFixer', 'debugging-and-error-recovery']]
    for (const [role, skill] of routed) {
      expect(ROUTING.skills[role]).toEqual([skill])
      const text = await methodText(host.io, role)
      expect(text.split('\n')[0]).toBe(HEAD)
      expect(text).toContain(`METHOD ${skill}`)
      expect(text.endsWith(OVERRIDES_TEXT.trim())).toBe(true)
    }
    const red = await methodText(host.io, 'red')
    expect(red).toBe([HEAD, '## Test Structure (Arrange-Act-Assert)\nSTRUCTURE', '## Test Naming Conventions\nNAMING', '### Mock at Boundaries Only\nBOUNDARIES', '## Test Anti-Patterns\nANTI', OVERRIDES_TEXT.trim()].join('\n\n'))
    expect(red).not.toContain('NOT SENT')
  })

  test('B1 testing text is the testing-patterns sections §8.1 cites (the routing fallback of §8)', () => {
    expect(ROUTING.skills.red).toEqual([])
    expect(RED_TESTING).toEqual({ reference: 'testing-patterns', sections: ['Test Structure', 'Test Naming', 'Mock at Boundaries Only', 'Test Anti-Patterns'] })
    expect(ROUTING.references.red).toContain(RED_TESTING.reference)
  })

  test('a vendored file that cannot be read, or a lock without a commit sha, fails loudly and names the file', async () => {
    for (const gone of [`${VENDOR_DIR}/skills/planning-and-task-breakdown/SKILL.md`, VENDOR_LOCK, OVERRIDES]) {
      const w = fakeHost()
      w.files.delete(`${MOD_ROOT}/${gone}`)
      await expect(methodText(w.host.io, 'planner')).rejects.toThrow(gone)
    }
    const red = fakeHost()
    red.files.delete(`${MOD_ROOT}/${VENDOR_DIR}/references/testing-patterns.md`)
    await expect(methodText(red.host.io, 'red')).rejects.toThrow('references/testing-patterns.md')
    for (const lock of ['{"sha":"main"}', '[]', 'not json']) {
      const w = fakeHost({ files: { [`${MOD_ROOT}/${VENDOR_LOCK}`]: lock } })
      await expect(methodText(w.host.io, 'planner')).rejects.toThrow(VENDOR_LOCK)
    }
  })

  test('every ticket that carries a method has it after its own instructions and before its ANSWER; without one there is no method section', () => {
    const method = methodSection(VENDOR_SHA, ['METHOD X'], OVERRIDES_TEXT)
    const c = { f: 'F-01', nonce: N, pluginProject: false }
    const texts = (m: string | undefined) => [
      redTicketText({ ...c, pack: 'PACK', problems: [], method: m }), authorTicketText({ ...c, pack: 'PACK', method: m }),
      debugTicketText({ ...c, failing: 'FAIL x', pack: 'PACK', method: m }), planTicketText({ ...c, intent: 'add', issues: [], method: m }),
      reviewTicketText({ ...c, acs: ['AC-001 adds'], rubrics: [], diff: '+x', redDiff: '', method: m }),
    ].map(t => t ?? '')
    for (const t of texts(method)) {
      expect(t.indexOf(method)).toBeGreaterThan(0)
      expect(t.indexOf(method)).toBeLessThan(t.indexOf('## ANSWER'))
      expect(t.indexOf('## PACK') < 0 || t.indexOf('## PACK') < t.indexOf(method)).toBe(true)
    }
    for (const t of texts(undefined)) expect(t).not.toContain('Reference method')
  })
})
