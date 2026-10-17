// Types of the flow data (plan v7.1 §3–§8): tasks and caps, routing, stacks, rubrics, Definition of Done and texts.
// The data lives in typed modules, not JSON: a hooks module imports only script files, and `claude plugin test`
// has no real file system to read JSON from.

export type Phase = 'setup' | 'plan' | 'build' | 'verify' | 'ship'
/** Who does the task: the mod itself, the owner's attested command, the orchestrating session, or a routed agent. */
export type Actor = 'mod' | 'owner' | 'main' | 'agent'
export type CapScope = 'plan' | 'feature' | 'verify'
/** e = edit rounds (round 0 included), r = joint review rounds, d = debug attempts (one debug ticket = one attempt). */
export type Caps = { readonly e: number; readonly r: number; readonly d: number }
/** red: writes the failing eval tests (B1); author: implements (B2) and fixes; debugger: failing tests; buildFixer: build
 * and type errors (plan §3 B3). */
export type Role = 'planner' | 'red' | 'author' | 'reviewer' | 'securityReviewer' | 'debugger' | 'buildFixer'

export type Task = {
  readonly id: string
  readonly phase: Phase
  readonly title: string
  readonly actor: Actor
  readonly role?: Role
  /** Roles the task hands tickets to besides its own (debug and fix tickets, the security review). */
  readonly extraRoles?: readonly Role[]
  readonly scope?: CapScope
  /** The task runs approved commands (counted in the judge-run bound of its scope). */
  readonly usesJudge?: boolean
  /** Named outputs: `record.*` (the flow record), `view.*` (files the mod writes, never read back unverified), `repo.*`. */
  readonly writes: readonly string[]
  /** Named inputs: earlier writes, repository sources, or packs built from earlier writes (see DERIVED). */
  readonly reads: readonly string[]
}

export type Model = 'opus' | 'sonnet' | 'haiku'
export type Routing = {
  readonly agents: Readonly<Record<Role, { readonly agent: string; readonly typescript?: string; readonly model: Model }>>
  readonly skills: Readonly<Record<Role, readonly string[]>>
  readonly references: Readonly<Record<Role, readonly string[]>>
  /** Loaded first by every agent when the project is a Claude Code plugin or mod (owner rule, 2026-10-12). */
  readonly pluginProjectSkills: readonly string[]
  /** Agent types a non-ticket spawn may use while flow is active. */
  readonly freeSpawn: readonly string[]
  /** Built-in tools allowed while flow is active before the owner adds extras in the setup echo. */
  readonly allowTools: readonly string[]
  readonly vendored: { readonly skills: readonly string[]; readonly agents: readonly string[]; readonly references: readonly string[] }
}

/** One failure pattern (JS regex source, matched per line after ANSI codes are stripped). Named groups: file, test, id,
 * rule, message. A fileHeader sets the file for the entries under it (block formats: eslint stylish, jest). */
export type FailurePattern = {
  readonly runner: string
  readonly entry: string
  readonly fileHeader?: string
  /** The whole file failed (a collection or import error), not one test. */
  readonly collection?: boolean
  /** The failure's message is the next non-empty line (vitest, jest print it under the test name). */
  readonly messageNext?: boolean
  /** Stop reading this runner's output at this line (jest repeats every failure in a summary). */
  readonly stopAt?: string
}
export type PackageManager = { readonly id: string; readonly lockfiles: readonly string[]; readonly domains: readonly string[]; readonly cacheDirs: readonly string[] }

export type Stack = {
  readonly id: string
  readonly detect: { readonly files: readonly string[] }
  /** package.json script names tried in order for each command; the owner approves the resolved argv at S2. */
  readonly scripts: Readonly<Record<'test' | 'typecheck' | 'lint' | 'build', readonly string[]>>
  /** Anchored on each runner's summary line; group 1 is the number. */
  readonly counters: readonly { readonly runner: string; readonly passed: string; readonly failed: string; readonly skipped: string }[]
  readonly failures: readonly FailurePattern[]
  /** RED: what an assertion failure looks like, and the import errors RED accepts (named groups module, symbol). */
  readonly red: { readonly assertion: readonly string[]; readonly moduleNotFound: readonly string[]; readonly missingExport: readonly string[] }
  readonly packageManagers: readonly PackageManager[]
  /** Publishing commands denied while flow is active: a tool followed (after options) by one of the subcommands, or a release tool. */
  readonly publish: {
    readonly tools: readonly string[]
    readonly subcommands: readonly string[]
    /** Words between the tool and the subcommand (`yarn npm publish`). */
    readonly prefixes: Readonly<Record<string, readonly string[]>>
    /** Options that take the next word as their value, so it is not the subcommand (`npm --workspace pkg publish`). */
    readonly valueOptions: readonly string[]
    readonly releaseTools: readonly string[]
  }
  readonly registryAuthEnv: readonly string[]
  /** Credential files the proposed sandbox block makes unreadable for Bash. */
  readonly sandbox: { readonly denyRead: readonly string[] }
  readonly securityPatterns: readonly string[]
  readonly testFiles: readonly string[]
  readonly entrypoints: readonly string[]
  readonly dependencyDirs: readonly string[]
  readonly buildOutputs: readonly string[]
  readonly loopbackPorts: readonly number[]
  readonly filterFlag: Readonly<Record<string, string>>
}

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export type Criterion = {
  readonly id: string
  readonly axis: 'correctness' | 'readability' | 'architecture' | 'security' | 'performance' | 'testing'
  readonly text: string
  /** The highest severity a reviewer may give this criterion (higher is clamped). */
  readonly max: Severity
  /** `det`: judged only by the mod's scans; a reviewer finding on it is dropped. */
  readonly kind: 'llm' | 'det'
}
export type Rubric = { readonly id: string; readonly criteria: readonly Criterion[] }

export type DodRow = {
  readonly id: string
  readonly level: 'task' | 'feature' | 'release'
  readonly text: string
  /** The check that decides the row, or exactly NOT_CHECKED when no check exists in this release. */
  readonly check: string
}

export type Language = 'vi' | 'en'
/** Owner-facing texts; `{address}` and the other `{names}` are filled by the mod. */
export type Templates = Readonly<Record<Language, Readonly<Record<string, string>>>>
