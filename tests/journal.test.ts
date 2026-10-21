import { describe, expect, test } from 'claude-code/testing'
import { isScratch, editsAfter, withEdit, stopReason, compactEntry, compactContext, shortcutPhrase, MAX_EDITS } from '../hooks/journal'
import { planHandoff, WORKER_SCRIPT, MAX_JOURNAL_CHARS } from '../hooks/handoff'
import { usageNotices, statusText, subagentReminder } from '../hooks/usage'
import { parseConfig, isExemptLine, hashOf } from '../hooks/session'

const ROOT = '/p', JDIR = '/p/.snagon/journal'

describe('journal', () => {
  test('the journal, the mod data and temp files never need an entry; project files always do', () => {
    expect(isScratch('/p/.snagon/journal/2026-10-11.md', ROOT, JDIR)).toBe(true)
    expect(isScratch('/p/.snagon/cost.jsonl', ROOT, JDIR)).toBe(true)
    expect(isScratch('/tmp/x.txt', ROOT, JDIR)).toBe(true)
    expect(isScratch('/p/src/a.py', ROOT, JDIR)).toBe(false)
    expect(isScratch('/tmp/proj/src/a.py', '/tmp/proj', '/tmp/proj/.snagon/journal')).toBe(false)
  })

  test('edits after the last entry: newest per file, oldest first, scratch dropped', () => {
    const edits = [{ file: '/p/a.py', at: 5 }, { file: '/p/b.py', at: 20 }, { file: '/p/a.py', at: 30 }, { file: '/tmp/s', at: 40 }, { file: '/p/c.py', at: 1 }]
    expect(editsAfter(edits, 10, ROOT, JDIR)).toEqual([{ file: '/p/b.py', at: 20 }, { file: '/p/a.py', at: 30 }])
  })

  test('the edit list keeps one row per file and at most MAX_EDITS rows', () => {
    let edits = [{ file: '/p/a', at: 1 }]
    edits = withEdit(edits, '/p/a', 2)
    expect(edits).toEqual([{ file: '/p/a', at: 2 }])
    for (let i = 0; i < MAX_EDITS + 10; i += 1) edits = withEdit(edits, `/p/f${i}`, i)
    expect(edits.length).toBe(MAX_EDITS)
  })

  test('the stop reason names the files, the real clock and the line words', () => {
    const r = stopReason([{ file: '/p/src/a.py', at: 1 }], ROOT, '/p/.snagon/journal/2026-10-11.md', '21:07', { decision: 'Quyết định', lesson: 'Bài học' })
    expect(r).toContain('1 file(s) changed after the last journal entry: src/a.py.')
    expect(r).toContain('## 21:07 · <topic>')
    expect(r).toContain('"Quyết định:"')
    expect(r).toContain('.snagon/journal/2026-10-11.md')
  })

  test('the compaction entry exists in both languages', () => {
    expect(compactEntry('21:07', 'abcd1234-0000-1122ffee', ['src/a.py'], false, 'vi')).toContain('## 21:07 · Nén ngữ cảnh (tự động; mục này do hook ghi)')
    expect(compactEntry('21:07', '', [], true, 'en')).toContain('Files edited with Edit/Write since the previous entry: none.')
    expect(compactContext('x\n'.repeat(10), 'j.md')).toContain('Context was just compacted')
  })

  test('shortcut phrases are noticed; ordinary text is not', () => {
    expect(shortcutPhrase('I will skip the tests for now.')).toBe('skip the tests for now')
    expect(shortcutPhrase('That is a pre-existing bug.')).toBe('pre-existing bug')
    expect(shortcutPhrase('All tests pass.')).toBeNull()
    expect(shortcutPhrase(undefined)).toBeNull()
  })
})

describe('handoff', () => {
  test('no handoff when the journal did not change; the prompt carries the addendum and the journal', () => {
    expect(planHandoff('j', 10, 10, '', '/p/.snagon/handoff', '2026-10-11', 's')).toBeNull()
    const plan = planHandoff('journal text', 11, 10, 'Owner rules here.', '/p/.snagon/handoff', '2026-10-11', 'abcd-12345678')
    expect(plan?.outFile).toBe('/p/.snagon/handoff/2026-10-11.md')
    expect(plan?.promptFile).toBe('/p/.snagon/handoff/prompt-12345678.md')
    expect(plan?.prompt).toContain('Owner rules here.')
    expect(plan?.prompt).toContain('<journal>\njournal text\n</journal>')
  })

  test('journal lines that look like secrets never reach the handoff worker', () => {
    const plan = planHandoff(`- note\n- key ${'ghp_' + 'd'.repeat(36)}\n`, 2, 1, '', '/d', '2026-10-11', 's')
    expect(plan?.prompt).toContain('- key [secret removed: GitHub token]')
    expect(plan?.prompt).not.toContain('ghp_')
  })

  test('a private-key block is removed whole, not only its first line', () => {
    const begin = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', end = '-----END OPENSSH ' + 'PRIVATE KEY-----'
    const plan = planHandoff(['- before', begin, 'b3BlbnNzaC1rZXktdjEAAAAA'.repeat(3), 'QUJDREVGR0g=', end, '- after'].join('\n'), 2, 1, '', '/d', '2026-10-11', 's')
    expect(plan?.prompt).toContain('- before')
    expect(plan?.prompt).toContain('- after')
    expect(plan?.prompt).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA')
    expect(plan?.prompt).not.toContain('QUJDREVGR0g=')
  })

  test('a long journal whose tail starts inside a private-key block still sends none of the key', () => {
    const begin = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', end = '-----END OPENSSH ' + 'PRIVATE KEY-----'
    const body = Array<string>(4000).fill('QUJDREVG'.repeat(8)) // ≈ 260k characters: the tail cut lands inside the block
    const plan = planHandoff(['- before', begin, ...body, end, '- after'].join('\n'), 2, 1, '', '/d', '2026-10-11', 's')
    expect(plan?.prompt).toContain('- after')
    expect(plan?.prompt).not.toContain('QUJDREVG')
    // the tail cut can also land inside a one-line secret: the line is removed before the cut, so no half of it is sent
    const key = 'sk-ant-' + 'api03-' + 'Q'.repeat(30), split = `${'a'.repeat(10)} ${key}\n${'b'.repeat(MAX_JOURNAL_CHARS - 20)}`
    expect(planHandoff(split, 2, 1, '', '/d', '2026-10-11', 's')?.prompt).not.toContain('Q'.repeat(10))
  })

  test('a long journal is cut to its tail', () => {
    const plan = planHandoff('a'.repeat(MAX_JOURNAL_CHARS) + 'TAIL', 2, 1, '', '/d', '2026-10-11', 's')
    expect(plan?.prompt).toContain('TAIL')
    expect((plan?.prompt.length ?? 0) < MAX_JOURNAL_CHARS + 2000).toBe(true)
  })

  test('the worker never loads the mod again and backgrounds itself with all streams redirected', () => {
    expect(WORKER_SCRIPT).toContain('env -u CLAUDE_CODE_PLUGIN_DIRS SNAGON_WORKER=1 HANDOFF_WORKER=1 claude -p')
    expect(WORKER_SCRIPT).toContain('--no-session-persistence')
    expect(WORKER_SCRIPT).toContain('--permission-mode dontAsk --tools "" --strict-mcp-config')
    expect(WORKER_SCRIPT).not.toContain('--max-budget-usd') // no cost cap since 2026-10-20 (owner decision)
    expect(planHandoff('- a\n', 2, 1, '', '/d', '2026-10-11', '../../x;rm')?.promptFile).toBe('/d/prompt-xrm.md')
    expect(WORKER_SCRIPT.trimEnd().endsWith(') >/dev/null 2>&1 </dev/null &')).toBe(true)
  })
})

describe('usage', () => {
  test('cost notices fire once per level, the highest new level speaking', () => {
    const a = usageNotices(12, 10, [])
    expect(a.lines).toEqual(['[cost] Session total about $12.00 (over $10). Informational only, not an instruction to stop.'])
    expect(a.fired).toEqual(['cost:5', 'cost:10'])
    expect(usageNotices(13, 10, a.fired).lines).toEqual([])
    expect(usageNotices(60, 10, a.fired).fired).toContain('cost:50')
  })

  test('the compact reminder fires at 70% and again every 5 points', () => {
    expect(usageNotices(0, 69, []).lines).toEqual([])
    const a = usageNotices(0, 71, [])
    expect(a.lines[0]).toContain('Context is at 71%')
    expect(usageNotices(0, 74, a.fired).lines).toEqual([])
    expect(usageNotices(0, 76, a.fired).lines.length).toBe(1)
  })

  test('status text and subagent reminder', () => {
    expect(statusText(1.234, 42.4)).toBe('$1.23 · ctx 42%')
    expect(statusText(undefined, undefined)).toBe('')
    expect(subagentReminder({ subagent_type: 'Explore' })).toContain('spawned without a model')
    expect(subagentReminder({ model: 'haiku' })).not.toContain('No effort set')
  })
})

describe('session', () => {
  test('local config falls back to English defaults', () => {
    const def = { language: 'en', decisionWord: 'Decision', lessonWord: 'Lesson', journalDir: '.snagon/journal', autoInstall: true, address: '' }
    expect(parseConfig(undefined)).toEqual(def)
    expect(parseConfig('{"language":"vi","decisionWord":"Quyết định","lessonWord":"Bài học","journalDir":"notes/journal/"}')).toEqual({ language: 'vi', decisionWord: 'Quyết định', lessonWord: 'Bài học', journalDir: 'notes/journal', autoInstall: true, address: '' })
    // the project file (from /snagon-setup) overrides the user's file field by field; bad values keep the base
    const mine = parseConfig('{"language":"vi","decisionWord":"Quyết định"}')
    expect(parseConfig('{"language":"en","autoInstall":false,"lessonWord":42}', mine)).toEqual({ ...def, language: 'en', decisionWord: 'Quyết định', autoInstall: false })
    expect(parseConfig('{"language":"fr"}', mine).language).toBe('vi')
    expect(parseConfig('{bad')).toEqual(def)
    for (const bad of ['/etc', '../x', 'a/../../b', '']) expect(parseConfig(JSON.stringify({ journalDir: bad })).journalDir).toBe('.snagon/journal')
  })

  test('any exempt variable makes the session exempt', () => {
    expect(isExemptLine('||')).toBe(false)
    expect(isExemptLine('builder||')).toBe(true)
    expect(isExemptLine('||1')).toBe(true)
  })

  test('hashes are stable and differ for different text', () => {
    expect(hashOf('a')).toBe(hashOf('a'))
    expect(hashOf('a')).not.toBe(hashOf('b'))
    expect(hashOf('a')).toMatch(/^[0-9a-f]{16}$/)
  })
})
