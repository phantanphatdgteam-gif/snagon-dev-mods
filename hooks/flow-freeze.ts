// S2 and S2b (plan v7.1 §2.2, §2.4, §3): /flow-setup shows the S1 echo; its approval freezes the setup into the record (a
// new flow, or a re-freeze that keeps the pointer), then opens the one-shot Write window for the settings file, or, when
// that file holds a secret, waits for the owner to paste the block. The probe main runs then shows whether the sandbox is
// on: it turns the sandbox on for this session and, the first time, freezes the effective sandbox the engine reports.
import type { FlowSetupArgs } from '../types'
import { fill } from '../flow/data/templates'
import { cfgDetail, cfgHash, gitPaths, seenHash } from './flow-git'
import { pluginIntegrity, pluginVersion } from './flow-judge'
import { runnerHash } from './flow-sources'
import { CONTROL_ARGV, effectiveOf, PROBE_COMMAND, probeShowsSandbox, sandboxRefusals, type Layer, type Settings } from './flow-sandbox'
import { canonical, dropEcho, makeEcho, refusalText, showEcho, type Origin } from './flow-owner'
import { sha256 } from './flow-review'
import { activeView, blockFlow, dropView, holderOf, mutateSession, pluginRoots, session, staticsOf, type FlowHost } from './flow-host'
import { claimLock, createRecord, newRecord, updateRecord, type Approval, type FlowRecord, type FlowSetup, type UpdateResult } from './flow-state'
import { detectSetup, setupEcho, writeDraftView, LOCAL_SETTINGS, type SetupDraft } from './flow-setup'

/** The npm package that holds each runner, for the runner hash. */
const RUNNER_PACKAGE: Readonly<Record<string, string>> = { tsc: 'typescript' }
/** Frozen keys that come from the setup: replaced by a re-freeze (the sandbox after the probe). H_cfg is not: it stays as
 * it was until the probe freezes it again, so /flow-off never compares against an empty freeze meanwhile. */
const SETUP_KEY = /^(?:post|plugin|runner|remote\.|env\.|src:|sandbox$)/
const LAYERS: readonly Layer[] = ['user', 'project', 'local', 'flag', 'policy']

// Agent-facing prompts (English): what main does next in S2b.
const writePrompt = (path: string, post: string): string =>
  `flow S2b: the project owner approved the sandbox settings. Read ${path} if it exists, then call Write once with file_path ${path} and exactly the text between the two marker lines below as content (it ends with one newline). Change nothing else, and make no other call that names this file.\n<<<CONTENT\n${post}CONTENT>>>`
export const PROBE_PROMPT = `flow: run exactly this Bash command once, as it is; it checks that the sandbox is on, and a refusal is the expected result: ${PROBE_COMMAND}`
const CHECK_PROMPT = 'flow: the sandbox is on. Call flow_check now to run the baseline.'

/** The draft whose echo the last recompute built: the approval freezes exactly what it hashed. */
let approvedDraft: { hash: string; draft: SetupDraft } | null = null
const unique = (xs: readonly string[]): string[] => [...new Set(xs)]
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const newFlowId = (): string => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')
const settled = (out: UpdateResult): FlowRecord => { dropView(); if (!out.ok) throw new Error(`flow: the record could not be written (${out.reason})`); return out.record }

/** /flow-setup: S1, then its echo in the focused pane (the session keeps it and the arguments), or every refusal. */
export async function setupCommand(h: FlowHost, args: FlowSetupArgs, origin: Origin): Promise<string> {
  const found = await detectSetup(h, args)
  if (!found.ok) return [fill(h.language, 'setup.refused', {}), ...found.refusals.map(r => `- ${r}`)].join('\n')
  const echo = await makeEcho(setupEcho(h, found.draft))
  await writeDraftView(h, [echo.title, ...echo.lines].join('\n'))
  const s = await mutateSession(h, x => ({ ...x, pending: { ...x.pending, setup: echo }, shown: 'setup', setupArgs: args }))
  const shown = await showEcho(h, s?.pending ?? {}, echo, origin)
  if (shown.shown) return fill(h.language, 'echo.shown', { address: h.address })
  await mutateSession(h, x => ({ ...x, pending: dropEcho(x.pending, 'setup'), shown: x.shown === 'setup' ? null : x.shown }))
  return fill(h.language, 'blocked.noSurface', {})
}

/** The setup echo rebuilt from the arguments it was shown with and the files as they are now: its hash, or undefined. */
export async function setupHash(h: FlowHost): Promise<string | undefined> {
  const args = (await session(h)).value.setupArgs
  const found = args ? await detectSetup(h, args) : null
  if (!found?.ok) return undefined
  const hash = (await makeEcho(setupEcho(h, found.draft))).hash
  approvedDraft = { hash, draft: found.draft }
  return hash
}

/** What S2 freezes besides the setup itself (§2.4): the approved settings (as parsed JSON), the plugin and runner code,
 * the push facts, the judge's PATH and every command source by name. */
async function freezeOf(h: FlowHost, d: SetupDraft): Promise<Record<string, string>> {
  const p = await gitPaths(h.io, d.root)
  return {
    post: await sha256(canonical(JSON.parse(d.post))),
    plugin: await pluginIntegrity(h.io, h.io.pluginRoot), 'plugin.version': await pluginVersion(h.io, h.io.pluginRoot),
    runner: await runnerHash(h.io, p.top, unique(d.commands.map(c => RUNNER_PACKAGE[c.runner] ?? c.runner))),
    'remote.url': d.facts.url, 'remote.rules': d.facts.urlRules, 'remote.global': d.facts.globalKeys, 'remote.keys': d.facts.keyNames.join('\n'),
    'env.PATH': d.path || h.env.PATH, // the filtered PATH the owner approved (NK-02)
    cfgSeen: d.cfgSeen, // the H_cfg parts the approval binds; the probe freezes them only if they are still so
    ...Object.fromEntries(Object.entries(d.sources).map(([k, v]) => [`src:${k}`, v])),
  }
}

/** Whether the settings file holds the approved settings (compared as parsed JSON). */
async function localHolds(h: FlowHost, root: string, post: string | undefined): Promise<boolean> {
  try { return post !== undefined && (await sha256(canonical(JSON.parse(await h.io.read(`${root}/${LOCAL_SETTINGS}`))))) === post } catch { return false }
}

/** A new flow, or a re-freeze of this repository's flow: setup and frozen replaced, the approval added, the block cleared,
 * the pointer kept (in setup it goes to S2b). */
async function saveSetup(h: FlowHost, d: SetupDraft, a: Approval, frozen: Record<string, string>, awaiting: string | undefined): Promise<FlowRecord> {
  const setup: FlowSetup = { stack: d.stack, commands: d.commands, allowTools: d.allowTools, allowMcp: d.allowMcp, journalDir: d.journalDir, remote: d.remote, branch: d.branch, pluginProject: d.pluginProject, caps: d.caps, sessionCap: d.sessionCap }
  const view = await activeView(h), now = await h.io.now(), holder = await holderOf(h)
  if (view.mode === 'unknown') throw new Error(`flow: the flow state cannot be read (${view.why})`)
  if (view.mode === 'on') {
    return settled(await updateRecord(h.io, h.home, view.record.flowId, h.sessionId, r => {
      const { blocked: _b, awaiting: _a, ...rest } = claimLock(holder, now, true)(r)
      const kept = Object.fromEntries(Object.entries(r.frozen).filter(([k]) => !SETUP_KEY.test(k)))
      return { ...rest, setup, frozen: { ...kept, ...frozen }, approvals: [...r.approvals, a], ...(awaiting ? { awaiting } : {}), ...(r.phase === 'setup' ? { task: 'S2b' } : {}) }
    }))
  }
  const repoKey = (await staticsOf(h)).repoKey
  if (repoKey === null) throw new Error('flow: git could not name this repository')
  const base = newRecord({ flowId: newFlowId(), repoKey, root: d.root, branch: d.branch, sessionId: h.sessionId, now })
  return settled(await createRecord(h.io, h.home, { ...base, phase: 'setup', task: 'S2b', setup, frozen, approvals: [a], ...(awaiting ? { awaiting } : {}) }))
}

/** S2: the approved draft frozen; then the Write window and main's instruction, the owner's paste, or (the file already
 * holds the block) the probe. */
export async function applySetup(h: FlowHost, a: Approval): Promise<string> {
  const held = approvedDraft
  approvedDraft = null
  const d = held?.hash === a.echoHash ? held.draft : undefined
  if (!d) return refusalText(h.language, h.address, 'hash', 'setup')
  const frozen = await freezeOf(h, d)
  const written = await localHolds(h, d.root, frozen.post)
  const paste = !written && d.writeYourself
  await saveSetup(h, d, a, frozen, paste ? '/flow-status' : undefined)
  const path = `${d.root}/${LOCAL_SETTINGS}`
  const window = written || paste ? null : { path, post: d.post, preHash: d.pre === null ? null : await sha256(d.pre) }
  await mutateSession(h, s => ({ ...s, setupArgs: null, sandbox: null, s2b: window }))
  if (paste) return fill(h.language, 'setup.paste', {})
  await h.submit(window ? writePrompt(path, d.post) : PROBE_PROMPT)
  return fill(h.language, window ? 'setup.writing' : 'setup.probing', {})
}

/** /flow-status while the owner pastes the block: the paste checked (as JSON), then main runs the probe. */
export async function pastedCheck(h: FlowHost, r: FlowRecord): Promise<string | null> {
  if (r.awaiting !== '/flow-status' || r.frozen.sandbox !== undefined || r.frozen.post === undefined) return null
  if (!(await localHolds(h, r.root, r.frozen.post))) return fill(h.language, 'setup.notPasted', {})
  settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => { const { awaiting: _a, ...rest } = x; return rest }))
  await h.submit(PROBE_PROMPT)
  return null
}

/** The probe's exit code and text from the Bash result: an error result starts `Exit code N`. */
function probeResult(out: unknown): { exit: number; text: string } {
  const o = isObj(out) ? out : {}
  const res = o.result
  const text = typeof res === 'string' ? res : isObj(res) ? [res.stdout, res.stderr].filter((x): x is string => typeof x === 'string').join('\n') : ''
  return { exit: o.isError === true ? Number(/^Exit code (\d+)/m.exec(text)?.[1] ?? 1) : 0, text }
}
/** What differs from the approved sandbox, as the engine reports it now: the local layer, the two fixed keys, any key
 * a layer adds that loosens it (S1's refusals again), and, once frozen, the whole effective sandbox. */
export async function sandboxProblems(h: FlowHost, r: FlowRecord): Promise<string[]> {
  const layers = Object.fromEntries(await Promise.all(LAYERS.map(async l => [l, await h.settings(l)] as const))) as Record<Layer, Settings>
  const merged = await h.settings(), sb = isObj(merged.sandbox) ? merged.sandbox : {}
  const out: string[] = []
  if ((await sha256(canonical(layers.local))) !== r.frozen.post) out.push('local')
  if (sb.enabled !== true) out.push('sandbox.enabled')
  if (sb.allowUnsandboxedCommands !== false) out.push('sandbox.allowUnsandboxedCommands')
  const ctx = { home: h.home, root: r.root, protectedPaths: [h.claudeDir, `${h.home}/.snagon`, ...(await pluginRoots(h))], denyRead: [] }
  out.push(...(await sandboxRefusals(layers, ctx)).map(x => `${x.layer}:${x.key}`))
  if (r.frozen.sandbox !== undefined && canonical(effectiveOf(merged)) !== r.frozen.sandbox) out.push('effective')
  return out
}

async function afterProbe(h: FlowHost, r: FlowRecord, out: unknown): Promise<void> {
  if (isObj(out) && out.deny !== undefined) return // the guard refused it: no probe ran
  const { exit, text } = probeResult(out)
  const refused = probeShowsSandbox(exit, text)
  // the control: the same request from the mod's own process, outside Claude's sandbox; when it cannot reach the network
  // either (offline, DNS down), main's failure says nothing about the sandbox: inconclusive, its own block (SEC13-1, S13-7)
  const reason = !refused ? 'sandboxMismatch'
    : !(await h.io.run([...CONTROL_ARGV], { timeoutMs: 8000 }).then(c => c.exitCode === 0, () => false)) ? 'probeInconclusive'
    : (await sandboxProblems(h, r)).length ? 'sandboxMismatch' : null
  if (reason) {
    await mutateSession(h, s => ({ ...s, sandbox: s.sandbox === 'on' ? 'changed' : null }))
    await blockFlow(h, r.flowId, { reason, vars: {} })
    return
  }
  if (r.frozen.sandbox === undefined) {
    const merged = await h.settings()
    let cfg: Awaited<ReturnType<typeof cfgHash>>
    try { cfg = await cfgHash(h.io, r.root, await gitPaths(h.io, r.root), h.home) } catch (err) {
      await blockFlow(h, r.flowId, { reason: 'couldNotRun', vars: { detail: fill(h.language, 'cfg.unreadable', { detail: cfgDetail(err) }) } })
      return
    }
    // GAP-054-9: freeze what the owner approved, never what main's S2b turn may have planted since
    if (r.frozen.cfgSeen !== undefined && seenHash(cfg.parts, r.root) !== r.frozen.cfgSeen) {
      await blockFlow(h, r.flowId, { reason: 'tampered', vars: { file: fill(h.language, 'cfg.sinceApproval', {}) } })
      return
    }
    const parts = Object.fromEntries(Object.entries(cfg.parts).map(([k, v]) => [`cfg:${k}`, v]))
    // an earlier freeze's parts go now: a re-freeze kept them until the probe, so /flow-off could compare meanwhile
    const kept = (f: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('cfg:')))
    settled(await updateRecord(h.io, h.home, r.flowId, h.sessionId, x => ({ ...x, frozen: { ...kept(x.frozen), sandbox: canonical(effectiveOf(merged)), hCfg: cfg.hash, ...parts }, ...(x.phase === 'setup' && x.task === 'S2b' ? { task: 'S3' } : {}) })))
    if (r.phase === 'setup') await h.submit(CHECK_PROMPT)
  }
  await mutateSession(h, s => ({ ...s, sandbox: 'on' }))
}

/** After main's call (tool.call, after next, once the guard's recheck passed, so the file holds exactly what the window
 * allowed): the S2b Write asks for the probe, which checks the settings as the engine reads them; the probe in any later
 * session too. */
export async function afterSetupCall(h: FlowHost, r: FlowRecord, tool: string, input: Record<string, unknown>, out: unknown): Promise<void> {
  if (tool === 'Bash' && String(input.command ?? '').trim() === PROBE_COMMAND) return afterProbe(h, r, out)
  if (tool !== 'Write' || r.frozen.sandbox !== undefined || r.frozen.post === undefined || input.file_path !== `${r.root}/${LOCAL_SETTINGS}`) return
  if (isObj(out) && out.deny === undefined && out.isError !== true) await h.submit(PROBE_PROMPT)
}
