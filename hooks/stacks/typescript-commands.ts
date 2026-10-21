// The TypeScript stack's commands (moved in R2 step 1, unchanged): the package scripts S1 proposes, the runner each one
// names and the flags that make a failing check pass (hooks/flow-setup.ts); the script body a command runs
// (hooks/flow-run.ts); how the judge runs a runner, with its JSON report and caches (hooks/flow-judge.ts), and the npm
// config it runs with; registry credentials in the environment and in project files (hooks/flow-sandbox.ts).
import type { Io } from '../session'
import type { FlowCommand } from '../flow-state'
import type { Stack } from '../../flow/data/types'
import { scriptNames } from './typescript-sources'

const RUNNERS = ['vitest', 'jest', 'tsc', 'eslint']
/** What makes a failing check pass, in a command line or a script body. */
const WEAK = [/--pass-?with-?no-?tests(?![\w-])/i, /\|\|\s*(?:true|:|exit\s+0)(?![\w-])/, /;\s*exit\s+0(?![\w-])/, /--no-error-on-unmatched-pattern(?![\w-])/]
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const base = (x: string): string => x.slice(x.lastIndexOf('/') + 1)

/** The runner a command line or script body names (`npx vitest run` is vitest), else its first program. */
export const runnerOf = (tokens: readonly string[]): string => {
  const names = tokens.map(base).filter(n => n && !n.includes('='))
  return names.find(n => RUNNERS.includes(n)) ?? names.find(n => n !== 'npx') ?? ''
}
/** The flags in a command line or script body that make a failing check pass. */
export const weakFlags = (text: string): string[] => WEAK.flatMap(re => { const m = re.exec(text); return m ? [m[0].replace(/\s+/g, ' ')] : [] })

/** The stack's commands: a package script per id (`npm test`, `pnpm run lint`), an override's argv (split on spaces, no
 * shell quoting), or none (`<id>=none` drops it, GAP-step10-11). `manifest`: package.json's text, null when absent;
 * text that is not JSON throws. */
export function proposeCommands(stack: Stack, manifest: string | null, pm: string, overrides: Readonly<Record<string, string>>): { commands: FlowCommand[]; scripts: Record<string, string> } {
  const pkg: unknown = manifest === null ? null : JSON.parse(manifest)
  const scripts = isObj(pkg) && isObj(pkg.scripts) ? pkg.scripts : {}
  const commands: FlowCommand[] = [], bodies: Record<string, string> = {}
  for (const [id, names] of Object.entries(stack.scripts ?? {})) {
    const over = overrides[id]
    if (over === 'none') continue
    const name = names.find(n => typeof scripts[n] === 'string')
    const argv = over !== undefined ? over.split(/\s+/).filter(Boolean) : name ? (name === 'test' && pm !== 'bun' ? [pm, 'test'] : [pm, 'run', name]) : []
    if (!argv.length) continue
    const run = scriptNames([argv])[0], body = run !== undefined ? scripts[run] : undefined
    if (typeof body === 'string') bodies[id] = body
    commands.push({ id, argv, runner: runnerOf(typeof body === 'string' ? body.split(/\s+/) : argv), mode: 'must-pass' })
  }
  return { commands, scripts: bodies }
}

/** The body of the package script an approved command line runs, when it runs one. */
export async function scriptBody(io: Io, root: string, argv: readonly string[]): Promise<string | undefined> {
  const name = scriptNames([argv])[0]
  if (name === undefined) return undefined
  const pkg: unknown = JSON.parse(await io.read(`${root}/package.json`).catch(() => '{}'))
  const body = typeof pkg === 'object' && pkg !== null ? (pkg as { scripts?: Record<string, unknown> }).scripts?.[name] : undefined
  return typeof body === 'string' ? body : undefined
}

const RUN_FLAGS: Readonly<Record<string, (dir: string, argv: readonly string[]) => { flags: string[]; report: boolean }>> = {
  vitest: d => ({ flags: ['--reporter=default', '--reporter=json', `--outputFile.json=${d}/report.json`], report: true }),
  jest: d => ({ flags: ['--json', `--outputFile=${d}/report.json`, '--no-cache'], report: true }),
  eslint: d => ({ flags: [`--cache-location=${d}/eslintcache`], report: false }),
  tsc: (_d, argv) => ({ flags: argv.some(a => a === '-b' || a === '--build') ? ['--force'] : ['--incremental', 'false', '--composite', 'false'], report: false }),
}
/**
 * The command as the judge runs it: the runner's JSON report requested into `runDir` (a fresh folder per run) and its
 * caches turned off or moved there (an edited cache would change results with no diff). Possible when the runner is
 * named in the command or the command is a package-manager script whose body is that runner alone; otherwise the
 * command runs as approved, with no report.
 */
export function judgedArgv(argv: readonly string[], runner: string, runDir: string, scriptBody?: string): { argv: string[]; reportFile: string | null } {
  const pm = base(argv[0] ?? ''), sub = argv[1] ?? '', named = Boolean(argv[2])
  const script = (pm === 'npm' && (sub === 'test' || ((sub === 'run' || sub === 'run-script') && named))) || ((pm === 'pnpm' || pm === 'yarn') && (sub === 'test' || (sub === 'run' && named))) || (pm === 'bun' && sub === 'run' && named)
  const body = script ? (scriptBody ?? '').trim() : ''
  const single = script && new RegExp(`^(?:npx\\s+)?${runner}(?:\\s|$)`).test(body) && !/[;&|<>`$()]/.test(body)
  const make = RUN_FLAGS[runner]
  if (!make || !(single || (!script && argv.some(a => base(a) === runner)))) return { argv: [...argv], reportFile: null }
  const { flags, report } = make(runDir, single ? body.split(/\s+/) : argv)
  const dashes = single && pm === 'npm' && !argv.slice(2).includes('--') ? ['--'] : []
  return { argv: [...argv, ...dashes, ...flags], reportFile: report ? `${runDir}/report.json` : null }
}

/** No user or global npm config in the judge: npm refuses one file as both, so the global one is an empty file the
 * mod ships. */
export const judgeEnv = (o: { pluginRoot: string }): string[] => ['npm_config_userconfig=/dev/null', `npm_config_globalconfig=${o.pluginRoot}/flow/empty.npmrc`]

/** Registry credentials in the environment, by name (values are never read): the stack's list and npm_config auth keys. */
export const authEnvNames = (names: readonly string[], stack: Stack): string[] =>
  names.filter(n => stack.registryAuthEnv.includes(n) || /^npm_config_.*_auth/i.test(n))

/** Whether a project .npmrc or .yarnrc.yml holds a registry credential (comment lines aside). */
export const npmrcHasAuth = (text: string): boolean =>
  text.split('\n').some(l => !/^\s*[#;]/.test(l) && /(^|[^\w])(_auth|_authToken|npmAuthToken)\s*[=:]/.test(l))
