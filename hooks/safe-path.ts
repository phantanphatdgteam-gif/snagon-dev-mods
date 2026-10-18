// The PATH of every process the mod starts (debt NK-02, plan 0.5.4 §3). The mod runs git, the runner hash's find, sort,
// xargs and readlink, setup's env and sed, the journal's cat, and the handoff worker's claude outside Claude's sandbox,
// found by name through PATH: an entry the agent's Bash can write (relative, inside the project, a temp folder, a
// sandbox write path) would let it put its own program first. Pure: the caller lists the places and resolves real paths.
import { writableIncludes } from './flow-git'

/** The PATH when the host gives none, when no entry is left, or when anything may be written: the system folders,
 * which System Integrity Protection keeps read-only. */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/** Temp folders Bash can write on macOS whatever the settings say, in both spellings (TMPDIR is added by the caller). */
export const TEMP_PLACES: readonly string[] = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/var/tmp', '/private/var/tmp']
/** Shown in the echo when the PATH could not be worked out and the system folders are used instead. */
export const PATH_UNCHECKED = '(the PATH could not be checked; the system folders are used)'

/**
 * `path` without its unsafe entries: empty or relative ones, and those that are, as written or as their real path
 * (`real`: entry → real path), one of `places` or under one, compared without letter case as writableIncludes does.
 * The rest keep their order; `dropped` lists each unsafe entry once. A place that is the whole disk (`/`) leaves only
 * the system folders.
 */
export function safePath(path: string, places: readonly string[], real: Readonly<Record<string, string>> = {}): { path: string; dropped: string[] } {
  const entries = path.split(':')
  // a place that is the whole disk however it is spelled (`/`, `//`, `/tmp/..`): only the system folders stay
  const everywhere = places.some(p => p.startsWith('/') && p.split('/').reduce<string[]>((at, s) => (s === '' || s === '.' ? at : s === '..' ? at.slice(0, -1) : [...at, s]), []).length === 0)
  const system = new Set(SYSTEM_PATH.split(':'))
  const unsafe = (e: string): boolean => !e.startsWith('/') || (everywhere ? !system.has(e) : writableIncludes([e, ...(real[e] ? [real[e]] : [])], places).length > 0)
  const kept = entries.filter(e => !unsafe(e))
  return { path: kept.length ? kept.join(':') : SYSTEM_PATH, dropped: [...new Set(entries.filter(unsafe))] }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const field = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined)
const EDIT_PATH = /^(?:Edit|Write|MultiEdit|NotebookEdit)\((.+)\)$/
/** What a settings merge lets Bash write besides the project: the sandbox's allowWrite, the extra directories, and the
 * absolute (`//x`) or home (`~/x`) path of an Edit-family allow rule up to its first glob (a project-relative rule is
 * inside the project already); a rule that opens the whole disk is `/`. */
export function settingsPlaces(merged: unknown): string[] {
  const permissions = field(merged, 'permissions')
  const rules = strings(field(permissions, 'allow')).flatMap(r => EDIT_PATH.exec(r.trim())?.[1] ?? [])
    .filter(p => p.startsWith('//') || p.startsWith('~/')).map(p => (p.startsWith('//') ? p.slice(1) : p).replace(/\/?[^/]*[*?[{].*$/, '') || '/')
  return [...strings(field(field(field(merged, 'sandbox'), 'filesystem'), 'allowWrite')), ...strings(field(permissions, 'additionalDirectories')), ...rules].filter(Boolean)
}

/** Where `path` lands: the real path of its deepest existing ancestor (`realOf` answers for paths that exist) with the
 * rest appended, so a folder that does not exist yet under a link into the project is still found there. */
export async function realPathOf(path: string, realOf: (p: string) => Promise<string | undefined>): Promise<string | undefined> {
  const parts = path.split('/').filter(Boolean)
  for (let i = parts.length; i > 0; i -= 1) {
    const real = await realOf(`/${parts.slice(0, i).join('/')}`)
    if (real) return [real.replace(/\/+$/, ''), ...parts.slice(i)].join('/') || '/'
  }
  return undefined
}

/** The places Bash can write, as written (`~/` expanded) and as real paths: the project, TMPDIR, the temp folders and
 * `extra` (settings places, cache folders). */
export async function writePlaces(o: { root: string; tmp: string; home: string; extra: readonly string[] }, realOf: (p: string) => Promise<string | undefined>): Promise<string[]> {
  const given = [o.root, o.tmp, ...TEMP_PLACES, ...o.extra.map(p => (p === '~' || p.startsWith('~/') ? `${o.home}${p.slice(1)}` : p))].filter(p => p.startsWith('/'))
  return [...new Set([...given, ...(await Promise.all(given.map(p => realPathOf(p, realOf)))).filter((p): p is string => Boolean(p))])]
}

/** The host PATH filtered (safePath) against the write places, each entry also taken at its real path. */
export async function filteredPath(host: string, o: { root: string; tmp: string; home: string; extra: readonly string[] }, realOf: (p: string) => Promise<string | undefined>): Promise<{ path: string; dropped: string[] }> {
  const places = await writePlaces(o, realOf)
  const entries = host.split(':').filter(e => e.startsWith('/'))
  const real = Object.fromEntries((await Promise.all(entries.map(async e => [e, await realPathOf(e, realOf)] as const))).filter((x): x is readonly [string, string] => Boolean(x[1])))
  return safePath(host, places, real)
}
