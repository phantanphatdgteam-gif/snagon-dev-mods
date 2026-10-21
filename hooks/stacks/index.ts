// The stack registry (R2 plan §3.1): each stack's data (flow/data/stacks/<id>.ts) with its code (hooks/stacks/<id>.ts),
// by id. The core reaches a stack only through here; a flow reads its stack from the record (frozen at S2), and an id
// this mod does not know is never guessed: flow_check blocks couldNotRun naming it (AC-CORE-5), stackOf throws anywhere
// else. Stack code imports only the core's lower modules (never this file's importers), so no import cycle runs.
import type { Stack } from '../../flow/data/types'
import type { Report } from '../../flow/parse'
import type { GitPaths } from '../flow-git'
import type { DeclChanges } from '../flow-judge'
import type { DiffFile, LexedLine, Line, RedShape, ScanCtx, ScanFinding, View } from '../flow-scan'
import type { FlowCommand } from '../flow-state'
import type { RunnerState } from '../flow-tree'
import type { Io } from '../session'
import { PYTHON_STACK } from './python'
import { TYPESCRIPT_STACK } from './typescript'

/** What the core asks of a stack's code; hooks/stacks/typescript.ts and python.ts show each member's forms. */
export type StackCode = {
  // S1 and the judged runs
  /** The commands the manifest proposes, with the script bodies they run (`manifest` null: the file is absent;
   * `rootNames`: the names in the project's root folder). */
  readonly proposeCommands: (manifest: string | null, manager: string, overrides: Readonly<Record<string, string>>, rootNames: readonly string[]) => { commands: FlowCommand[]; scripts: Record<string, string> }
  /** The flags in a command line or script body that make a failing check pass. */
  readonly weakFlags: (text: string) => string[]
  /** Registry credentials in the environment, by name; whether a project auth file (data `authFiles`) holds one. */
  readonly authEnvNames: (names: readonly string[]) => string[]
  /** The variables that can hold a registry URL: setup refuses one whose URL carries a password, reading the values
   * only in a child process that prints names (F19). A stack without it has none. */
  readonly urlEnvNames?: (names: readonly string[]) => string[]
  readonly hasAuth: (file: string, text: string) => boolean
  /** What the judged form of a command needs from the project as it is now: the package script's body (TypeScript),
   * the root's config file of the runner (Python). */
  readonly judgeInput: (io: Io, root: string, argv: readonly string[]) => Promise<string | undefined>
  /** The options a command's runner takes from the project's config and the file they are in (Python: pytest's addopts),
   * for the setup echo's weak flags; null when it takes none there. */
  readonly configOptions?: (io: Io, root: string, argv: readonly string[]) => Promise<{ file: string; text: string } | null>
  /** The command as the judge runs it, and the report file it asks the runner for (null: none). `load`: the plugins
   * runner integrity froze for the judge to load by name (RunnerState.load). */
  readonly judged: (argv: readonly string[], runner: string, runDir: string, input?: string, load?: readonly string[]) => { argv: string[]; reportFile: string | null }
  /** Environment lines the judge sets for the stack's tools, beside the core's own. */
  readonly judgeEnv: (o: { pluginRoot: string; runDir: string }) => string[]
  /** A report the judged run asked for, read with the run's output; null when it is missing, cannot be read or the
   * output contradicts it. */
  readonly readReport: (text: string, root: string, run: { readonly output: string; readonly stdout?: string }) => Report | null
  // what S2 freezes and every flow_check compares
  readonly commandSources: (io: Io, p: GitPaths, argvs: ReadonlyArray<readonly string[]>) => Promise<{ hashes: Record<string, string>; reached: string[]; setupChain: string[] }>
  readonly cmdSourceVerdict: (changed: readonly string[], texts: Readonly<Record<string, { before: string; after: string }>>, fFiles: readonly string[], reached?: readonly string[], setupChain?: readonly string[]) => { cmdSrc: string[]; dependencyOnly: string[]; declared: string[]; forceSecurity: boolean }
  /** Runner integrity (R2 step 6): the whole tree the approved runners load, hashed (flow-tree.ts), with the facts, the
   * plugins and the refusals of RunnerState; throws TreeError when the tree cannot be pinned. `home` expands `~`. */
  readonly runnerIntegrity: (io: Io, top: string, commands: readonly FlowCommand[], home: string) => Promise<RunnerState>
  /** The standard library of each base interpreter the approved commands start from (GAP-R2-0.6-7): outside the project
   * and allowWrite, so S1 hashes it once for the setup echo (null: not found or unreadable); nothing checks it again. */
  readonly baseLibraries?: (io: Io, top: string, commands: readonly FlowCommand[]) => Promise<Array<{ path: string; hash: string | null }>>
  /** The hash a record frozen before 0.6.0 holds as `runner` (no `runner:v2`), compared the old way until its re-freeze
   * (GAP-R2-0.6-27); a stack without one counts such a record's runner as changed. */
  readonly runnerV1?: (io: Io, top: string, commands: readonly FlowCommand[]) => Promise<string>
  /** Why an accepted dependency change may not re-baseline the runner hash (what it added; AC-RI-3), or null. A stack
   * without it re-baselines on its hash alone. */
  readonly rebaseBlock?: (frozen: string, now: string) => string | null
  /** Tool caches in the project that the judged run moves out first, root-relative. */
  readonly cacheFiles: (io: Io, p: GitPaths) => Promise<string[]>
  // the scans and the RED freeze
  /** A file's kept lines lexed, carrying state across lines; null when it is not one of the stack's code files. */
  readonly lex: (path: string, kept: readonly Line[]) => LexedLine[] | null
  /** Whether the lexer reads this file whole reliably (default yes); no: it is lexed hunk by hunk (TypeScript's JSX). */
  readonly lexWhole?: (path: string) => boolean
  readonly scanFile: (f: DiffFile, v: View, ctx: ScanCtx, isTest: boolean, out: ScanFinding[]) => void
  /** `texts`: the RED tree's text of the test files, for a stack that reads them whole. */
  readonly redShape: (files: readonly DiffFile[], testFiles: readonly string[], texts?: Readonly<Record<string, string>>) => Record<string, RedShape>
  readonly redFindings: (files: readonly DiffFile[], red: Readonly<Record<string, RedShape>>, texts: Readonly<Record<string, string>>) => ScanFinding[]
  // test code and imports
  // texts: files whole on a side of the diff, where the caller has them (a stack that reads code may need them)
  readonly declChanges: (files: readonly DiffFile[], testFiles: readonly string[], texts?: { before?: Readonly<Record<string, string>>; now?: Readonly<Record<string, string>> }) => Required<DeclChanges>
  readonly addedTests: (files: readonly DiffFile[], testFiles: readonly string[], now?: Readonly<Record<string, string>>) => Array<{ file: string; name: string }>
  readonly importsOf: (lines: readonly string[]) => Map<string, { spec: string; name: string }>
  /** An import spec as a root-relative path (null: a package), and the files a module path can load. */
  readonly resolveImport: (from: string, spec: string) => string | null
  readonly moduleFiles: (rel: string) => string[]
  readonly evalIdsInTests: (io: Io, p: GitPaths, testGlobs: readonly string[]) => Promise<Map<string, string[]>>
  /** Whether the diff forces `Security: yes`. */
  readonly securityForced: (files: readonly DiffFile[]) => boolean
}
export type StackEntry = { readonly data: Stack; readonly code: StackCode }

/** Every stack the mod knows, in the order S1 tries them (flow/data/stacks.ts lists their data in the same order). */
export const STACK_ENTRIES: readonly StackEntry[] = [TYPESCRIPT_STACK, PYTHON_STACK]
export const stackById = (id: string | undefined): StackEntry | null => STACK_ENTRIES.find(s => s.data.id === id) ?? null
/** Why a record's stack cannot be used (the couldNotRun detail). */
export const unknownStack = (id: string | undefined): string => (id === undefined ? 'the record holds no stack' : `the record names the stack "${id}", which this version of the mod does not know`)
/** The stack the record froze at S2. Throws on one this mod does not know; flow_check blocks on it first (AC-CORE-5). */
export function stackOf(r: { readonly setup?: { readonly stack: string } }): StackEntry {
  const s = stackById(r.setup?.stack)
  if (!s) throw new Error(`flow: ${unknownStack(r.setup?.stack)}`)
  return s
}
