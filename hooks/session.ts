// What the side modules may do outside the module, as plain functions (the engine's `$` stays in register.ts,
// flow-wiring.ts and engine-io.ts, which reach each other only through function declarations, as the validator
// requires), plus facts about the session several hooks need.

export type FsItem = { name: string; kind: string; size: number; mtimeMs: number }
// is*Truncated: the engine keeps the first 4 MiB of each stream; a check that reads output refuses past it.
export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export type Io = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  list(path: string): Promise<readonly FsItem[]>
  // env: variables set over the host's own environment for this child only.
  run(argv: string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<RunResult>
  now(): Promise<number>
  pluginRoot: string
}

export type LocalConfig = { language: 'en' | 'vi'; decisionWord: string; lessonWord: string; journalDir: string; autoInstall: boolean; address: string }
// home: the user's home folder; their own files for every project live in `~/.snagon/` (outside the installed plugin,
// which a marketplace update replaces).
export type SessionFacts = { root: string; exempt: boolean; config: LocalConfig; home: string }

export const DEFAULT_CONFIG: LocalConfig = { language: 'en', decisionWord: 'Decision', lessonWord: 'Lesson', journalDir: '.snagon/journal', autoInstall: true, address: '' }
// Environment variables that mark a session started by a loop runner or by this mod's own handoff worker. SNAGON_WORKER
// is the one any harness sets; LOOP535_ROLE is the 535 loop's own name, kept (owner decision 2026-10-19; step 14 docs).
export const EXEMPT_VARS = ['LOOP535_ROLE', 'HANDOFF_WORKER', 'SNAGON_WORKER'] as const

/** Parses a config file (the user's `~/.snagon/config.json` or the project's `.snagon/config.json`); a missing, unknown or
 * bad field keeps the value from `base`. */
export function parseConfig(text: string | undefined, base: LocalConfig = DEFAULT_CONFIG): LocalConfig {
  if (!text) return base
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return base }
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  const word = (v: unknown, d: string) => (typeof v === 'string' && v.trim() && v.length <= 40 ? v.trim() : d)
  return {
    language: r.language === 'vi' || r.language === 'en' ? r.language : base.language,
    decisionWord: word(r.decisionWord, base.decisionWord),
    lessonWord: word(r.lessonWord, base.lessonWord),
    // a folder inside the project: relative, no "..", no leading slash
    journalDir: typeof r.journalDir === 'string' && /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(r.journalDir) && !r.journalDir.split('/').some(seg => seg === '..' || seg === '.') ? r.journalDir.replace(/\/+$/, '') : base.journalDir,
    autoInstall: typeof r.autoInstall === 'boolean' ? r.autoInstall : base.autoInstall,
    // how the user is addressed, for example "anh Minh" or "Chủ dự án" (written by /snagon-setup)
    address: typeof r.address === 'string' && r.address.trim().length <= 60 ? r.address.trim() : base.address,
  }
}

/** Whether any exempt variable is set, from the `printf` line `computeFacts` runs (values joined by `|`). */
export function isExemptLine(line: string): boolean {
  return line.split('|').some(value => value.trim() !== '')
}

export async function computeFacts(io: Io, root: string, home = ''): Promise<SessionFacts> {
  let exempt = false
  try {
    const script = EXEMPT_VARS.map(v => `"\${${v}:-}"`).join(' ')
    const run = await io.run(['/bin/sh', '-c', `printf '%s|%s|%s' ${script}`])
    exempt = isExemptLine(run.stdout)
  } catch { /* no shell: a normal session */ }
  // The user's config for every project (`~/.snagon/config.json`), then this project's `.snagon/config.json` (written by
  // /snagon-setup) on top.
  const read = async (p: string): Promise<string | undefined> => { try { return await io.read(p) } catch { return undefined } }
  const mine = parseConfig(home ? await read(`${home}/.snagon/config.json`) : undefined)
  const config = parseConfig(await read(`${root}/.snagon/config.json`), mine)
  // The user's own "autoInstall": false wins over a project file (a cloned repository cannot turn installs back on).
  return { root, exempt, config: mine.autoInstall ? config : { ...config, autoInstall: false }, home }
}

/** The machine's local date (YYYY-MM-DD) and clock (HH:MM) from `date`, never estimated; UTC when `date` is missing. */
export async function localNow(io: Io): Promise<{ date: string; clock: string }> {
  try {
    const run = await io.run(['/bin/date', '+%Y-%m-%d %H:%M'])
    const m = run.stdout.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/)
    if (m && m[1] && m[2]) return { date: m[1], clock: m[2] }
  } catch { /* fall through */ }
  const iso = new Date(await io.now()).toISOString()
  return { date: iso.slice(0, 10), clock: iso.slice(11, 16) }
}

/** The mod's data folder in the project; its own `.gitignore` keeps everything in it out of git. */
export async function dataDir(io: Io, root: string): Promise<string> {
  const dir = `${root}/.snagon`
  if (!(await io.exists(`${dir}/.gitignore`))) {
    await io.write(`${dir}/.gitignore`, '# Written by the snagon-dev-mods mod: everything here is per-user, per-machine data.\n*\n')
  }
  return dir
}

/** Appends text to a file without reading it back (concurrent sessions append whole lines). */
export async function appendText(io: Io, file: string, text: string): Promise<void> {
  const run = await io.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', file], { stdin: text })
  if (run.exitCode !== 0) throw new Error(`append to ${file} failed: ${run.stderr.trim()}`)
}

/** A short stable hash of a string (FNV-1a and a second lane), for dedup keys. */
export function hashOf(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c ^ (i & 0xff), 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
