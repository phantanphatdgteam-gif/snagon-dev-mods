// Reads a session's transcript (JSONL) and prints one JSON line per event since a time: each tool call of main (its
// name and input, whether the result was an error, the result's text; `error` null while no result came) and each Stop
// hook feedback main got. A scenario reads a scripted main's answer from it (plan §4.7, GAP-R2-0.6-110): refused, ran,
// or no such call at all ("not attempted", never a pass).
// Usage: node calls.mjs <transcript.jsonl> <since-ms>
import { existsSync, readFileSync } from 'node:fs'

const [file, since] = process.argv.slice(2)
if (!file || !/^\d+$/.test(since ?? '')) { console.error('usage: calls.mjs <transcript.jsonl> <since-ms>'); process.exit(2) }
const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(r => r && r.isSidechain !== true) : []
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '')
const results = new Map()
for (const r of rows) if (r.type === 'user' && Array.isArray(r.message?.content)) for (const c of r.message.content) if (c?.type === 'tool_result') results.set(c.tool_use_id, { error: c.is_error === true, text: textOf(c.content) })
for (const r of rows) {
  const at = Date.parse(r.timestamp ?? '')
  if (!(at >= Number(since))) continue
  if (r.type === 'assistant') for (const c of r.message?.content ?? []) if (c?.type === 'tool_use') console.log(JSON.stringify({ kind: 'call', at, name: c.name, input: c.input ?? {}, ...(results.get(c.id) ?? { error: null, text: '' }) }))
  const said = r.type === 'user' ? textOf(r.message?.content) : ''
  if (said.startsWith('Stop hook feedback:')) console.log(JSON.stringify({ kind: 'stop', at, text: said }))
}
