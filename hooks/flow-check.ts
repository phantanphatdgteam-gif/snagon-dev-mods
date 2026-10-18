// flow_check (plan v7.1 §4.6): main's one call that moves the flow on. It runs only where the flow waits for a check, after
// this session's sandbox probe; every call first checks the plugin's own files, the sandbox and the command sources
// against what S2 froze (F30), and any difference blocks the flow before anything runs. It answers as flow_status does.
import { pluginIntegrity, pluginVersion } from './flow-judge'
import { cfgDetail, cfgDrift, git, gitPaths } from './flow-git'
import { cmdSourceVerdict } from './flow-sources'
import { hashOf } from './session'
import { TYPESCRIPT } from '../flow/data/stacks'
import { fill } from '../flow/data/templates'
import type { Language } from '../flow/data/types'
import { activeView, blockFlow, dropView, mutateSession, session, type FlowHost } from './flow-host'
import { updateRecord, type Blocked, type FlowRecord } from './flow-state'
import { flowStatus, TICKET_PROMPT, whereNow } from './flow-turn'
import { sandboxProblems } from './flow-freeze'
import { sourcesDrift } from './flow-run'
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

async function integrity(h: FlowHost, r: FlowRecord): Promise<Blocked | null> {
  if ((await pluginIntegrity(h.io, h.io.pluginRoot)) !== r.frozen.plugin) {
    const update = modChange(r.frozen['plugin.version'], await pluginVersion(h.io, h.io.pluginRoot), h.language)
    return { reason: 'tampered', vars: { file: update ? `${h.io.pluginRoot} (${update})` : h.io.pluginRoot } }
  }
  if ((await sandboxProblems(h, r)).length) {
    await mutateSession(h, s => ({ ...s, sandbox: 'changed' }))
    return { reason: 'sandboxMismatch', vars: {} }
  }
  const src = await cmdSrcCheck(h, r)
  if (src) return src
  return r.frozen.hCfg === undefined ? null : cfgChanged(h, r)
}

/** §3.2 CMD-SRC: a changed command source blocks, except what the active feature changed itself and lists in its Files:
 * a dependency-only package.json edit with its lockfile, or a declared source (cmdSourceVerdict, step 5). Those are
 * frozen again; a dependency change is noted for verify.md and a declared setup-chain file forces the security review.
 * The text before is the file in the feature's start tree, which must still be what was frozen. */
async function cmdSrcCheck(h: FlowHost, r: FlowRecord): Promise<Blocked | null> {
  const drift = await sourcesDrift(h, r)
  if (!drift.changed.length) return null
  const block: Blocked = { reason: 'cmdSrc', vars: { file: drift.changed[0] ?? '' } }
  const f = r.phase === 'build' ? r.features?.find(x => x.id === r.feature) : undefined, start = f ? r.frozen[`start:${f.id}`] : undefined
  // the runner code and the git keys are never a feature's edit
  if (!f || !start || drift.changed.some(k => k === 'runner' || k.includes(':'))) return block
  const p = await gitPaths(h.io, r.root), texts: Record<string, { before: string; after: string }> = {}
  for (const k of drift.changed) {
    const was = await git(h.io, p.top, ['cat-file', 'blob', `${start}:${k}`]), before = was.exitCode === 0 && !was.isStdoutTruncated ? was.stdout : ''
    if (hashOf(before) !== (r.frozen[`src:${k}`] ?? hashOf(''))) return { reason: 'cmdSrc', vars: { file: k } }
    texts[k] = { before, after: await h.io.read(`${r.root}/${k}`).catch(() => '') }
  }
  const v = cmdSourceVerdict(drift.changed, texts, f.files, TYPESCRIPT, drift.reached, drift.setupChain)
  if (v.cmdSrc.length) return { reason: 'cmdSrc', vars: { file: v.cmdSrc[0] ?? '' } }
  const out = await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, frozen: {
    ...x.frozen, ...Object.fromEntries(drift.changed.map(k => [`src:${k}`, drift.now[k] ?? 'absent'])),
    ...(v.dependencyOnly.length ? { [`dep:${f.id}`]: 'yes' } : {}), ...(v.forceSecurity ? { [`security:${f.id}`]: 'forced' } : {}),
  } }))
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
  const blocked = await integrity(h, view.record)
  if (blocked) {
    await blockFlow(h, view.record.flowId, blocked)
    return flowStatus(h)
  }
  // a ticket lost in a restart: closed and its round given back; the step below issues it again (H5)
  const again = (await recoverLost(h, view.record)) ? await activeView(h) : view
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
