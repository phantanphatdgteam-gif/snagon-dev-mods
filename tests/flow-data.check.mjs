// Developer check of the flow data against the files on disk (claude plugin test has no file system):
// node tests/flow-data.check.mjs. Prints "flow data check: ok".
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('..', import.meta.url)
const routing = fs.readFileSync(new URL('flow/data/routing.ts', root), 'utf8')
const agents = [...routing.matchAll(/(?:agent|typescript): '([\w-]+)'/g)].map(m => m[1])
assert.ok(agents.length >= 6, 'routing names its agents')
// Routed agents allow Skill (plan §8): a ticket in a plugin project starts with Skill(plugin-authoring), and an agent's
// `tools:` line limits Skill too. No `tools:` line means every tool; `disallowedTools:` takes tools away.
const listOf = (front, key) => {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front)
  return m ? m[1].replace(/[[\]"']/g, '').split(',').map(s => s.trim()).filter(Boolean) : null
}
for (const a of new Set(agents)) {
  const file = new URL(`agents/${a}.md`, root)
  assert.ok(fs.existsSync(file), `agents/${a}.md exists`)
  const front = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? ''
  assert.ok(front, `agents/${a}.md has frontmatter`) // unread frontmatter would read as "every tool"
  const tools = listOf(front, 'tools'), denied = listOf(front, 'disallowedTools') ?? []
  assert.ok((tools === null || tools.includes('Skill')) && !denied.includes('Skill'), `agents/${a}.md allows Skill`)
}
// The flow-loop rules (plan §10 step 11): the harness loads the file into every conversation itself (instructions.ts), and
// it is never a skill the model calls (the flow guard refuses `flow-*` skill names); it replaces Immediate Agent Usage.
const loop = fs.readFileSync(new URL('skills/flow-loop/SKILL.md', root), 'utf8')
const loopFront = /^---\n([\s\S]*?)\n---\n/.exec(loop)?.[1] ?? ''
assert.match(loopFront, /^name: flow-loop$/m, 'flow-loop names itself')
assert.match(loopFront, /^disable-model-invocation: true$/m, 'flow-loop is not a skill the model calls')
assert.ok(loop.includes('Immediate Agent Usage'), 'flow-loop names the agents rule it replaces')
// A plugin's agent is dispatched only as `<plugin>:<name>` (checked live on 2.1.302): the prefix is this plugin's name.
const plugin = JSON.parse(fs.readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8')).name
assert.equal(/AGENT_PLUGIN = '([\w-]+)'/.exec(routing)?.[1], plugin, 'routed agents are dispatched under the plugin name')
for (const f of fs.readdirSync(new URL('flow/data/', root))) {
  const src = fs.readFileSync(new URL(`flow/data/${f}`, root), 'utf8')
  assert.ok(!/from 'node:|require\(/.test(src), `${f} imports nothing from Node (the hooks module runs without Node)`)
  assert.ok(src.split('\n').length <= 400, `${f} stays under 400 lines`)
}
console.log('flow data check: ok')
