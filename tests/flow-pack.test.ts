import { describe, expect, test } from 'claude-code/testing'
import { featurePack, roomLeft, viewText, HUNK_CONTEXT, type Pack, type PackIn } from '../hooks/flow-pack'
import { debugTicketText } from '../hooks/flow-review'
import { REDACTED_LINE } from '../hooks/secrets'
import type { Plan } from '../hooks/flow-plan'
import type { PathRule } from '../hooks/rules'

const PLAN: Plan = {
  acs: [
    { id: 'AC-001', required: true, text: 'adds two numbers. Verification: test name contains `AC-001`' },
    { id: 'AC-002', required: true, text: 'ALPHA-ONLY behaviour. Verification: test name contains `AC-002`' },
    { id: 'AC-003', required: false, text: 'subtracts. Verification: test name contains `AC-003`' },
  ],
  features: [
    { id: 'F-01', title: 'First feature ALPHA', acs: ['AC-002'], files: [{ path: 'src/one.ts', isNew: false }, { path: 'tests/one.test.ts', isNew: false }], security: false },
    { id: 'F-02', title: 'Calculator', acs: ['AC-001', 'AC-003'], files: [{ path: 'src/calc.ts', isNew: false }, { path: 'tests/calc.test.ts', isNew: false }, { path: 'src/new.ts', isNew: true }], security: true },
  ],
}
const RULES: PathRule[] = [
  { id: 'typescript/coding-style.md', path: '/m/instructions/paths/typescript/coding-style.md', globs: ['**/*.ts', '**/*.tsx'], body: 'TS RULE BODY' },
  { id: 'python/coding-style.md', path: '/m/instructions/paths/python/coding-style.md', globs: ['**/*.py'], body: 'PY RULE BODY' },
]
/** Lines `row <n> end`, numbered from `from` to `to`. */
const rows = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => `row ${from + i} end`).join('\n')
const FILES = [{ path: 'src/calc.ts', text: 'export const add = (a: number, b: number) => a + b' }, { path: 'tests/calc.test.ts', text: "it('AC-001 adds', () => {})" }]
const input = (over: Partial<PackIn> = {}): PackIn => ({ f: 'F-02', plan: PLAN, flowRules: 'FLOW RULES BODY', stack: 'typescript', rules: RULES, files: FILES, pattern: { path: 'src/util.ts', text: 'PATTERN BODY' }, ...over })
const textOf = (p: Pack): string => (p.ok ? p.text : '')

describe('flow packs (plan v7.1 §7)', () => {
  test('a pack holds, in order: flow rules, the stack rules for its files, its plan section, the ACs it cites, its files in plan order, one pattern file', () => {
    const p = featurePack(input())
    const text = textOf(p)
    const marks = ['FLOW RULES BODY', 'TS RULE BODY', 'F-02: Calculator', '- Security: yes', '- AC-001 (Required): adds two numbers', '- AC-003 (Optional): subtracts',
      '#### src/calc.ts', 'a + b', '#### tests/calc.test.ts', '#### src/new.ts (new, not written yet)', '#### src/util.ts', 'PATTERN BODY']
    for (const m of marks) expect([m, text.includes(m)]).toEqual([m, true])
    const at = marks.map(m => text.indexOf(m))
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(p.ok && [p.shrunk, p.patternDropped]).toEqual([[], false])
    const reversed = textOf(featurePack(input({ files: [...FILES].reverse() })))
    expect(reversed.indexOf('#### src/calc.ts') < reversed.indexOf('#### tests/calc.test.ts')).toBe(true)
    // a file whose text holds a code fence is shown in a longer one, so the fence cannot close early
    expect(textOf(featurePack(input({ files: [{ path: 'src/calc.ts', text: 'a\n```\nb' }] })))).toContain('````\na\n```\nb\n````')
  })

  test("a pack holds the flow stack's rules only (§7: the routed agent's stack rules), even where another stack's rule matches its files", () => {
    const arkts: PathRule = { id: 'arkts/coding-style.md', path: '/m/instructions/paths/arkts/coding-style.md', globs: ['**/*.ts'], body: 'ARKTS RULE BODY' }
    const text = textOf(featurePack(input({ rules: [...RULES, arkts] })))
    expect([text.includes('TS RULE BODY'), text.includes('ARKTS RULE BODY')]).toEqual([true, false])
    expect(textOf(featurePack(input({ rules: [...RULES, arkts], stack: 'arkts' })))).toContain('ARKTS RULE BODY')
    expect(textOf(featurePack(input({ rules: [{ ...arkts, id: 'typescript-extra/x.md' }] })))).not.toContain('ARKTS RULE BODY')
  })

  test('a pack holds nothing of another feature; a file outside its Files, or a feature the plan lacks, fails loudly', () => {
    const text = textOf(featurePack(input()))
    for (const other of ['ALPHA', 'AC-002', 'src/one.ts', 'tests/one.test.ts', 'F-01', 'PY RULE BODY']) expect([other, text.includes(other)]).toEqual([other, false])
    expect(() => featurePack(input({ files: [...FILES, { path: 'src/one.ts', text: 'x' }] }))).toThrow('src/one.ts is not a file of F-02')
    expect(() => featurePack(input({ f: 'F-09' }))).toThrow('F-09 is not a feature of the approved plan')
    expect(textOf(featurePack(input({ f: 'F-01', files: [] })))).toContain('- Security: no')
    const unset = { ...PLAN, features: PLAN.features.map(x => ({ ...x, security: null })) }
    expect(textOf(featurePack(input({ plan: unset })))).toContain('- Security: not set')
  })

  test('every part is redacted before anything is cut: a secret line anywhere, and a key block that the shrink window cuts through', () => {
    const key = 'ghp_' + 'e'.repeat(36), begin = '-----BEGIN EC ' + 'PRIVATE KEY-----', end = '-----END EC ' + 'PRIVATE KEY-----'
    const lines = rows(1, 3000).split('\n')
    lines.splice(99, 202, begin, ...Array<string>(200).fill('S0VZ'.repeat(16)), end) // BEGIN at 100, END at 301
    const p = featurePack(input({ files: [{ path: 'src/calc.ts', text: lines.join('\n') }, { path: 'tests/calc.test.ts', text: `const t = "${key}"` }], hunks: [{ path: 'src/calc.ts', start: 200, end: 201 }] }))
    const text = textOf(p)
    expect(p.ok && p.shrunk).toEqual(['src/calc.ts']) // the window 160-241 lies inside the key, away from both markers
    expect([text.includes('S0VZS0VZ'), text.includes(key), text.includes(REDACTED_LINE)]).toEqual([false, false, true])
    expect([text.includes('[flow: lines 1-159 not shown]'), text.includes('[flow: lines 242-3000 not shown]')]).toEqual([true, true])
    for (const over of [{ flowRules: `rules ${key}` }, { pattern: { path: 'src/util.ts', text: key } }, { rules: [{ ...RULES[0] as PathRule, body: key }] }])
      expect(textOf(featurePack(input(over))).includes(key)).toBe(false)
    // a private file never becomes the pattern file (the plan lint vets Files, not the pattern)
    for (const path of ['.env.local', 'certs/site.pem', '.snagon/memory/memory.jsonl', 'config/.ENV', 'deploy/ID_RSA'])
      expect(() => featurePack(input({ pattern: { path, text: 'DB_PASSWORD=hunter2hunter2' } }))).toThrow(`the pattern file ${path} is private`)
  })

  test('over the cap the largest files shrink to their changed lines ±40 first, then the pattern file goes, then the feature is split', () => {
    expect(HUNK_CONTEXT).toBe(40) // plan §7: hunks ±40
    const p = featurePack(input({
      files: [{ path: 'tests/calc.test.ts', text: rows(1, 400) }, { path: 'src/calc.ts', text: rows(1, 3000) }], // the largest is not first
      hunks: [{ path: 'src/calc.ts', start: 1000, end: 1004 }, { path: 'tests/calc.test.ts', start: 5, end: 5 }, { path: 'src/other.ts', start: 1, end: 1 }],
    }))
    const text = textOf(p)
    expect(p.ok && [p.shrunk, p.patternDropped]).toEqual([['src/calc.ts'], false]) // shrinking the largest was enough
    const lo = 1000 - HUNK_CONTEXT, hi = 1004 + HUNK_CONTEXT
    expect([lo, lo - 1, hi, hi + 1].map(n => text.includes(`row ${n} end`))).toEqual([true, false, true, false])
    expect([text.includes(`[flow: lines 1-${lo - 1} not shown]`), text.includes(`[flow: lines ${hi + 1}-3000 not shown]`), text.includes('row 400 end')]).toEqual([true, true, true])
    // a file that ends with a line break still has 3000 lines
    const ending = textOf(featurePack(input({ files: [{ path: 'src/calc.ts', text: `${rows(1, 3000)}\n` }], hunks: [{ path: 'src/calc.ts', start: 100, end: 100 }] })))
    expect([ending.includes('[flow: lines 141-3000 not shown]'), ending.includes('3001')]).toEqual([true, false])
    // two changes whose windows overlap show one run; a change at the first line has no gap before it
    const merged = textOf(featurePack(input({ files: [{ path: 'src/calc.ts', text: rows(1, 3000) }], hunks: [{ path: 'src/calc.ts', start: 1, end: 1 }, { path: 'src/calc.ts', start: 60, end: 60 }] })))
    expect([merged.includes('row 1 end'), merged.includes('row 100 end'), merged.includes('row 101 end'), merged.includes('[flow: lines 101-3000 not shown]'), merged.includes('[flow: lines 1-')]).toEqual([true, true, false, true, false])
    // a file with no change to show (B1, before any diff) cannot shrink: the pattern file goes first, then the feature is split
    const tight = featurePack(input({ files: [{ path: 'src/calc.ts', text: rows(1, 1400) }], pattern: { path: 'src/util.ts', text: rows(5001, 5200) } }))
    expect([tight.ok, tight.ok && tight.patternDropped, tight.ok && tight.shrunk, textOf(tight).includes('row 5001 end')]).toEqual([true, true, [], false])
    expect(textOf(tight)).toContain('#### tests/calc.test.ts (not in the tree now)')
    // a hunk past the end of the text (older than the text) shows nothing of its own
    const stale = featurePack(input({ files: [{ path: 'src/calc.ts', text: rows(1, 1600) }], hunks: [{ path: 'src/calc.ts', start: 1700, end: 1701 }] }))
    expect(stale).toEqual({ ok: false, split: true })
    expect(featurePack(input({ files: [{ path: 'src/calc.ts', text: rows(1, 1600) }] }))).toEqual({ ok: false, split: true })
    expect(featurePack(input({ pattern: undefined }), { lines: 10, chars: 60_000 })).toEqual({ ok: false, split: true })
  })

  test('roomLeft: the room a ticket frame leaves, so the ticket with its pack stays within the ticket cap', () => {
    // the frame holds the role's vendored method (plan §8), so the pack's room is what the method leaves
    const t = { f: 'F-02', failing: 'FAIL x', nonce: 'abcd1234abcd1234', pluginProject: true, method: Array<string>(300).fill('method line').join('\n') }
    const room = roomLeft(debugTicketText({ ...t, pack: '' }) ?? '')
    const lines = Array<string>(room.lines).fill('p').join('\n')
    expect([debugTicketText({ ...t, pack: lines }) !== null, debugTicketText({ ...t, pack: `${lines}\np` })]).toEqual([true, null])
    expect([debugTicketText({ ...t, pack: 'q'.repeat(room.chars) }) !== null, debugTicketText({ ...t, pack: 'q'.repeat(room.chars + 1) })]).toEqual([true, null])
    const p = featurePack(input(), room)
    expect(p.ok && debugTicketText({ ...t, pack: p.text }) !== null).toBe(true)
  })

  test('a view is written redacted; leak says something was removed (in docs/flow/verify.md that blocks the flow at V8)', () => {
    const key = 'sk-ant-' + 'api03-' + 'B'.repeat(30)
    const v = viewText(`# Verify\n- F-01: evidence ${key}\n- F-02: ok`)
    expect([v.leak, v.text.split('\n')]).toEqual([true, ['# Verify', '- F-01: evidence [secret removed: Anthropic API key]', '- F-02: ok']])
    expect(viewText('# Verify\nall clean')).toEqual({ text: '# Verify\nall clean', leak: false })
  })
})
