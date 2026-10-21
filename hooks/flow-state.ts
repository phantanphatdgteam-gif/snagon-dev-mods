// The flow record (plan v7.1 §2.4; write protocol revised at step 2 review): one file per version,
// ~/.snagon/flow/<id8>.v<N>.json, outside the project, so the agent's Edit tools, the Bash sandbox and the judge profile
// cannot write it. A write is a compare-and-swap: the next version goes to an unpredictable temp file that is then
// hard-linked to its final name, and link(2) fails when that version exists, so the loser reloads and re-applies. Old
// versions are emptied in place, never deleted, so a version name stays taken for the life of the flow and a link that
// succeeds always won. Only the end of a flow frees names; its marker `<id8>.end` (kept for good) makes a writer racing
// the end withdraw. There is no lock to go stale and nothing a crash leaves held. The record holds hashes, counters and
// small records, never ticket text.
import { hashOf, type Io } from './session'
import type { CapScope, Caps, Phase, Severity } from '../flow/data/types'

export type Lifecycle = 'active' | 'done' | 'off'
export type FlowLock = { sessionId: string; root: string; branch: string; heartbeatAt: number }
export type LockHolder = Omit<FlowLock, 'heartbeatAt'>
export type Approval = { kind: 'setup' | 'baseline' | 'plan' | 'release' | 'waive' | 'allow'; echoHash: string; at: number; origin: string }
export type Counters = { e: number; r: number; d: number; retried: boolean }
/** sig: the hash of the text of the line `loc` names, when the scan had it (a finding follows its line when lines move). */
export type FindingDigest = { id: string; f: string; rubricId: string; sev: Severity; loc: string; status: string; sig?: string }
/** review and delta tickets judge a fixed tree; red, author, fix and debug tickets change it by design. */
export type TicketKind = 'review' | 'delta' | 'fix' | 'debug' | 'red' | 'author'
export type TicketRecord = { id: string; f: string; sha: string; nonce: string; tree: string; routedType: string; model: string; used: boolean; kind?: TicketKind; toolUseId?: string; agentId?: string; attested?: boolean }
export type Seal = { f: string; tree: string; evalIds: string[]; tickets: number; findings: Record<Severity, number>; followups: string[] }
/** The blocked reason the card shows and its owner exits (flow.ts BLOCKED_EXITS), with the values its text names. */
export type Blocked = { reason: string; vars: Record<string, string> }
export type FlowCommand = { id: string; argv: string[]; runner: string; mode: 'must-pass' | 'no-new-failures' }
/** What the owner approved at S2 (§2.2, §6 "Frozen at S2"): the commands, the allow-lists, the journal folder, the remote
 * and branch a release pushes to, and the round caps. */
export type FlowSetup = {
  stack: string; commands: FlowCommand[]; allowTools: string[]; allowMcp: string[]; journalDir: string
  remote: string; branch: string; pluginProject: boolean; caps: Record<CapScope, Caps>
  /** Older setups only; not read any more (no cost cap since 2026-10-20). */
  sessionCap?: number
}
/** Each approved feature (P3): its key (counters, carried across re-plans) and Files, which red scope and packs read
 * without parsing the plan again. */
export type FeatureFiles = { id: string; key: string; files: string[] }
/** The last judge run: its tree, whether it passed, and the task (and feature) it judged. */
export type JudgeMark = { tree: string; green: boolean; task: string; f?: string; at: number }
export type FlowRecord = {
  version: number; flowId: string; repoKey: string; root: string; branch: string; lifecycle: Lifecycle; phase: Phase; task: string
  lock: FlowLock | null
  approvals: Approval[]; frozen: Record<string, string>; counters: Record<string, Counters>
  findings: FindingDigest[]; tickets: TicketRecord[]; seals: Seal[]
  redTestHash: Record<string, string>; verifiedTree?: string; verifyMdHash?: string; releaseTree?: string
  feature?: string; blocked?: Blocked; setup?: FlowSetup; features?: FeatureFiles[]; judge?: JudgeMark
  /** The owner command the flow waits for (flow.ts afterPass). */
  awaiting?: string
  /** `flowCap`: older records only, not read any more (no cost cap since 2026-10-20); `spent`: what the flow's turns have spent so far. */
  flowCap?: number; spent?: number
  /** The number of the last ticket issued in this flow: ids count on past the tickets a seal dropped, so one never comes
   * round again (dry run 16, D12). Absent in older records, which count the tickets they hold. */
  ticketSeq?: number
  /** Spend by phase and by phase/feature, in USD (with `spent`, the total, added at each heartbeat write). */
  spendBy?: Record<string, number>
  /** How many self-caused blocks (SELF_CAUSED) the flow had; verify.md and the release echo show it. */
  selfBlocks?: number
  /** Each feature's ASSUMPTIONS block from its last author run, parsed and redacted (the reply is not kept). */
  assumptions?: Record<string, string[]>
  /** The open review round of the active feature: its tree, the tree of the round before (a delta round), its tickets. */
  round?: ReviewRound
  /** The active feature's FIX map: finding id → the line ranges its fix may change. */
  fixMap?: Record<string, string[]>
  /** The highest number a finding id has had, per prefix (FL, J, CR, SR): a seal drops closed findings, their numbers
   * stay used, so an id never names two findings (the session keeps reviewers' words and disputes by id). */
  lastIds?: Record<string, number>
  /** `/flow-allow red`: the owner let one debug ticket of `feature` edit its RED test file(s); `used` once that ticket is issued. */
  redAllow?: RedAllow
}
/** `ticket`: the debug ticket that carries it (a re-issue after a restart carries it again). */
export type RedAllow = { feature: string; reason: string; at: number; used: boolean; ticket?: string }
/** `corrected`: this round had its one scope correction (§4.5); the next fix-scope finding blocks for the owner. */
export type ReviewRound = { f: string; tree: string; prev?: string; tickets: string[]; corrected?: boolean }
/** Every failure is a reason the caller turns into `blocked: could not run (record)`; none is silently passed. */
export type RecordFailure = 'conflict' | 'invalid' | 'too-large' | 'io' | 'missing' | 'rejected' | 'rollback' | 'ended'
export type UpdateResult = { ok: true; record: FlowRecord; staleRead: boolean } | { ok: false; reason: RecordFailure; detail?: string }

export const LOCK_STALE_MS = 12 * 60_000 // a flow lock without a heartbeat for this long may be taken by another session
export const HEARTBEAT_PERSIST_MS = 5 * 60_000 // the heartbeat lives in $.state; it is written to the record at most this often
export const RECORD_LIMIT = 256 * 1024 // characters of JSON; seals compact tickets and findings long before this
export const WRITE_ATTEMPTS = 3 // a lost compare-and-swap reloads and re-applies; three losses in a row give `conflict`
export const KEEP_VERSIONS = 2 // after a write, versions older than the newest two are emptied (the names stay)
export const TEMP_STALE_MS = 60_000 // a temp file this old was left by a writer that crashed
export const MAX_VERSION = 999_999_999 // nine digits, the most a version file name holds
const RM_BATCH = 500 // paths per /bin/rm, far below the argument length limit

const ID8 = /^[0-9a-f]{8}$/
const VERSION_FILE = /^([0-9a-f]{8})\.v([1-9]\d{0,8})\.json$/
const END_FILE = /^([0-9a-f]{8})\.end$/
const LIFECYCLES: readonly string[] = ['active', 'done', 'off']
const APPROVALS = new Set(['setup', 'baseline', 'plan', 'release', 'waive', 'allow'])
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
export const CLOSED: ReadonlySet<string> = new Set(['resolved', 'accepted-follow-up', 'dropped', 'owner-rejected', 'withdrawn', 'waived'])
const TICKET_KEYS = new Set(['id', 'f', 'sha', 'nonce', 'tree', 'routedType', 'model', 'used', 'kind', 'toolUseId', 'agentId', 'attested'])
const TICKET_KINDS = new Set(['review', 'delta', 'fix', 'debug', 'red', 'author'])
const RECORD_KEYS = new Set(['version', 'flowId', 'repoKey', 'root', 'branch', 'lifecycle', 'phase', 'task', 'lock', 'approvals', 'frozen', 'counters', 'findings', 'tickets', 'seals', 'redTestHash', 'verifiedTree', 'verifyMdHash', 'releaseTree', 'feature', 'blocked', 'setup', 'features', 'judge', 'awaiting', 'flowCap', 'spent', 'round', 'fixMap', 'lastIds', 'selfBlocks', 'assumptions', 'spendBy', 'ticketSeq', 'redAllow'])
const SCOPES: readonly CapScope[] = ['plan', 'feature', 'verify']
const MODES = new Set(['must-pass', 'no-new-failures'])

const id8 = (flowId: string): string => { if (!ID8.test(flowId)) throw new Error(`flow record: bad flow id ${JSON.stringify(flowId)}`); return flowId }
export const flowDir = (home: string): string => `${home}/.snagon/flow`
export function versionPath(home: string, flowId: string, version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw new Error(`flow record: bad version ${version}`)
  return `${flowDir(home)}/${id8(flowId)}.v${version}.json`
}
/** The key of a repository: its common git dir, so linked worktrees share one flow. */
export const repoKeyOf = (gitCommonDirRealpath: string): string => hashOf(gitCommonDirRealpath).slice(0, 8)
/** `entropy` comes from the caller's random source (`openssl rand -hex 8`); the id only has to be new, not secret. */
export const newFlowId = (entropy: string): string => hashOf(`flow:${entropy}`).slice(0, 8)
const endPath = (home: string, flowId: string): string => `${flowDir(home)}/${id8(flowId)}.end`
const tempToken = (sessionId: string, now: number): string => hashOf(`${sessionId}:${now}:${Math.random()}`)

export function newRecord(o: { flowId: string; repoKey: string; root: string; branch: string; sessionId: string; now: number }): FlowRecord {
  return {
    version: 1, flowId: o.flowId, repoKey: o.repoKey, root: o.root, branch: o.branch, lifecycle: 'active', phase: 'setup', task: 'S1',
    lock: { sessionId: o.sessionId, root: o.root, branch: o.branch, heartbeatAt: o.now },
    approvals: [], frozen: {}, counters: {}, findings: [], tickets: [], seals: [], redTestHash: {},
  }
}

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): boolean => typeof v === 'string'
const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0
const each = (v: unknown, ok: (x: Obj) => boolean): boolean => Array.isArray(v) && v.every(x => isObject(x) && ok(x))
const values = (v: unknown, ok: (x: unknown) => boolean): boolean => isObject(v) && Object.values(v).every(ok)
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(str)
const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v)
const caps = (v: unknown): boolean => isObject(v) && SCOPES.every(s => { const c = v[s]; return isObject(c) && count(c.e) && count(c.r) && count(c.d) })
const setupOk = (s: unknown): boolean => isObject(s) && str(s.stack) && each(s.commands, c => str(c.id) && strings(c.argv) && str(c.runner) && MODES.has(c.mode as string))
  && strings(s.allowTools) && strings(s.allowMcp) && [s.journalDir, s.remote, s.branch].every(str) && typeof s.pluginProject === 'boolean' && caps(s.caps) && optional(s.sessionCap, num)
const CHECKS: ReadonlyArray<readonly [string, (r: Obj) => boolean]> = [
  ['keys', r => Object.keys(r).every(k => RECORD_KEYS.has(k))],
  ['version', r => Number.isInteger(r.version) && (r.version as number) >= 1 && (r.version as number) <= MAX_VERSION],
  ['ids', r => str(r.flowId) && ID8.test(r.flowId as string) && str(r.repoKey) && ID8.test(r.repoKey as string)],
  ['identity', r => [r.root, r.branch, r.phase, r.task].every(str) && LIFECYCLES.includes(r.lifecycle as string)],
  ['lock', r => r.lock === null || (isObject(r.lock) && [r.lock.sessionId, r.lock.root, r.lock.branch].every(str) && num(r.lock.heartbeatAt))],
  ['approvals', r => each(r.approvals, a => APPROVALS.has(a.kind as string) && str(a.echoHash) && num(a.at) && str(a.origin))],
  ['hashes', r => values(r.frozen, str) && values(r.redTestHash, str) && [r.verifiedTree, r.verifyMdHash, r.releaseTree].every(v => v === undefined || str(v))],
  ['counters', r => values(r.counters, c => isObject(c) && count(c.e) && count(c.r) && count(c.d) && typeof c.retried === 'boolean')],
  ['findings', r => each(r.findings, f => [f.id, f.f, f.rubricId, f.loc, f.status].every(str) && SEVERITIES.has(f.sev as string) && optional(f.sig, str))],
  ['tickets (ticket text is never stored)', r => each(r.tickets, t => Object.keys(t).every(k => TICKET_KEYS.has(k)) && [t.id, t.f, t.sha, t.nonce, t.tree, t.routedType, t.model].every(str) && typeof t.used === 'boolean' && (t.attested === undefined || typeof t.attested === 'boolean') && (t.kind === undefined || (typeof t.kind === 'string' && TICKET_KINDS.has(t.kind))))],
  ['seals', r => each(r.seals, s => str(s.f) && str(s.tree) && count(s.tickets) && Array.isArray(s.evalIds) && Array.isArray(s.followups) && values(s.findings, count))],
  ['feature', r => optional(r.feature, str)],
  ['blocked', r => optional(r.blocked, b => isObject(b) && str(b.reason) && values(b.vars, str))],
  ['setup', r => optional(r.setup, setupOk)],
  ['features', r => optional(r.features, fs => each(fs, f => str(f.id) && str(f.key) && strings(f.files)))],
  ['judge', r => optional(r.judge, j => isObject(j) && str(j.tree) && typeof j.green === 'boolean' && str(j.task) && optional(j.f, str) && num(j.at))],
  ['awaiting', r => optional(r.awaiting, str)],
  ['cost', r => optional(r.flowCap, num) && optional(r.spent, num)],
  ['ticketSeq', r => optional(r.ticketSeq, count)],
  ['round', r => optional(r.round, x => isObject(x) && str(x.f) && str(x.tree) && optional(x.prev, str) && strings(x.tickets) && optional(x.corrected, b => typeof b === 'boolean'))],
  ['fixMap', r => optional(r.fixMap, m => values(m, strings))],
  ['lastIds', r => optional(r.lastIds, m => values(m, count))],
  ['selfBlocks', r => optional(r.selfBlocks, count)],
  ['spendBy', r => optional(r.spendBy, m => values(m, num))],
  ['assumptions', r => optional(r.assumptions, a => values(a, strings))],
  ['redAllow', r => optional(r.redAllow, a => isObject(a) && str(a.feature) && str(a.reason) && num(a.at) && typeof a.used === 'boolean' && optional(a.ticket, str))],
]

/** Blocks the agent's own work can cause (plan §3.2): verify.md counts them. An owner edit of the same files counts
 * too, as the mod cannot tell who changed a file. */
export const SELF_CAUSED: ReadonlySet<string> = new Set(['floor', 'junk', 'injection', 'redTestChanged', 'cmdSrc', 'tampered', 'frozenChanged', 'reportChanged'])
/** The record blocked for the owner, a self-caused block counted. */
export const withBlock = (r: FlowRecord, blocked: Blocked): FlowRecord => ({ ...r, blocked, ...(SELF_CAUSED.has(blocked.reason) ? { selfBlocks: (r.selfBlocks ?? 0) + 1 } : {}) })

/** Reads a record; anything that is not a well-formed record throws, naming the first check that failed. */
/** The highest number given per finding-id prefix: the floor kept in the record and the ids still in it. */
export function usedIds(findings: readonly FindingDigest[], floor: Readonly<Record<string, number>> = {}): Record<string, number> {
  return findings.reduce<Record<string, number>>((m, x) => {
    const g = /^([A-Z]+)-(\d+)$/.exec(x.id), prefix = g?.[1]
    return prefix ? { ...m, [prefix]: Math.max(m[prefix] ?? 0, Number(g[2])) } : m
  }, { ...floor })
}

export function parseRecord(text: string): FlowRecord {
  const r: unknown = JSON.parse(text)
  if (!isObject(r)) throw new Error('flow record: not an object')
  const failed = CHECKS.find(([, ok]) => !ok(r))
  if (failed) throw new Error(`flow record: bad ${failed[0]}`)
  return r as FlowRecord
}

type Entry = { versions: number[]; bad: boolean; ended: boolean }
/** Version files per flow id, newest first, and whether the flow ended; a version entry that is not a plain file is bad. */
async function scan(io: Io, home: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>() // built locally, sorted once at the end (a long flow has thousands of versions)
  if (!(await io.exists(flowDir(home)))) return out
  for (const item of await io.list(flowDir(home))) {
    const v = VERSION_FILE.exec(item.name), e = END_FILE.exec(item.name)
    const id = v?.[1] ?? e?.[1]
    if (!id) continue
    const entry = out.get(id) ?? { versions: [], bad: false, ended: false }
    if (e) entry.ended = true; else if (item.kind === 'file') entry.versions.push(Number(v?.[2])); else entry.bad = true
    out.set(id, entry)
  }
  for (const entry of out.values()) entry.versions.sort((a, b) => b - a)
  return out
}

type Loaded = FlowRecord | 'missing' | 'invalid' | 'ended' | 'conflict'
/**
 * The newest version of a flow. A version found empty was emptied by newer writes meanwhile, so the listing is read again;
 * an empty newest that is still the newest after that was cut short (a power loss before the data reached disk): invalid.
 */
async function loadLatest(io: Io, home: string, flowId: string, first?: Entry): Promise<Loaded> {
  let emptyNewest = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = attempt === 0 && first ? first : (await scan(io, home)).get(flowId)
    if (!entry) return 'missing'
    if (entry.ended) return 'ended'
    const newest = entry.versions[0]
    if (entry.bad || newest === undefined) return 'invalid'
    const path = versionPath(home, flowId, newest)
    let text: string
    try { text = await io.read(path) } catch { if (await io.exists(path)) return 'invalid'; continue }
    if (text === '') { if (emptyNewest === newest) return 'invalid'; emptyNewest = newest; continue }
    try { const r = parseRecord(text); return r.flowId === flowId && r.version === newest ? r : 'invalid' } catch { return 'invalid' }
  }
  return 'conflict' // the newest kept moving: a burst of writes, worth another try later
}

export type ListResult = { ok: true; active: FlowRecord[]; invalid: string[] } | { ok: false; reason: RecordFailure; detail?: string }
/** Active records of one repository, and flows whose files cannot be read (any of them makes the caller stop). */
export async function listActive(io: Io, home: string, repoKey: string): Promise<ListResult> {
  try {
    const active: FlowRecord[] = [], invalid: string[] = []
    for (const [flowId, entry] of await scan(io, home)) {
      if (entry.ended) continue
      const r = await loadLatest(io, home, flowId, entry)
      if (r === 'conflict') return { ok: false, reason: 'conflict' }
      if (r === 'invalid') invalid.push(flowId)
      else if (typeof r === 'object' && r.repoKey === repoKey && r.lifecycle === 'active') active.push(r)
    }
    return { ok: true, active, invalid }
  } catch (err) { return { ok: false, reason: 'io', detail: String(err) } }
}

/** Writes one version: temp file, then a hard link that fails when the version exists ('taken'). */
async function writeVersion(io: Io, home: string, next: FlowRecord, token: string): Promise<'ok' | 'taken' | 'io' | 'too-large' | 'invalid'> {
  const text = `${JSON.stringify(next, null, 1)}\n`
  if (text.length > RECORD_LIMIT) return 'too-large'
  try { parseRecord(text) } catch { return 'invalid' } // never write what could not be read back, ticket text included
  const tmp = `${flowDir(home)}/${id8(next.flowId)}.tmp-${token}`
  try {
    await io.write(tmp, text)
    const linked = await io.run(['/bin/ln', '-n', tmp, versionPath(home, next.flowId, next.version)]) // -n: never into a linked directory
    if (linked.exitCode === 0) return 'ok'
    // File exists: another writer took this version. No such file: our temp file was pruned while this process stood
    // still for over a minute. Both are retried with a fresh read and a fresh temp file.
    return /File exists|No such file/i.test(linked.stderr) ? 'taken' : 'io'
  } catch { return 'io' } finally { await io.run(['/bin/rm', '-f', tmp]).catch(() => null) }
}

/**
 * Empties versions older than the newest two through a temp file and `mv -f` (rename(2): the name is never absent), and
 * deletes temp files a crashed writer left. Best effort: a version left full or a stray temp file is harmless.
 */
async function prune(io: Io, home: string, flowId: string, newest: number, sessionId: string): Promise<void> {
  try {
    const now = await io.now()
    for (const item of await io.list(flowDir(home))) {
      if (item.kind !== 'file') continue
      const path = `${flowDir(home)}/${item.name}`
      const v = VERSION_FILE.exec(item.name)
      if (v?.[1] === flowId && Number(v[2]) <= newest - KEEP_VERSIONS && item.size > 0) {
        const empty = `${flowDir(home)}/${flowId}.tmp-${tempToken(sessionId, now)}`
        await io.write(empty, '')
        await io.run(['/bin/mv', '-f', empty, path])
      } else if (item.name.startsWith(`${flowId}.tmp-`) && now - item.mtimeMs > TEMP_STALE_MS) await io.run(['/bin/rm', '-f', path])
    }
  } catch { /* see above */ }
}

/** After a link the write stands, unless the flow ended meanwhile (the end frees names): then it withdraws its file. */
async function confirmLive(io: Io, home: string, next: FlowRecord): Promise<'ok' | 'ended'> {
  let ended: boolean
  try { ended = await io.exists(endPath(home, next.flowId)) } catch { return 'ok' } // it landed; every load checks the marker first
  if (ended) await io.run(['/bin/rm', '-f', versionPath(home, next.flowId, next.version)]).catch(() => null)
  return ended ? 'ended' : 'ok'
}

/** Creates the first version of a new flow; an id already in use is a conflict. */
export async function createRecord(io: Io, home: string, record: FlowRecord): Promise<UpdateResult> {
  try {
    if (record.version !== 1) return { ok: false, reason: 'invalid' }
    if ((await io.run(['/bin/mkdir', '-p', flowDir(home)])).exitCode !== 0) return { ok: false, reason: 'io' }
    if ((await scan(io, home)).has(record.flowId)) return { ok: false, reason: 'conflict' } // an id in use or ended is never reused
    const w = await writeVersion(io, home, record, tempToken(record.lock?.sessionId ?? 'new', await io.now()))
    return w === 'ok' ? { ok: true, record, staleRead: false } : { ok: false, reason: w === 'taken' ? 'conflict' : w }
  } catch (err) { return { ok: false, reason: 'io', detail: String(err) } }
}

/**
 * Applies `change` to the newest version on disk and writes the next one; a lost compare-and-swap reloads and re-applies.
 * `knownVersion` is the version the caller last saw: an older one on disk is a rollback (blocked), a newer one sets
 * `staleRead` so the caller reloads its view. A change that throws is `rejected`; an ended flow takes no change.
 */
export async function updateRecord(io: Io, home: string, flowId: string, sessionId: string, change: (r: FlowRecord) => FlowRecord, knownVersion?: number): Promise<UpdateResult> {
  try {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const current = await loadLatest(io, home, flowId)
      if (typeof current !== 'object') return { ok: false, reason: current }
      if (knownVersion !== undefined && current.version < knownVersion) return { ok: false, reason: 'rollback' }
      if (current.lifecycle !== 'active') return { ok: false, reason: 'ended' }
      if (current.version >= MAX_VERSION) return { ok: false, reason: 'too-large' }
      const staleRead = knownVersion !== undefined && knownVersion !== current.version
      let changed: FlowRecord
      try { changed = change(current) } catch (err) { return { ok: false, reason: 'rejected', detail: String(err) } }
      if (changed === current) return { ok: true, record: current, staleRead } // nothing to write
      const next: FlowRecord = { ...changed, version: current.version + 1, flowId, repoKey: current.repoKey }
      const w = await writeVersion(io, home, next, tempToken(sessionId, await io.now()))
      if (w === 'taken') continue
      if (w !== 'ok') return { ok: false, reason: w }
      if ((await confirmLive(io, home, next)) === 'ended') return { ok: false, reason: 'ended' }
      await prune(io, home, flowId, next.version, sessionId)
      return { ok: true, record: next, staleRead }
    }
    return { ok: false, reason: 'conflict' }
  } catch (err) { return { ok: false, reason: 'io', detail: String(err) } }
}

/**
 * Ends a flow (`done`, or `/flow-off` by the owner): the end marker `<id8>.end` first, kept for good (a few bytes), so a
 * writer racing the end finds it after linking and withdraws; then every version and temp file of the flow is deleted.
 * A record that cannot be read is deleted too, since only the owner's command calls this. Views in the project stay.
 */
export async function removeRecord(io: Io, home: string, flowId: string, end: 'done' | 'off'): Promise<{ ok: true } | { ok: false; reason: RecordFailure; detail?: string }> {
  try {
    await io.write(endPath(home, flowId), `${JSON.stringify({ end, at: await io.now() })}\n`)
    const files = (await io.list(flowDir(home))).filter(i => i.name.startsWith(`${id8(flowId)}.`) && !END_FILE.test(i.name)).map(i => `${flowDir(home)}/${i.name}`)
    for (let i = 0; i < files.length; i += RM_BATCH) if ((await io.run(['/bin/rm', '-f', ...files.slice(i, i + RM_BATCH)])).exitCode !== 0) return { ok: false, reason: 'io' }
    return { ok: true }
  } catch (err) { return { ok: false, reason: 'io', detail: String(err) } }
}

export type LockStatus = 'mine' | 'moved' | 'free' | 'stale' | 'other'
/** `moved`: this session holds the lock from another root or branch (blocked). A heartbeat from the future is stale. */
export function lockStatus(r: FlowRecord, me: LockHolder, now: number): LockStatus {
  const l = r.lock
  if (!l) return 'free'
  if (l.sessionId === me.sessionId) return l.root === me.root && l.branch === me.branch ? 'mine' : 'moved'
  return Math.abs(now - l.heartbeatAt) > LOCK_STALE_MS ? 'stale' : 'other'
}
/**
 * The change that claims the lock: a free or stale lock always, a held one only for an owner command. The change runs on
 * the record as it is on disk at that moment, so the caller reads the holder from the record `updateRecord` returns.
 */
export const claimLock = (me: LockHolder, now: number, byOwner: boolean) => (r: FlowRecord): FlowRecord => {
  const s = lockStatus(r, me, now)
  return (s === 'other' || s === 'moved') && !byOwner ? r : { ...r, lock: { ...me, heartbeatAt: now } }
}
export const heartbeat = (me: LockHolder, now: number) => (r: FlowRecord): FlowRecord =>
  r.lock && lockStatus(r, me, now) === 'mine' ? { ...r, lock: { ...r.lock, heartbeatAt: now } } : r
export const releaseLock = (sessionId: string) => (r: FlowRecord): FlowRecord => (r.lock?.sessionId === sessionId ? { ...r, lock: null } : r)
export const shouldPersistHeartbeat = (lastPersistedAt: number, now: number): boolean => now - lastPersistedAt >= HEARTBEAT_PERSIST_MS

