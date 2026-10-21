import { describe, expect, test } from 'claude-code/testing'
import { flowCard, flowStatus, flowStop, ownerSpoke, STALL_LIMIT, ticketWaiting } from '../hooks/flow-turn'
import { activeView, emptySession, forgetFlowCaches, mutateSession } from '../hooks/flow-host'
import { retryCommand } from '../hooks/flow-decide'
import { forgetModes } from '../hooks/flow-live'
import { CARD_MAX_LINES } from '../hooks/flow'
import { versionPath, type FlowRecord } from '../hooks/flow-state'
import { activeRecord, fakeHost, recordFile, HOME, ROOT, type FakeOpts } from './flow-fakes'

function world(o: FakeOpts & { flow?: boolean; record?: Partial<FlowRecord> } = {}) {
  forgetFlowCaches()
  forgetModes()
  return fakeHost({ ...o, files: { [`${ROOT}/src/a.ts`]: 'a', ...(o.flow === false ? {} : recordFile(activeRecord(o.record))), ...o.files } })
}
const ticket = { id: 'T-1', f: 'F-01', sha: 's', nonce: 'n', tree: 't', routedType: 'tdd-guide', model: 'sonnet', used: false, kind: 'debug' as const }
const RED = { tree: 't', green: false, task: 'B3', f: 'F-01', at: 1 }

describe('flow-turn: the card', () => {
  test('outside flow there is no card', async () => {
    expect(await flowCard(world({ flow: false }).host)).toBeNull()
  })

  test('in flow the card names the task, the caps used, the owner command awaited, the sandbox and the cost', async () => {
    const w = world({ record: { phase: 'plan', task: 'P1', feature: undefined, awaiting: '/flow-plan', counters: { plan: { e: 1, r: 0, d: 0, retried: false } } } })
    const text = await flowCard(w.host) ?? ''
    const lines = text.split('\n')
    expect(lines[0]).toBe('flow · plan / P1')
    expect(text).toContain('Used: edit 1/3, review 0/0, debug 0/0')
    expect(text).toContain('Next: waiting for the project owner. Command: /flow-plan')
    expect(text).toContain('Sandbox: not checked in this session yet')
    expect(text).toContain('Cost: session $1.00; flow $0.00')
    expect(text).not.toMatch(/ of \$|cap|notice/i) // the spend only, no cap (owner decision 2026-10-20)
    expect(lines.length).toBeLessThanOrEqual(CARD_MAX_LINES)
  })

  test('a blocked flow shows NOT done with the owner\'s exits; a retry adds to the caps', async () => {
    const w = world({ record: { blocked: { reason: 'tampered', vars: { file: 'src/a.ts' } }, counters: { 'key-f01': { e: 2, r: 1, d: 4, retried: true } } } })
    const text = await flowCard(w.host) ?? ''
    expect(text).toContain('Blocked, NOT done: a protected file changed: src/a.ts')
    expect(text).toContain('/flow-setup · /flow-off')
    expect(text).toContain('Used: edit 2/4, review 1/4, debug 4/6')
  })

  test('an issued ticket is the next step; a session holding another lock sees view-only', async () => {
    const w = world({ record: { tickets: [ticket] } })
    w.setSession({ ...emptySession(), tickets: { 'T-1': 'the ticket text' } })
    expect(await flowCard(w.host)).toContain('Next: start the snagon-dev-mods:tdd-guide agent with exactly this prompt. Command: TICKET T-1')
    const other = world({ record: { tickets: [ticket] }, sessionId: 'sess-2' })
    expect(await flowCard(other.host)).toContain('another session holds this flow')
  })

  test('open ids leave out closed findings; a one-time note shows on the next card only', async () => {
    const findings = [
      { id: 'CR-1', f: 'F-01', rubricId: 'CODE-C', sev: 'HIGH' as const, loc: 'src/a.ts:1', status: 'open' },
      { id: 'CR-2', f: 'F-01', rubricId: 'CODE-C', sev: 'HIGH' as const, loc: 'src/a.ts:2', status: 'resolved' },
    ]
    const w = world({ record: { findings } })
    w.setSession({ ...emptySession(), notes: ['A release approval came from bridge'] })
    const first = await flowCard(w.host) ?? ''
    expect(first).toContain('Open: CR-1')
    expect(first).not.toContain('CR-2')
    expect(first).toContain('A release approval came from bridge')
    expect(await flowCard(w.host)).not.toContain('came from bridge')
  })

  test('a ticket whose text this session does not hold is not offered (after a restart it is issued again)', async () => {
    const w = world({ record: { tickets: [ticket] } })
    expect(await flowCard(w.host)).toContain('Command: flow_check')
  })

  test('a used ticket is never offered again', async () => {
    const w = world({ record: { tickets: [{ ...ticket, used: true }] } })
    w.setSession({ ...emptySession(), tickets: { 'T-1': 'the ticket text' } })
    expect(await flowCard(w.host)).toContain('Command: flow_check')
  })

  test('the card is in the owner\'s language; an unreadable flow is one line', async () => {
    const vi = world({ language: 'vi', record: { awaiting: '/flow-build' } })
    expect(await flowCard(vi.host)).toContain('Bước tiếp: chờ Chủ dự án. Lệnh: /flow-build')
    const broken = world({ flow: false, files: { [versionPath(HOME, 'deadbeef', 1)]: 'nope' } })
    expect(await flowCard(broken.host)).toContain('The flow state cannot be read')
  })
})

describe('flow-turn: D13, a main that will not start its ticket', () => {
  test('the Stop hook pushes main back to the same unstarted ticket three times, then the flow blocks stalled; /flow-retry check offers the ticket again', async () => {
    const w = world({ record: { judge: RED, tickets: [ticket] } })
    await mutateSession(w.host, s => ({ ...s, tickets: { ...s.tickets, 'T-1': 'TICKET T-1' } }))
    const record = async () => { const v = await activeView(w.host); return v.mode === 'on' ? v.record : undefined }
    expect(await ticketWaiting(w.host)).toBe(true)
    for (let k = 1; k <= STALL_LIMIT; k++) {
      expect((await flowStop(w.host, { message: 'I will not start it.', stopHookActive: false }))?.block).toMatch(/The current task is not passed and rounds are left: B2 F-01/)
      expect(w.session().value?.nudges['T-1']).toBe(k)
    }
    // the fourth Stop blocks the flow instead of pushing; what else the Stop carries (a done claim on a red judge, the
    // journal reminder) still comes, as on any Stop
    const fourth = await flowStop(w.host, { message: 'done', stopHookActive: false, journal: 'Write the journal entry.' })
    expect(fourth?.block).toMatch(/^1\. The last reply claims the work is done, but the judge is red/)
    expect(fourth?.block).not.toMatch(/not passed/)
    expect(fourth?.block).toContain('2. Write the journal entry.')
    expect(w.session().value?.claimHeld).toBe(true)
    expect((await record())?.blocked).toEqual({ reason: 'stalled', vars: { id: 'T-1', n: '3' } })
    expect(await flowStatus(w.host)).toContain('/flow-retry check')
    expect(w.session().value?.nudges['T-1']).toBe(0)
    expect(await retryCommand(w.host, 'check')).toBe('The ticket is offered to main again.')
    expect((await record())?.blocked).toBeUndefined()
    expect((await flowStop(w.host, { message: 'no', stopHookActive: false }))?.block).toMatch(/not passed/)
    expect(w.session().value?.nudges['T-1']).toBe(1)
    // the owner's own prompt starts the count again (a main that stopped to ask the owner was not refusing)
    await ownerSpoke(w.host)
    expect(w.session().value?.nudges).toEqual({})
  })

  test('in one wake-up the pushes come back to back inside stop_hook_active, the pressure line alone, then the flow blocks stalled and main may stop', async () => {
    // live: the first Stop of a wake-up is outside stop_hook_active and every Stop after a push is inside it; a main that
    // will not start its ticket gets no other wake-up, so the count has to run here (runs of 2026-10-20 hung at one push)
    const w = world({ record: { judge: RED, tickets: [ticket] } })
    await mutateSession(w.host, s => ({ ...s, tickets: { ...s.tickets, 'T-1': 'TICKET T-1' } }))
    expect((await flowStop(w.host, { message: 'I will not start it.', stopHookActive: false, journal: 'Write the journal entry.' }))?.block).toContain('Write the journal entry.')
    for (let k = 2; k <= STALL_LIMIT; k++) {
      // neither a done claim nor the journal reminder comes again inside stop_hook_active: the push alone
      expect((await flowStop(w.host, { message: 'done', stopHookActive: true, journal: 'Write the journal entry.' }))?.block).toMatch(/^1\. The current task is not passed and rounds are left: B2 F-01 .*; call flow_status for the next step\.$/)
      expect(w.session().value?.nudges['T-1']).toBe(k)
    }
    expect((await flowStop(w.host, { message: 'still not', stopHookActive: true }))?.block).toBeUndefined()
    const view = await activeView(w.host)
    expect(view.mode === 'on' ? view.record.blocked : undefined).toEqual({ reason: 'stalled', vars: { id: 'T-1', n: '3' } })
    // a blocked flow pushes no more, so the pushes cannot loop
    expect((await flowStop(w.host, { message: 'no', stopHookActive: true }))?.block).toBeUndefined()
    expect((await flowStop(w.host, { message: 'no', stopHookActive: false }))?.block).toBeUndefined()
  })

  test('a ticket prompt is wanted only while an issued ticket is unstarted', async () => {
    expect(await ticketWaiting(world({ record: { tickets: [{ ...ticket, used: true }] } }).host)).toBe(false)
    expect(await ticketWaiting(world({ flow: false }).host)).toBe(false)
    expect(await ticketWaiting(world({ record: { tickets: [ticket] } }).host)).toBe(false) // unused, but its text is not in this session: lost, flow_check re-issues it
  })
})

describe('flow-turn: one Stop block in order', () => {
  test('outside flow Stop is left to the journal reminder alone', async () => {
    expect(await flowStop(world({ flow: false }).host, { message: 'done', stopHookActive: false, journal: 'write the journal' })).toBeNull()
  })

  test('a done claim on a red judge, open floor and junk hits, pressure and the journal come as one numbered block', async () => {
    const findings = [
      { id: 'FL-1', f: 'F-01', rubricId: 'skip', sev: 'HIGH' as const, loc: 'tests/a.test.ts:3', status: 'open' },
      { id: 'J-2', f: 'F-01', rubricId: 'console', sev: 'HIGH' as const, loc: 'src/a.ts:9', status: 'open' },
      { id: 'J-3', f: 'F-01', rubricId: 'todo', sev: 'HIGH' as const, loc: 'src/a.ts:12', status: 'resolved' },
    ]
    const w = world({ record: { judge: RED, findings } })
    const out = await flowStop(w.host, { message: 'All done ✅', stopHookActive: false, journal: 'Write the journal entry.' })
    const lines = (out?.block ?? '').split('\n')
    expect(lines[0]).toMatch(/^1\. The last reply claims the work is done, but the judge is red/)
    expect(lines[1]).toBe('2. Unresolved floor or junk findings: FL-1, J-2. Fix them, or ask the project owner to waive them.')
    expect(lines[2]).toMatch(/^3\. The current task is not passed and rounds are left: B2 F-01/)
    expect(lines[3]).toBe('4. Write the journal entry.')
    expect(w.session().value?.claimHeld).toBe(true)
  })

  test('a repeated claim is not held again but goes on the card and into the journal', async () => {
    const w = world({ record: { judge: RED, awaiting: '/flow-decide' } })
    await flowStop(w.host, { message: 'done', stopHookActive: false })
    const again = await flowStop(w.host, { message: 'done', stopHookActive: false })
    expect(again?.block).toBeUndefined()
    expect(await flowCard(w.host)).toContain('The last reply said done while the judge is red; it is NOT done.')
    expect(w.journal.some(l => l.includes('said done again while the judge was red'))).toBe(true)
  })

  test('stop_hook_active blocks nothing but a D13 push (here no ticket waits); setup and plan have no judge to claim against', async () => {
    const w = world({ record: { judge: RED } })
    expect((await flowStop(w.host, { message: 'done', stopHookActive: true, journal: 'j' }))?.block).toBeUndefined()
    const plan = world({ record: { phase: 'plan', task: 'P2', feature: undefined, awaiting: '/flow-plan' } })
    expect((await flowStop(plan.host, { message: 'done', stopHookActive: false }))?.block).toBeUndefined()
  })

  test('a green judge counts only for its tree: computed only when the reply claims done, and stale when it cannot be', async () => {
    const GREEN = { ...RED, green: true }
    const quiet = world({ record: { judge: GREEN, awaiting: '/flow-decide' } })
    expect((await flowStop(quiet.host, { message: 'next I will refactor', stopHookActive: false }))?.block).toBeUndefined()
    expect(quiet.runs.some(r => r.includes('read-tree'))).toBe(false)
    const claim = world({ record: { judge: GREEN, awaiting: '/flow-decide' } })
    expect((await flowStop(claim.host, { message: 'done', stopHookActive: false }))?.block).toContain('the judge is stale')
  })

  test('a judge run of another feature does not count for this one', async () => {
    const w = world({ record: { judge: { ...RED, green: true, f: 'F-00' }, awaiting: '/flow-decide' } })
    expect((await flowStop(w.host, { message: 'done', stopHookActive: false }))?.block).toContain('the judge is missing')
  })

  test('the journal reminder alone reads as today', async () => {
    const w = world({ record: { awaiting: '/flow-build' } })
    expect((await flowStop(w.host, { message: 'ok', stopHookActive: false, journal: 'Write the journal entry.' }))?.block).toBe('Write the journal entry.')
  })
})

describe('flow-turn: flow_status', () => {
  test('outside flow, blocked, awaiting the owner, a ticket, a check', async () => {
    expect(JSON.parse(await flowStatus(world({ flow: false }).host)).next).toContain('No flow is active')
    expect(JSON.parse(await flowStatus(world({ record: { blocked: { reason: 'cost', vars: { kind: 'flow', cap: '60' } } } }).host)).next).toContain('Blocked, NOT done: cost')
    expect(JSON.parse(await flowStatus(world({ record: { awaiting: '/flow-verify' } }).host)).next).toContain('/flow-verify')
    const w = world({ record: { tickets: [ticket] } })
    w.setSession({ ...emptySession(), tickets: { 'T-1': 'text' } })
    expect(JSON.parse(await flowStatus(w.host))).toMatchObject({ ticket: 'TICKET T-1', routedType: 'snagon-dev-mods:tdd-guide' })
    expect(JSON.parse(await flowStatus(world().host)).next).toContain('flow_check')
  })

  test('the ticket text never leaves the session state through flow_status', async () => {
    const w = world({ record: { tickets: [ticket] } })
    w.setSession({ ...emptySession(), tickets: { 'T-1': 'SECRET-TICKET-TEXT' } })
    expect(await flowStatus(w.host)).not.toContain('SECRET-TICKET-TEXT')
  })
})
