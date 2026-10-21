// A1 and NK-10 (R2 plan §4.3 and step 9; spike P5, GAP-R2-0.6-8). A1: the trees flow reads again later are kept from
// `git gc` by refs under refs/snagon/flow/<id8>/ that point straight at each tree: `git log --all` skips a ref to a tree,
// and `git branch -a`, `git status` and `git fsck` show nothing; a clone or fetch does not take them. They are synced in
// one `git update-ref --stdin` transaction whenever the record names a new tree, and deleted the same way once the flow
// ends. A tree lost anyway (its ref deleted by hand, then pruned) re-anchors the scope (AC-A1-2). NK-10: every ref but
// the flow branch, the remote-tracking refs and the flow's own is frozen at S2 and compared at each flow_check and at
// release.
import { fill } from '../flow/data/templates'
import { git, gitPaths, type GitPaths } from './flow-git'
import { hashOf, type Io } from './session'
import type { FlowHost } from './flow-host'
import type { Blocked, FlowRecord } from './flow-state'

const ID8 = /^[0-9a-f]{8}$/
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** The trees flow keeps, by the name of their ref, in the order the card names them: the active feature's start and RED
 * trees, its review round's tree and the one before, the first feature's start (verify diffs from it while there is no
 * base commit), the last seal's tree and the verified tree (the release echo lists what changed between them). */
const KEPT_NAMES: readonly string[] = ['start', 'red', 'round', 'prev', 'first', 'sealed', 'verified']
/** Kept trees only the release echo reads; it handles their loss itself (sealedFrom), so flow_check never re-anchors for
 * them (the seals are history). */
export const ECHO_ONLY: ReadonlySet<string> = new Set(['sealed', 'verified'])
/** How long naming a ref folder's type may take. */
const STAT_TIMEOUT_MS = 5_000
/** Something under the flow's ref folders flow did not write (a linked folder, another ref): nothing is touched there. */
class Refused extends Error {}
/** A missing object is never fetched from a promisor remote (no network from a check). */
const NO_FETCH = { GIT_NO_LAZY_FETCH: '1' }
/** The frozen refs list is kept in the record up to this many characters; a longer one only by its hash (NK-10). */
const REFS_LISTED = 32 * 1024
/** The refs a block names. */
const REFS_SHOWN = 10

export function keptPrefix(flowId: string): string {
  if (!ID8.test(flowId)) throw new Error(`flow: bad flow id ${JSON.stringify(flowId)}`)
  return `refs/snagon/flow/${flowId}/`
}

/** The trees the record still reads as git objects, by ref name. */
export function neededTrees(r: FlowRecord): Record<string, string> {
  const f = r.feature, first = r.features?.[0]?.id, round = r.round?.f === f ? r.round : undefined
  const noBase = r.frozen.scanBase === undefined && (r.frozen.baseSha ?? 'none') === 'none'
  const named: ReadonlyArray<readonly [string, string | undefined]> = [
    ['start', f ? r.frozen[`start:${f}`] : undefined], ['red', f ? r.frozen[`red:${f}`] : undefined], ['round', round?.tree], ['prev', round?.prev],
    ['first', noBase && first ? r.frozen[`start:${first}`] : undefined],
    ['sealed', r.phase === 'verify' || r.phase === 'ship' ? r.seals.at(-1)?.tree : undefined],
    ['verified', r.phase === 'verify' || r.phase === 'ship' ? r.verifiedTree : undefined],
  ]
  return Object.fromEntries(named.filter((e): e is readonly [string, string] => !!e[1]))
}

const failed = (what: string, r: { stderr: string }): Error => new Error(`git ${what} failed: ${r.stderr.trim().slice(0, 200)}`)

/** Each object's type, or `missing` (one cat-file process). */
async function typesOf(io: Io, p: GitPaths, oids: readonly string[]): Promise<Map<string, string>> {
  if (!oids.length) return new Map()
  const r = await git(io, p.top, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { stdin: `${oids.join('\n')}\n`, env: NO_FETCH })
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw failed('cat-file', r)
  const types = new Map(r.stdout.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)] as const))
  if (oids.some(o => !types.has(o))) throw new Error('git cat-file: an object id got no answer')
  return types
}

/** The flow's refs, name → object id. Anything under the prefix but `<prefix><kept name>` (a ref below one, which a
 * linked folder would list) is refused: the flow writes and deletes no other ref. */
async function refsUnder(io: Io, p: GitPaths, prefix: string): Promise<Map<string, string>> {
  const r = await git(io, p.top, ['for-each-ref', '--format=%(objectname) %(refname)', prefix.replace(/\/$/, '')])
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw failed('for-each-ref', r)
  const refs = new Map(r.stdout.split('\n').filter(Boolean).map(l => [l.slice(l.indexOf(' ') + 1), l.slice(0, l.indexOf(' '))] as const).filter(([ref]) => ref.startsWith(prefix)))
  const odd = [...refs.keys()].find(ref => !KEPT_NAMES.includes(ref.slice(prefix.length)))
  if (odd !== undefined) throw new Refused(`flow: ${odd} is not a ref flow writes; flow touches no ref under ${prefix} while it is there`)
  return refs
}

/** The folders the flow's loose refs live in, each a plain folder or absent: a symbolic link there would point the
 * flow's ref writes and deletes at other refs, which `--no-deref` does not stop. */
async function plainFolders(io: Io, p: GitPaths, flowId: string): Promise<void> {
  for (const dir of ['refs/snagon', 'refs/snagon/flow', `refs/snagon/flow/${flowId}`]) {
    const at = `${p.commonDir}/${dir}`, st = await io.run(['/usr/bin/stat', '-f', '%HT', at], { timeoutMs: STAT_TIMEOUT_MS }) // never follows a link
    if (st.exitCode === 0 ? st.stdout.trim() !== 'Directory' : !/No such file/.test(st.stderr)) throw new Refused(`flow: ${at} is not a plain folder; flow writes no ref there`)
  }
}

/** One `git update-ref --stdin` transaction, all or nothing; a symbolic ref is changed itself, never followed. */
async function updateRefs(io: Io, p: GitPaths, lines: readonly string[]): Promise<void> {
  if (!lines.length) return
  const r = await git(io, p.top, ['update-ref', '--no-deref', '--stdin'], { stdin: `${lines.join('\n')}\n`, env: NO_FETCH })
  if (r.exitCode !== 0) throw failed('update-ref', r)
}

/** Whether git has the object (looked up locally, never fetched). */
export async function present(io: Io, p: GitPaths, oid: string): Promise<boolean> {
  return OID.test(oid) && (await typesOf(io, p, [oid])).get(oid) !== 'missing'
}

/**
 * A1: the flow's refs made to point at exactly `trees` (ref name → tree id) in one transaction, the flow's other refs
 * deleted. A tree git no longer has comes back lost (its name); an object that is not a tree (the base commit, which
 * history keeps) gets no ref, as `git log --all` would walk it. A name or id flow never writes throws before any write.
 */
export async function keepTrees(io: Io, p: GitPaths, flowId: string, trees: Readonly<Record<string, string>>): Promise<string[]> {
  const prefix = keptPrefix(flowId), names = Object.keys(trees)
  const bad = names.find(n => !KEPT_NAMES.includes(n) || !OID.test(trees[n] ?? ''))
  if (bad !== undefined) throw new Error(`flow: ${JSON.stringify(bad)} is not a tree flow keeps`)
  await plainFolders(io, p, flowId)
  const types = await typesOf(io, p, [...new Set(Object.values(trees))])
  const want = new Map(names.filter(n => types.get(trees[n] ?? '') === 'tree').map(n => [`${prefix}${n}`, trees[n] ?? ''] as const))
  const have = await refsUnder(io, p, prefix)
  await checkedWrite(io, p, flowId, [
    ...[...want].filter(([ref, oid]) => have.get(ref) !== oid).map(([ref, oid]) => `update ${ref} ${oid}`),
    ...[...have.keys()].filter(ref => !want.has(ref)).map(ref => `delete ${ref}`),
  ])
  return names.filter(n => types.get(trees[n] ?? '') === 'missing')
}

/** At the flow's end (`.end` written): every ref of the flow deleted in one transaction. */
export async function dropTrees(io: Io, p: GitPaths, flowId: string): Promise<void> {
  const prefix = keptPrefix(flowId)
  await plainFolders(io, p, flowId)
  await checkedWrite(io, p, flowId, [...(await refsUnder(io, p, prefix)).keys()].map(ref => `delete ${ref}`))
}
/** updateRefs with the folders checked again right before it; with loose ref files there is no way to close the window
 * between that check and git's write completely, and the lines name only `<prefix><kept name>`. */
async function checkedWrite(io: Io, p: GitPaths, flowId: string, lines: readonly string[]): Promise<void> {
  if (!lines.length) return
  await plainFolders(io, p, flowId)
  await updateRefs(io, p, lines)
}
/** dropTrees for an ending flow: null when done, else the owner's line: how to remove the refs by hand, or, when the
 * folders hold what flow did not write, to look first (git would follow a linked folder to other refs). */
export async function endTrees(h: FlowHost, root: string, flowId: string): Promise<string | null> {
  try { await dropTrees(h.io, await gitPaths(h.io, root), flowId); return null } catch (err) { return fill(h.language, err instanceof Refused ? 'end.refsOdd' : 'end.refsLeft', { id: flowId }) }
}

/** Where the release echo's list of files changed after the last seal starts: that seal's tree, or, when it was lost, the
 * flow's base (the files changed since the base, which can miss one reverted or deleted after the seal; the echo says
 * so); null when the verified tree is the sealed one. A verified tree git no longer has stops the echo in fixed words. */
export async function sealedFrom(io: Io, p: GitPaths, r: FlowRecord): Promise<{ from: string; lost: boolean } | null> {
  const sealed = r.seals.at(-1)?.tree, verified = r.verifiedTree ?? ''
  if (!sealed || sealed === verified) return null
  if (!(await present(io, p, verified))) throw new Error('flow: the verified tree was deleted by hand; run /flow-ship again')
  return (await present(io, p, sealed)) ? { from: sealed, lost: false } : { from: await baseOf(io, p, r), lost: true }
}

/** The flow's base (AC-A1-2): the baseline commit while this repository has it, else git's empty tree (written, so a ref
 * can keep it). */
export async function baseOf(io: Io, p: GitPaths, r: Pick<FlowRecord, 'frozen'>): Promise<string> {
  const sha = r.frozen.baseSha ?? ''
  if (OID.test(sha) && (await git(io, p.top, ['cat-file', '-e', `${sha}^{commit}`], { env: NO_FETCH })).exitCode === 0) return sha
  const e = await git(io, p.top, ['hash-object', '-w', '-t', 'tree', '--stdin'], { stdin: '' })
  const oid = e.stdout.trim()
  if (e.exitCode !== 0 || !OID.test(oid)) throw failed('hash-object', e)
  return oid
}

/**
 * AC-A1-2: the record once kept trees were lost anyway (`lost`: their names). A lost start (the active feature's, or the
 * first feature's that verify diffs from) becomes `base`, so every check measures from further back, never less; a lost
 * RED tree is dropped (the RED tests stay frozen by their hash); a lost round tree closes the round: its unstarted tickets
 * close, its review round is given back and, at B4, the judge runs before a full review. `reverify:<scope>` names what
 * was lost, for the card.
 */
export function reanchored(r: FlowRecord, lost: readonly string[], base: string): FlowRecord {
  const f = r.feature, first = r.features?.[0]?.id, was = new Set(lost)
  const frozen = {
    ...Object.fromEntries(Object.entries(r.frozen).filter(([k]) => !(was.has('red') && f && k === `red:${f}`))),
    ...(was.has('first') && first ? { [`start:${first}`]: base } : {}),
    ...(was.has('start') && f ? { [`start:${f}`]: base } : {}),
    [`reverify:${f ?? r.phase}`]: KEPT_NAMES.filter(n => was.has(n)).join(', '),
  }
  const round = r.round
  if (!round || !(was.has('round') || was.has('prev'))) return { ...r, frozen }
  const key = r.features?.find(x => x.id === round.f)?.key, used = key === undefined ? undefined : r.counters[key]
  const { round: _closed, ...rest } = r
  return {
    ...rest, frozen,
    tickets: r.tickets.map(t => (round.tickets.includes(t.id) && !t.used ? { ...t, used: true } : t)),
    ...(key !== undefined && used ? { counters: { ...r.counters, [key]: { ...used, r: Math.max(0, used.r - 1) } } } : {}),
    ...(r.task === 'B4' ? { task: 'B3' } : {}),
  }
}

/** A refs line: object id, ref name and, for a symbolic ref, the ref it names (ref names hold no spaces). */
const fields = (l: string): { oid: string; ref: string; sym: string } => { const [oid = '', ref = '', sym = ''] = l.split(' '); return { oid, ref, sym } }
/** NK-10: every ref but the flow branch, the remote-tracking refs and this flow's kept trees, as `<id> <ref>[ <target>]`
 * lines in git's order (by name); a symbolic ref carries the ref it names, so a new target at the same object counts. */
export async function refsNow(io: Io, p: GitPaths, branch: string, flowId: string | null): Promise<string> {
  const kept = flowId === null ? null : keptPrefix(flowId)
  const r = await git(io, p.top, ['for-each-ref', '--format=%(objectname) %(refname) %(symref)'])
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw failed('for-each-ref', r)
  const free = (ref: string): boolean => ref === `refs/heads/${branch}` || ref.startsWith('refs/remotes/') || (kept !== null && ref.startsWith(kept))
  return r.stdout.split('\n').map(fields).filter(f => f.ref && !free(f.ref)).map(f => `${f.oid} ${f.ref}${f.sym ? ` ${f.sym}` : ''}`).join('\n')
}
/** What S2 freezes of refsNow: its hash, and the list itself while it is short enough for the record. */
export const refsFrozen = (text: string): Record<string, string> => ({ refs: hashOf(text), ...(text.length <= REFS_LISTED ? { 'refs.list': text } : {}) })
/** The refs that differ from the frozen ones, by name: null when none does, empty when the frozen list is not kept. */
export function refsChanged(frozen: Readonly<Record<string, string>>, text: string): string[] | null {
  if (hashOf(text) === frozen.refs) return null
  const was = frozen['refs.list']
  if (was === undefined || hashOf(was) !== frozen.refs) return []
  const byName = (t: string): Map<string, string> => new Map(t.split('\n').filter(Boolean).map(fields).map(f => [f.ref, `${f.oid} ${f.sym}`] as const))
  const a = byName(was), b = byName(text)
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort()
}

/** NK-10 at each flow_check and at release: refs moved since S2 block `tampered`, named. A record frozen before 0.6.0
 * holds no refs and is not compared. */
export async function refsBlock(h: FlowHost, r: FlowRecord): Promise<Blocked | null> {
  if (r.frozen.refs === undefined) return null
  let changed: string[] | null
  try { changed = refsChanged(r.frozen, await refsNow(h.io, await gitPaths(h.io, r.root), r.setup?.branch ?? r.branch, r.flowId)) } catch {
    return { reason: 'couldNotRun', vars: { detail: 'git could not list the refs (NK-10)' } } // fixed words: git's text can quote the repository
  }
  if (changed === null) return null
  const refs = changed.length ? `${changed.slice(0, REFS_SHOWN).join(', ')}${changed.length > REFS_SHOWN ? ', …' : ''}` : fill(h.language, 'refs.unlisted', {})
  return { reason: 'tampered', vars: { file: fill(h.language, 'tampered.refs', { refs }) } }
}
