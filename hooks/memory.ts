// The memory store's effects: `<project>/.snagon/memory/memory.jsonl` (source of truth, append-only, per user and
// machine, never in git) and `memory.db`, a SQLite FTS5 index rebuilt from it with the system `sqlite3`. A module
// cannot run WebAssembly, so SQLite runs as a process; without sqlite3 the store still saves and scans.
import { appendText, dataDir, hashOf, type Io } from './session'
import { findSecrets } from './secrets'
import {
  countSql, digest, formatHits, getSql, insertSql, journalItems, makeEntry, OFFSET_SQL, parseLines, recentOf, recentSql,
  scanSearch, searchSql, utf8Length, LIMITS, type Entry, type Hit,
} from './memory-core'

export const TOOL_NAMES = { save: 'memory_save', search: 'memory_search', get: 'memory_get' } as const
const MAX_IMPORT = 200 // journal lines copied per session end, to stay inside the session-end time budget

type Paths = { dir: string; jsonl: string; db: string; synced: string }

async function paths(io: Io, root: string): Promise<Paths> {
  const dir = `${await dataDir(io, root)}/memory`
  return { dir, jsonl: `${dir}/memory.jsonl`, db: `${dir}/memory.db`, synced: `${dir}/journal-synced.txt` }
}

/** Runs SQL through the system sqlite3 and parses its JSON rows; null when sqlite3 is missing or fails. */
async function sqlite(io: Io, db: string, sql: string): Promise<Record<string, unknown>[] | null> {
  try {
    const run = await io.run(['sqlite3', '-json', db], { stdin: sql, timeoutMs: 20_000 })
    if (run.exitCode !== 0) return null
    const out = run.stdout.trim()
    return out ? (JSON.parse(out) as Record<string, unknown>[]) : []
  } catch {
    return null
  }
}

async function fileSize(io: Io, file: string): Promise<number> {
  const slash = file.lastIndexOf('/')
  try {
    const entry = (await io.list(file.slice(0, slash))).find(e => e.name === file.slice(slash + 1))
    return entry ? entry.size : 0
  } catch { return 0 }
}

/** Brings the index up to the JSONL file; false when sqlite3 is unavailable.
 * ponytail: the file is append-only by design; one replaced by a longer file is not detected (only a shorter one
 * triggers a rebuild). Upgrade path: keep a hash of the first line in meta and rebuild when it changes. */
async function syncIndex(io: Io, p: Paths): Promise<boolean> {
  const rows = await sqlite(io, p.db, OFFSET_SQL)
  if (rows === null) return false
  const size = await fileSize(io, p.jsonl)
  let offset = Number(rows[0]?.v ?? 0)
  const reset = offset > size // the file was replaced or truncated: rebuild
  if (reset) offset = 0
  if (offset === size && !reset) return true
  const tail = await io.run(['/usr/bin/tail', '-c', `+${offset + 1}`, p.jsonl], { timeoutMs: 20_000 })
  const text = tail.stdout
  const complete = text.lastIndexOf('\n') + 1 // only whole lines; a line being written is indexed next time
  const entries = parseLines(text.slice(0, complete))
  const bytes = utf8Length(text.slice(0, complete))
  return (await sqlite(io, p.db, insertSql(entries, offset + bytes, reset))) !== null
}

async function readAll(io: Io, p: Paths): Promise<Entry[]> {
  try { return parseLines(await io.read(p.jsonl)) } catch { return [] }
}

async function newId(io: Io): Promise<{ id: string; ts: string }> {
  const now = await io.now()
  return { id: `${now.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`, ts: new Date(now).toISOString() }
}

/** Saves one entry from tool input; returns the message for the model, or a refusal starting with "refused:". */
export async function save(io: Io, root: string, input: Record<string, unknown>): Promise<string> {
  const { id, ts } = await newId(io)
  const entry = makeEntry(input, id, ts, 'memory_save')
  if (typeof entry === 'string') return `refused: ${entry}`
  const secrets = findSecrets(`${entry.title}\n${entry.body}\n${entry.tags.join(' ')}`)
  if (secrets.length) return `refused: the entry looks like it contains a secret (${secrets.join(', ')}); memory never stores secrets`
  const p = await paths(io, root)
  await appendText(io, p.jsonl, `${JSON.stringify(entry)}\n`)
  return `Saved memory ${entry.id} (${entry.kind}): ${entry.title}`
}

export async function search(io: Io, root: string, input: Record<string, unknown>): Promise<string> {
  const q = typeof input.query === 'string' ? input.query : ''
  const kind = typeof input.kind === 'string' ? input.kind : undefined
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.min(LIMITS.results, Math.max(1, Math.floor(input.limit))) : 8
  if (!q.trim()) return 'refused: query must be a non-empty string'
  const p = await paths(io, root)
  const sql = searchSql(q, kind, limit)
  if (sql && (await syncIndex(io, p))) {
    const rows = await sqlite(io, p.db, sql)
    if (rows) return formatHits(rows as unknown as Hit[])
  }
  return formatHits(scanSearch(await readAll(io, p), q, kind, limit))
}

export async function get(io: Io, root: string, input: Record<string, unknown>): Promise<string> {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) return 'refused: id must be a non-empty string'
  const p = await paths(io, root)
  const e = (await readAll(io, p)).find(x => x.id === id)
  if (!e) return `No memory entry with id ${id}.`
  return [`${e.title}`, `kind: ${e.kind} · saved: ${e.ts} · source: ${e.source}${e.tags.length ? ` · tags: ${e.tags.join(', ')}` : ''}`, '', e.body].join('\n')
}

/** The digest loaded at the start of a conversation; empty when the store has no entries. */
export async function startDigest(io: Io, root: string): Promise<string> {
  const p = await paths(io, root)
  if ((await fileSize(io, p.jsonl)) === 0) return ''
  if (await syncIndex(io, p)) {
    const count = await sqlite(io, p.db, countSql)
    const recent = await sqlite(io, p.db, recentSql(LIMITS.digestEntries))
    if (count && recent) return digest(Number(count[0]?.n ?? 0), recent as unknown as Hit[], true)
  }
  const all = await readAll(io, p)
  return digest(all.length, recentOf(all, LIMITS.digestEntries), false)
}

/** Copies new decision and lesson lines of the journal files into memory (deduplicated by line hash). */
export async function importJournal(io: Io, root: string, journalFiles: readonly string[], words: { decision: readonly string[]; lesson: readonly string[] }): Promise<number> {
  const p = await paths(io, root)
  let synced: Set<string>
  try { synced = new Set((await io.read(p.synced)).split('\n').filter(Boolean)) } catch { synced = new Set() }
  const lines: string[] = []
  const hashes: string[] = []
  for (const file of journalFiles) {
    let text: string
    try { text = await io.read(file) } catch { continue }
    for (const item of journalItems(text, words)) {
      const h = hashOf(`${item.kind}\n${item.text}`)
      if (synced.has(h) || hashes.includes(h)) continue
      if (findSecrets(`${item.text}\n${item.heading}`).length) continue // a journal line or heading that looks like a secret is not copied
      if (lines.length >= MAX_IMPORT) break
      const { id, ts } = await newId(io)
      const name = file.slice(file.lastIndexOf('/') + 1)
      const entry: Entry = { id, ts, kind: item.kind, title: item.text.slice(0, LIMITS.title), body: item.heading ? `${item.text}\n\n(journal section: ${item.heading})` : item.text, tags: ['journal'], source: `journal ${name}` }
      lines.push(JSON.stringify(entry))
      hashes.push(h)
    }
  }
  if (!lines.length) return 0
  await appendText(io, p.jsonl, `${lines.join('\n')}\n`)
  await appendText(io, p.synced, `${hashes.join('\n')}\n`)
  return lines.length
}

export const TOOL_SPECS = [
  {
    name: TOOL_NAMES.save,
    description: 'Save one entry to this project\'s memory (kept on this machine, outside git). Use for corrections and confirmed approaches (feedback), decisions the code does not show, lessons, facts, references and preferences. Never include secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['decision', 'lesson', 'feedback', 'fact', 'reference', 'preference', 'note'] },
        title: { type: 'string', description: 'One line that states the point (max 200 characters)' },
        body: { type: 'string', description: 'Details, the reason, and when it applies (max 8000 characters)' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      },
      required: ['kind', 'title'],
    },
    isDeferred: false,
  },
  {
    name: TOOL_NAMES.search,
    description: 'Search this project\'s memory by words (full-text, accents ignored). Returns ids, dates, kinds, titles and snippets.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } },
      required: ['query'],
    },
    isDeferred: false,
  },
  {
    name: TOOL_NAMES.get,
    description: 'Read one memory entry in full by its id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    isDeferred: false,
  },
] as const
