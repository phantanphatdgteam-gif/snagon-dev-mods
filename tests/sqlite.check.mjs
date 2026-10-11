// Developer check of the real SQLite path (claude plugin test has no processes): node tests/sqlite.check.mjs
// Needs Node 23.6+ (runs the TypeScript core directly) and sqlite3 on PATH. Prints "sqlite check: ok" or throws.
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { insertSql, OFFSET_SQL, searchSql, countSql, recentSql, utf8Length } from '../hooks/memory-core.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagon-sqlite-'))
const db = path.join(dir, 'memory.db')
const run = sql => { const out = execFileSync('sqlite3', ['-json', db], { input: sql }).toString().trim(); return out ? JSON.parse(out) : [] }
const e = (id, title, body, kind = 'decision', ts = '2026-10-11T10:00:00Z') => ({ id, ts, kind, title, body, tags: ['t'], source: 's' })
try {
  const a = [e('a1', 'Dùng SQLite cho bộ nhớ', "it's fast"), e('a2', "x'); DROP TABLE meta; --", 'body'), e('a3', 'Quyết định khác', 'lesson body', 'lesson', '2026-10-11T11:00:00Z')]
  run(insertSql(a.slice(0, 2), 100, false))
  run(insertSql(a.slice(0, 2), 100, false)) // the same tail again (a second session): no duplicates
  run(insertSql(a.slice(2), 150, false))
  assert.equal(run(countSql)[0].n, 3)
  assert.equal(run(OFFSET_SQL)[0].v, '150')
  run(insertSql([], 120, false)) // a stale writer never moves the offset back
  assert.equal(run(OFFSET_SQL)[0].v, '150')
  assert.deepEqual(run(searchSql('quyet dinh', undefined, 5)).map(r => r.id), ['a3']) // accents ignored
  assert.deepEqual(run(searchSql("it's", undefined, 5)).map(r => r.id), ['a1']) // apostrophes stay data
  assert.deepEqual(run(searchSql('DROP', undefined, 5)).map(r => r.id), ['a2'])
  assert.equal(run("SELECT count(*) AS n FROM sqlite_master WHERE name = 'meta';")[0].n, 1) // the injection-shaped title did nothing
  assert.deepEqual(run(searchSql('body', 'lesson', 5)).map(r => r.id), ['a3'])
  assert.deepEqual(run(recentSql(2)).map(r => r.id), ['a3', 'a1'])
  run(insertSql([a[0]], 50, true)) // rebuild after the file was replaced by a shorter one
  assert.equal(run(countSql)[0].n, 1)
  assert.equal(run(OFFSET_SQL)[0].v, '50')
  for (const s of ['abc', 'Quyết định', '日本語', '👍 ok', '']) assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'))
  // Santa round 3 attack: a NUL in one entry, then a dot-command in the next one's title. Nothing may run.
  const out = execFileSync('sqlite3', ['-json', db], { input: insertSql([e('n1', 't', 'a\u0000'), e('n2', "1;\n.print DOT_COMMAND_RAN\n--", 'b')], 60, false) }).toString()
  assert.ok(!out.includes('DOT_COMMAND_RAN'), 'dot-command ran')
  assert.equal(run(countSql)[0].n, 3)
  assert.deepEqual(run(searchSql('DOT_COMMAND_RAN', undefined, 5)).map(r => r.id), ['n2'])
  console.log('sqlite check: ok')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
