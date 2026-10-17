// snagon-dev-mods's $.state contract (session-scoped values).
export type AppendedRules = string[]
export type EditRecord = { file: string; at: number }

/** flow (plan v7.1 §2.4, §2.5, F35): what one session holds of an active flow; the record on disk is the authority. */
export type FlowEchoKind = 'setup' | 'baseline' | 'plan' | 'release' | 'waive'
export type FlowEcho = { kind: FlowEchoKind; hash: string; title: string; lines: readonly string[] }
/** The S2b window (§2.2): one Write of exactly `post` to `path` (a realpath) while the file still hashes to `preHash`. */
export type FlowS2b = { path: string; post: string; preHash: string | null }
/** The arguments of the last /flow-setup, so an approval rebuilds the same echo. */
export type FlowSetupArgs = { overrides: Record<string, string>; tools: string[]; mcp: string[] }
/** A reviewer's own words for a finding (evidence, scenario, expected fix), kept out of the record. */
export type FlowDetail = { evidence?: string; scenario?: string; expected?: string }
export type FlowSession = {
  /** Echoes shown in the flow pane and waiting for /flow-approve, by kind. */
  pending: Partial<Record<FlowEchoKind, FlowEcho>>
  /** The open S2b window; null once the first call that names the settings file closed it. */
  s2b: FlowS2b | null
  /** Ticket text by ticket id (F35: the record keeps only its sha and nonce). */
  tickets: Record<string, string>
  details: Record<string, FlowDetail>
  /** R6: a done claim was held once while the judge was not green. */
  claimHeld: boolean
  /** A done claim that was not held (a repeat): the judge state the card names until the judge is green. */
  claim: 'red' | 'missing' | 'stale' | null
  /** The echo kind the flow pane shows. */
  shown: FlowEchoKind | null
  /** The sandbox as this session last checked it against the approved block (null: not checked yet). */
  sandbox: 'on' | 'changed' | null
  /** Owner-facing lines the next card shows once (a release approval from another origin). */
  notes: readonly string[]
  /** The arguments of the setup echo waiting for approval. */
  setupArgs: FlowSetupArgs | null
  /** What the owner asked /flow-plan to build (it goes into every planner ticket). */
  intent: string | null
  /** Each ticket's run as attested when the Agent call answered (the reply itself is not kept). */
  runs: Record<string, { ok: boolean; reason?: string }>
  /** The tickets this session started (id to agent id): their turn ends come to this session; a restarted one has none. */
  started: Record<string, string>
  /** When each ticket's agent was started (ms since the epoch), for the deadline on a silent run. */
  startedAt: Record<string, number>
  /** The agents whose turn end this session heard (agent id to true): a run never waited for again. */
  ended: Record<string, boolean>
  /** The author's evidence against a finding (DISPUTE), redacted; the delta round shows it fenced. */
  disputes: Record<string, string>
  /** The waiver the pane shows, waiting for /flow-approve waive. */
  waive: { target: string; reason: string } | null
  /** The release the pane shows (H1): the commit and the hash of the commit list the scan passed; never the code. */
  release: { head: string; revsHash: string; revs: string[] } | null
  /** This session's flow spend: the session cost last seen, what has not reached the record yet (in total and by phase
   * or phase/feature), and when the record last got it with the heartbeat. */
  spend: { seen: number; pending: number; by: Record<string, number>; at: number } | null
  /** /flow-retry cost raised this session's cap by half (once per session). */
  costBoost: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'snagon-dev-mods': {
      appendedRules: AppendedRules
      edits: EditRecord[]
      gateChecked: string[]
      gateDenials: number
      notices: string[]
      installNotice: string
      addressSlips: number
      flow: FlowSession
    }
  }
}
