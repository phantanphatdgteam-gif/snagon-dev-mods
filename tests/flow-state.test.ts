import { describe, expect, test } from 'claude-code/testing'
import type { Io, RunResult } from '../hooks/session'
import {
  newRecord, createRecord, listActive, updateRecord, removeRecord, parseRecord, versionPath, flowDir, repoKeyOf, newFlowId,
  lockStatus, claimLock, heartbeat, releaseLock, shouldPersistHeartbeat,
  LOCK_STALE_MS, RECORD_LIMIT, WRITE_ATTEMPTS, TEMP_STALE_MS, MAX_VERSION, type FlowRecord,
} from '../hooks/flow-state'
import { RECORD_053 } from './fixtures/record-053'

const HOME = '/home/u'
const ID = 'a1b2c3d4'
const NOW = 1_000_000
const DIR = flowDir(HOME)
const ok = (): RunResult => ({ exitCode: 0, stdout: '', stderr: '' })
const fail = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr })

/** An in-memory machine shared by several sessions: files, directories, and the commands the record protocol runs. */
function machine() {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const dirs = new Set<string>()
  const links = new Set<string>() // symbolic links: listed as `other`, read through to their content
  const runs: string[][] = []
  const hooks: { existsFails?: (path: string) => boolean; beforeRead?: (path: string) => void; beforeLn?: (to: string) => void; afterLn?: (to: string) => void; failWrite?: boolean; lnError?: string; rmFails?: boolean; listFails?: boolean } = {}
  const put = (p: string, t: string, at = NOW): void => { files.set(p, t); mtimes.set(p, at) }
  const io: Io = {
    read: async p => { hooks.beforeRead?.(p); const t = files.get(p); if (t === undefined) throw new Error(`ENOENT ${p}`); return t },
    write: async (p, t) => { if (hooks.failWrite) throw new Error('EACCES'); put(p, t) },
    exists: async p => { if (hooks.existsFails?.(p)) throw new Error('EIO'); return files.has(p) || dirs.has(p) },
    list: async d => {
      if (hooks.listFails) throw new Error('EMFILE')
      const names = new Set<string>()
      for (const p of [...files.keys(), ...dirs]) if (p.startsWith(`${d}/`)) names.add(p.slice(d.length + 1).split('/')[0] ?? '')
      return [...names].filter(Boolean).map(name => {
        const p = `${d}/${name}`
        return { name, kind: dirs.has(p) ? 'dir' : links.has(p) ? 'other' : 'file', size: files.get(p)?.length ?? 0, mtimeMs: mtimes.get(p) ?? 0 }
      })
    },
    run: async argv => {
      runs.push(argv)
      const [cmd, ...a] = argv
      if (cmd === '/bin/mkdir' && a[0] === '-p') { dirs.add(a[1] ?? ''); return ok() }
      if (cmd === '/bin/rm' && a[0] === '-f') { if (hooks.rmFails) return fail('Operation not permitted'); for (const p of a.slice(1)) files.delete(p); return ok() }
      if (cmd === '/bin/ln' && a[0] === '-n') {
        const [from = '', to = ''] = a.slice(1)
        hooks.beforeLn?.(to)
        if (hooks.lnError) return fail(hooks.lnError)
        if (files.has(to) || dirs.has(to)) return fail(`ln: ${to}: File exists`)
        const t = files.get(from); if (t === undefined) return fail('No such file or directory')
        put(to, t); hooks.afterLn?.(to); return ok()
      }
      if (cmd === '/bin/mv' && a[0] === '-f') {
        const [from = '', to = ''] = a.slice(1)
        const t = files.get(from); if (t === undefined) return fail('No such file or directory')
        files.delete(from); put(to, t); return ok()
      }
      return fail(`unexpected ${argv.join(' ')}`)
    },
    now: async () => NOW,
    pluginRoot: '/mod',
  }
  return { io, files, dirs, links, runs, hooks, put }
}
type Machine = ReturnType<typeof machine>

const base = (now = NOW, over: Partial<FlowRecord> = {}): FlowRecord =>
  ({ ...newRecord({ flowId: ID, repoKey: 'feedf00d', root: '/p', branch: 'main', sessionId: 'S-A', now }), ...over })
const at = (version: number, over: Partial<FlowRecord> = {}): string => JSON.stringify({ ...base(), version, ...over })
const bump = (r: FlowRecord): FlowRecord => ({ ...r, counters: { ...r.counters, 'F-01': { e: (r.counters['F-01']?.e ?? 0) + 1, r: 0, d: 0, retried: false } } })
const names = (m: Machine): string[] => [...m.files.keys()].map(p => p.slice(DIR.length + 1)).sort()
const lns = (m: Machine): number => m.runs.filter(r => r[0] === '/bin/ln').length
async function active(m: Machine, key = 'feedf00d'): Promise<FlowRecord[]> {
  const r = await listActive(m.io, HOME, key)
  if (!r.ok) throw new Error(`listActive: ${r.reason}`)
  return r.active
}
const A = { sessionId: 'S-A', root: '/p', branch: 'main' }
const B = { sessionId: 'S-B', root: '/p-wt', branch: 'feature' }

describe('flow record', () => {
  test('a new flow is written through a temp file and a hard link, found by its repository key and not by another', async () => {
    const m = machine()
    expect((await createRecord(m.io, HOME, base())).ok).toBe(true)
    expect(m.runs.some(r => r[0] === '/bin/ln' && (r[2] ?? '').includes('.tmp-'))).toBe(true)
    expect(names(m)).toEqual([`${ID}.v1.json`])
    expect((await active(m)).map(r => r.flowId)).toEqual([ID])
    expect(await active(m, 'beefbeef')).toEqual([])
    expect(await createRecord(m.io, HOME, base())).toEqual({ ok: false, reason: 'conflict' })
  })

  test('two sessions writing at the same moment: one wins the version, the other reloads and re-applies; old versions are pruned', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    const [a, b] = await Promise.all([updateRecord(m.io, HOME, ID, 'S-A', bump, 1), updateRecord(m.io, HOME, ID, 'S-B', bump, 1)])
    const results = [a, b].flatMap(x => (x?.ok ? [x] : []))
    expect(results.map(x => x.record.version).sort()).toEqual([2, 3])
    expect(results.map(x => x.staleRead).sort()).toEqual([false, true])
    expect(lns(m)).toBe(4) // create, both first tries (one lost), the retry
    const last = (await active(m))[0]
    expect([last?.version, last?.counters['F-01']?.e]).toEqual([3, 2])
    expect(names(m)).toEqual([`${ID}.v1.json`, `${ID}.v2.json`, `${ID}.v3.json`])
    expect(m.files.get(`${DIR}/${ID}.v1.json`)).toBe('') // emptied in place: the name stays taken
  })

  test('a writer that won is never withdrawn when another session builds on its version at once', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.hooks.afterLn = to => { // session B reads the fresh v2 and writes v3 on top of it before A looks again
      if (!to.endsWith('.v2.json')) return
      m.hooks.afterLn = undefined
      const v2 = JSON.parse(m.files.get(to) ?? '{}') as FlowRecord
      m.put(`${DIR}/${ID}.v3.json`, JSON.stringify({ ...bump(v2), version: 3 }))
    }
    const r = await updateRecord(m.io, HOME, ID, 'S-A', bump)
    expect(r.ok && r.record.version).toBe(2)
    const last = (await active(m))[0]
    expect([last?.version, last?.counters['F-01']?.e]).toEqual([3, 2]) // two bumps, applied once each
  })

  test('a write that landed stays ok when the end check after it fails; the end is checked again on every load', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.hooks.existsFails = p => p.endsWith('.end')
    const r = await updateRecord(m.io, HOME, ID, 'S-A', bump)
    expect([r.ok && r.record.version, lns(m)]).toEqual([2, 2])
  })

  test('an empty newest version that stays the newest was cut short: the flow is invalid, not busy for ever', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.put(`${DIR}/${ID}.v2.json`, '')
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'invalid' })
    const found = await listActive(m.io, HOME, 'feedf00d')
    expect(found.ok && found.invalid).toEqual([ID])
  })

  test('ending a long flow deletes its files in batches', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    for (let v = 2; v <= 1200; v += 1) m.put(`${DIR}/${ID}.v${v}.json`, '')
    const runsBefore = m.runs.length
    expect(await removeRecord(m.io, HOME, ID, 'done')).toEqual({ ok: true })
    expect(names(m)).toEqual([`${ID}.end`])
    expect(m.runs.slice(runsBefore).filter(r => r[0] === '/bin/rm').map(r => r.length - 2)).toEqual([500, 500, 200])
  })

  test('a temp file pruned while its writer stood still is rewritten and the write goes through', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.hooks.beforeLn = () => { m.hooks.beforeLn = undefined; for (const k of [...m.files.keys()]) if (k.includes('.tmp-')) m.files.delete(k) }
    const r = await updateRecord(m.io, HOME, ID, 'S-A', bump)
    expect(r.ok && r.record.version).toBe(2)
  })

  test('a slow writer finds its version name still taken after pruning, reloads the newest and re-applies once', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    let stalled = true
    m.hooks.beforeLn = to => {
      if (!stalled || !to.endsWith('.v2.json')) return
      stalled = false // meanwhile three other writes landed (v2, v3, v4) and pruning emptied v1 and v2
      m.put(`${DIR}/${ID}.v1.json`, '')
      m.put(`${DIR}/${ID}.v2.json`, '')
      m.put(`${DIR}/${ID}.v3.json`, at(3, { task: 'B1' }))
      m.put(`${DIR}/${ID}.v4.json`, at(4, { task: 'B2' }))
    }
    const r = await updateRecord(m.io, HOME, ID, 'S-A', bump)
    expect(r.ok && [r.record.version, r.record.task, r.record.counters['F-01']?.e]).toEqual([5, 'B2', 1])
    expect(names(m)).toEqual([1, 2, 3, 4, 5].map(v => `${ID}.v${v}.json`))
  })

  test('losing the compare-and-swap every time ends in conflict after the allowed attempts', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.hooks.beforeLn = to => { const v = Number(/\.v(\d+)\.json$/.exec(to)?.[1]); m.put(to, at(v)) }
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'conflict' })
    expect(lns(m)).toBe(1 + WRITE_ATTEMPTS)
  })

  test('ending a flow: the end marker stays, a writer racing the end withdraws, and the id is never reused', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.put(`${DIR}/ffffffff.v1.json`, at(1, { flowId: 'ffffffff' }))
    let raced = false
    m.hooks.beforeLn = to => { // the owner's /flow-off ran completely between this writer's read and its link
      if (raced || !to.endsWith(`${ID}.v2.json`)) return
      raced = true
      m.put(`${DIR}/${ID}.end`, '{"end":"off"}')
      m.files.delete(`${DIR}/${ID}.v1.json`)
    }
    expect(await updateRecord(m.io, HOME, ID, 'S-B', bump)).toEqual({ ok: false, reason: 'ended' })
    expect(names(m)).toEqual([`${ID}.end`, 'ffffffff.v1.json'])
    expect((await active(m)).map(r => r.flowId)).toEqual(['ffffffff']) // the ended flow is gone; the other one stays
    expect(await createRecord(m.io, HOME, base())).toEqual({ ok: false, reason: 'conflict' })
    m.hooks.beforeLn = undefined
    m.put(`${DIR}/ffffffff.tmp-deadbeef`, '{}')
    expect(await removeRecord(m.io, HOME, 'ffffffff', 'done')).toEqual({ ok: true })
    expect(names(m)).toEqual([`${ID}.end`, 'ffffffff.end'])
    expect(await updateRecord(m.io, HOME, 'ffffffff', 'S-A', bump)).toEqual({ ok: false, reason: 'ended' })
  })

  test('a crash between the end marker and the delete leaves an ended flow, not an active one', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.put(`${DIR}/${ID}.end`, '{"end":"off"}')
    expect(await active(m)).toEqual([])
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'ended' })
  })

  test('a newest version that keeps being emptied under the reader is a conflict to retry, not a broken flow', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    let v = 1
    m.hooks.beforeRead = path => { if (path.endsWith(`.v${v}.json`)) { m.put(path, ''); v += 1; m.put(`${DIR}/${ID}.v${v}.json`, at(v)) } }
    expect(await listActive(m.io, HOME, 'feedf00d')).toEqual({ ok: false, reason: 'conflict' })
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'conflict' })
  })

  test('every failure comes back as a reason and leaves the record as it was', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    const before = names(m)
    m.hooks.lnError = 'ln: Operation not permitted'
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'io' })
    m.hooks.lnError = undefined
    m.hooks.failWrite = true
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'io' })
    expect((await removeRecord(m.io, HOME, ID, 'off')).ok).toBe(false)
    m.hooks.failWrite = false
    const thrown = await updateRecord(m.io, HOME, ID, 'S-A', () => { throw new Error('F-01 still has open findings') })
    expect(thrown.ok ? '' : thrown.reason).toBe('rejected')
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump, 5)).toEqual({ ok: false, reason: 'rollback' })
    expect(await updateRecord(m.io, HOME, ID, 'S-A', r => ({ ...r, frozen: { blob: 'x'.repeat(RECORD_LIMIT) } }))).toEqual({ ok: false, reason: 'too-large' })
    const withText = (r: FlowRecord): FlowRecord => ({ ...r, tickets: [{ id: 'T1', f: 'F-01', sha: 's', nonce: 'n', tree: 't', routedType: 'tdd-guide', model: 'sonnet', used: false, text: 'the ticket' } as never] })
    expect(await updateRecord(m.io, HOME, ID, 'S-A', withText)).toEqual({ ok: false, reason: 'invalid' })
    expect(names(m)).toEqual(before)
    m.hooks.listFails = true
    expect((await listActive(m.io, HOME, 'feedf00d')).ok).toBe(false)
    m.hooks.listFails = false
    m.hooks.rmFails = true
    expect(await removeRecord(m.io, HOME, ID, 'done')).toEqual({ ok: false, reason: 'io' })
  })

  test('a change that changes nothing writes nothing; temp files left by a crash are cleared; versions stop at nine digits', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    const lnBefore = lns(m)
    const kept = await updateRecord(m.io, HOME, ID, 'S-B', claimLock(B, NOW, false))
    expect([kept.ok, lns(m)]).toEqual([true, lnBefore])
    m.put(`${DIR}/${ID}.tmp-0ld0ld0ld0ld0ld0`, '{}', NOW - TEMP_STALE_MS - 1)
    m.put(`${DIR}/${ID}.tmp-fresh0fresh0fre`, '{}', NOW)
    await updateRecord(m.io, HOME, ID, 'S-A', bump)
    expect(names(m)).toEqual([`${ID}.tmp-fresh0fresh0fre`, `${ID}.v1.json`, `${ID}.v2.json`])
    m.put(`${DIR}/${ID}.v${MAX_VERSION}.json`, at(MAX_VERSION))
    expect(await updateRecord(m.io, HOME, ID, 'S-A', bump)).toEqual({ ok: false, reason: 'too-large' })
    expect(() => parseRecord(at(MAX_VERSION + 1))).toThrow()
  })

  test('unreadable flows are reported, not skipped: broken JSON, a directory, a symbolic link, a name that disagrees with the file', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base())
    m.put(`${DIR}/dddddddd.v1.json`, '{ not json')
    m.dirs.add(`${DIR}/eeeeeeee.v1.json`)
    m.put(`${DIR}/bbbbbbbb.v1.json`, at(1))
    m.put(`${DIR}/cccccccc.v3.json`, at(2, { flowId: 'cccccccc' }))
    m.put(`${DIR}/99999999.v1.json`, at(1, { flowId: '99999999' }))
    m.links.add(`${DIR}/99999999.v1.json`) // a well-formed record behind a symbolic link
    const found = await listActive(m.io, HOME, 'feedf00d')
    expect(found.ok && found.active.map(r => r.flowId)).toEqual([ID])
    expect(found.ok && found.invalid.sort()).toEqual(['99999999', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'])
  })

  test('a record file is checked field by field: no ticket text, no unknown keys, counters are counts, the lock is complete', () => {
    const good = base()
    expect(parseRecord(JSON.stringify(good)).flowId).toBe(ID)
    expect(parseRecord(JSON.stringify({ ...good, tickets: [{ id: 'T1', f: 'F-01', sha: 's', nonce: 'n', tree: 't', routedType: 'x', model: 'm', used: false, kind: 'fix' }] })).tickets[0]?.kind).toBe('fix')
    const bad: Array<[string, unknown]> = [
      ['ticket text', { ...good, tickets: [{ id: 'T1', f: 'F-01', sha: 's', nonce: 'n', tree: 't', routedType: 'x', model: 'm', used: false, text: 'the ticket' }] }],
      ['unknown ticket kind', { ...good, tickets: [{ id: 'T1', f: 'F-01', sha: 's', nonce: 'n', tree: 't', routedType: 'x', model: 'm', used: false, kind: 'approve' }] }],
      ['unknown key', { ...good, ticketText: 'the ticket' }],
      ['counter as text', { ...good, counters: { 'F-01': { e: '-99', r: 0, d: 0, retried: false } } }],
      ['lock without root', { ...good, lock: { sessionId: 'S', heartbeatAt: 1 } }],
      ['unknown lifecycle', { ...good, lifecycle: 'paused' }],
      ['path in the id', { ...good, flowId: '../../x' }],
      ['unknown severity', { ...good, findings: [{ id: 'X', f: 'F', rubricId: 'C', sev: 'BLOCKER', loc: 'l', status: 's' }] }],
      ['line hash not text', { ...good, findings: [{ id: 'X', f: 'F', rubricId: 'C', sev: 'HIGH', loc: 'l', status: 's', sig: 5 }] }],
      ['unknown approval', { ...good, approvals: [{ kind: 'all', echoHash: 'h', at: 1, origin: 'composer' }] }],
      ['an array', []],
      ['negative self-caused count', { ...good, selfBlocks: -1 }],
      ['assumptions as text', { ...good, assumptions: { 'F-01': 'all of it' } }],
      ['negative finding number', { ...good, lastIds: { CR: -1 } }],
      ['finding number as text', { ...good, lastIds: { CR: '3' } }],
    ]
    for (const [what, value] of bad) expect([what, (() => { try { parseRecord(JSON.stringify(value)); return 'accepted' } catch { return 'refused' } })()]).toEqual([what, 'refused'])
    expect(parseRecord(JSON.stringify({ ...good, lastIds: { CR: 3, J: 1 } })).lastIds).toEqual({ CR: 3, J: 1 })
    expect(() => versionPath(HOME, '../../x', 1)).toThrow()
    expect(() => versionPath(HOME, ID, 0)).toThrow()
  })

  test('the flow lock: an owner takes it at once, another session only when free or stale, and the holder must stay on its root and branch', () => {
    const held = base(NOW)
    expect(lockStatus(held, A, NOW)).toBe('mine')
    expect(lockStatus(held, { ...A, branch: 'other' }, NOW)).toBe('moved')
    expect(lockStatus(held, B, NOW + LOCK_STALE_MS)).toBe('other')
    expect(lockStatus(held, B, NOW + LOCK_STALE_MS + 1)).toBe('stale')
    expect(lockStatus({ ...held, lock: { ...A, heartbeatAt: NOW + LOCK_STALE_MS + 1 } }, B, NOW)).toBe('stale')
    expect(lockStatus({ ...held, lock: null }, B, NOW)).toBe('free')
    expect(claimLock(B, NOW + 5, false)(held)).toBe(held)
    expect(claimLock(B, NOW + 5, true)(held).lock).toEqual({ ...B, heartbeatAt: NOW + 5 })
    expect(claimLock(B, NOW + LOCK_STALE_MS + 1, false)(held).lock?.sessionId).toBe('S-B')
    expect(claimLock({ ...A, branch: 'other' }, NOW, false)(held)).toBe(held)
    expect(heartbeat(B, NOW + 9)(held)).toBe(held)
    expect(heartbeat(A, NOW + 9)(held).lock?.heartbeatAt).toBe(NOW + 9)
    expect(releaseLock('S-B')(held)).toBe(held)
    expect(releaseLock('S-A')(held).lock).toBeNull()
    expect([shouldPersistHeartbeat(NOW, NOW + 5 * 60_000 - 1), shouldPersistHeartbeat(NOW, NOW + 5 * 60_000)]).toEqual([false, true])
  })

  test('an owner takes the lock through an update even when the cached view was stale; another session does not', async () => {
    const m = machine()
    await createRecord(m.io, HOME, base(NOW))
    const tried = await updateRecord(m.io, HOME, ID, 'S-B', claimLock(B, NOW + 100, false))
    expect(tried.ok && tried.record.lock?.sessionId).toBe('S-A')
    const owner = await updateRecord(m.io, HOME, ID, 'S-B', claimLock(B, NOW + 200, true))
    expect(owner.ok && owner.record.lock?.sessionId).toBe('S-B')
  })

  test('linked worktrees share one key (the common git dir); ids are 8 hex characters', () => {
    expect(repoKeyOf('/p/.git')).toBe(repoKeyOf('/p/.git'))
    expect(repoKeyOf('/p/.git')).not.toBe(repoKeyOf('/q/.git'))
    expect(repoKeyOf('/p/.git')).toMatch(/^[0-9a-f]{8}$/)
    expect(newFlowId('9f2c')).toMatch(/^[0-9a-f]{8}$/)
    expect(newFlowId('9f2c')).not.toBe(newFlowId('9f2d'))
  })

  test('an older record with flowCap, counters.cost and setup.sessionCap still loads; a setup without sessionCap loads too (no cost cap since 2026-10-20)', () => {
    const older = { ...RECORD_053, flowCap: 90, spent: 12, counters: { ...RECORD_053.counters, cost: { e: 0, r: 0, d: 0, retried: true } } }
    const r = parseRecord(JSON.stringify(older))
    expect(r).toMatchObject({ flowCap: 90, spent: 12, setup: { sessionCap: 15 }, counters: { cost: { retried: true } } })
    expect(parseRecord(JSON.stringify({ ...RECORD_053, setup: { ...RECORD_053.setup, sessionCap: undefined } })).setup?.sessionCap).toBeUndefined()
    expect(() => parseRecord(JSON.stringify({ ...RECORD_053, setup: { ...RECORD_053.setup, sessionCap: 'x' } }))).toThrow()
  })
})
