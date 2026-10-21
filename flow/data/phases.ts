// The MVP task chain (plan v7.1 §3): each task's writes and reads, and the caps per scope. A unit test checks that every
// read comes from an earlier write, a repository source or a pack built from earlier writes.
import type { CapScope, Caps, Task } from './types'

export const TASKS: readonly Task[] = [
  { id: 'S1', phase: 'setup', title: 'Detect', actor: 'mod', writes: ['record.setupDraft', 'view.setupDraft'], reads: ['repo.manifests', 'repo.ci', 'settings.sandbox'] },
  { id: 'S2', phase: 'setup', title: 'Approve setup', actor: 'owner', writes: ['record.approval.setup', 'record.frozen'], reads: ['record.setupDraft'] },
  { id: 'S2b', phase: 'setup', title: 'Write the sandbox block', actor: 'main', writes: ['settings.local.sandbox'], reads: ['record.approval.setup'] },
  { id: 'S3', phase: 'setup', title: 'Baseline', actor: 'mod', usesJudge: true, writes: ['record.baseline', 'view.boundary'], reads: ['record.frozen', 'settings.local.sandbox'] },
  { id: 'S4', phase: 'setup', title: 'Accept the baseline', actor: 'owner', writes: ['record.approval.baseline'], reads: ['record.baseline'] },
  { id: 'P1', phase: 'plan', title: 'Plan', actor: 'agent', role: 'planner', scope: 'plan', writes: ['repo.plan'], reads: ['repo.rules', 'owner.intent'] },
  { id: 'P2', phase: 'plan', title: 'Lint the plan', actor: 'mod', writes: ['record.lint', 'view.boundary'], reads: ['repo.plan', 'repo.files'] },
  { id: 'P3', phase: 'plan', title: 'Approve the plan', actor: 'owner', writes: ['record.approval.plan', 'record.featureKeys'], reads: ['record.lint'] },
  { id: 'B1', phase: 'build', title: 'RED', actor: 'agent', role: 'red', scope: 'feature', usesJudge: true, writes: ['repo.tests', 'record.redTestHash'], reads: ['pack.feature'] },
  { id: 'B2', phase: 'build', title: 'Implement', actor: 'agent', role: 'author', scope: 'feature', writes: ['repo.diff', 'record.assumptions'], reads: ['pack.feature'] },
  { id: 'B3', phase: 'build', title: 'Judge', actor: 'mod', extraRoles: ['debugger', 'buildFixer'], scope: 'feature', usesJudge: true, writes: ['record.verification', 'view.debug'], reads: ['repo.diff', 'record.frozen', 'record.baseline', 'record.redTestHash'] },
  { id: 'B4', phase: 'build', title: 'Review', actor: 'agent', role: 'reviewer', extraRoles: ['securityReviewer', 'author'], scope: 'feature', writes: ['record.findings'], reads: ['ticket.artifact', 'ticket.contract'] },
  { id: 'B5', phase: 'build', title: 'Seal', actor: 'mod', writes: ['record.seal', 'view.feature'], reads: ['record.verification', 'record.findings'] },
  { id: 'V1', phase: 'verify', title: 'Full run', actor: 'mod', extraRoles: ['debugger', 'buildFixer'], scope: 'verify', usesJudge: true, writes: ['record.verification'], reads: ['record.seal', 'record.baseline'] },
  { id: 'V2', phase: 'verify', title: 'Reconcile the ACs', actor: 'mod', writes: ['record.reconcile'], reads: ['record.verification', 'repo.plan'] },
  { id: 'V4', phase: 'verify', title: 'Introduced junk', actor: 'mod', extraRoles: ['author'], scope: 'verify', writes: ['record.junk', 'view.junk'], reads: ['repo.diff', 'record.baseline'] },
  { id: 'V8', phase: 'verify', title: 'Report', actor: 'mod', writes: ['view.verify', 'record.verifiedTree', 'record.verifyMdHash'], reads: ['record.reconcile', 'record.junk', 'record.verification', 'record.findings', 'record.assumptions'] },
  { id: 'H0', phase: 'ship', title: 'Commit', actor: 'main', writes: ['repo.commit'], reads: ['view.verify'] },
  { id: 'H1', phase: 'ship', title: 'Approve the release', actor: 'owner', writes: ['record.approval.release', 'record.releaseTree'], reads: ['record.verifiedTree', 'record.verifyMdHash', 'repo.commit', 'record.frozen'] },
  { id: 'H2', phase: 'ship', title: 'Push', actor: 'mod', writes: ['record.done'], reads: ['record.approval.release', 'record.frozen'] },
]

/** Every blocked reason of plan §3.2 (and reportChanged: the verify report edited after V8, answered by /flow-verify);
 * each has an owner-facing text `blocked.<reason>` in both languages. `cost`: nothing raises it since 2026-10-20 (no cost
 * cap); it stays so an old record that holds it still reads. */
export const BLOCKED_REASONS: readonly string[] = [
  'cap', 'dispute', 'frozenChanged', 'cmdSrc', 'remoteChanged', 'tooSlow', 'sandboxMismatch', 'probeInconclusive', 'sandboxKey', 'tampered',
  'couldNotRun', 'cost', 'redCheck', 'floor', 'junk', 'injection', 'redTestChanged', 'pushRejected', 'viewOnly',
  'awaitingOwner', 'split', 'noSurface', 'planLint', 'publish', 'reportChanged', 'stalled',
]

/** Inputs that exist before flow starts (the repository, the owner's words, the merged settings). */
export const SOURCES: readonly string[] = ['repo.manifests', 'repo.ci', 'repo.rules', 'repo.files', 'owner.intent', 'settings.sandbox']

/** Packs and tickets the mod builds for an agent, from earlier writes (plan §7). */
export const DERIVED: Readonly<Record<string, readonly string[]>> = {
  'pack.feature': ['repo.plan', 'record.approval.plan', 'record.featureKeys'],
  'ticket.artifact': ['repo.diff', 'repo.tests'],
  'ticket.contract': ['repo.plan', 'record.approval.plan'],
}

export const CAPS: Readonly<Record<CapScope, Caps>> = {
  plan: { e: 3, r: 0, d: 0 },
  feature: { e: 3, r: 3, d: 4 },
  verify: { e: 2, r: 0, d: 3 },
}

/** What one `/flow-retry <scope>` adds, once per scope. */
export const RETRY: Readonly<Record<CapScope, Caps>> = {
  plan: { e: 1, r: 0, d: 0 },
  feature: { e: 1, r: 1, d: 2 },
  verify: { e: 1, r: 0, d: 2 },
}

/** The most judge runs a scope can cause: the first, one after each edit and review round, two per debug attempt. */
export const judgeRunBound = (c: Caps): number => 1 + c.e + c.r + 2 * c.d

/** The caps table for docs/flow.md, generated so the doc never drifts from the data. */
export function capsTable(): string {
  const rows = (Object.keys(CAPS) as CapScope[]).map(s => {
    const c = CAPS[s], r = RETRY[s]
    const dash = (n: number): string => (n ? String(n) : '—')
    const retry = ([['e', r.e], ['r', r.r], ['d', r.d]] as const).filter(([, n]) => n > 0).map(([k, n]) => `+${n} ${k}`).join(', ')
    return `| ${s} | ${dash(c.e)} | ${dash(c.r)} | ${dash(c.d)} | ${judgeRunBound(c)} | ${retry} |`
  })
  return ['| Scope | e | r (joint) | d | Judge runs at most | `/flow-retry` (once) |', '|---|---|---|---|---|---|', ...rows].join('\n')
}
