import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { onReply } from '../hooks/flow-reviewing'
import { METHOD_HEAD, MOD_ROOT, ROOT } from './flow-fakes'
import { added, agentRun, atB3, AUTHOR_TREE, diffKey, editRecord, ended, lastTicket, latest, NEW_FAILED, NEW_PASSED, OLD, reportOf, SRC, START, TEST_FILE, type DriveOpts, type W } from './flow-drive'

const FIX_TREE = 'd'.repeat(40)
const FIXED_SRC = 'export const add = (a: number, b: number): number => {\n  return a + b\n}\n'
const HIGH = 'FINDING | CODE-C2 | HIGH | src/add.ts:1 | evidence: `a + b` with no check | scenario: add(NaN, 1) → NaN | expected: reject NaN'
/** Sets one counter of F-01 in the newest record version (as if earlier rounds had used it). */
function bump(w: W, field: 'e' | 'r' | 'd', value: number): void {
  const [path, text] = [...w.files.entries()].filter(([k, v]) => /\.v\d+\.json$/.test(k) && v.trim()).sort((a, b) => Number(/\.v(\d+)\.json$/.exec(b[0])?.[1]) - Number(/\.v(\d+)\.json$/.exec(a[0])?.[1]))[0] ?? ['', '']
  const r = JSON.parse(text) as { counters: Record<string, Record<string, unknown>>; features: { key: string }[] }
  const key = r.features[0]?.key ?? ''
  r.counters[key] = { e: 0, r: 0, d: 0, retried: false, ...r.counters[key], [field]: value }
  w.files.set(path, JSON.stringify(r))
}
const reviewTickets = (w: W) => (latest(w)?.tickets ?? []).filter(t => t.kind === 'review' || t.kind === 'delta')

/** The author answers the fix ticket; its change rewrites src/add.ts lines 1-3 (the tree moves to FIX_TREE). */
async function fixRun(w: W, d: DriveOpts, reply: string): Promise<void> {
  const gitOut = d.gitOut ?? {}
  const fixDiff = ['diff --git a/src/add.ts b/src/add.ts', '--- a/src/add.ts', '+++ b/src/add.ts', '@@ -1 +1,3 @@', `-${SRC.trim()}`, ...FIXED_SRC.trim().split('\n').map(l => `+${l}`), ''].join('\n')
  gitOut[diffKey(AUTHOR_TREE, FIX_TREE)] = fixDiff
  gitOut[diffKey(START, FIX_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', FIXED_SRC)
  await agentRun(w, lastTicket(w)?.id ?? '', ended(reply), () => { w.setTree(FIX_TREE); w.files.set(`${ROOT}/src/add.ts`, FIXED_SRC) })
  await flowCheck(w.host)
}

describe('flow-reviewing: B4, the first review round', () => {
  test('a green judge issues one review ticket per required reviewer: CONTRACT and fenced ARTIFACT, one review round', async () => {
    const { w } = await atB3()
    const r = latest(w), [t] = reviewTickets(w)
    expect(reviewTickets(w)).toHaveLength(1)
    expect(t).toMatchObject({ f: 'F-01', kind: 'review', routedType: 'typescript-reviewer', model: 'sonnet', used: false, tree: AUTHOR_TREE })
    expect(r?.round).toEqual({ f: 'F-01', tree: AUTHOR_TREE, tickets: [t?.id] })
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.r).toBe(1)
    const text = w.session().value?.tickets[t?.id ?? ''] ?? ''
    expect(text).toContain('## CONTRACT')
    expect(text).toContain('AC-001')
    expect(text).toMatch(/<<<UNTRUSTED-[0-9a-f]{16} diff\n/)
    expect(text).toContain('+export const add')
    expect(text).toContain('The tests as written at RED')
    expect(text).toMatch(/red-tests\ndiff --git a\/tests\/add\.test\.ts/)
    expect(text).toContain(`${METHOD_HEAD}\n\n---\nname: code-review-and-quality\n---\nMETHOD code-review-and-quality`)
    expect(text.indexOf(METHOD_HEAD)).toBeLessThan(text.indexOf('## ANSWER'))
  })

  test('Security forced by the diff adds the security reviewer to the same round', async () => {
    const { w } = await atB3({ src: `import { readFileSync } from 'node:fs'\n${SRC}` })
    expect(reviewTickets(w).map(t => t.routedType).sort()).toEqual(['security-reviewer', 'typescript-reviewer'])
    const security = reviewTickets(w).find(t => t.routedType === 'security-reviewer')
    expect(w.session().value?.tickets[security?.id ?? '']).toContain(`${METHOD_HEAD}\n\n---\nname: security-and-hardening\n---\nMETHOD security-and-hardening`)
    expect(latest(w)?.round?.tickets).toHaveLength(2)
    expect(latest(w)?.counters[latest(w)?.features?.[0]?.key ?? '']?.r).toBe(1)
  })

  test('a reviewer method that cannot be read fails the round whole: no review ticket is issued and no round is counted', async () => {
    const box: { w?: W } = {}
    const gone = `${MOD_ROOT}/flow/vendor/agent-skills/skills/security-and-hardening/SKILL.md`
    await expect(atB3({ src: `import { readFileSync } from 'node:fs'\n${SRC}`, start: x => { box.w = x; x.files.delete(gone) } })).rejects.toThrow('security-and-hardening/SKILL.md')
    const r = box.w ? latest(box.w) : undefined
    expect(r).toMatchObject({ task: 'B4', judge: { green: true } })
    expect(r?.round).toBeUndefined()
    expect(box.w ? reviewTickets(box.w) : null).toEqual([])
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.r ?? 0).toBe(0)
  })

  test('at the review cap no new round opens: the flow is blocked for the owner', async () => {
    const { w } = await atB3({ before: (_d, x) => bump(x, 'r', 3) })
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'review' } })
  })

  test('no findings: the gate passes and the feature is sealed; after the last feature the flow waits for /flow-verify', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended('NO-FINDINGS'))
    await flowCheck(w.host)
    const r = latest(w)
    expect(r?.seals).toEqual([expect.objectContaining({ f: 'F-01', tree: AUTHOR_TREE, evalIds: ['AC-001'] })])
    expect(r).toMatchObject({ phase: 'verify', task: 'V1', awaiting: '/flow-verify' })
    expect(r?.round).toBeUndefined()
    expect(r?.tickets.filter(t => t.f === 'F-01')).toEqual([])
    expect(w.files.get(`${ROOT}/.snagon/flow/F-01.json`)).toContain('"f": "F-01"')
  })
})

describe('flow-reviewing: a reply counts only once its results are kept', () => {
  test('a reply whose findings cannot be kept is not attested: the gate does not pass on it and the run is asked again', async () => {
    const { w } = await atB3()
    const t = lastTicket(w), write = w.host.writeSession
    await agentRun(w, t?.id ?? '', ended(HIGH), () => { w.host.writeSession = async () => false }).catch(() => null)
    w.host.writeSession = write
    expect(latest(w)?.tickets.find(x => x.id === t?.id)?.attested).toBeUndefined()
    await flowCheck(w.host)
    expect(latest(w)?.seals).toEqual([])
    expect(lastTicket(w)).toMatchObject({ kind: 'review', used: false })
  })
})

describe('flow-reviewing: finding numbers', () => {
  test('a finding number is never given twice: the numbers a seal dropped stay used', async () => {
    const { w } = await atB3()
    const cr = lastTicket(w)
    if (!cr) throw new Error('no ticket')
    editRecord(w, r => ({ ...r, lastIds: { CR: 3 } }))
    await onReply(w.host, cr, ended(HIGH)(cr.nonce))
    expect(latest(w)?.findings.map(x => x.id)).toEqual(['CR-4'])
  })
})

describe('flow-reviewing: two replies at once', () => {
  test('the code and security reviewers answering together both keep their findings', async () => {
    const { w } = await atB3({ src: `import { readFileSync } from 'node:fs'\n${SRC}` })
    const [cr, sr] = ['typescript-reviewer', 'security-reviewer'].map(type => latest(w)?.tickets.find(t => t.kind === 'review' && t.routedType === type))
    if (!cr || !sr) throw new Error('no round')
    const at = (id: string, line: string, nonce: string) => `${line}\nREVIEW-END ${nonce}`
    await Promise.all([
      onReply(w.host, cr, at(cr.id, 'FINDING | CODE-C2 | HIGH | src/add.ts:2 | evidence: `a + b` | scenario: add(NaN, 1) → NaN | expected: reject NaN', cr.nonce)),
      onReply(w.host, sr, at(sr.id, 'FINDING | SEC-I2 | HIGH | src/add.ts:1 | evidence: `readFileSync` | scenario: a path from input reads any file | expected: keep reads under the root', sr.nonce)),
    ])
    const r = latest(w)
    expect(r?.findings.map(x => x.id).sort()).toEqual(['CR-1', 'SR-1'])
    expect(r?.tickets.filter(t => t.kind === 'review' && t.attested).map(t => t.id).sort()).toEqual([cr.id, sr.id].sort())
    expect(Object.keys(w.session().value?.details ?? {}).sort()).toEqual(['CR-1', 'SR-1'])
    // two replies under one prefix at once: the ids follow the newest record, so none is reused
    await Promise.all([
      onReply(w.host, cr, at(cr.id, 'FINDING | CODE-C2 | HIGH | src/add.ts:3 | evidence: `x` | scenario: x → y | expected: z', cr.nonce)),
      onReply(w.host, cr, at(cr.id, 'FINDING | CODE-C2 | HIGH | src/add.ts:4 | evidence: `x` | scenario: x → y | expected: z', cr.nonce)),
    ])
    const ids = latest(w)?.findings.map(x => x.id) ?? []
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(x => x.startsWith('CR-')).sort()).toEqual(['CR-1', 'CR-2', 'CR-3'])
  })
})

describe('flow-reviewing: findings, the fix and the delta round', () => {
  test('a HIGH finding: recorded (its words in the session only), then a fix ticket that names it; one edit round', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const r = latest(w)
    expect(r?.findings).toEqual([{ id: 'CR-1', f: 'F-01', rubricId: 'CODE-C2', sev: 'HIGH', loc: 'src/add.ts:1', status: 'open' }])
    expect(w.session().value?.details['CR-1']).toMatchObject({ scenario: 'add(NaN, 1) → NaN' })
    expect(JSON.stringify(r)).not.toContain('add(NaN, 1)')
    const t = lastTicket(w)
    expect(t).toMatchObject({ kind: 'fix', routedType: 'tdd-guide' })
    expect(w.session().value?.tickets[t?.id ?? '']).toContain('CR-1 HIGH open CODE-C2')
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.e).toBe(1)
  })

  test('the fix is judged at its tree, then a delta round sees the FIX map and the change since the review; RESOLVED seals', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | src/add.ts:1-3')
    const r = latest(w)
    expect(r?.fixMap).toEqual({ 'CR-1': ['src/add.ts:1-3'] })
    expect(r?.findings[0]?.status).toBe('fixed-unconfirmed')
    expect(r?.judge).toMatchObject({ tree: FIX_TREE, green: true })
    const t = lastTicket(w)
    expect(t).toMatchObject({ kind: 'delta', routedType: 'typescript-reviewer', tree: FIX_TREE })
    expect(r?.round).toEqual({ f: 'F-01', tree: FIX_TREE, prev: AUTHOR_TREE, tickets: [t?.id] })
    const text = w.session().value?.tickets[t?.id ?? ''] ?? ''
    expect(text).toContain('CR-1 HIGH fixed-unconfirmed CODE-C2 (FIX src/add.ts:1-3)')
    expect(text).toContain('+  return a + b')
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.r).toBe(2)
    await agentRun(w, t?.id ?? '', ended('RESOLVED CR-1'))
    await flowCheck(w.host)
    expect(latest(w)?.seals.map(s => [s.f, s.tree])).toEqual([['F-01', FIX_TREE]])
    // the seal dropped the resolved CR-1; its number stays used
    expect(latest(w)?.findings.map(x => x.id)).not.toContain('CR-1')
    expect(latest(w)?.lastIds).toMatchObject({ CR: 1 })
  })

  test('a fix run without the nonce line gets a new fix ticket and is not judged', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const first = lastTicket(w)?.id
    await agentRun(w, first ?? '', () => 'FIX CR-1 | src/add.ts:1-1')
    await flowCheck(w.host)
    const r = latest(w)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false })
    expect(lastTicket(w)?.id).not.toBe(first)
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.e).toBe(2)
  })

  test('D11: a fix that changes lines outside its FIX ranges gets one scope correction, free of charge; a correction that covers the hunk resolves it', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const key = latest(w)?.features?.[0]?.key ?? '', e = latest(w)?.counters[key]?.e
    await fixRun(w, d, 'FIX CR-1 | tests/add.test.ts:1-1')
    expect(latest(w)?.blocked).toBeUndefined()
    const correction = lastTicket(w)
    expect(correction).toMatchObject({ kind: 'fix', used: false })
    expect(latest(w)?.round?.corrected).toBe(true)
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')).toMatchObject({ rubricId: 'fix-scope', status: 'open', loc: 'src/add.ts:1' })
    expect(w.session().value?.tickets[correction?.id ?? '']).toContain('fix-scope finding is a hunk changed outside the FIX ranges')
    expect(latest(w)?.counters[key]?.e).toBe(e)
    await agentRun(w, correction?.id ?? '', ended('FIX CR-1 | tests/add.test.ts:1-1\nFIX FL-1 | src/add.ts:1-3'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')?.status).toBe('resolved')
    expect(lastTicket(w)).toMatchObject({ kind: 'delta', used: false })
  })

  test('D11: a hunk still outside the FIX ranges after the correction is the floor finding, for the owner', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | tests/add.test.ts:1-1')
    expect(latest(w)?.round?.corrected).toBe(true)
    // a claim that overlaps the hunk without holding it whole is no cover (D11-1)
    await agentRun(w, lastTicket(w)?.id ?? '', ended('FIX FL-1 | src/add.ts:1-1'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'floor', vars: { rule: 'fix-scope', location: 'src/add.ts:1' } })
  })

  test('D11: a correction that reverts the hunk and replies REVERT is attested; the finding resolves and the round goes on', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | tests/add.test.ts:1-1')
    const correction = lastTicket(w)?.id ?? ''
    await agentRun(w, correction, ended('REVERT FL-1'), () => { w.setTree(AUTHOR_TREE); w.files.set(`${ROOT}/src/add.ts`, SRC) })
    expect(w.session().value?.runs[correction]).toEqual({ ok: true })
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')?.status).toBe('resolved')
    expect(latest(w)?.fixMap?.['FL-1']).toBeUndefined()
  })

  test('D11-4: a served correction claim covers its hunk for the rest of the round: a red judge and a debug run after it do not reopen the finding', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | tests/add.test.ts:1-1')
    const correction = lastTicket(w)?.id ?? ''
    d.judge = { test: { exit: 1, report: reportOf([OLD, NEW_FAILED]) } } // the correction leaves a test red
    await agentRun(w, correction, ended('FIX CR-1 | tests/add.test.ts:1-1\nFIX FL-1 | src/add.ts:1-3'))
    await flowCheck(w.host)
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')?.status).toBe('resolved')
    expect(lastTicket(w)).toMatchObject({ kind: 'debug', used: false })
    expect(latest(w)?.fixMap?.['FL-1']).toEqual(['src/add.ts:1-3']) // the served claim stays for the rest of the round
    d.judge = { test: { exit: 0, report: reportOf([OLD, NEW_PASSED]) } } // the debug run makes it green again
    await agentRun(w, lastTicket(w)?.id ?? '', ended('REPRODUCE: test\nLOCALIZE: src/add.ts:1\nHYPOTHESIS: x\nFIX: src/add.ts:1-1\nGUARD: AC-001 adds'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')?.status).toBe('resolved') // the re-judge still saw the claim
    expect(lastTicket(w)).toMatchObject({ kind: 'delta', used: false })
    expect(latest(w)?.fixMap?.['FL-1']).toBeUndefined() // gone with the round that opened
  })

  test('D11-R2-3: a fix reply naming only a finding its ticket did not carry is not attested', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const first = lastTicket(w)?.id ?? ''
    await agentRun(w, first, ended('REVERT FL-7'))
    expect(w.session().value?.runs[first]).toEqual({ ok: false, reason: 'the fix names no finding of its ticket' })
    expect(latest(w)?.tickets.find(t => t.id === first)?.attested).toBeFalsy()
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false }) // the ticket comes again, as after any unattested run
    expect(lastTicket(w)?.id).not.toBe(first)
  })

  test('D15: a delta reply with no verdict on a fixed finding of its prefix is not attested and the round is asked again; a verdict with a reason counts', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | src/add.ts:1-3')
    const delta = lastTicket(w)
    expect(delta).toMatchObject({ kind: 'delta', used: false })
    const key = latest(w)?.features?.[0]?.key ?? '', r = latest(w)?.counters[key]?.r ?? 0
    await agentRun(w, delta?.id ?? '', ended('NO-FINDINGS'))
    expect(w.session().value?.runs[delta?.id ?? '']).toEqual({ ok: false, reason: 'the delta reply gives no verdict on CR-1' })
    await flowCheck(w.host)
    const again = lastTicket(w)
    expect(again).toMatchObject({ kind: 'delta', used: false })
    expect(again?.id).not.toBe(delta?.id)
    expect(latest(w)?.counters[key]?.r).toBe(r + 1)
    await agentRun(w, again?.id ?? '', ended('RESOLVED CR-1: the guard sits on line 2 now\nNO-FINDINGS'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    // the verdict landed and the gate passed: the feature is sealed (its closed findings and its round are gone)
    expect(latest(w)?.findings.some(x => x.id === 'CR-1')).toBe(false)
    expect(latest(w)?.round?.f).toBeUndefined()
    expect(lastTicket(w)?.kind).not.toBe('fix')
  })

  test('D11 round 3: a correction that reverted its hunk but reported nothing is not attested, yet no fix ticket that lists nothing follows: the change is judged and the delta round opens', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | tests/add.test.ts:1-1')
    const correction = lastTicket(w)?.id ?? ''
    const key = latest(w)?.features?.[0]?.key ?? '', e = latest(w)?.counters[key]?.e
    await agentRun(w, correction, ended('I reverted the hunk.'), () => { w.setTree(AUTHOR_TREE); w.files.set(`${ROOT}/src/add.ts`, SRC) })
    expect(w.session().value?.runs[correction]).toEqual({ ok: false, reason: 'the fix reply names no FIX or DISPUTE line' })
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')?.status).toBe('resolved')
    expect(lastTicket(w)).toMatchObject({ kind: 'delta', used: false })
    expect(latest(w)?.counters[key]?.e).toBe(e)
  })

  test('D11 round 3: a correction that disputes the fix-scope finding is attested, moves nothing, and the floor block goes to the owner', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | tests/add.test.ts:1-1')
    const correction = lastTicket(w)?.id ?? ''
    await agentRun(w, correction, ended('DISPUTE FL-1 | the change is needed'))
    expect(w.session().value?.runs[correction]).toEqual({ ok: true })
    await flowCheck(w.host)
    expect(latest(w)?.findings.find(x => x.id === 'FL-1')?.status).toBe('open')
    expect(latest(w)?.blocked).toMatchObject({ reason: 'floor', vars: { rule: 'fix-scope', location: 'src/add.ts:1' } })
  })

  test('D11 round 3: live findings with none open after the delta round (a disputed one of the other prefix) ask the delta round again, never a fix ticket that lists nothing', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    await fixRun(w, d, 'FIX CR-1 | src/add.ts:1-3')
    const delta = lastTicket(w)
    expect(delta).toMatchObject({ kind: 'delta', used: false })
    editRecord(w, r => ({ ...r, findings: [...r.findings, { id: 'SR-1', f: 'F-01', rubricId: 'SEC-S1', sev: 'HIGH', loc: 'src/add.ts:2', status: 'disputed' }] }))
    const key = latest(w)?.features?.[0]?.key ?? '', r = latest(w)?.counters[key]?.r ?? 0, e = latest(w)?.counters[key]?.e
    expect(latest(w)?.round).toMatchObject({ tree: FIX_TREE, prev: AUTHOR_TREE })
    await agentRun(w, delta?.id ?? '', ended('RESOLVED CR-1\nNO-FINDINGS'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toBeUndefined()
    expect(lastTicket(w)).toMatchObject({ kind: 'delta', used: false })
    expect(lastTicket(w)?.id).not.toBe(delta?.id)
    expect(latest(w)?.counters[key]?.r).toBe(r + 1)
    expect(latest(w)?.counters[key]?.e).toBe(e)
    // opened again at the same tree, the round keeps its real `prev`, and the ticket shows the fix's change again
    expect(latest(w)?.round).toMatchObject({ tree: FIX_TREE, prev: AUTHOR_TREE })
    expect(w.session().value?.tickets[lastTicket(w)?.id ?? '']).toContain('diff --git a/src/add.ts b/src/add.ts')
  })

  test('D13: a ticket issued inside flow_check submits no "ticket is ready" prompt: the result names it', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    const before = w.submitted.length // /flow-build, an owner command, did prompt for its RED ticket (main was idle)
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false })
    expect(w.submitted.slice(before).some(t => t.startsWith('flow: a ticket is ready'))).toBe(false)
  })

  test('D11: a feature fix reply with no FIX and no DISPUTE line is not attested; the fix ticket comes again', async () => {
    const { w } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const first = lastTicket(w)?.id ?? ''
    await agentRun(w, first, ended('I rewrote src/add.ts.'))
    expect(w.session().value?.runs[first]).toEqual({ ok: false, reason: 'the fix reply names no FIX or DISPUTE line' })
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'fix', used: false })
    expect(lastTicket(w)?.id).not.toBe(first)
  })

  test('a disputed finding the reviewer upholds goes to the owner', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    void d
    await agentRun(w, lastTicket(w)?.id ?? '', ended('DISPUTE CR-1 | add only takes numbers checked by the caller'))
    await flowCheck(w.host)
    expect(lastTicket(w)).toMatchObject({ kind: 'delta' })
    expect(latest(w)?.findings[0]?.status).toBe('disputed')
    expect(w.session().value?.disputes['CR-1']).toContain('checked by the caller')
    await agentRun(w, lastTicket(w)?.id ?? '', ended('UPHOLD CR-1'))
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toEqual({ reason: 'dispute', vars: { id: 'CR-1' } })
  })

  test('an unattested review run is asked again and takes a review round; at the review cap the owner decides', async () => {
    const { w } = await atB3()
    const first = lastTicket(w)?.id
    await agentRun(w, first ?? '', () => 'NO-FINDINGS')
    await flowCheck(w.host)
    const r = latest(w)
    expect(lastTicket(w)?.id).not.toBe(first)
    expect(lastTicket(w)).toMatchObject({ kind: 'review', used: false })
    expect(r?.round?.tickets).toEqual([lastTicket(w)?.id])
    expect(r?.counters[r?.features?.[0]?.key ?? '']?.r).toBe(2)
    await agentRun(w, lastTicket(w)?.id ?? '', () => 'NO-FINDINGS')
    await flowCheck(w.host)
    await agentRun(w, lastTicket(w)?.id ?? '', () => 'NO-FINDINGS')
    await flowCheck(w.host)
    expect(latest(w)?.blocked).toEqual({ reason: 'cap', vars: { scope: 'F-01', kind: 'review' } })
  })
})
