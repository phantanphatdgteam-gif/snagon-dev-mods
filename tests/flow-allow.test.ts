import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { exitsFor, card } from '../hooks/flow'
import { ownerCommand } from '../hooks/flow-cmd'
import { sha256 } from '../hooks/flow-review'
import { parseOwner } from '../hooks/flow-owner'
import { parseRecord } from '../hooks/flow-state'
import { ROOT, activeRecord } from './flow-fakes'
import { added, agentRun, atB3, AUTHOR_TREE, diffKey, editRecord, ended, lastTicket, latest, NEW_FAILED, NEW_PASSED, OLD, reportOf, run, START, TEST_FILE, world, type W } from './flow-drive'

const REASON = 'the helper rejects an empty match'
const DEBUG_REPLY = 'REPRODUCE: test\nLOCALIZE: src/add.ts:1\nHYPOTHESIS: x\nFIX: src/add.ts:1-1\nGUARD: AC-001 adds'
const RED = { tests: [OLD, NEW_FAILED], exit: 1 } as const
const textOf = (w: W): string => w.session().value?.tickets[lastTicket(w)?.id ?? ''] ?? ''
const hash8 = (w: W): string => w.session().value?.pending.allow?.hash.slice(0, 8) ?? ''
const keyOf = (w: W): string => latest(w)?.features?.[0]?.key ?? ''
/** F-01 red at B3 with debug ticket 1 issued; each round ends the newest ticket and checks again (the debug cap is 4, so 4 rounds block). */
async function debugRounds(w: W, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
  }
}
const allow = async (w: W, reason = REASON): Promise<string> => {
  await run(w, `flow-allow red F-01 ${reason}`)
  return (await run(w, `flow-approve allow ${hash8(w)}`)).text
}

describe('flow-allow: parsing, card exits', () => {
  test('/flow-allow red F-NN <reason> parses; a missing reason, feature or word is the usage line; /flow-approve takes the new kind', () => {
    expect(parseOwner('flow-allow', `red F-02 ${REASON}`)).toEqual({ name: 'flow-allow', feature: 'F-02', reason: REASON })
    for (const args of ['red F-02', 'red F-2 x', 'green F-02 x', '', 'F-02 x']) expect(parseOwner('flow-allow', args)).toEqual({ error: '/flow-allow red F-NN <reason>' })
    expect(parseOwner('flow-approve', 'allow 0a1b2c3d')).toEqual({ name: 'flow-approve', kind: 'allow', hash8: '0a1b2c3d' })
  })

  test('the cap card offers /flow-allow red F-NN <reason> for a feature\'s debug rounds, and for no other cap', () => {
    expect(exitsFor('cap', { scope: 'F-01', kind: 'debug' })).toEqual(['/flow-decide <X-n> fix|reject|followup', '/flow-retry <scope>', '/flow-reject plan', '/flow-allow red F-01 <reason>'])
    for (const vars of [{ scope: 'F-01', kind: 'review' }, { scope: 'F-01', kind: 'edit' }, { scope: 'plan', kind: 'edit' }, { scope: 'verify', kind: 'debug' }]) expect(exitsFor('cap', vars)).toHaveLength(3)
    const lines = card({ lang: 'en', address: 'the project owner', pointer: { phase: 'build', task: 'B3', feature: 'F-01' }, used: { e: 1, r: 0, d: 4 }, caps: { e: 4, r: 4, d: 4 }, open: [], blocked: { reason: 'cap', vars: { scope: 'F-01', kind: 'debug' } }, sandbox: 'on', cost: { session: 0, flow: 0 }, next: { step: 's', command: 'c' } })
    expect(lines.at(-1)).toContain('/flow-allow red F-01 <reason>')
  })

  test('a record without the field loads as before; a malformed one is refused', () => {
    const text = JSON.stringify(activeRecord())
    expect(parseRecord(text).redAllow).toBeUndefined()
    const ok = { feature: 'F-01', reason: 'r', at: 1, used: false }
    expect(parseRecord(JSON.stringify({ ...activeRecord(), redAllow: ok })).redAllow).toEqual(ok)
    for (const bad of [{ ...ok, used: 'no' }, { ...ok, feature: 3 }, { feature: 'F-01' }, 'yes']) expect(() => parseRecord(JSON.stringify({ ...activeRecord(), redAllow: bad }))).toThrow('bad redAllow')
  })
})

describe('flow-allow: the echo and its approval', () => {
  test('the echo names the feature, its RED test files, the reason and what happens; the hash binds the approval', async () => {
    const { w } = await atB3(RED)
    expect((await run(w, `flow-allow red F-01 ${REASON}`)).text).toContain('Shown in the flow pane')
    const echo = w.session().value?.pending.allow
    expect(echo).toMatchObject({ kind: 'allow', title: 'RED test fix for the project owner to approve' })
    const lines = echo?.lines.join('\n') ?? ''
    expect(lines).toContain('F-01')
    expect(lines).toContain('tests/add.test.ts')
    expect(lines).toContain(REASON)
    expect(lines).toContain('One debug ticket of F-01 may fix the RED test')
    expect(lines).toContain('red-test-changed')
    expect((await run(w, 'flow-approve allow 00000000')).text).toContain('This changed after it was shown')
    expect(latest(w)?.redAllow).toBeUndefined()
  })

  test('a second /flow-allow replaces the first: the old hash no longer approves', async () => {
    const { w } = await atB3(RED)
    await run(w, 'flow-allow red F-01 first reason')
    const first = hash8(w)
    await run(w, 'flow-allow red F-01 second reason')
    expect(hash8(w)).not.toBe(first)
    expect((await run(w, `flow-approve allow ${first}`)).text).toContain('This changed after it was shown')
    expect((await run(w, `flow-approve allow ${hash8(w)}`)).text).toContain('may fix its RED test')
    expect(latest(w)?.redAllow).toMatchObject({ feature: 'F-01', reason: 'second reason', used: false })
    expect(latest(w)?.approvals.at(-1)?.kind).toBe('allow')
    expect(w.session().value?.pending.allow).toBeUndefined()
  })

  test('nothing to allow: no flow, a feature other than the one being built, or before the RED tests are recorded', async () => {
    const none = world()
    expect((await run(none, `flow-allow red F-01 ${REASON}`)).text).toContain('No flow is active in this repository')
    const { w } = await atB3(RED)
    expect((await run(w, `flow-allow red F-02 ${REASON}`)).text).toContain('There is no RED test of F-02 to allow a fix for')
    expect(w.session().value?.pending.allow).toBeUndefined()
    editRecord(w, r => ({ ...r, redTestHash: {} })) // the RED tests not recorded yet
    expect((await run(w, `flow-allow red F-01 ${REASON}`)).text).toContain('There is no RED test of F-01 to allow a fix for')
    expect(w.session().value?.pending.allow).toBeUndefined()
  })

  test('the echo is rebuilt at approval: a flow that left the feature meanwhile refuses it', async () => {
    const { w } = await atB3(RED)
    await run(w, `flow-allow red F-01 ${REASON}`)
    editRecord(w, r => { const { feature: _f, ...rest } = r; return { ...rest, phase: 'verify' } })
    expect((await run(w, `flow-approve allow ${hash8(w)}`)).text).toContain('This changed after it was shown')
    expect(latest(w)?.redAllow).toBeUndefined()
  })
})

describe('flow-allow: the allowed debug ticket', () => {
  test('approved at a debug cap: the block is released with no /flow-retry, the next debug ticket may edit the RED test, a later one may not', async () => {
    const { w } = await atB3(RED)
    await debugRounds(w, 4)
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'debug' } })
    const d = latest(w)?.counters[keyOf(w)]?.d
    expect(await allow(w)).toContain('may fix its RED test')
    const r = latest(w)
    expect(r?.blocked).toBeUndefined()
    expect(r?.counters[keyOf(w)]).toMatchObject({ retried: false })
    expect(w.submitted.at(-1)).toContain('flow_check')
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    const text = textOf(w)
    expect(text).toContain('## RED TEST FIX ALLOWED')
    expect(text).toContain('tests/add.test.ts')
    expect(text).toContain(REASON)
    expect(text).toContain('only to fix a defect in the test itself')
    expect(latest(w)?.redAllow).toMatchObject({ feature: 'F-01', used: true })
    expect(latest(w)?.counters[keyOf(w)]?.d).toBe(d) // one extra round on top of the counters
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'debug' } }) // the extra round is spent
    await run(w, 'flow-retry F-01')
    await flowCheck(w.host)
    expect(textOf(w)).not.toContain('RED TEST FIX ALLOWED')
    expect(textOf(w)).toContain('## DEBUG F-01')
  })

  test('approved when nothing blocks: recorded, and the next debug ticket (not the one already issued) is the allowed one', async () => {
    const { w } = await atB3(RED)
    const issued = lastTicket(w)?.id
    expect(textOf(w)).not.toContain('RED TEST FIX ALLOWED')
    await allow(w)
    expect(latest(w)?.redAllow).toMatchObject({ feature: 'F-01', reason: REASON, used: false })
    expect(lastTicket(w)?.id).toBe(issued)
    await agentRun(w, issued ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    expect(lastTicket(w)?.id).not.toBe(issued)
    expect(textOf(w)).toContain('## RED TEST FIX ALLOWED')
    expect(latest(w)?.redAllow?.used).toBe(true)
    expect(latest(w)?.counters[keyOf(w)]?.d).toBe(1)
  })

  test('another block is not released by an allowance', async () => {
    const { w } = await atB3({ src: "export const add = (a: number, b: number): number => a + b\nconsole.log('here')\n" })
    expect(latest(w)?.blocked?.reason).toBe('junk')
    await allow(w)
    expect(latest(w)?.blocked?.reason).toBe('junk')
    expect(latest(w)?.redAllow).toMatchObject({ feature: 'F-01', used: false })
  })

  test('an allowance for another feature never reaches this feature\'s debug ticket', async () => {
    const { w } = await atB3(RED)
    editRecord(w, r => ({ ...r, redAllow: { feature: 'F-02', reason: REASON, at: 1, used: false } }))
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(textOf(w)).not.toContain('RED TEST FIX ALLOWED')
    expect(latest(w)?.redAllow).toMatchObject({ feature: 'F-02', used: false })
    expect(latest(w)?.counters[keyOf(w)]?.d).toBe(2)
  })

  test('the judge still raises red-test-changed for the RED file the allowed ticket changed; the owner waives it', async () => {
    const { w, d } = await atB3(RED)
    await allow(w)
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    expect(textOf(w)).toContain('## RED TEST FIX ALLOWED')
    const fixed = TEST_FILE.replace('toBe(3)', 'toBe(2)'), tree = 'd'.repeat(40)
    ;(d.gitOut ?? {})[diffKey(START, tree)] = added('tests/add.test.ts', fixed) + added('src/add.ts', 'export const add = (a: number, b: number): number => a + b\n')
    d.judge = { test: { exit: 0, out: '', report: reportOf([OLD, NEW_PASSED]) } }
    expect(AUTHOR_TREE).not.toBe(tree)
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY), () => { w.setTree(tree); w.files.set(`${ROOT}/tests/add.test.ts`, fixed) })
    await flowCheck(w.host)
    const r = latest(w)
    expect(r?.findings.map(x => x.rubricId)).toContain('red-test-changed')
    expect(r?.blocked).toMatchObject({ reason: 'redTestChanged', vars: { feature: 'F-01', location: 'tests/add.test.ts' } })
    const id = r?.blocked?.vars.id ?? ''
    await run(w, `flow-waive ${id} the test had a defect`)
    expect((await run(w, `flow-approve waive ${w.session().value?.pending.waive?.hash.slice(0, 8) ?? ''}`)).text).toContain(`Waived ${id}`)
    expect(latest(w)?.findings.find(x => x.id === id)?.status).toBe('waived')
  })

  test('an allowance never used does not outlive its feature: the seal drops it, and keeps one for another feature', async () => {
    for (const [feature, kept] of [['F-01', false], ['F-02', true]] as const) {
      const { w } = await atB3()
      editRecord(w, r => ({ ...r, redAllow: { feature, reason: REASON, at: 1, used: false } }))
      await agentRun(w, lastTicket(w)?.id ?? '', ended('NO-FINDINGS'))
      await flowCheck(w.host)
      const r = latest(w)
      expect(r?.seals.map(x => x.f)).toEqual(['F-01'])
      expect([feature, r !== undefined && 'redAllow' in r]).toEqual([feature, kept])
    }
  })

  test('the owner\'s reason is kept in the waivers view when the allowance is approved', async () => {
    const { w } = await atB3(RED)
    await allow(w)
    expect(w.files.get(`${ROOT}/.snagon/flow/waivers.md`)).toContain(`- allow red F-01: ${REASON}`)
  })

  test('a very long reason is cut inside the ticket only: the ticket is issued, the record and the echo keep the whole reason', async () => {
    const long = 'x'.repeat(70_000), { w } = await atB3(RED)
    await run(w, `flow-allow red F-01 ${long}`)
    expect(w.session().value?.pending.allow?.lines.join('\n')).toContain(long)
    await run(w, `flow-approve allow ${hash8(w)}`)
    expect(latest(w)?.redAllow?.reason).toBe(long)
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    const text = textOf(w)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(text).toContain('## RED TEST FIX ALLOWED')
    expect(text).toContain('x'.repeat(2000))
    expect(text).not.toContain('x'.repeat(2001))
    expect(text).toContain('the full reason is in the flow record')
  })

  test('an allowed ticket lost in a restart is issued again with the allowance, and no round is used', async () => {
    const { w } = await atB3(RED)
    await allow(w)
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    const lost = lastTicket(w)
    expect(textOf(w)).toContain('## RED TEST FIX ALLOWED')
    expect(latest(w)?.redAllow).toMatchObject({ used: true, ticket: lost?.id })
    const d = latest(w)?.counters[keyOf(w)]?.d
    const s = w.session().value
    if (s) w.setSession({ ...s, tickets: {} }) // the restart: ticket texts are gone
    await flowCheck(w.host)
    expect(lastTicket(w)?.id).not.toBe(lost?.id)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(textOf(w)).toContain('## RED TEST FIX ALLOWED')
    expect(latest(w)?.redAllow).toMatchObject({ used: true, ticket: lastTicket(w)?.id })
    expect(latest(w)?.counters[keyOf(w)]?.d).toBe(d)
  })
})

describe('flow-allow: a waiver covers the RED text the owner read, not the file for good', () => {
  const rewrite = (n: number): string => TEST_FILE.replace('toBe(3)', `toBe(${n})`)
  const SRC_ADD = 'export const add = (a: number, b: number): number => a + b\n'
  /** The allowed ticket rewrote the RED file (toBe(2)); FL-1 raised and waived. */
  async function waived() {
    const { w, d } = await atB3(RED)
    await allow(w)
    await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY))
    await flowCheck(w.host)
    const edit = async (n: number, tree: string, exit: number): Promise<void> => {
      const g = d.gitOut ?? {}
      g[diffKey(START, tree)] = added('tests/add.test.ts', rewrite(n)) + added('src/add.ts', SRC_ADD)
      g[`cat-file blob ${tree}:tests/add.test.ts`] = rewrite(n)
      d.judge = { test: { exit, out: '', report: reportOf([OLD, exit ? NEW_FAILED : NEW_PASSED]) } }
      await agentRun(w, lastTicket(w)?.id ?? '', ended(DEBUG_REPLY), () => { w.setTree(tree); w.files.set(`${ROOT}/tests/add.test.ts`, rewrite(n)) })
      await flowCheck(w.host)
    }
    await edit(2, 'd'.repeat(40), 0)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'redTestChanged', vars: { id: 'FL-1' } })
    await run(w, 'flow-waive FL-1 the test had a defect')
    await run(w, `flow-approve waive ${w.session().value?.pending.waive?.hash.slice(0, 8) ?? ''}`)
    return { w, d, edit }
  }

  test('the same RED text after the waiver stays waived: no new finding, the flow goes on', async () => {
    const { w } = await waived()
    await flowCheck(w.host)
    const r = latest(w)
    expect(r?.findings.filter(x => x.rubricId === 'red-test-changed').map(x => [x.id, x.status])).toEqual([['FL-1', 'waived']])
    expect(r).toMatchObject({ task: 'B4' })
    expect(r?.blocked).toBeUndefined()
    // the file's text is known by its SHA-256 (a 64-bit hash could be collided by a crafted RED file)
    expect(r?.findings.find(x => x.id === 'FL-1')?.sig).toBe(await sha256(rewrite(2)))
  })

  test('another rewrite of the RED file after the waiver opens a new finding and blocks again', async () => {
    const { w, d, edit } = await waived()
    d.judge = { test: { exit: 1, out: '', report: reportOf([OLD, NEW_FAILED]) } }
    await flowCheck(w.host) // red again: a normal debug ticket (the allowance is spent)
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(textOf(w)).not.toContain('RED TEST FIX ALLOWED')
    await edit(1, 'e'.repeat(40), 0)
    const r = latest(w)
    expect(r?.findings.filter(x => x.rubricId === 'red-test-changed').map(x => [x.id, x.status])).toEqual([['FL-1', 'waived'], ['FL-2', 'open']])
    expect(r?.blocked).toMatchObject({ reason: 'redTestChanged', vars: { id: 'FL-2', feature: 'F-01' } })
  })
})

describe('flow-allow: the waivers view holds one line per reason', () => {
  const WAIVERS = `${ROOT}/.snagon/flow/waivers.md`
  const FORGED = 'first line\n- FL-9: forged\u2028- J-9: forged too'
  const lines = (w: W): string[] => (w.files.get(WAIVERS) ?? '').split(/[\r\n\u2028\u2029]/)

  test('an allowance reason with line breaks cannot add a waiver line', async () => {
    const { w } = await atB3(RED)
    await ownerCommand(w.host, { command: 'flow-allow', args: `red F-01 ${FORGED}`, origin: { kind: 'composer' } })
    await run(w, `flow-approve allow ${hash8(w)}`)
    expect(lines(w).filter(l => l.startsWith('- '))).toEqual(['- allow red F-01: first line - FL-9: forged - J-9: forged too'])
  })

  test('a waiver reason with line breaks cannot add a waiver line', async () => {
    const { w } = await atB3({ src: "export const add = (a: number, b: number): number => a + b\nconsole.log('here')\n" })
    await ownerCommand(w.host, { command: 'flow-waive', args: `J-1 ${FORGED}`, origin: { kind: 'composer' } })
    await run(w, `flow-approve waive ${w.session().value?.pending.waive?.hash.slice(0, 8) ?? ''}`)
    expect(lines(w).filter(l => l.startsWith('- '))).toEqual(['- J-1: first line - FL-9: forged - J-9: forged too'])
  })
})
