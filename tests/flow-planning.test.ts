import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { checkVerdict, liveCall, noteMode } from '../hooks/flow-live'
import { forgetAgents, noteSpawned, RUN_DEADLINE_MS, spawnHook } from '../hooks/flow-ticket'
import { emptySession } from '../hooks/flow-host'
import { featureKey } from '../hooks/flow-plan'
import { applyPlan, flowCapAtP3 } from '../hooks/flow-planning'
import { sha256 } from '../hooks/flow-review'
import { flowStatus } from '../hooks/flow-turn'
import { METHOD_HEAD, OVERRIDES_TEXT, ROOT } from './flow-fakes'
import { agentEnds, agentLaunch, editRecord, latest, run, toS3, world, type W } from './flow-drive'

const HEAD = { 'rev-parse --verify -q HEAD^{commit}': `${'a'.repeat(40)}\n` }
const PLAN = `${ROOT}/docs/flow/plan.md`
const GOOD = [
  '## Acceptance', '- AC-001 (Required): adding two numbers returns their sum. Verification: tests/add.test.ts', '',
  '## Features', '### F-01: Add numbers', '- ACs: AC-001', '- Files: src/add.ts (new), tests/add.test.ts (new)', '- Security: no', '',
].join('\n')
const BAD = GOOD.replace('- ACs: AC-001\n', '')

const GREEN = { testResults: [{ name: `${ROOT}/tests/a.test.ts`, status: 'passed', message: '', assertionResults: [{ title: 'adds', ancestorTitles: [], status: 'passed', failureMessages: [] }] }] }
async function atP1(): Promise<W> {
  const w = world({ gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN } } })
  await toS3(w)
  await flowCheck(w.host)
  return w
}
/** main starts the ticket: the spawn hook rewrites it, the engine starts the agent, the agent answers. */
async function planner(w: W, id: string, answer: (nonce: string) => string, write?: string): Promise<void> {
  const decision = await spawnHook(w.host, { tool_use_id: `tu-${id}`, prompt: `TICKET ${id}`, description: 'plan', subagentType: 'planner' })
  if (!decision || !('rewrite' in decision)) throw new Error(`spawn refused: ${JSON.stringify(decision)}`)
  await noteSpawned(w.host, decision.ticketId, `tu-${id}`, `ag-${id}`)
  if (write !== undefined) w.files.set(PLAN, write)
  const nonce = latest(w)?.tickets.find(t => t.id === id)?.nonce ?? ''
  const live = await liveCall(w.host, { tool: 'Agent', tool_use_id: `tu-${id}`, prompt: `TICKET ${id}`, subagent_type: 'planner' })
  await live.after({ result: { status: 'completed', agentId: `ag-${id}`, content: [{ type: 'text', text: answer(nonce) }] } })
}
const ended = (text: string) => (nonce: string) => `${text}\nREVIEW-END ${nonce}`

describe('flow-planning: P1, the planner ticket', () => {
  test('/flow-plan needs what to build; with it the planner ticket is issued, its text held by the session only', async () => {
    const w = await atP1()
    expect(latest(w)).toMatchObject({ phase: 'plan', task: 'P1', awaiting: '/flow-plan' })
    expect((await run(w, 'flow-plan')).text).toContain('/flow-plan <what to build>')
    expect((await run(w, 'flow-plan add a sum function')).text).toContain('The planner starts now')
    const r = latest(w), t = r?.tickets[0]
    expect(r?.awaiting).toBeUndefined()
    expect(t).toMatchObject({ id: 'T-1', f: 'plan', routedType: 'planner', model: 'opus', used: false })
    const text = w.session().value?.tickets['T-1'] ?? ''
    expect(t?.sha).toBe(await sha256(text))
    expect(text).toContain('add a sum function')
    expect(text).toContain('docs/flow/plan.md')
    expect(text).toContain('### F-01: <title>')
    expect(text).toContain(`${METHOD_HEAD}\n\n---\nname: planning-and-task-breakdown\n---\nMETHOD planning-and-task-breakdown\n\n${OVERRIDES_TEXT.trim()}\n## ANSWER`)
    expect(text.trim().split('\n').at(-1)).toBe(`End your answer with this line and nothing after it: REVIEW-END ${t?.nonce}`)
    expect(JSON.stringify(r)).not.toContain('add a sum function')
    expect(r?.counters.plan).toMatchObject({ e: 1 })
    expect(JSON.parse(await flowStatus(w.host))).toMatchObject({ ticket: 'TICKET T-1', routedType: 'snagon-dev-mods:planner' })
    expect(w.submitted.at(-1)).toContain('flow_status')
  })

  test('the spawn: only `TICKET <id>` of an issued, unused ticket is rewritten to its text, type and model; a free spawn only of Explore', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const text = w.session().value?.tickets['T-1']
    expect(await spawnHook(w.host, { tool_use_id: 'tu-1', prompt: 'TICKET T-1', description: 'p', subagentType: 'general-purpose' }))
      .toEqual({ ticketId: 'T-1', rewrite: { prompt: text, subagentType: 'snagon-dev-mods:planner', model: 'opus', background: false, cwd: ROOT } })
    await noteSpawned(w.host, 'T-1', 'tu-1', 'ag-1')
    expect(latest(w)?.tickets[0]).toMatchObject({ used: true, toolUseId: 'tu-1', agentId: 'ag-1' })
    expect(await spawnHook(w.host, { tool_use_id: 'tu-2', prompt: 'TICKET T-1', description: 'p', subagentType: 'planner' })).toMatchObject({ deny: expect.stringContaining('already used') })
    expect(await spawnHook(w.host, { tool_use_id: 'tu-3', prompt: 'look around', description: 'p', subagentType: 'Explore' })).toEqual({ free: true })
    expect(await spawnHook(w.host, { tool_use_id: 'tu-4', prompt: 'write code', description: 'p', subagentType: 'general-purpose' })).toMatchObject({ deny: expect.any(String) })
  })

  test('D4 (2.1.302): the Agent tool answers the launch; the ticket stays running, flow_check issues nothing, the turn end attests it', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const nonce = await agentLaunch(w, 'T-1')
    expect(latest(w)?.tickets[0]).toMatchObject({ used: true, agentId: 'ag-T-1' })
    expect(w.session().value?.runs['T-1']).toBeUndefined()
    expect(JSON.parse(await flowStatus(w.host)).next).toContain('runs in the background')
    await flowCheck(w.host)
    expect(latest(w)?.tickets).toHaveLength(1)
    expect(latest(w)?.counters.plan).toMatchObject({ e: 1 })
    w.files.set(PLAN, GOOD)
    await agentEnds(w, 'T-1', `Plan written.\nREVIEW-END ${nonce}`)
    expect(w.session().value?.runs['T-1']).toEqual({ ok: true })
    await flowCheck(w.host)
    expect(latest(w)).toMatchObject({ task: 'P3', awaiting: '/flow-plan' })
  })

  test('D4/D6: a running ticket is waited for in the session that started it; after a restart it is a run that did not report back; a turn that did not answer neither', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await agentLaunch(w, 'T-1')
    await flowCheck(w.host) // the engine's agent list is not asked: the ticket waits
    expect(w.session().value?.runs['T-1']).toBeUndefined()
    expect(latest(w)?.tickets).toHaveLength(1)
    w.setSession({ ...emptySession(), ...w.session().value, started: {} }) // a restarted session: nothing started here
    forgetAgents() // and its module memory is fresh
    await flowCheck(w.host)
    expect(w.session().value?.runs['T-1']).toEqual({ ok: false, reason: 'started by an earlier session; its answer never reached this one' })
    expect(latest(w)?.tickets.map(t => t.id)).toEqual(['T-1', 'T-2'])
    expect(latest(w)?.counters.plan).toMatchObject({ e: 2 })
    const nonce = await agentLaunch(w, 'T-2')
    await agentEnds(w, 'T-2', `half\nREVIEW-END ${nonce}`, 'aborted')
    expect(w.session().value?.runs['T-2']).toEqual({ ok: false, reason: 'the run did not complete' })
  })

  test('S13-1: an agent end heard but not judged (the tree call failed, then a reload) never leaves the ticket running; the step asks again', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const nonce = await agentLaunch(w, 'T-1')
    const io = w.host.io, realRun = io.run
    io.run = async (argv, init) => (argv.includes('write-tree') ? { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false } : realRun(argv, init))
    await expect(agentEnds(w, 'T-1', `Plan written.\nREVIEW-END ${nonce}`)).rejects.toThrow()
    io.run = realRun
    forgetAgents() // the module reloaded: its memory is gone, the session's `ended` is not
    expect(JSON.parse(await flowStatus(w.host)).next).not.toContain('runs in the background')
    await flowCheck(w.host)
    expect(w.session().value?.runs['T-1']).toEqual({ ok: false, reason: 'the run ended but its verdict could not be kept' })
    expect(latest(w)?.tickets.map(t => t.id)).toEqual(['T-1', 'T-2'])
  })

  test('SEC13-2: the planner agent writes docs/flow/plan.md and nothing else; SEC13-4: a run is judged once', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const nonce = await agentLaunch(w, 'T-1')
    noteMode('ag-T-1', 'acceptEdits')
    expect(await checkVerdict(w.host, { tool: 'Write', input: { file_path: `${ROOT}/src/x.ts`, content: '' }, agentId: 'ag-T-1' })).toContain('the planner writes docs/flow/plan.md')
    expect(await checkVerdict(w.host, { tool: 'Edit', input: { file_path: `${ROOT}/docs/flow/../../package.json`, old_string: 'a', new_string: 'b' }, agentId: 'ag-T-1' })).toContain('the planner writes')
    expect(await checkVerdict(w.host, { tool: 'Write', input: { file_path: `${ROOT}/docs/flow/plan.md`, content: GOOD }, agentId: 'ag-T-1' })).toBeNull()
    // SEC13R2-2: an agent the record does not name yet (its launch still being recorded) is held to the ticket in flight
    const named = latest(w)?.tickets ?? []
    editRecord(w, r => ({ ...r, tickets: r.tickets.map(t => { const c = { ...t }; delete c.agentId; return c }) }))
    expect(await checkVerdict(w.host, { tool: 'Write', input: { file_path: `${ROOT}/src/x.ts`, content: '' }, agentId: 'ag-unnamed' })).toContain('the planner writes')
    editRecord(w, r => ({ ...r, tickets: named }))
    w.files.set(PLAN, GOOD)
    await agentEnds(w, 'T-1', `Plan written.\nREVIEW-END ${nonce}`)
    // SEC13R2-3: the ticket is settled; a call from its agent after that is refused
    expect(await checkVerdict(w.host, { tool: 'Read', input: { file_path: `${ROOT}/package.json` }, agentId: 'ag-T-1' })).toContain('is settled')
    const live = await liveCall(w.host, { tool: 'Agent', tool_use_id: 'tu-T-1', prompt: 'TICKET T-1', subagent_type: 'planner' })
    await live.after({ result: { status: 'completed', agentId: 'ag-T-1', content: [{ type: 'text', text: `again\nREVIEW-END ${nonce}` }] } })
    expect(w.session().value?.runs['T-1']).toEqual({ ok: true })
    expect(latest(w)?.tickets).toHaveLength(1)
  })

  test('S13-5: flow_check while a verdict is being written leaves the ticket alone, and the verdict lands', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const nonce = await agentLaunch(w, 'T-1')
    w.files.set(PLAN, GOOD)
    const io = w.host.io, realRun = io.run
    let release = (): void => undefined, gated = false
    const gate = new Promise<void>(resolve => { release = resolve })
    io.run = async (argv, init) => { if (!gated && argv.includes('write-tree')) { gated = true; await gate } return realRun(argv, init) }
    const ending = agentEnds(w, 'T-1', `Plan written.\nREVIEW-END ${nonce}`)
    for (let i = 0; !gated && i < 10_000; i++) await Promise.resolve() // the turn end reaches the tree read and waits there
    expect(gated).toBe(true)
    expect(w.session().value?.ended['ag-T-1']).toBeUndefined()
    await flowCheck(w.host)
    expect(w.session().value?.runs['T-1']).toBeUndefined()
    expect(latest(w)?.tickets).toHaveLength(1)
    release()
    await ending
    io.run = realRun
    expect(w.session().value?.runs['T-1']).toEqual({ ok: true })
    expect(w.session().value?.ended['ag-T-1']).toBe(true)
  })

  test('S13-6: a ticket silent past the deadline is settled and asked again, even after a reload forgot its start', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await agentLaunch(w, 'T-1')
    forgetAgents() // a reload: module memory gone; the session's started and startedAt stay
    expect(JSON.parse(await flowStatus(w.host)).next).toContain('runs in the background')
    const io = w.host.io, t0 = await io.now()
    io.now = async () => t0 + RUN_DEADLINE_MS + 1000
    await flowCheck(w.host)
    expect(w.session().value?.runs['T-1']).toEqual({ ok: false, reason: 'the run gave no answer within the deadline' })
    expect(latest(w)?.tickets.map(t => t.id)).toEqual(['T-1', 'T-2'])
  })

  test('S13-3: a cap /flow-retry cost raised before P3 is kept at P3; the echo shows that figure', async () => {
    const w = await atP1()
    const r = latest(w)
    if (!r) throw new Error('no record')
    expect(flowCapAtP3(r, 3)).toBe(11)
    expect(flowCapAtP3({ ...r, counters: { ...r.counters, cost: { e: 0, r: 0, d: 0, retried: true } }, flowCap: 90 }, 3)).toBe(90)
  })

  test('two spawns of one ticket at once: exactly one is rewritten', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const both = await Promise.all(['tu-a', 'tu-b'].map(id => spawnHook(w.host, { tool_use_id: id, prompt: 'TICKET T-1', description: 'p', subagentType: 'planner' })))
    expect(both.filter(d => d !== null && 'rewrite' in d)).toHaveLength(1)
    expect(both.filter(d => d !== null && 'deny' in d)).toHaveLength(1)
  })

  test('outside flow the spawn hook stays out of the way', async () => {
    expect(await spawnHook(world().host, { tool_use_id: 'tu', prompt: 'anything', description: 'p', subagentType: 'general-purpose' })).toBeNull()
  })
})

describe('flow-planning: P2 lint and the plan echo', () => {
  test('a plan with lint issues gets a new ticket naming them, until the edit cap blocks the flow', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await planner(w, 'T-1', ended('Plan written.'), BAD)
    await flowCheck(w.host)
    expect(latest(w)?.tickets.map(t => t.id)).toEqual(['T-1', 'T-2'])
    const second = w.session().value?.tickets['T-2'] ?? ''
    expect(second).toContain('F-01 lists no acceptance criterion')
    expect(second).toContain('add a sum function')
    await planner(w, 'T-2', ended('Fixed.'), BAD)
    await flowCheck(w.host)
    await planner(w, 'T-3', ended('Fixed again.'), BAD)
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'planLint', vars: { count: '2', first: expect.stringContaining('AC-001 is Required but no feature covers it') } })
  })

  test('an answer without the nonce line is not attested: the plan is not linted and a new ticket goes out', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await planner(w, 'T-1', () => 'Plan written.', GOOD)
    await flowCheck(w.host)
    expect(latest(w)).toMatchObject({ task: 'P1' })
    expect(latest(w)?.tickets.map(t => t.id)).toEqual(['T-1', 'T-2'])
  })

  test('a clean plan waits for the owner; /flow-plan shows it, and its approval freezes the plan and starts the build', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await planner(w, 'T-1', ended('Plan written.'), GOOD)
    await flowCheck(w.host)
    expect(latest(w)).toMatchObject({ phase: 'plan', task: 'P3', awaiting: '/flow-plan' })
    expect(w.files.get(`${ROOT}/.snagon/flow/boundary-P2.md`)).toContain('### F-01: Add numbers')
    expect((await run(w, 'flow-plan')).text).toContain('Shown in the flow pane')
    const echo = w.session().value?.pending.plan
    expect(echo?.title).toBe('Plan for the project owner to approve')
    expect(echo?.lines).toContain('### F-01: Add numbers')
    expect((await run(w, `flow-approve plan ${echo?.hash.slice(0, 8) ?? ''}`)).text).toContain('Plan approved: 1 features')
    const r = latest(w)
    expect(r).toMatchObject({ phase: 'build', task: 'B1', feature: 'F-01', awaiting: '/flow-build', flowCap: 5 }) // (2 × 1 + 1.2) × 1.5, whole dollars up (plan §9, step 13)
    const key = featureKey({ title: 'Add numbers', acs: ['AC-001'] })
    expect(r?.features).toEqual([{ id: 'F-01', key, files: ['src/add.ts', 'tests/add.test.ts'] }])
    expect(r?.counters[key]).toEqual({ e: 0, r: 0, d: 0, retried: false })
    expect(r?.frozen.plan).toMatch(/^[0-9a-f]{16}$/)
    expect(Object.keys(r?.frozen ?? {})).toEqual(expect.arrayContaining(['rubric:code', 'rubric:security', 'routing', 'acceptance']))
    expect(r?.approvals.map(a => a.kind)).toEqual(['setup', 'plan'])
  })

  test('the plan echo binds the file itself: a secret swapped for another (both hidden in the pane) breaks the approval', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    const secret = (c: string) => GOOD.replace('returns their sum', `returns their sum (token ghp_${c.repeat(36)})`)
    await planner(w, 'T-1', ended('Plan written.'), secret('a'))
    await flowCheck(w.host)
    await run(w, 'flow-plan')
    const echo = w.session().value?.pending.plan
    expect(echo?.lines.join('\n')).not.toContain('aaaaaaaa')
    w.files.set(PLAN, secret('b'))
    expect((await run(w, `flow-approve plan ${echo?.hash.slice(0, 8) ?? ''}`)).text).toContain('This changed after it was shown')
  })

  test('an approval reaching a plan that no longer lints clean freezes nothing', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await planner(w, 'T-1', ended('Plan written.'), GOOD)
    await flowCheck(w.host)
    w.files.set(PLAN, BAD)
    expect(await applyPlan(w.host, { kind: 'plan', echoHash: 'h', at: 1, origin: 'composer' })).toContain('This changed after it was shown')
    expect(latest(w)).toMatchObject({ task: 'P3' })
    expect(latest(w)?.features).toBeUndefined()
  })

  test('a plan changed after the echo is not approved; /flow-reject plan sends it back to P1', async () => {
    const w = await atP1()
    await run(w, 'flow-plan add a sum function')
    await planner(w, 'T-1', ended('Plan written.'), GOOD)
    await flowCheck(w.host)
    await run(w, 'flow-plan')
    const hash8 = w.session().value?.pending.plan?.hash.slice(0, 8) ?? ''
    w.files.set(PLAN, GOOD.replace('Add numbers', 'Add numbers fast'))
    expect((await run(w, `flow-approve plan ${hash8}`)).text).toContain('This changed after it was shown')
    expect((await run(w, 'flow-reject plan')).text).toContain('/flow-plan <what to build>')
    expect(latest(w)).toMatchObject({ phase: 'plan', task: 'P1', awaiting: '/flow-plan' })
    expect(w.session().value?.pending.plan).toBeUndefined()
  })
})
