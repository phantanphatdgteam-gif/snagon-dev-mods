// flow_check (plan v7.1 §4.6): main's one call that moves the flow on. It runs only where the flow waits for a check, after
// this session's sandbox probe; every call first checks the plugin's own files, the sandbox and the command sources
// against what S2 froze (F30), and any difference blocks the flow before anything runs. It answers as flow_status does.
import { pluginIntegrity, pluginVersion } from './flow-judge'
import { cfgDetail, cfgDrift, flowTree, git, gitPaths } from './flow-git'
import { baseOf, ECHO_ONLY, keepTrees, neededTrees, reanchored, refsBlock } from './flow-refs'
import { newNonce } from './flow-review'
import { hashOf } from './session'
import { stackById, stackOf, unknownStack } from './stacks/index'
import { fill } from '../flow/data/templates'
import type { Language } from '../flow/data/types'
import { activeView, blockFlow, dropView, mutateSession, session, type FlowHost } from './flow-host'
import { updateRecord, type Blocked, type FlowRecord } from './flow-state'
import { flowStatus, TICKET_PROMPT, whereNow } from './flow-turn'
import { sandboxProblems } from './flow-freeze'
import { sourcesDrift, type Drift } from './flow-run'
import { runBaseline } from './flow-baseline'
import { planCheck } from './flow-planning'
import { authorStep, redStep } from './flow-build'
import { judgeStep } from './flow-judging'
import { recoverLost, settleRunning } from './flow-ticket'
import { reviewStep } from './flow-reviewing'
import { verifyStep } from './flow-verify'

/** The tampered card's words for a mod update (NK-04): the version S2 froze (none before 0.5.4, GAP-054-6) and the one
 * now; null when it did not change or cannot be read, so a file changed within one version reads as before. */
export function modChange(from: string | undefined, to: string, lang: Language): string | null {
  if (!to || from === to) return null
  return fill(lang, 'tampered.mod', { from: from || fill(lang, 'tampered.unknownVersion', {}), to })
}

/** F30, before any worktree git or record write: the plugin's own files, the stack, the sandbox and H_cfg (a changed
 * repository config could name a filter that `git add` runs). */
async function integrity(h: FlowHost, r: FlowRecord): Promise<Blocked | null> {
  if ((await pluginIntegrity(h.io, h.io.pluginRoot)) !== r.frozen.plugin) {
    const update = modChange(r.frozen['plugin.version'], await pluginVersion(h.io, h.io.pluginRoot), h.language)
    return { reason: 'tampered', vars: { file: update ? `${h.io.pluginRoot} (${update})` : h.io.pluginRoot } }
  }
  // AC-CORE-5: a stack this mod does not know is never guessed; nothing below may read it
  if (!stackById(r.setup?.stack)) return { reason: 'couldNotRun', vars: { detail: unknownStack(r.setup?.stack) } }
  if ((await sandboxProblems(h, r)).length) {
    await mutateSession(h, s => ({ ...s, sandbox: 'changed' }))
    return { reason: 'sandboxMismatch', vars: {} }
  }
  return r.frozen.hCfg === undefined ? null : cfgChanged(h, r)
}

/** A1 (AC-A1-1, AC-A1-2), before anything reads a kept tree: the worktree's tree written (a kept tree equal to it is back),
 * then the kept trees synced; one lost anyway (its ref deleted by hand, then pruned) re-anchors the scope. The record as
 * it stands after. */
async function keptTrees(h: FlowHost, r: FlowRecord): Promise<FlowRecord> {
  const p = await gitPaths(h.io, r.root), needed = neededTrees(r)
  if (Object.keys(needed).length) await flowTree(h.io, p, 'worktree', newNonce())
  const lost = (await keepTrees(h.io, p, r.flowId, needed)).filter(n => !ECHO_ONLY.has(n)) // the release echo's own (sealedFrom)
  if (!lost.length) return r
  const base = await baseOf(h.io, p, r)
  const out = await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => reanchored(x, lost, base))
  dropView()
  if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`)
  await keepTrees(h.io, p, r.flowId, neededTrees(out.record))
  return out.record
}

type Feature = NonNullable<FlowRecord['features']>[number]
type Verdict = { block: Blocked | null; frozen: Record<string, string>; depOnly: boolean }
/** §3.2 for the changed sources: what the active feature changed itself and lists in its Files (a dependency-only edit
 * with its lockfile, or a declared source: cmdSourceVerdict) is frozen again, a dependency change noted for verify.md
 * and the re-baseline, a declared setup-chain file forcing the security review; anything else blocks. The text before
 * is the file in the feature's start tree, which must still be what was frozen. */
async function sourceVerdict(h: FlowHost, r: FlowRecord, drift: Drift, f: Feature | undefined, start: string | undefined): Promise<Verdict> {
  const blocked = (file: string): Verdict => ({ block: { reason: 'cmdSrc', vars: { file } }, frozen: {}, depOnly: false })
  // the git keys are never a feature's edit
  if (!f || !start || drift.changed.some(k => k.includes(':'))) return blocked(drift.changed[0] ?? '')
  const p = await gitPaths(h.io, r.root), texts: Record<string, { before: string; after: string }> = {}
  for (const k of drift.changed) {
    const was = await git(h.io, p.top, ['cat-file', 'blob', `${start}:${k}`]), before = was.exitCode === 0 && !was.isStdoutTruncated ? was.stdout : ''
    if (hashOf(before) !== (r.frozen[`src:${k}`] ?? hashOf(''))) return blocked(k)
    texts[k] = { before, after: await h.io.read(`${r.root}/${k}`).catch(() => '') }
  }
  const v = stackOf(r).code.cmdSourceVerdict(drift.changed, texts, f.files, drift.reached, drift.setupChain)
  if (v.cmdSrc.length) return blocked(v.cmdSrc[0] ?? '')
  return {
    block: null, depOnly: v.dependencyOnly.length > 0,
    frozen: { ...Object.fromEntries(drift.changed.map(k => [`src:${k}`, drift.now[k] ?? 'absent'])), ...(v.dependencyOnly.length ? { [`dep:${f.id}`]: 'yes' } : {}), ...(v.forceSecurity ? { [`security:${f.id}`]: 'forced' } : {}) },
  }
}
/** A changed runner (AC-STK-9) blocks `tampered`, naming what changed, unless it re-baselines (AC-RI-3): once per
 * dependency change the active feature made and the gate accepted (`dep:<F>` yes; then `rebased`), never from or to
 * 'absent', and only when the change adds nothing the runner loads at start (the stack's rebaseBlock); a refusal of the
 * stack seen now comes as `run.error`. The record keeps the old and the new hash (`rebase:<F>`). */
export function runnerVerdict(r: FlowRecord, run: Drift['runner'], f: Feature | undefined, depNow: boolean): { block: Blocked } | { frozen: Record<string, string> } {
  const s = stackOf(r), tampered = (file: string): { block: Blocked } => ({ block: { reason: 'tampered', vars: { file } } })
  const tree = s.data.dependencyDirs[0] ?? 'runner', was = r.frozen['runner:v2'] ?? '', now = run.state
  if (run.error !== undefined) return tampered(run.error)
  if (!now || !f || !(depNow || r.frozen[`dep:${f.id}`] === 'yes') || was === 'absent' || now.hash === 'absent') return tampered(tree)
  const added = s.code.rebaseBlock?.(r.frozen['runner:v2.facts'] ?? '', now.facts) ?? null
  if (added !== null) return tampered(added)
  const kept = [r.frozen[`rebase:${f.id}`], `${was}>${now.hash}`].filter(Boolean).join(' ')
  return { frozen: { 'runner:v2': now.hash, 'runner:v2.facts': now.facts, 'runner:v2.load': now.load.join('\n'), [`dep:${f.id}`]: 'rebased', [`rebase:${f.id}`]: kept } }
}
/** §3.2 CMD-SRC and runner integrity before anything runs: the changed sources (sourceVerdict), then the runner
 * (runnerVerdict); a tampered runner is named before a source block. What passes is frozen again in one write. */
async function cmdSrcCheck(h: FlowHost, r: FlowRecord): Promise<Blocked | null> {
  const drift = await sourcesDrift(h, r)
  if (!drift.changed.length && !drift.runner.changed) return null
  const f = r.phase === 'build' ? r.features?.find(x => x.id === r.feature) : undefined, start = f ? r.frozen[`start:${f.id}`] : undefined
  const src: Verdict = drift.changed.length ? await sourceVerdict(h, r, drift, f, start) : { block: null, frozen: {}, depOnly: false }
  const run = drift.runner.changed ? runnerVerdict(r, drift.runner, f, src.depOnly) : { frozen: {} }
  if ('block' in run) return run.block
  if (src.block) return src.block
  const out = await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, frozen: { ...x.frozen, ...src.frozen, ...run.frozen } }))
  dropView()
  if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`)
  return null
}

/** H_cfg (§5.1): the repository config, hooks, info files and project settings as frozen after the probe; the changed
 * names when they differ. */
async function cfgChanged(h: FlowHost, r: FlowRecord): Promise<Blocked | null> {
  let changed: string[] | null
  try { changed = await cfgDrift(h.io, r.root, h.home, r.frozen) } catch (err) { return { reason: 'couldNotRun', vars: { detail: fill(h.language, 'cfg.unreadable', { detail: cfgDetail(err) }) } } }
  return changed === null ? null : { reason: 'tampered', vars: { file: changed.slice(0, 5).join(', ') || 'the repository config' } }
}

/** B3 and B4 hand over within one flow_check: a green judge opens the review; a fix needs the judge before the delta. */
async function buildLoop(h: FlowHost, first: 'judge' | 'review'): Promise<void> {
  let step: 'judge' | 'review' | null = first
  for (let i = 0; i < 4 && step; i += 1) {
    const v = await activeView(h)
    if (v.mode !== 'on' || v.record.blocked) return
    step = step === 'judge' ? ((await judgeStep(h, v.record)) ? 'review' : null) : ((await reviewStep(h, v.record)) ? 'judge' : null)
  }
}

export async function flowCheck(h: FlowHost): Promise<string> {
  const view = await activeView(h)
  if (view.mode !== 'on') return flowStatus(h)
  await settleRunning(h, view.record) // D4: a running ticket whose agent is gone counts as a run that did not report back
  if ((await whereNow(h, view.record, (await session(h)).value)).kind !== 'check') return flowStatus(h)
  // integrity first; then the kept trees (A1), which the command sources' check reads; then the refs (NK-10)
  const first = await integrity(h, view.record)
  const kept = first ? view.record : await keptTrees(h, view.record)
  const blocked = first ?? (await cmdSrcCheck(h, kept)) ?? (await refsBlock(h, kept))
  if (blocked) {
    await blockFlow(h, kept.flowId, blocked)
    return flowStatus(h)
  }
  // a ticket lost in a restart: closed and its round given back; the step below issues it again (H5). The record is read
  // again either way: the check may have frozen an accepted change, which every judged run now compares against
  await recoverLost(h, kept)
  const again = await activeView(h)
  if (again.mode !== 'on') return flowStatus(h)
  const r = again.record, q = quiet(h)
  switch (r.task) {
    case 'S3': await runBaseline(q, r); break
    case 'P1': await planCheck(q, r); break
    case 'B1': await redStep(q, r); break
    case 'B2': if (await authorStep(q, r)) await buildLoop(q, 'judge'); break
    case 'B3': await buildLoop(q, 'judge'); break
    case 'B4': await buildLoop(q, 'review'); break
    case 'V1': await verifyStep(q, r); break
    default: throw new Error(`flow: flow_check for ${r.task} is not wired yet`)
  }
  return flowStatus(h)
}
/** flow_check is main's own call, and its result names the ticket a step issues: the "ticket is ready" prompt an owner
 * command's ticket needs is not submitted from here, where, queued behind main's turn, it only reached main after it had
 * started the agent (dry run 18: eleven "no new ticket" turns; review of D13). */
const quiet = (h: FlowHost): FlowHost => ({ ...h, submit: async text => { if (!text.startsWith(TICKET_PROMPT)) await h.submit(text) } })
