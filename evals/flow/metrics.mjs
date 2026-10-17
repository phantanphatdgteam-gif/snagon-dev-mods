// Reads one run folder of run.sh and prints a JSON summary: the verdict, spend (per phase and feature from the
// record, per main turn from cost.jsonl), LLM calls per ticket agent and for main, caps used, card size per
// turn, judge time against the direct run (sandbox-exec overhead), record-write intervals, guard denials.
// Usage: node metrics.mjs <run folder>
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) { console.error('usage: metrics.mjs <run folder>'); process.exit(2) }
const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '')
const json = (name, fallback) => { try { return JSON.parse(read(name)) } catch { return fallback } }
const lines = (text) => text.split('\n').filter(Boolean)
const rows = (text) => lines(text).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

// The final record, or the newest snapshot when the flow ended (its record files go with it).
const snapshots = readdirSync(dir).filter(n => /^record-v\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
const record = json('record-final.json', null) ?? (snapshots.length ? json(snapshots[snapshots.length - 1], null) : null)
const timeline = lines(read('timeline.tsv')).map(l => { const [t, j] = l.split('\t'); return { t: Number(t), ...JSON.parse(j) } })
const cost = rows(read('cost.jsonl'))
const transcript = rows(read('transcript.jsonl'))
const direct = json('direct.json', {})
const verdict = read('verdict').trim() || `rc ${read('rc').trim()}`

// Tickets with their agent ids, from every record snapshot (a seal drops a feature's tickets from the record).
const tickets = new Map()
for (const f of readdirSync(dir).filter(n => /^record-v\d+\.json$/.test(n) || n === 'record-final.json')) {
  for (const t of json(f, {}).tickets ?? []) if (t.agentId) tickets.set(t.agentId, { id: t.id, f: t.f, kind: t.kind ?? 'planner', routedType: t.routedType, model: t.model, attested: t.attested === true })
}
// Subagent transcripts: assistant messages (LLM calls) and token use per agent.
const agents = []
const subDir = join(dir, 'subagents')
const walk = (d) => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : [] })
if (existsSync(subDir)) {
  for (const p of walk(subDir)) {
    const msgs = rows(readFileSync(p, 'utf8'))
    const calls = msgs.filter(m => m.type === 'assistant')
    const id = (p.match(/agent-([\w-]+)\.jsonl$/) ?? [])[1] ?? p.slice(subDir.length + 1)
    const usage = calls.reduce((a, m) => ({ in: a.in + (m.message?.usage?.input_tokens ?? 0) + (m.message?.usage?.cache_read_input_tokens ?? 0) + (m.message?.usage?.cache_creation_input_tokens ?? 0), out: a.out + (m.message?.usage?.output_tokens ?? 0) }), { in: 0, out: 0 })
    const tools = calls.flatMap(m => (m.message?.content ?? []).filter(c => c.type === 'tool_use').map(c => c.name))
    const meta = json(p.slice(dir.length + 1).replace(/\.jsonl$/, '.meta.json'), {})
    const stamps = msgs.map(m => Date.parse(m.timestamp ?? '')).filter(Number.isFinite)
    const seconds = stamps.length > 1 ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000) : null
    agents.push({ agentId: id, ...(tickets.get(id) ?? {}), description: meta.description ?? null, agentType: meta.agentType ?? null, model: meta.model ?? null, seconds, llmCalls: calls.length, toolCalls: tools.length, tokens: usage })
  }
}
// Main: assistant messages per timeline state (the state in force at the message's time), and the flow card size.
const stateAt = (ms) => { let s = null; for (const x of timeline) if (x.t * 1000 <= ms) s = x; return s ? `${s.phase}/${s.task}${s.feature ? ` ${s.feature}` : ''}` : 'before' }
const mainCalls = {}
const cards = []
for (const m of transcript) {
  const ms = Date.parse(m.timestamp ?? '') || 0
  if (m.type === 'assistant') mainCalls[stateAt(ms)] = (mainCalls[stateAt(ms)] ?? 0) + 1
  // the card reaches the model inside the request (api-request-blob), as a `flow · <phase> / <task>` block
  if (m.type === 'api-request-blob') {
    for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
      const text = typeof c?.text === 'string' ? c.text : ''
      const at = text.indexOf('flow · ')
      if (at >= 0) { const end = text.indexOf('\n\n', at); cards.push((end < 0 ? text.slice(at) : text.slice(at, end)).replace(/<\/local-command-stdout>\s*$/, '').length); break }
    }
  }
}
const denials = transcript.flatMap(m => (Array.isArray(m.message?.content) ? m.message.content : []).filter(c => c.type === 'tool_result' && c.is_error).map(c => (typeof c.content === 'string' ? c.content : (c.content ?? []).map(x => x.text ?? '').join(' '))).filter(t => /^flow:|\bflow:/.test(t)))
// Judge time: the baseline's ms per command against the direct `npm test` run of the harness.
const baseline = (() => { const f = readdirSync(dir).find(n => n.endsWith('.baseline.json')); return f ? json(f, null) : null })()
const judgeMs = Object.fromEntries(Object.entries(baseline?.commands ?? baseline ?? {}).filter(([, v]) => v && typeof v === 'object' && typeof v.ms === 'number').map(([k, v]) => [k, v.ms]))
// Record versions: the mod's own files when the flow was still active at collection (their mtimes are write times);
// else the snapshots alone, whose count says how many versions the run saw (the 5 s poll cannot time the writes).
const versions = readdirSync(dir).filter(n => /^[0-9a-f]{8}\.v\d+\.json$/.test(n)).map(n => ({ v: Number(n.match(/\.v(\d+)\./)[1]), ms: statSync(join(dir, n)).mtimeMs })).sort((a, b) => a.v - b.v)
const gaps = versions.slice(1).map((x, i) => x.ms - versions[i].ms).filter(g => g >= 0)
const burst = gaps.filter(g => g < 2000)
const lastVersion = record?.version ?? (snapshots.length ? Number(snapshots[snapshots.length - 1].match(/\d+/)[0]) : null)
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
const usd = cost.length ? cost[cost.length - 1].usd : null
const minutes = timeline.length > 1 ? Math.round((timeline[timeline.length - 1].t - timeline[0].t) / 60) : null
const nudges = (read('run.log').match(/ nudge \d+/g) ?? []).length

console.log(JSON.stringify({
  verdict, usd, turns: cost.length, minutes, nudges,
  spend: { flow: record?.spent ?? null, by: record?.spendBy ?? null, flowCap: record?.flowCap ?? null, sessionCap: record?.setup?.sessionCap ?? null },
  caps: record?.counters ?? null, blocked: timeline.filter(x => x.blocked).map(x => ({ at: x.task, reason: x.blocked })),
  mainLlmCalls: mainCalls, agents, cardChars: { n: cards.length, mean: cards.length ? Math.round(cards.reduce((a, b) => a + b, 0) / cards.length) : null, max: cards.length ? Math.max(...cards) : null },
  judge: { baselineMs: judgeMs, directTestMs: direct.directTestMs ?? null, overheadMs: judgeMs.test !== undefined && direct.directTestMs !== undefined ? judgeMs.test - direct.directTestMs : null },
  record: { lastVersion, snapshots: snapshots.length, timedVersions: versions.length, burstWriteMs: { n: burst.length, median: median(burst), max: burst.length ? Math.max(...burst) : null } },
  denials: { n: denials.length, first: denials.slice(0, 20) },
  timeline: timeline.map(x => ({ t: new Date(x.t * 1000).toISOString().slice(11, 19), v: x.v, task: x.task, f: x.feature, awaiting: x.awaiting, blocked: x.blocked, spent: x.spent })),
}, null, 1))
