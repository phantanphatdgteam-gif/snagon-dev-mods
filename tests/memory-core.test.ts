import { describe, expect, test } from 'claude-code/testing'
import { makeEntry, parseLines, ftsQuery, insertSql, sqlQuote, scanSearch, digest, journalItems, searchSql, type Entry, clean } from '../hooks/memory-core'

const entry = (over: Partial<Entry>): Entry => ({ id: 'i1', ts: '2026-10-11T10:00:00.000Z', kind: 'decision', title: 't', body: '', tags: [], source: 's', ...over })
const WORDS = { decision: ['Quyết định', 'Decision'], lesson: ['Bài học', 'Lesson'] }

describe('memory-core', () => {
  test('entries are checked: kind, title, body and tags limits', () => {
    expect(makeEntry({ kind: 'decision', title: 'Use SQLite' }, 'a', 't', 'src')).toEqual({ id: 'a', ts: 't', kind: 'decision', title: 'Use SQLite', body: '', tags: [], source: 'src' })
    expect(makeEntry({ kind: 'nope', title: 'x' }, 'a', 't', 's')).toContain('kind must be one of')
    expect(makeEntry({ kind: 'fact', title: '' }, 'a', 't', 's')).toContain('title must be')
    expect(makeEntry({ kind: 'fact', title: 'x', body: 'b'.repeat(8001) }, 'a', 't', 's')).toContain('body must be')
    expect(makeEntry({ kind: 'fact', title: 'x', tags: ['ok', 3] }, 'a', 't', 's')).toContain('tags must be')
  })

  test('broken or blank JSON lines are skipped', () => {
    const lines = [JSON.stringify(entry({ id: 'a' })), '{broken', '', JSON.stringify({ nope: 1 }), JSON.stringify(entry({ id: 'b' }))].join('\n')
    expect(parseLines(lines).map(e => e.id)).toEqual(['a', 'b'])
  })

  test('FTS5 queries quote every word so no query syntax gets through', () => {
    expect(ftsQuery('sqlite memory')).toBe('"sqlite" OR "memory"')
    expect(ftsQuery('a" OR 1=1 --')).toBe('"a" OR "OR" OR "1=1" OR "--"')
    expect(ftsQuery('*:()')).toBeNull()
  })

  test('SQL literals double single quotes; inserts keep data inside literals', () => {
    expect(sqlQuote("it's")).toBe("'it''s'")
    const sql = insertSql([entry({ title: "x'); DROP TABLE meta; --" })], 120, false)
    expect(sql).toContain("'x''); DROP TABLE meta; --'")
    expect(sql).toContain("VALUES ('offset', '120')")
    expect(insertSql([], 0, true)).toContain('FROM mem;')
    expect(sql).toContain('BEGIN IMMEDIATE;')
    expect(sql).toContain('.timeout 3000')
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM mem WHERE id = 'i1')")
    expect(searchSql('x', "decision' OR '1", 5)).toContain("kind = 'decision'' OR ''1'")
  })

  test('scan search ignores accents and ranks by matched words', () => {
    const all = [entry({ id: 'a', title: 'Quyết định dùng SQLite', body: 'bộ nhớ' }), entry({ id: 'b', title: 'Bài học về git', kind: 'lesson' })]
    expect(scanSearch(all, 'quyet dinh sqlite', undefined, 5).map(h => h.id)).toEqual(['a'])
    expect(scanSearch(all, 'git', 'decision', 5)).toEqual([])
    expect(scanSearch(all, '   ', undefined, 5)).toEqual([])
  })

  test('the digest says how to use the store and lists recent entries', () => {
    const text = digest(2, [{ id: 'a', ts: '2026-10-11T10:00:00Z', kind: 'decision', title: 'Use SQLite', snippet: '' }], true)
    expect(text).toContain('2 entries')
    expect(text).toContain('memory_search')
    expect(text).toContain('- 2026-10-11 [decision] Use SQLite (id a)')
    expect(text).toContain('Never save secrets')
  })

  test('journal decision and lesson lines are read in Vietnamese and English with their heading', () => {
    const journal = ['## 20:10 · Bộ nhớ', '- Quyết định: dùng SQLite + JSONL.', '- Bài học (N0): process.run chờ stdout đóng.', '- Quyết định: không có.', '- Decision: keep the gate.', '- Ghi chú: không phải dòng này.'].join('\n')
    expect(journalItems(journal, WORDS)).toEqual([
      { kind: 'decision', text: 'dùng SQLite + JSONL.', heading: '20:10 · Bộ nhớ' },
      { kind: 'lesson', text: 'process.run chờ stdout đóng.', heading: '20:10 · Bộ nhớ' },
      { kind: 'decision', text: 'keep the gate.', heading: '20:10 · Bộ nhớ' },
    ])
  })
  test('NUL and other control characters never reach the sqlite3 shell (they would break quoting)', () => {
    expect(sqlQuote("a\u0000b'c")).toBe("'ab''c'")
    expect(clean('x\u0000\u0007\u001b\u007fy\tz\n')).toBe('xy\tz\n')
    const entry = makeEntry({ kind: 'note', title: 'T\u0000', body: 'a\u0000\n.shell echo hi', tags: ['t\u0000'] }, 'i', 't', 's')
    expect(entry).toEqual({ id: 'i', ts: 't', kind: 'note', title: 'T', body: 'a\n.shell echo hi', tags: ['t'], source: 's' })
    expect(insertSql([{ id: 'i\u0000', ts: 't', kind: 'note', title: "x'\u0000", body: 'b', tags: [], source: 's' }], 1, false)).not.toContain('\u0000')
  })
})
