import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { flowCard } from '../hooks/flow-turn'
import { gitPaths } from '../hooks/flow-git'
import { dropTrees, endTrees, keepTrees, keptPrefix, neededTrees, reanchored, refsBlock, refsChanged, refsFrozen, refsNow, sealedFrom } from '../hooks/flow-refs'
import { onReply } from '../hooks/flow-reviewing'
import type { Io } from '../hooks/session'
import type { FlowRecord, TicketRecord } from '../hooks/flow-state'
import { activeRecord, fakeHost, FLOW_ID, HOME, recordFile, ROOT } from './flow-fakes'
import { agentRun, approved, atB3, AUTHOR_TREE, diffKey, ended, GREEN_REPORT, HEAD, lastTicket, latest, RED_TREE, run, START, toB1, toH0, toV1, world } from './flow-drive'

const HIGH = 'FINDING | CODE-C2 | HIGH | src/add.ts:1 | evidence: `a + b` with no check | scenario: add(NaN, 1) → NaN | expected: reject NaN'
const T1 = '1'.repeat(40), T2 = '2'.repeat(40), T3 = '3'.repeat(40), BASE = 'a'.repeat(40), FIX_TREE = 'd'.repeat(40)
const KEPT = keptPrefix(FLOW_ID)
const FEATURES = [{ id: 'F-01', key: 'k1', files: [] }, { id: 'F-02', key: 'k2', files: [] }]
const ticket = (id: string, used: boolean): TicketRecord => ({ id, f: 'F-01', sha: 's', nonce: 'n', tree: T2, routedType: 'code-reviewer', model: 'm', used, kind: 'review' })
const keptOf = (refs: Map<string, string>, id: string): Record<string, string> =>
  Object.fromEntries([...refs].filter(([n]) => n.startsWith(keptPrefix(id))).map(([n, o]) => [n.slice(keptPrefix(id).length), o]))

describe('A1: the trees flow keeps (R2 plan §4.3, spike P5)', () => {
  test('the active feature start and RED trees and its open round trees are needed; a sealed feature trees are not', () => {
    const r = activeRecord({ task: 'B4', feature: 'F-02', features: FEATURES, frozen: { baseSha: BASE, 'start:F-01': T1, 'red:F-01': T1, 'start:F-02': T2, 'red:F-02': T3 }, round: { f: 'F-02', tree: T3, prev: T2, tickets: [] } })
    expect(neededTrees(r)).toEqual({ start: T2, red: T3, round: T3, prev: T2 })
    expect(neededTrees({ ...r, round: { f: 'F-01', tree: T1, tickets: [] } })).toEqual({ start: T2, red: T3 })
  })

  test('without a base commit verify diffs from the first feature start, which stays needed', () => {
    const r = activeRecord({ phase: 'verify', task: 'V1', feature: undefined, features: FEATURES, frozen: { baseSha: 'none', 'start:F-01': T1 } })
    expect(neededTrees(r)).toEqual({ first: T1 })
    expect(neededTrees({ ...r, frozen: { ...r.frozen, baseSha: BASE } })).toEqual({})
    expect(neededTrees({ ...r, frozen: { ...r.frozen, scanBase: BASE } })).toEqual({})
  })

  test('one update-ref transaction (no deref) points the flow refs at the trees and deletes its other refs; other refs stay', async () => {
    const w = fakeHost({ refs: { [`${KEPT}round`]: T1, [`${KEPT}start`]: T2, 'refs/snagon/flow/ffffffff/start': T3, 'refs/heads/main': BASE } })
    const p = await gitPaths(w.host.io, ROOT)
    expect(await keepTrees(w.host.io, p, FLOW_ID, { start: T2, red: T3 })).toEqual([])
    expect(Object.fromEntries(w.refs)).toEqual({ [`${KEPT}start`]: T2, [`${KEPT}red`]: T3, 'refs/snagon/flow/ffffffff/start': T3, 'refs/heads/main': BASE })
    const writes = w.runs.filter(a => a.includes('update-ref'))
    expect(writes.length).toBe(1)
    expect(writes[0]).toContain('--no-deref')
    await keepTrees(w.host.io, p, FLOW_ID, { start: T2, red: T3 })
    expect(w.runs.filter(a => a.includes('update-ref')).length).toBe(1) // nothing to change: no write
  })

  test('a tree git no longer has is not kept and comes back lost; a commit needs no ref (it would show in git log --all)', async () => {
    const w = fakeHost()
    w.missing.add(T2)
    w.commits.add(BASE)
    expect(await keepTrees(w.host.io, await gitPaths(w.host.io, ROOT), FLOW_ID, { start: T2, red: T3, first: BASE })).toEqual(['start'])
    expect(Object.fromEntries(w.refs)).toEqual({ [`${KEPT}red`]: T3 })
  })

  test('a name, an object id or a flow id flow never writes throws before any git write', async () => {
    const w = fakeHost(), p = await gitPaths(w.host.io, ROOT)
    await expect(keepTrees(w.host.io, p, FLOW_ID, { 'start\nupdate refs/heads/main': T1 })).rejects.toThrow()
    await expect(keepTrees(w.host.io, p, FLOW_ID, { start: `${T1}\ndelete refs/heads/main` })).rejects.toThrow()
    await expect(keepTrees(w.host.io, p, '../heads', { start: T1 })).rejects.toThrow()
    await expect(dropTrees(w.host.io, p, 'a1b2c3d')).rejects.toThrow()
    expect(w.runs.some(a => a.includes('update-ref'))).toBe(false)
  })

  test('dropTrees deletes every ref of the flow in one transaction and leaves the rest', async () => {
    const w = fakeHost({ refs: { [`${KEPT}start`]: T1, [`${KEPT}round`]: T2, 'refs/snagon/flow/ffffffff/start': T3, 'refs/tags/v1': T3 } })
    await dropTrees(w.host.io, await gitPaths(w.host.io, ROOT), FLOW_ID)
    expect(Object.fromEntries(w.refs)).toEqual({ 'refs/snagon/flow/ffffffff/start': T3, 'refs/tags/v1': T3 })
    expect(w.runs.filter(a => a.includes('update-ref')).length).toBe(1)
  })
})

describe('AC-A1-2: a kept tree lost anyway re-anchors the scope', () => {
  test('a lost start becomes the base (never less is checked), a lost RED tree goes, the card names them', () => {
    const r = activeRecord({ task: 'B3', features: FEATURES, frozen: { baseSha: BASE, 'start:F-01': T1, 'red:F-01': T2 } })
    const x = reanchored(r, ['start', 'red'], BASE)
    expect([x.frozen['start:F-01'], x.frozen['red:F-01'], x.frozen['reverify:F-01'], x.task]).toEqual([BASE, undefined, 'start, red', 'B3'])
    expect([r.frozen['start:F-01'], r.frozen['red:F-01']]).toEqual([T1, T2]) // the given record is not changed
  })

  test('a lost round tree closes the round: its unstarted tickets close, its round is given back, the judge runs first', () => {
    const r: FlowRecord = activeRecord({ task: 'B4', features: FEATURES, counters: { k1: { e: 1, r: 2, d: 0, retried: false } }, frozen: { baseSha: BASE, 'start:F-01': T1 },
      round: { f: 'F-01', tree: T2, prev: T3, tickets: ['T-4', 'T-5'] }, tickets: [ticket('T-4', true), ticket('T-5', false)] })
    const x = reanchored(r, ['prev'], BASE)
    expect([x.round, x.task, x.counters.k1?.r, x.tickets.map(t => t.used), x.frozen['reverify:F-01'], x.frozen['start:F-01']]).toEqual([undefined, 'B3', 1, [true, true], 'prev', T1])
  })

  test('the first feature start lost in verify becomes the base (the empty tree without a base commit)', () => {
    const r = activeRecord({ phase: 'verify', task: 'V1', feature: undefined, features: FEATURES, frozen: { baseSha: 'none', 'start:F-01': T1 } })
    const x = reanchored(r, ['first'], '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    expect([x.frozen['start:F-01'], x.frozen['reverify:verify'], x.task]).toEqual(['4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'first', 'V1'])
  })
})

describe('A1 after review round 1', () => {
  const SEAL = { f: 'F-01', tree: T1, evalIds: [], tickets: 1, findings: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, followups: [] }

  test('the last seal tree is needed in verify and ship (the release echo diffs from it), not while building', () => {
    const r = activeRecord({ phase: 'verify', task: 'V1', feature: undefined, features: FEATURES, seals: [SEAL], frozen: { baseSha: BASE } })
    expect(neededTrees(r)).toEqual({ sealed: T1 })
    expect(neededTrees({ ...r, phase: 'ship', task: 'H0' })).toEqual({ sealed: T1 })
    expect(neededTrees({ ...r, phase: 'build', task: 'B1', feature: 'F-02' })).toEqual({})
  })

  test('the release echo lists from the base when the last seal tree was lost (more files, never fewer)', async () => {
    const w = fakeHost(), p = await gitPaths(w.host.io, ROOT)
    const r = activeRecord({ phase: 'ship', task: 'H0', feature: undefined, verifiedTree: T2, seals: [SEAL], frozen: { baseSha: BASE } })
    expect(await sealedFrom(w.host.io, p, r)).toEqual({ from: T1, lost: false })
    expect(await sealedFrom(w.host.io, p, { ...r, verifiedTree: T1 })).toBeNull()
    w.missing.add(T1)
    w.commits.add(BASE)
    expect(await sealedFrom(w.host.io, p, r)).toEqual({ from: BASE, lost: true })
  })

  test('object lookups and ref writes never fetch: GIT_NO_LAZY_FETCH on cat-file and update-ref', async () => {
    const w = fakeHost(), seen: Array<Record<string, string> | undefined> = []
    const io: Io = { ...w.host.io, run: async (argv, init) => { if (argv.includes('cat-file') || argv.includes('update-ref')) seen.push(init?.env); return w.host.io.run(argv, init) } }
    await keepTrees(io, await gitPaths(io, ROOT), FLOW_ID, { start: T1 })
    expect([seen.length, seen.every(e => e?.GIT_NO_LAZY_FETCH === '1')]).toEqual([2, true])
  })
})

describe('A1 after review round 2', () => {
  const SEAL = { f: 'F-01', tree: T1, evalIds: [], tickets: 1, findings: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, followups: [] }
  const LINK = `${ROOT}/.git/refs/snagon/flow/${FLOW_ID}`

  test('a lost last-seal tree is the release echo\'s to handle: flow_check does not re-anchor for it', async () => {
    const { w, d } = await toV1()
    const sealed = latest(w)?.seals.at(-1)?.tree ?? ''
    if (d.gitOut) d.gitOut[diffKey(BASE, FIX_TREE)] = d.gitOut[diffKey(BASE, AUTHOR_TREE)] ?? ''
    await run(w, 'flow-verify')
    w.refs.clear()
    w.missing.add(sealed)
    w.setTree(FIX_TREE)
    await flowCheck(w.host)
    expect(latest(w)?.frozen['reverify:verify']).toBeUndefined()
  })

  test('a kept-ref folder that is a symbolic link is refused before any ref is listed or written', async () => {
    const w = fakeHost({ links: { [LINK]: `${ROOT}/.git/refs/heads` }, refs: { 'refs/heads/main': T1 } }), p = await gitPaths(w.host.io, ROOT)
    await expect(keepTrees(w.host.io, p, FLOW_ID, { start: T1 })).rejects.toThrow('not a plain folder')
    await expect(dropTrees(w.host.io, p, FLOW_ID)).rejects.toThrow('not a plain folder')
    expect(w.runs.some(a => a.includes('update-ref') || a.includes('for-each-ref'))).toBe(false)
    expect(w.refs.get('refs/heads/main')).toBe(T1)
  })

  test('a ref listed below a kept name (a linked folder inside the prefix) is refused before any ref is written', async () => {
    const w = fakeHost({ refs: { [`${KEPT}x/main`]: T1, 'refs/heads/main': T1 } }), p = await gitPaths(w.host.io, ROOT)
    await expect(keepTrees(w.host.io, p, FLOW_ID, { start: T1 })).rejects.toThrow('is not a ref flow writes')
    await expect(dropTrees(w.host.io, p, FLOW_ID)).rejects.toThrow('is not a ref flow writes')
    expect([w.runs.some(a => a.includes('update-ref')), w.refs.get(`${KEPT}x/main`)]).toEqual([false, T1])
  })

  test('at the end, refs flow did not write (a linked folder) are reported to look at, never to delete one by one', async () => {
    const linked = fakeHost({ links: { [LINK]: `${ROOT}/.git/refs/heads` } }), odd = fakeHost({ refs: { [`${KEPT}x/main`]: T1 } })
    for (const w of [linked, odd]) {
      const text = (await endTrees(w.host, ROOT, FLOW_ID)) ?? ''
      expect([text.includes('refs/snagon'), text.includes('update-ref -d')]).toEqual([true, false])
    }
    expect(await endTrees(fakeHost({ refs: { [`${KEPT}start`]: T1 } }).host, ROOT, FLOW_ID)).toBeNull()
  })

  test('a kept-ref folder that turns into a link after the listing stops the write', async () => {
    let n = 0
    const w = fakeHost({ run: argv => (argv[0] === '/usr/bin/stat' && argv.at(-1) === LINK ? { exitCode: 0, stdout: n++ === 0 ? 'Directory\n' : 'Symbolic Link\n', stderr: '' } : undefined) })
    await expect(keepTrees(w.host.io, await gitPaths(w.host.io, ROOT), FLOW_ID, { start: T1 })).rejects.toThrow('not a plain folder')
    expect(w.runs.some(a => a.includes('update-ref'))).toBe(false)
  })

  test('a delta reply whose round tree git no longer has runs no diff and is not attested', async () => {
    const t: TicketRecord = { ...ticket('T-5', true), kind: 'delta', toolUseId: 'tu-5', agentId: 'ag-5' }
    const r = activeRecord({ task: 'B4', features: FEATURES, frozen: { baseSha: BASE, 'start:F-01': T1 }, round: { f: 'F-01', tree: T2, prev: T3, tickets: ['T-5'] }, tickets: [t] })
    const w = world({ files: recordFile(r) })
    w.missing.add(T3)
    await onReply(w.host, t, `NO-FINDINGS\nREVIEW-END ${t.nonce}`)
    expect([w.session().value?.runs['T-5']?.ok, w.runs.some(a => a.includes('diff'))]).toEqual([false, false])
  })

  test('a verified tree git no longer has: the release echo stops in fixed words before any diff', async () => {
    const w = fakeHost(), p = await gitPaths(w.host.io, ROOT)
    const r = activeRecord({ phase: 'ship', task: 'H0', feature: undefined, verifiedTree: T2, seals: [SEAL], frozen: { baseSha: BASE } })
    w.missing.add(T2)
    await expect(sealedFrom(w.host.io, p, r)).rejects.toThrow('run /flow-ship again')
  })

  test('the verified tree is kept with the last seal from verify through the release', () => {
    const r = activeRecord({ phase: 'ship', task: 'H0', feature: undefined, verifiedTree: T2, seals: [SEAL], frozen: { baseSha: BASE } })
    expect(neededTrees(r)).toEqual({ sealed: T1, verified: T2 })
  })
})

describe('NK-10: the refs frozen at S2', () => {
  test('refs that cannot be listed block couldNotRun in fixed words, never git text', async () => {
    const w = fakeHost({ run: argv => (argv.includes('for-each-ref') ? { exitCode: 128, stdout: '', stderr: 'INJECTED text' } : undefined) })
    const b = await refsBlock(w.host, activeRecord({ frozen: refsFrozen('') }))
    expect(b?.reason).toBe('couldNotRun')
    expect(b?.vars.detail).not.toContain('INJECTED')
  })

  test('a record frozen before 0.6.0 is not compared; more than ten refs end with …; a hash-only freeze says too many to list', async () => {
    const w = fakeHost({ refs: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`refs/tags/t${String(i).padStart(2, '0')}`, T1])) })
    expect(await refsBlock(w.host, activeRecord())).toBeNull()
    const named = await refsBlock(w.host, activeRecord({ frozen: refsFrozen('') }))
    expect(named?.vars.file).toContain('refs/tags/t09, …')
    expect(named?.vars.file).not.toContain('t10')
    expect((await refsBlock(w.host, activeRecord({ frozen: { refs: 'x' } })))?.vars.file).toContain('too many refs to list them')
  })

  test('every ref but the flow branch, the remote-tracking refs and this flow kept trees', async () => {
    const w = fakeHost({ refs: { 'refs/heads/main': T1, 'refs/heads/flow': T2, 'refs/remotes/origin/main': T1, 'refs/tags/v1': T3, [`${KEPT}start`]: T2, 'refs/snagon/flow/ffffffff/start': T3, 'refs/stash': T1 } })
    const text = await refsNow(w.host.io, await gitPaths(w.host.io, ROOT), 'flow', FLOW_ID)
    expect(text.split('\n')).toEqual([`${T1} refs/heads/main`, `${T3} refs/snagon/flow/ffffffff/start`, `${T1} refs/stash`, `${T3} refs/tags/v1`])
  })

  test('a moved, a new and a deleted ref are named; the same refs give null', () => {
    const was = [`${T1} refs/heads/main`, `${T3} refs/tags/v1`].join('\n'), frozen = refsFrozen(was)
    expect(refsChanged(frozen, was)).toBeNull()
    expect(refsChanged(frozen, [`${T2} refs/heads/main`, `${T1} refs/tags/v2`].join('\n'))).toEqual(['refs/heads/main', 'refs/tags/v1', 'refs/tags/v2'])
  })

  test('a list too long to keep in the record is frozen by its hash: a change is still found, unnamed', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `${T1} refs/tags/t${String(i).padStart(5, '0')}`).join('\n'), frozen = refsFrozen(big)
    expect(frozen['refs.list']).toBeUndefined()
    expect(refsChanged(frozen, big)).toBeNull()
    expect(refsChanged(frozen, `${big}\n${T2} refs/tags/new`)).toEqual([])
    expect(refsChanged({ ...refsFrozen('x'), 'refs.list': 'y' }, 'z')).toEqual([]) // a list that is not the frozen one names nothing
  })
})

describe('A1 and NK-10 in a flow', () => {
  test('AC-A1-1: the start, RED and review round trees are kept by refs while F-01 is built', async () => {
    const { w } = await atB3()
    expect(keptOf(w.refs, latest(w)?.flowId ?? '')).toEqual({ start: START, red: RED_TREE, round: AUTHOR_TREE })
  })

  test('AC-A1-2: kept refs deleted by hand and the trees pruned while the author works: F-01 is measured from the base, no git error, the card says why, no round counted', async () => {
    const plain = latest((await atB3()).w)
    const { w } = await atB3({ before: (d, x) => {
      if (d.gitOut) d.gitOut[diffKey(BASE, AUTHOR_TREE)] = d.gitOut[diffKey(START, AUTHOR_TREE)] ?? ''
      x.refs.clear()
      x.missing.add(START)
      x.missing.add(RED_TREE)
      x.commits.add(BASE)
    } })
    const r = latest(w)
    expect([r?.blocked, r?.task, r?.frozen['start:F-01'], r?.frozen['red:F-01'], r?.round?.tree, r?.counters]).toEqual([undefined, 'B4', BASE, undefined, AUTHOR_TREE, plain?.counters])
    expect(keptOf(w.refs, r?.flowId ?? '')).toEqual({ round: AUTHOR_TREE }) // the base is a commit: no ref
    const card = (await flowCard(w.host)) ?? ''
    expect(card).toContain('Trees flow kept for F-01 were deleted by hand (start, red)')
    expect(card).not.toContain('checked again') // a past fact, true for every lost tree (a lost RED tree re-checks nothing)
  })

  test('AC-A1-2: the review round tree lost during a fix: the judge runs at the current tree, then a full review; the lost round is given back', async () => {
    const { w, d } = await atB3()
    await agentRun(w, lastTicket(w)?.id ?? '', ended(HIGH))
    await flowCheck(w.host)
    const before = latest(w)
    expect(lastTicket(w)?.kind).toBe('fix')
    if (d.gitOut) d.gitOut[diffKey(START, FIX_TREE)] = d.gitOut[diffKey(START, AUTHOR_TREE)] ?? ''
    w.refs.clear()
    w.missing.add(AUTHOR_TREE) // the reviewed tree, pruned while the author fixes
    await agentRun(w, lastTicket(w)?.id ?? '', ended('Fixed.'), () => w.setTree(FIX_TREE))
    await flowCheck(w.host)
    const r = latest(w)
    expect([r?.blocked, r?.task, r?.round?.tree, r?.round?.prev, r?.counters, r?.frozen['reverify:F-01']]).toEqual([undefined, 'B4', FIX_TREE, undefined, before?.counters, 'round'])
    expect(r?.judge?.tree).toBe(FIX_TREE)
  })

  test('NK-10: a branch or tag moved outside the flow blocks the next flow_check with the refs named', async () => {
    const { w } = await atB3({ before: (_d, x) => { x.refs.set('refs/tags/v1', T1); x.refs.set('refs/heads/other', T2) } })
    const b = latest(w)?.blocked
    expect(b?.reason).toBe('tampered')
    expect(b?.vars.file).toContain('refs/heads/other, refs/tags/v1')
    expect(b?.vars.file).toContain('every ref but the flow branch, the remote-tracking refs and the flow\'s own is frozen')
  })

  test('NK-10: the flow branch, remote-tracking refs and the kept trees moving block nothing', async () => {
    const { w } = await atB3({ before: (_d, x) => { x.refs.set('refs/heads/main', T1); x.refs.set('refs/remotes/origin/main', T2) } })
    expect([latest(w)?.blocked, latest(w)?.task]).toEqual([undefined, 'B4'])
  })

  test('NK-10 at release: a tag moved after verify blocks /flow-ship', async () => {
    const { w } = await toH0()
    w.refs.set('refs/tags/v1', T1)
    await run(w, 'flow-ship')
    expect(latest(w)?.blocked?.vars.file).toContain('refs/tags/v1')
  })

  test('a tree the record no longer names loses its ref at the next flow_check (F-01 sealed: verify keeps only the last seal and verified trees)', async () => {
    const { w } = await toV1()
    const id = latest(w)?.flowId ?? ''
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    const r = latest(w)
    expect(keptOf(w.refs, id)).toEqual({ sealed: r?.seals.at(-1)?.tree ?? '', ...(r?.verifiedTree ? { verified: r.verifiedTree } : {}) })
  })

  test('integrity first: a changed repository config blocks before any git add or re-anchor', async () => {
    let mark = 0
    const { w } = await atB3({ before: (_d, x) => {
      x.files.set(`${ROOT}/.git/config`, '[filter "x"]\n\tclean = x\n')
      x.refs.clear()
      x.missing.add(START)
      mark = x.runs.length
    } })
    const r = latest(w)
    expect([r?.blocked?.reason, r?.frozen['start:F-01']]).toEqual(['tampered', START])
    expect(w.runs.slice(mark).some(a => a.includes('add') && a.includes('-A'))).toBe(false)
  })

  test('AC-A1-2: after a lost RED tree the review ticket says so instead of an empty RED diff', async () => {
    const { w } = await atB3({ before: (_d, x) => { x.refs.clear(); x.missing.add(RED_TREE) } })
    const t = lastTicket(w)
    expect([t?.kind, latest(w)?.frozen['red:F-01']]).toEqual(['review', undefined])
    expect(w.session().value?.tickets[t?.id ?? ''] ?? '').toContain('The RED tree was deleted after RED.')
  })

  test('a delta reply whose round trees are gone is not attested and throws no git error', async () => {
    const t: TicketRecord = { ...ticket('T-5', true), kind: 'delta', toolUseId: 'tu-5', agentId: 'ag-5' }
    const r = activeRecord({ task: 'B4', features: FEATURES, frozen: { baseSha: BASE, 'start:F-01': T1 }, round: { f: 'F-01', tree: T2, prev: T3, tickets: ['T-5'] }, tickets: [t] })
    const w = world({ files: recordFile(r) }) // world(): no flow cached by an earlier test
    await onReply(w.host, t, `NO-FINDINGS\nREVIEW-END ${t.nonce}`)
    expect(w.session().value?.runs['T-5']?.ok).toBe(false)
  })

  test('a re-freeze (/flow-setup) replaces both refs keys: a list now too long to keep leaves only its hash', async () => {
    const { w } = await atB3()
    const was = latest(w)?.frozen
    for (let i = 0; i < 600; i += 1) w.refs.set(`refs/tags/t${String(i).padStart(4, '0')}`, T1)
    await approved(w)
    const f = latest(w)?.frozen ?? {}
    expect([was?.['refs.list'], f.refs !== was?.refs, f['refs.list']]).toEqual(['', true, undefined])
  })

  test('a keep that fails right after a ticket is issued keeps the ticket and its text, and the failure is not swallowed', async () => {
    let fail = false
    const w = world({ gitOut: { ...HEAD }, judge: { test: { exit: 0, report: GREEN_REPORT } }, run: argv => (fail && argv.includes('update-ref') ? { exitCode: 128, stdout: '', stderr: 'fatal: cannot lock ref' } : undefined) })
    await toB1(w)
    fail = true
    const out = await run(w, 'flow-build').then(x => x.text, (err: unknown) => String(err))
    const t = lastTicket(w)
    expect([t?.kind, w.session().value?.tickets[t?.id ?? ''] !== undefined]).toEqual(['red', true])
    expect(out).toContain('update-ref')
  })

  test('the verified and last-seal trees are kept from the end of verify, before /flow-ship', async () => {
    const { w } = await toH0()
    const r = latest(w)
    expect(keptOf(w.refs, r?.flowId ?? '')).toEqual({ sealed: r?.seals.at(-1)?.tree ?? '', verified: r?.verifiedTree ?? '' })
  })

  test('/flow-off of a flow whose record cannot be read says where its kept refs may be, as its repository is unknown', async () => {
    const w = world({ files: { [`${HOME}/.snagon/flow/deadbeef.v1.json`]: '{ not json' } })
    const out = (await run(w, 'flow-off deadbeef')).text
    expect([out.includes('refs/snagon/flow/deadbeef/'), w.runs.some(a => a.includes('update-ref'))]).toEqual([true, false])
  })

  test('/flow-off deletes the kept refs in one transaction after the end marker; other refs stay', async () => {
    const { w } = await atB3()
    const id = latest(w)?.flowId ?? ''
    w.refs.set('refs/tags/v1', T1)
    await run(w, `flow-off ${id}`)
    expect(keptOf(w.refs, id)).toEqual({})
    expect(w.refs.get('refs/tags/v1')).toBe(T1)
  })
})
