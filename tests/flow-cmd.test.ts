import { describe, expect, test } from 'claude-code/testing'
import { ownerCommand } from '../hooks/flow-cmd'
import { paneView } from '../hooks/flow-pane'
import { emptySession, forgetFlowCaches } from '../hooks/flow-host'
import { forgetModes } from '../hooks/flow-live'
import { makeEcho, paneCode, rotateCode } from '../hooks/flow-owner'
import { flowDir, parseRecord, versionPath, type FlowRecord } from '../hooks/flow-state'
import { activeRecord, fakeHost, recordFile, FLOW_ID, HOME, ROOT, type FakeOpts } from './flow-fakes'

function world(o: FakeOpts & { flow?: boolean; record?: Partial<FlowRecord> } = {}) {
  forgetFlowCaches()
  forgetModes()
  return fakeHost({ ...o, files: { [`${ROOT}/src/a.ts`]: 'a', ...(o.flow === false ? {} : recordFile(activeRecord(o.record))), ...o.files } })
}
const OWNER = { kind: 'composer' } as const
const run = (w: ReturnType<typeof world>, line: string, origin: { kind: string } = OWNER) => {
  const [command = '', ...rest] = line.split(' ')
  return ownerCommand(w.host, { command, args: rest.join(' '), origin })
}
const release = () => makeEcho({ kind: 'release', title: 'Release for the project owner to approve', lines: ['3 commits to main'], fields: { n: 3 }, files: {} })

describe('flow-cmd: parsing, origin and the lock', () => {
  test('a malformed command answers its usage', async () => {
    expect((await run(world(), 'flow-off nope')).text).toBe('Usage: /flow-off [<id8>]')
  })

  test('a command from anywhere but the prompt or the bridge is refused', async () => {
    expect((await run(world(), 'flow-status', { kind: 'sdk' })).text).toContain('count only when the project owner types them')
  })

  test('/flow-status shows the card and takes the lock for this session (GAP-step7-4)', async () => {
    const w = world({ sessionId: 'sess-2' })
    const out = await run(w, 'flow-status')
    expect(out.text).toContain('flow · build / B2 F-01')
    expect(parseRecord(w.files.get(versionPath(HOME, FLOW_ID, 2)) ?? '').lock?.sessionId).toBe('sess-2')
  })

  test('outside flow /flow-status says how to start one', async () => {
    expect((await run(world({ flow: false }), 'flow-status')).text).toContain('/flow-setup')
  })
})

describe('flow-cmd: approvals and the release code', () => {
  test('the release code is masked on the command line, and an approval with nothing shown is refused', async () => {
    const w = world()
    rotateCode()
    const out = await run(w, `flow-approve release 1234abcd ${paneCode() ?? ''}`)
    expect(out.args).toBe('release 1234abcd ******')
    expect(out.text).toContain('Nothing is waiting for this approval. Run /flow-ship first.')
    expect(paneCode()).toBeNull() // spent by the attempt
    expect((await run(w, 'flow-approve plan 1234abcd')).args).toBeUndefined()
  })

  test('a malformed approval still spends the release code', async () => {
    const w = world()
    rotateCode()
    expect((await run(w, `flow-approve release ${paneCode() ?? ''}`)).text).toContain('Usage: /flow-approve')
    expect(paneCode()).toBeNull()
  })

  test('a release approval through the bridge is refused, spends the code and leaves a journal and card line', async () => {
    const w = world()
    rotateCode()
    w.setSession({ ...emptySession(), pending: { release: await release() }, shown: 'release' })
    const echo = (w.session().value?.pending.release?.hash ?? '').slice(0, 8)
    const out = await run(w, `flow-approve release ${echo} ${paneCode() ?? ''}`, { kind: 'bridge' })
    expect(out.text).toContain('counts only when the project owner types it at the prompt')
    expect(paneCode()).toBeNull()
    expect(w.journal.some(l => l.includes('came from bridge'))).toBe(true)
    expect(w.session().value?.notes.some(l => l.includes('came from bridge'))).toBe(true)
  })
})

describe('flow-cmd: /flow-off', () => {
  test('ends the flow for good, clears this session\'s flow state and the release code', async () => {
    const w = world()
    rotateCode()
    w.setSession({ ...emptySession(), tickets: { 'T-1': 'x' }, pending: { release: await release() } })
    const out = await run(w, 'flow-off')
    expect(out.text).toBe(`flow ${FLOW_ID} is off. Its files in .snagon/flow stay as history.`)
    expect(w.files.has(`${flowDir(HOME)}/${FLOW_ID}.end`)).toBe(true)
    expect(w.session().value?.tickets).toEqual({})
    expect(w.session().value?.pending).toEqual({})
    expect(paneCode()).toBeNull()
  })

  test('with two active flows it names the one to end', async () => {
    const other = activeRecord({ flowId: 'b2b2b2b2' })
    const w = world({ files: recordFile(other) })
    expect((await run(w, 'flow-off')).text).toContain(`/flow-off ${FLOW_ID}`)
    expect((await run(w, 'flow-off c3c3c3c3')).text).toContain(`/flow-off ${FLOW_ID} · /flow-off b2b2b2b2`)
    expect((await run(w, 'flow-off b2b2b2b2')).text).toContain('flow b2b2b2b2 is off')
    expect(w.files.has(`${flowDir(HOME)}/b2b2b2b2.end`)).toBe(true)
    expect(w.files.has(`${flowDir(HOME)}/${FLOW_ID}.end`)).toBe(false)
  })
})

describe('flow-cmd: the pane', () => {
  test('draws the shown echo with the code read at draw time, never from the session state', async () => {
    const w = world()
    w.setSession({ ...emptySession(), pending: { release: await release() }, shown: 'release' })
    rotateCode()
    const code = paneCode() ?? ''
    const view = await paneView(w.host)
    expect(view.lines.join('\n')).toContain(`/flow-approve release ${(w.session().value?.pending.release?.hash ?? '').slice(0, 8)} ${code}`)
    expect(JSON.stringify(w.session())).not.toContain(code)
  })

  test('with nothing shown it says so', async () => {
    expect((await paneView(world().host)).lines).toEqual(['Nothing waits for approval.'])
  })
})
