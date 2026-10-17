// Ship (plan v7.1 §3 H0-H2, §5.6). /flow-ship at H0: the verified work must be committed (HEAD's flow tree and the
// worktree's are the verified tree), the verify report the one verify wrote, the branch the frozen one; main is asked to
// commit when it is not. Then the release scan runs without pushing and the release echo shows in the pane with a fresh
// code. /flow-approve release (typed at the prompt, with the code) checks it all again and pushes; a pushed flow is done.
// A release that fails goes back to H0 with the reason for the owner.
import { fill } from '../flow/data/templates'
import { afterPass, pointerFields } from './flow'
import { flowTree, git, gitPaths, release, type Frozen, type ReleaseResult } from './flow-git'
import { newNonce, sha256 } from './flow-review'
import { makeEcho, rotateCode, showEcho, type EchoContent, type Origin } from './flow-owner'
import { activeView, branchOf, dropView, emptySession, mutateSession, realOf, session, type FlowHost } from './flow-host'
import { removeRecord, updateRecord, withBlock, type Approval, type Blocked, type FlowRecord, type UpdateResult } from './flow-state'
import { atShip, VERIFY_FILE } from './flow-verify'
import { frozenSandboxList, tilde } from './flow-run'
import { redactSecrets } from './secrets'
import { flowCard } from './flow-turn'

// dry run of step 13, D9: `git add -A` alone took the local sandbox settings into the release commit
const COMMIT_PROMPT = 'flow: the verified work is not committed. Commit it now: run `git add -A -- . \':(exclude).claude/settings.local.json\'`, then `git commit -m "<one line on what the flow built>"`. Do not push: the project owner ships it with /flow-ship.'
/** A block /flow-ship answers by trying again: the commits held a secret (the owner rewrote them). */
const SHIP_AGAIN = new Set(['publish'])
const COMMITS_SHOWN = 50, FILES_SHOWN = 20
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }
const branchOfRecord = (r: FlowRecord): string => r.setup?.branch ?? r.branch

/** Why the release cannot go now: owner text, 'commit' (main commits first), a block; null when it can. */
async function notReady(h: FlowHost, r: FlowRecord): Promise<string | 'commit' | Blocked | null> {
  const p = await gitPaths(h.io, r.root)
  if ((await flowTree(h.io, p, 'worktree', newNonce())) !== r.verifiedTree) return fill(h.language, 'ship.changed', {})
  if ((await flowTree(h.io, p, 'head', newNonce())) !== r.verifiedTree) return 'commit'
  if ((await sha256(await h.io.read(`${r.root}/${VERIFY_FILE}`).catch(() => ''))) !== r.verifyMdHash) return { reason: 'reportChanged', vars: { file: VERIFY_FILE } }
  const now = await branchOf(h), branch = branchOfRecord(r)
  return now === branch ? null : fill(h.language, 'ship.branch', { now: now || 'HEAD', branch })
}

/** What release() compares and needs, from the record: the remote facts frozen at S2, H_cfg, the folders Bash can write
 * (TMPDIR and the approved sandbox's allowWrite, as written and as realpaths). */
export async function frozenOf(h: FlowHost, r: FlowRecord, revsHash?: string): Promise<Frozen> {
  const given = [h.env.TMPDIR, ...(frozenSandboxList(r, 'allowWrite') ?? [])].filter(Boolean).map(x => tilde(h, x))
  const writable = [...new Set([...given, ...(await Promise.all(given.map(x => realOf(h, x))))])]
  return {
    remote: r.setup?.remote ?? '', branch: branchOfRecord(r), hCfg: r.frozen.hCfg ?? '',
    facts: { url: r.frozen['remote.url'] ?? '', urlRules: r.frozen['remote.rules'] ?? '', globalKeys: r.frozen['remote.global'] ?? '', keyNames: (r.frozen['remote.keys'] ?? '').split('\n').filter(Boolean), repoCredentialKeys: [] },
    writable, configFiles: configFilesOf(h), ...(revsHash ? { revsHash } : {}),
  }
}
/** The global (and system) config files git reads for the push in this environment, existing or not. */
const configFilesOf = (h: FlowHost): string[] => {
  const e = h.env, global = e.GIT_CONFIG_GLOBAL ? [e.GIT_CONFIG_GLOBAL] : [`${h.home}/.gitconfig`, `${e.XDG_CONFIG_HOME || `${h.home}/.config`}/git/config`]
  return [...global, ...(e.GIT_CONFIG_SYSTEM ? [e.GIT_CONFIG_SYSTEM] : [])]
}

/** A failed release as the block the owner sees. The commit list changing between the echo and the push means the remote
 * moved: verify again, like a refused push. */
function blockedOf(res: Extract<ReleaseResult, { ok: false }>): Blocked {
  if (res.reason === 'tampered') return { reason: 'tampered', vars: { file: res.detail } }
  if (res.reason === 'remoteChanged') return { reason: 'remoteChanged', vars: { what: res.detail } }
  return { reason: res.reason === 'frozenChanged' ? 'pushRejected' : res.reason, vars: { detail: res.detail } }
}

/** The ship goes back to H0 with the block; the release echo and its record in the session go. */
async function shipBlock(h: FlowHost, r: FlowRecord, blocked: Blocked): Promise<string> {
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => withBlock({ ...x, phase: 'ship', task: 'H0', awaiting: '/flow-ship' }, blocked)))
  await mutateSession(h, s => { const { release: _e, ...pending } = s.pending; return { ...s, pending, release: null, shown: s.shown === 'release' ? null : s.shown } })
  return (await flowCard(h)) ?? ''
}

type Rel = { head: string; revsHash: string; revs: string[] }
async function gitText(h: FlowHost, r: FlowRecord, args: readonly string[]): Promise<string> {
  const out = await git(h.io, r.root, args)
  if (out.exitCode !== 0 || out.isStdoutTruncated) throw new Error(`flow: git ${args[0] ?? ''} failed: ${out.stderr.trim().slice(0, 200)}`)
  return out.stdout
}
/** §2.5 release echo: what is published (commits, remote, branch, push settings), the scan, what no reviewer saw since
 * the last seal, what stays out (untracked), the self-caused blocks, the trees, and the verify report itself. Built from
 * local git only, so the approval rebuilds it without the network. */
async function releaseEcho(h: FlowHost, r: FlowRecord, rel: Rel): Promise<EchoContent> {
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => fill(h.language, key, vars)
  const list = (names: readonly string[]): string => !names.length ? t('echo.none') : names.length <= FILES_SHOWN ? names.join(', ') : t('echo.list.more', { files: names.slice(0, FILES_SHOWN).join(', '), n: names.length - FILES_SHOWN })
  const names = (z: string): string[] => z.split('\0').filter(Boolean)
  const branch = branchOfRecord(r), url = r.frozen['remote.url'] ?? '', keys = (r.frozen['remote.keys'] ?? '').split('\n').filter(Boolean)
  const count = Number((await gitText(h, r, ['rev-list', '--count', ...rel.revs])).trim()) || 0
  const commits = (await gitText(h, r, ['log', '--no-color', '--format=%h %s', `--max-count=${COMMITS_SHOWN}`, ...rel.revs])).split('\n').filter(Boolean)
  const sealed = r.seals.at(-1)?.tree, tree = r.verifiedTree ?? ''
  const unreviewed = sealed && sealed !== tree ? names(await gitText(h, r, ['diff', '--name-only', '-z', sealed, tree])) : []
  const untracked = names(await gitText(h, r, ['ls-files', '-z', '--others', '--exclude-standard']))
  const report = (await h.io.read(`${r.root}/${VERIFY_FILE}`).catch(() => '')).split('\n')
  const lines = [
    t('echo.release.head', { head: rel.head.slice(0, 12), branch }), t('echo.release.remote', { url, branch }), t('echo.release.keys', { keys: keys.join(', ') || t('echo.none') }),
    t('echo.release.commits', { count }), ...commits.map(c => `  ${c}`), ...(count > commits.length ? [t('echo.release.more', { n: count - commits.length })] : []),
    t('echo.release.scan'), t('echo.release.unreviewed', { files: list(unreviewed) }), t('echo.release.untracked', { files: list(untracked) }),
    t('echo.release.self', { n: r.selfBlocks ?? 0 }), t('echo.release.tree', { tree: tree.slice(0, 12) }), t('echo.release.verify', { hash: (r.verifyMdHash ?? '').slice(0, 8) }),
    '', ...report,
  ]
  // commit subjects are the agent's words
  return { kind: 'release', title: t('echo.release', { address: h.address }), lines: lines.map(redactSecrets), fields: { head: rel.head, revsHash: rel.revsHash, branch, url }, files: { verify: r.verifyMdHash ?? '' } }
}

/** /flow-ship: at H0 (or showing the release again at H1, or after a publish block) the checks, the scan, the echo. */
export async function shipCommand(h: FlowHost, origin: Origin): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return fill(h.language, 'status.none', { address: h.address })
  const r = view.record
  const again = r.phase === 'ship' && SHIP_AGAIN.has(r.blocked?.reason ?? '')
  if (!again && !atShip(r)) return (await flowCard(h)) ?? ''
  const why = await notReady(h, r)
  if (why === 'commit') { await h.submit(COMMIT_PROMPT); return fill(h.language, 'ship.commit', {}) }
  if (typeof why === 'string') return why
  if (why) return shipBlock(h, r, why)
  const res = await release(h.io, r.root, await gitPaths(h.io, r.root), h.home, await frozenOf(h, r), false)
  if (!res.ok) return shipBlock(h, r, blockedOf(res))
  rotateCode()
  const rel = { head: res.head, revsHash: res.revsHash, revs: res.revs }, echo = await makeEcho(await releaseEcho(h, r, rel))
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => { const { blocked: _b, ...rest } = x; return { ...rest, ...pointerFields(afterPass({ phase: 'ship', task: 'H0' }, { features: [], baselineRed: false })) } }))
  const s = await mutateSession(h, x => ({ ...x, pending: { ...x.pending, release: echo }, shown: 'release', release: rel }))
  return (await showEcho(h, s?.pending ?? {}, echo, origin)).shown ? fill(h.language, 'echo.shown', { address: h.address }) : fill(h.language, 'blocked.noSurface', {})
}

/** The release echo rebuilt from HEAD now and the scanned commit list: its hash, or undefined. */
export async function releaseHash(h: FlowHost): Promise<string | undefined> {
  const view = await activeView(h), rel = (await session(h)).value.release
  if (view.mode !== 'on' || !rel) return undefined
  const head = await git(h.io, view.record.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head.exitCode !== 0) return undefined
  return (await makeEcho(await releaseEcho(h, view.record, { ...rel, head: head.stdout.trim() }))).hash
}

/** H1 approved (the gate checked the origin and the code): the checks again, H2 the push, then the flow is done. */
export async function applyRelease(h: FlowHost, a: Approval): Promise<string> {
  const view = await activeView(h), rel = (await session(h)).value.release
  if (view.mode !== 'on' || !rel) return fill(h.language, 'status.none', { address: h.address })
  const r = view.record
  const why = await notReady(h, r)
  if (why === 'commit') return fill(h.language, 'ship.changed', {})
  if (typeof why === 'string') return why
  if (why) return shipBlock(h, r, why)
  const p = await gitPaths(h.io, r.root), releaseTree = await flowTree(h.io, p, 'head', newNonce())
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => { const { awaiting: _a, ...rest } = x; return { ...rest, approvals: [...x.approvals, a], releaseTree, ...pointerFields(afterPass({ phase: 'ship', task: 'H1' }, { features: [], baselineRed: false })) } }))
  const res = await release(h.io, r.root, p, h.home, await frozenOf(h, r, rel.revsHash), true)
  if (!res.ok) return shipBlock(h, r, blockedOf(res))
  const ended = await removeRecord(h.io, h.home, r.flowId, 'done')
  dropView()
  await mutateSession(h, () => emptySession())
  if (!ended.ok) throw new Error(`flow: pushed, but the record could not be ended (${ended.reason})`)
  return fill(h.language, 'ship.done', { head: res.head.slice(0, 12), branch: branchOfRecord(r), url: r.frozen['remote.url'] ?? '' })
}
