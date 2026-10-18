import { describe, expect, test } from 'claude-code/testing'
import {
  parseOwner, originOk, echoHash, makeEcho, canonical, showEcho, approve, dropEcho, rotateCode, paneCode, takeCode, paneLines, refusalText, shownText,
  ECHO_PANE, type Echo, type EchoContent, type Pending, type ApproveCmd, type ApproveCtx,
} from '../hooks/flow-owner'
import { addressFor } from '../flow/data/templates'

const FIELDS = { argv: { test: ['npm', 'test'] }, caps: { e: 3, r: 3, d: 4 } }
const content = (kind: Echo['kind'], fields: unknown = FIELDS, files: Record<string, string> = { 'package.json': 'aa' }): EchoContent => ({ kind, title: `t ${kind}`, lines: ['line 1'], fields, files })
const echoOf = (kind: Echo['kind'], fields?: unknown, files?: Record<string, string>): Promise<Echo> => makeEcho(content(kind, fields, files))
type Ui = { opened: string[]; placed: boolean; open(p: { id: string; title: string; focus: true }): Promise<{ isPlaced: boolean }> }
const ui = (placed = true): Ui => ({ opened: [], placed, async open(p) { this.opened.push(`${p.id}|${p.title}|${String(p.focus)}`); return { isPlaced: this.placed } } })
/** The approval context with the echo rebuilt from the given content (the current draft). */
const ctxOf = (pending: Pending, now: EchoContent | undefined, over: Partial<ApproveCtx> = {}): ApproveCtx => ({ origin: { kind: 'composer' }, pending, at: 5, recompute: async () => (now ? echoHash(now) : undefined), ...over })

describe('owner commands: parsing and origin', () => {
  test('each command parses to its fields; anything else is a usage error', () => {
    expect(parseOwner('flow-approve', 'plan 0a1b2c3d')).toEqual({ name: 'flow-approve', kind: 'plan', hash8: '0a1b2c3d' })
    expect(parseOwner('flow-approve', 'release 0a1b2c3d k7p2qx')).toEqual({ name: 'flow-approve', kind: 'release', hash8: '0a1b2c3d', code: 'K7P2QX' })
    expect(parseOwner('flow-decide', 'R-3 followup')).toEqual({ name: 'flow-decide', id: 'R-3', choice: 'followup' })
    expect(parseOwner('flow-retry', 'F-02')).toEqual({ name: 'flow-retry', scope: 'F-02' })
    expect(parseOwner('flow-waive', 'check:lint  the old warnings are known ')).toEqual({ name: 'flow-waive', target: 'check:lint', reason: 'the old warnings are known' })
    expect(parseOwner('flow-reject', 'plan')).toEqual({ name: 'flow-reject', what: 'plan' })
    expect(parseOwner('flow-setup', 'test="npx vitest run" tools=+WebFetch mcp=+mcp__github__search_code mcp=+mcp__context7__query-docs')).toEqual({ name: 'flow-setup', overrides: { test: 'npx vitest run' }, tools: ['WebFetch'], mcp: ['mcp__github__search_code', 'mcp__context7__query-docs'] })
    expect(parseOwner('flow-ship', '')).toEqual({ name: 'flow-ship' })
    const bad: Array<[string, string]> = [
      ['flow-approve', 'release 0a1b2c3d'], ['flow-approve', 'plan 0A1B2C3D'], ['flow-approve', 'plan 0a1b2c3'], ['flow-approve', 'all 0a1b2c3d'], ['flow-approve', 'plan 0a1b2c3d extra'],
      ['flow-approve', 'release 0a1b2c3d K7P2Q'], ['flow-decide', 'R-3 maybe'], ['flow-retry', 'everything'], ['flow-waive', 'FL-2'], ['flow-waive', 'rm -rf it'],
      ['flow-reject', 'setup'], ['flow-ship', 'now'], ['flow-setup', 'deploy=rm'], ['flow-setup', 'tools=WebFetch'], ['flow-nope', ''],
      ['flow-setup', 'mcp=+github'], ['flow-setup', 'mcp=+mcp__github'], ['flow-setup', 'mcp=+mcp____x'], // NK-06: the guard matches full tool names only
    ]
    for (const [c, a] of bad) expect([c, a, 'error' in parseOwner(c, a)]).toEqual([c, a, true])
  })

  test('only the owner at the prompt or over the bridge runs owner commands; a release approval needs the prompt', () => {
    const plan = { name: 'flow-approve', kind: 'plan', hash8: '0a1b2c3d' } as const
    const release = { name: 'flow-approve', kind: 'release', hash8: '0a1b2c3d', code: 'K7P2QX' } as const
    expect([originOk(plan, { kind: 'composer' }), originOk(plan, { kind: 'bridge' }), originOk(release, { kind: 'composer' }), originOk(release, { kind: 'bridge' })]).toEqual([true, true, true, false])
    for (const kind of ['sdk', 'peer', 'peer-send-message', 'scheduled-trigger', 'task-notification', 'plugin', 'unclassified', 'auto-continuation', 'channel', 'coordinator', 'observer', 'projects-relay'])
      expect([kind, originOk({ name: 'flow-off' }, { kind }), originOk(plan, { kind })]).toEqual([kind, false, false])
  })
})

describe('owner commands: echoes bound to what the pane showed', () => {
  test('the echo hash covers the kind, the title and lines shown, the fields in any key order and every named file hash', async () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
    expect(canonical(Object.assign(Object.create(null) as object, { a: 1 }))).toBe('{"a":1}')
    // Values that would collapse into one string are refused, not hashed.
    for (const v of [new Set(['WebFetch']), new Map(), new Date(0), { a: undefined }, [undefined], NaN, Infinity, () => 1, BigInt(1), new (class X {})()]) expect(() => canonical({ v })).toThrow()
    const base = content('setup'), h = await echoHash(base)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(await echoHash({ ...base, fields: { caps: FIELDS.caps, argv: FIELDS.argv } })).toBe(h)
    const others = [{ ...base, kind: 'plan' as const }, { ...base, fields: { ...FIELDS, caps: { e: 4, r: 3, d: 4 } } }, { ...base, files: { 'package.json': 'ab' } }, { ...base, files: {} }, { ...base, title: 'other' }, { ...base, lines: ['line 1', 'script: rm -rf /'] }]
    for (const other of others) expect(await echoHash(other)).not.toBe(h)
    expect((await makeEcho(base)).hash).toBe(h)
    // Hidden characters in agent-written text show as visible escapes, and the hash covers what is drawn.
    const tricky = await makeEcho({ ...base, title: 'Release\u202E', lines: ['fix: tidy \x1b[8mrm -rf /\x1b[0m', 'ok\u2066x\u2069'] })
    expect([tricky.title, ...tricky.lines]).toEqual(['Release\\u{202e}', 'fix: tidy \\u{1b}[8mrm -rf /\\u{1b}[0m', 'ok\\u{2066}x\\u{2069}'])
    // The hash covers the drawn form: a raw escape and its visible spelling draw alike and hash alike.
    expect(await echoHash({ ...base, lines: ['\x1b'] })).toBe(await echoHash({ ...base, lines: ['\\u{1b}'] }))
    expect(tricky.hash).toBe(await echoHash({ ...base, title: 'Release\u202E', lines: ['fix: tidy \x1b[8mrm -rf /\x1b[0m', 'ok\u2066x\u2069'] }))
  })

  test('an echo is bound only when an owner command opened it in a focused pane that a surface draws', async () => {
    const e = await echoOf('setup'), u = ui()
    const shown = await showEcho(u, {}, e, { kind: 'composer' })
    expect([shown.shown, shown.pending.setup?.hash, u.opened]).toEqual([true, e.hash, [`${ECHO_PANE}|t setup|true`]])
    // isPlaced false: nothing is bound, and an older echo of that kind is dropped.
    const narrow = await showEcho(ui(false), shown.pending, await echoOf('setup', { other: 1 }), { kind: 'composer' })
    expect([narrow.shown, narrow.pending.setup]).toEqual([false, undefined])
    // flow_check, flow_status and any non-owner path never bind or rebind, and open no pane.
    for (const kind of ['tool', 'sdk', 'peer', 'plugin']) {
      const u2 = ui(), out = await showEcho(u2, shown.pending, await echoOf('setup', { other: 2 }), { kind })
      expect([kind, out.shown, out.pending.setup?.hash, u2.opened.length]).toEqual([kind, false, e.hash, 0])
    }
  })

  test('approval: origin, then a bound echo, then the typed hash8, then the echo rebuilt from the current draft; an approved echo is spent', async () => {
    const now = content('plan'), e = await makeEcho(now), pending: Pending = { plan: e, setup: await echoOf('setup') }, hash8 = e.hash.slice(0, 8)
    const cmd: ApproveCmd = { name: 'flow-approve', kind: 'plan', hash8 }
    const ok = await approve(cmd, ctxOf(pending, now))
    expect(ok).toEqual({ ok: true, approval: { kind: 'plan', echoHash: e.hash, at: 5, origin: 'composer' } })
    expect((await approve(cmd, ctxOf(dropEcho(pending, 'plan'), now))).ok).toBe(false)
    const no = async (c: ApproveCmd, o: Partial<ApproveCtx>, cur: EchoContent | undefined = now) => { const r = await approve(c, ctxOf(pending, cur, o)); return r.ok ? 'ok' : r.refuse }
    expect(await no(cmd, { origin: { kind: 'sdk' } })).toBe('origin')
    expect(await no(cmd, { pending: {} })).toBe('noEcho')
    expect(await no({ ...cmd, hash8: hash8 === '00000000' ? '11111111' : '00000000' }, {})).toBe('hash')
    expect(await no(cmd, {}, { ...now, fields: { changed: true } })).toBe('hash')
    expect(await no(cmd, {}, { ...now, lines: ['line 1', 'one more line'] })).toBe('hash')
    expect((await approve(cmd, ctxOf(pending, undefined))).ok).toBe(false)
    expect(await no({ ...cmd, kind: 'setup' }, {})).toBe('hash')
    expect(await no({ ...cmd, kind: 'baseline' }, {})).toBe('noEcho')
    expect(dropEcho(pending, 'setup')).toEqual({ plan: e })
  })
})

describe('owner commands: the release code', () => {
  test('the code lives in a module variable, works once, and any attempt rotates it', async () => {
    rotateCode()
    const code = paneCode() ?? ''
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(takeCode(code)).toBe(true)
    expect([paneCode(), takeCode(code)]).toEqual([null, false])
    rotateCode()
    const second = paneCode() ?? ''
    expect([takeCode('WRONG1'), takeCode(second)]).toEqual([false, false])
    rotateCode()
    expect(takeCode((paneCode() ?? '').toLowerCase())).toBe(true)
    const codes = new Set(Array.from({ length: 20 }, () => { rotateCode(); return paneCode() }))
    expect(codes.size).toBeGreaterThan(15)
  })

  test('a release approval needs the prompt, the echo and the code; the code is spent even when something else fails', async () => {
    const now = content('release'), e = await makeEcho(now), pending: Pending = { release: e }, hash8 = e.hash.slice(0, 8)
    rotateCode()
    const code = paneCode() ?? ''
    expect(await approve({ name: 'flow-approve', kind: 'release', hash8, code }, ctxOf(pending, now, { origin: { kind: 'bridge' } }))).toEqual({ ok: false, refuse: 'originRelease' })
    expect(await approve({ name: 'flow-approve', kind: 'release', hash8, code }, ctxOf(pending, now))).toEqual({ ok: false, refuse: 'code' })
    rotateCode()
    const fresh = paneCode() ?? ''
    expect((await approve({ name: 'flow-approve', kind: 'release', hash8, code: fresh }, ctxOf(pending, now))).ok).toBe(true)
    expect(await approve({ name: 'flow-approve', kind: 'release', hash8, code: fresh }, ctxOf(pending, now, { at: 2 }))).toEqual({ ok: false, refuse: 'code' })
    rotateCode()
    expect(await approve({ name: 'flow-approve', kind: 'release', hash8, code: paneCode() ?? '' }, ctxOf(pending, { ...now, lines: ['another rev'] }))).toEqual({ ok: false, refuse: 'hash' })
    expect(paneCode()).toBeNull()
  })

  test('the code shows only in the pane: never in the echo held in state, the pane request, the transcript text or a refusal', async () => {
    const e = await echoOf('release'), u = ui()
    rotateCode()
    const code = paneCode() ?? ''
    const out = await showEcho(u, {}, e, { kind: 'composer' })
    const lines = paneLines('en', 'the project owner', e, paneCode())
    expect(lines.join('\n')).toContain(code)
    expect(lines.at(-1)).toBe(`Approve by typing: /flow-approve release ${e.hash.slice(0, 8)} ${code}`)
    const leaks = [...u.opened, ...(out.pending.release?.lines ?? []), out.pending.release?.title ?? '', shownText('en', 'the project owner', out.shown), refusalText('en', 'the project owner', 'code', 'release')]
    for (const text of leaks) expect([text, text.includes(code)]).toEqual([text, false])
  })
})

describe('owner commands: texts in config.language with config.address', () => {
  test('pane and refusal texts use the configured address, else the fallback, in the configured language', async () => {
    expect([addressFor('vi', 'Anh Phát'), addressFor('vi', '  '), addressFor('en', undefined)]).toEqual(['Anh Phát', 'Chủ dự án', 'the project owner'])
    const e = await echoOf('plan')
    expect(paneLines('vi', 'Anh Phát', { ...e, title: 'Kế hoạch chờ Anh Phát duyệt' }, null).at(-1)).toBe(`Duyệt bằng cách gõ: /flow-approve plan ${e.hash.slice(0, 8)}`)
    expect(refusalText('vi', 'Anh Phát', 'origin', 'plan')).toBe('Lệnh duyệt chỉ có hiệu lực khi Anh Phát tự gõ ở dòng lệnh hoặc qua Remote Control.')
    expect(refusalText('vi', 'Anh Phát', 'originRelease', 'release')).toBe('Lệnh duyệt phát hành chỉ có hiệu lực khi Anh Phát tự gõ ở dòng lệnh.')
    expect(refusalText('vi', 'Anh Phát', 'hash', 'plan')).toBe('Nội dung đã đổi sau khi hiển thị. Chạy lại /flow-plan để xem bản hiện tại.')
    expect(refusalText('en', 'the project owner', 'noEcho', 'release')).toBe('Nothing is waiting for this approval. Run /flow-ship first.')
    expect(refusalText('vi', 'Anh Phát', 'originCommand', 'plan')).toBe('Lệnh flow chỉ có hiệu lực khi Anh Phát tự gõ ở dòng lệnh hoặc qua Remote Control.')
    expect(refusalText('en', 'the project owner', 'hash', 'baseline')).toBe('This changed after it was shown. Run /flow-status again to see the current version.')
    expect(shownText('vi', 'Anh Phát', true)).toBe('Đã hiện trong bảng flow để Anh Phát kiểm tra.')
    expect(shownText('vi', 'Anh Phát', false)).toBe('Đang bị chặn, CHƯA xong: không mở được bảng hiển thị ở đây; hãy mở terminal hoặc ứng dụng desktop')
  })
})
