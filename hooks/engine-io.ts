// The engine-side helpers register.ts and flow-wiring.ts share (R2 plan step 1a): the session facts, the mod's io with
// the filtered PATH, the one-line-per-kind log and the tool answer shape. Moved out of register.ts unchanged: the
// engine lets `$` and `on` reach only functions declared at the top of a file or imported from the mod's own files.
import type { CoreEngineInterface } from 'claude-code'
import { computeFacts, type Io, type SessionFacts } from './session'
import { filteredPath, settingsPlaces, PATH_UNCHECKED, SYSTEM_PATH } from './safe-path'
import { STACKS } from '../flow/data/stacks'

type Host = CoreEngineInterface

export const S = 'snagon-dev-mods'

let safeEnv: Promise<{ path: string; dropped: string[] }> | undefined
let hostFuncs: Promise<string[]> | undefined
/** The PATH every process of the mod gets (safe-path.ts, NK-02), worked out once per session and again at /flow-setup;
 * when it cannot be (settings unreadable too), the system folders with a marker the setup echo shows, and the next call
 * tries again: never the host PATH as it is. */
export function safeEnvOf($: Host): Promise<{ path: string; dropped: string[] }> {
  return (safeEnv ??= (async () => {
    const realOf = async (p: string): Promise<string | undefined> => (await $.fs.stat(p, { resolve: true }).catch(() => null))?.realPath
    const merged: unknown = await $.settings.read()
    const caches = STACKS.flatMap(s => s.packageManagers.flatMap(m => m.cacheDirs))
    const places = { root: await $.session.root(), tmp: (await $.env.get('TMPDIR')) ?? '', home: (await $.env.get('HOME')) ?? '', extra: [...settingsPlaces(merged), ...caches] }
    return filteredPath((await $.env.get('PATH')) ?? '', places, realOf)
  })().catch(() => { safeEnv = undefined; return { path: SYSTEM_PATH, dropped: [PATH_UNCHECKED] } }))
}
/** /flow-setup: the PATH filter reads the settings as they are now, and the environment's names are listed again. */
export function resetSafeEnv(): void { safeEnv = undefined; hostFuncs = undefined }

/** Variables a shell acts on as it starts: bash, macOS's /bin/sh, takes SHELLOPTS and BASHOPTS from the environment
 * (SHELLOPTS=noexec makes every `sh -c` exit 0 having run nothing, xtrace prints what it runs), and BASH_ENV and ENV name
 * a file it runs first. `$.process` sets variables over the host's own environment and cannot unset one; empty, each is
 * off (owner decision, R2 step 11). */
export const SHELL_RESET: Readonly<Record<string, string>> = { SHELLOPTS: '', BASHOPTS: '', BASH_ENV: '', ENV: '' }
/** A name bash defines a function from as it starts (`BASH_FUNC_<name>%%`, its value `() { …`): macOS's /bin/sh then
 * runs that function for a builtin such as printf, read or cd and for a command found on PATH, as the hash scripts'
 * find, sort and xargs. An empty value is ignored, in grandchildren too (owner decision after step 11, checked on
 * bash 3.2.57). */
export const isFuncName = (name: string): boolean => name.startsWith('BASH_FUNC_') && name.endsWith('%%')
/** Prints the environment's names, one a line, then the end mark `=`, never a value. awk, not a shell: /bin/sh would
 * first import the very functions this lists (an inherited BASH_FUNC_printf%% replaces printf, checked). */
export const ENV_LIST_ARGV: readonly string[] = ['/usr/bin/awk', 'BEGIN { for (k in ENVIRON) print k; print "=" }']
/** The function names of a listing. One that failed or lacks its end mark throws, never reads as none, and names the
 * exit status only. A name with a line break in it reads as pieces: bash refuses such a function, and a piece that
 * looks like a function name is only set empty (checked). */
export function funcNamesOf(r: { exitCode: number; stdout: string }): string[] {
  if (r.exitCode !== 0 || !(r.stdout === '=\n' || r.stdout.endsWith('\n=\n'))) throw new Error(`${S}: the environment's names could not be listed (exit ${r.exitCode}${r.exitCode === 0 ? ', unfinished' : ''})`)
  return [...new Set(r.stdout.split('\n').filter(isFuncName))]
}
/** The host's function names, listed once per session and again at /flow-setup, as the PATH; a listing that fails is
 * not kept, so no child starts until one succeeds. */
function hostFuncNamesOf($: Host): Promise<string[]> {
  return (hostFuncs ??= (async () => funcNamesOf(await $.process.run(ENV_LIST_ARGV, { env: childEnvWith((await safeEnvOf($)).path) })))()
    .catch(e => { hostFuncs = undefined; throw e }))
}
/** What every child of the mod gets over the host's environment: the caller's variables, then SHELL_RESET, each
 * function name (the host's, `funcs`, and any the caller passes) empty, and the filtered PATH, which no caller can
 * replace. */
export const childEnvWith = (path: string, env: Readonly<Record<string, string>> = {}, funcs: readonly string[] = []): Record<string, string> =>
  ({ ...env, ...SHELL_RESET, ...Object.fromEntries([...funcs, ...Object.keys(env).filter(isFuncName)].map(n => [n, ''])), PATH: path })
export async function childEnv($: Host, env?: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const path = (await safeEnvOf($)).path
  return childEnvWith(path, env, await hostFuncNamesOf($))
}

export function ioOf($: Host): Io {
  return {
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    list: path => $.fs.list(path),
    // a bare program name goes through env, which looks it up on the child's (filtered) PATH whatever the engine does
    run: async (argv, init) => $.process.run(argv[0]?.includes('/') ? argv : ['/usr/bin/env', ...argv], { ...init, env: await childEnv($, init?.env) }),
    now: () => $.clock.now(),
    pluginRoot: $.plugin.root,
  }
}

let cached: SessionFacts | undefined
export async function facts($: Host, refresh = false): Promise<SessionFacts> {
  if (!cached || refresh) cached = await computeFacts(ioOf($), await $.session.root(), (await $.env.get('HOME')) ?? '')
  return cached
}

// One log line per kind of failure, so a broken folder does not log on every call.
const noted = new Set<string>()
export function note($: Host, kind: string, text: string): void {
  if (noted.has(kind)) return
  noted.add(kind)
  try { $.ui.log(`${S}: ${text}`) } catch { /* no surface */ }
}

export const answer = (text: string) => (text.startsWith('refused:') ? { deny: text } : { result: text as never })
