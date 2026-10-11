// Installs the sqlite3 command-line program when it is missing, so project memory gets full-text search.
// Only ways that need no password and use the system's own package source: Homebrew, or the system package
// manager when the session already runs as root (containers, cloud machines). Never sudo, never a downloaded
// binary. When neither works (an ordinary user on Linux), the agent tells the user what is missing and the exact
// command for their package manager. Memory keeps working without sqlite3 (plain scan), so nothing is lost meanwhile.
import { dataDir, type Io } from './session'

export const INSTALL_RETRY_MS = 24 * 3_600_000 // one attempt (or one notice) per project per day at most
export const MISSING = 'sqlite3 (the SQLite command-line program, version 3.33 or later)'

// $1: the log file. Prints one line: "present"; the method it started in the background; or "none <package manager>
// <OS> <found>" when it cannot install without a password, "-" standing for an unknown package manager or OS, and
// <found> "old" when a sqlite3 without -json (older than 3.33) is installed, else "missing".
export const INSTALL_SCRIPT = [
  'log="$1"; m=""; c=""; pm=""; os="$(uname -s 2>/dev/null)"',
  'if command -v sqlite3 >/dev/null 2>&1 && sqlite3 -json :memory: "SELECT 1;" >/dev/null 2>&1; then echo present; exit 0; fi',
  'for p in apt-get dnf yum apk pacman zypper; do if command -v "$p" >/dev/null 2>&1; then pm="$p"; break; fi; done',
  // as root the system package manager comes first (Homebrew refuses to run as root)
  'if [ "$(id -u)" = 0 ] && [ -n "$pm" ]; then',
  '  m="$pm"',
  '  case "$pm" in',
  '    apt-get) c="apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3" ;;',
  '    dnf) c="dnf install -y sqlite" ;;',
  '    yum) c="yum install -y sqlite" ;;',
  '    apk) c="apk add --no-cache sqlite" ;;',
  '    pacman) c="pacman -S --noconfirm --needed sqlite" ;;',
  '    zypper) c="zypper --non-interactive install sqlite3" ;;',
  '  esac',
  'elif command -v brew >/dev/null 2>&1; then m=brew; c="brew install sqlite"', // ponytail: keg-only on macOS, where /usr/bin/sqlite3 always exists anyway
  'fi',
  'if [ -z "$m" ]; then if command -v sqlite3 >/dev/null 2>&1; then f=old; else f=missing; fi; echo "none ${pm:--} ${os:--} $f"; exit 0; fi',
  'mkdir -p "$(dirname "$log")"',
  'if [ -L "$log" ] || [ -L "$(dirname "$log")" ]; then log=/dev/null; fi', // never follow a planted link out of .snagon/
  '( printf "%s start %s\\n" "$(date "+%Y-%m-%d %H:%M:%S")" "$m"; if sh -c "$c"; then r=ok; else r=failed; fi; printf "%s %s\\n" "$(date "+%Y-%m-%d %H:%M:%S")" "$r" ) >> "$log" 2>&1 < /dev/null &',
  'echo "$m"',
].join('\n')

// The command an ordinary user types, per package manager (they enter their own password for sudo).
export const MANUAL_COMMANDS: Readonly<Record<string, string>> = {
  'apt-get': 'sudo apt-get update && sudo apt-get install -y sqlite3',
  dnf: 'sudo dnf install -y sqlite',
  yum: 'sudo yum install -y sqlite',
  apk: 'sudo apk add sqlite',
  pacman: 'sudo pacman -S --needed sqlite',
  zypper: 'sudo zypper install -y sqlite3',
}
export const MANUAL_HINT = 'install the sqlite3 command-line program (3.33 or later) with your system\'s package manager'

/** The exact command for this machine, from the script's "none <package manager> <OS>" line; null when unknown. */
export function manualCommand(pm: string, os: string): string | null {
  if (MANUAL_COMMANDS[pm]) return MANUAL_COMMANDS[pm] ?? null
  if (os === 'Darwin') return 'brew install sqlite' // after installing Homebrew
  return null
}

export type InstallStatus = { state: 'present' | 'off' | 'waiting' | 'started' | 'manual'; method?: string; command?: string | null; old?: boolean }

/** Whether sqlite3 is there, and if not, starts an install, or works out the manual command, once a day at most. */
export async function ensureSqlite(io: Io, root: string, autoInstall: boolean): Promise<InstallStatus> {
  try {
    // memory runs sqlite3 with -json (3.33 or later): an older one counts as missing
    const run = await io.run(['sqlite3', '-json', ':memory:', 'SELECT 1;'], { timeoutMs: 5_000 })
    if (run.exitCode === 0) return { state: 'present' }
  } catch { /* not installed */ }
  if (!autoInstall) return { state: 'off' }
  const dir = await dataDir(io, root)
  const stateFile = `${dir}/install.json`
  let last: number | null = null // null: never tried in this project
  try { last = Number(JSON.parse(await io.read(stateFile)).lastAttempt) } catch { last = null }
  const now = await io.now()
  if (last !== null && Number.isFinite(last) && last <= now && now - last < INSTALL_RETRY_MS) return { state: 'waiting' }
  // The attempt is recorded before the script runs, so a failed or timed-out run, or a second session starting at
  // the same moment, still waits a day.
  await io.write(stateFile, JSON.stringify({ lastAttempt: now }))
  const run = await io.run(['/bin/sh', '-c', INSTALL_SCRIPT, 'sh', `${dir}/install.log`], { timeoutMs: 10_000 })
  const [method = '', pmField = '-', osField = '-', found = 'missing'] = run.stdout.trim().split(' ')
  const pm = pmField === '-' ? '' : pmField, os = osField === '-' ? '' : osField
  if (method === 'present') return { state: 'present' }
  if (!method) return { state: 'waiting' } // no answer from the script (killed or timed out): stay quiet, retry tomorrow
  if (method && method !== 'none') {
    await io.write(stateFile, JSON.stringify({ lastAttempt: now, method }))
    return { state: 'started', method }
  }
  const command = manualCommand(pm, os)
  const old = found === 'old'
  await io.write(stateFile, JSON.stringify({ lastAttempt: now, method: 'none', command, old }))
  return { state: 'manual', command, old }
}

const OFF_SWITCH = 'To stop this reminder, set "autoInstall": false in .snagon/config.json.'

/** The line shown to the user (not the model) for a status worth telling, or null. */
export function installNotice(s: InstallStatus): string | null {
  if (s.state === 'started') return `snagon-dev-mods: sqlite3 was not found; installing it in the background with ${s.method} (log: .snagon/install.log). Memory search uses a plain scan until it is there.`
  if (s.state !== 'manual') return null
  const how = s.command ? `run: ${s.command}${s.command.startsWith('brew ') ? ' (after installing Homebrew)' : ''}` : `${MANUAL_HINT}.`
  const what = s.old ? `the installed sqlite3 is older than 3.33; memory needs ${MISSING}` : `missing ${MISSING}`
  return `snagon-dev-mods: ${what}; it needs an administrator password to install. Memory works with a plain scan until then. To install it, ${how} ${OFF_SWITCH}`
}

/** What the agent is told to pass on in its next reply when sqlite3 could not be installed, or null. */
export function agentNotice(s: InstallStatus): string | null {
  if (s.state !== 'manual') return null
  const how = s.command
    ? [`and the exact command to type${s.command.startsWith('brew ') ? ' once Homebrew is installed' : ''}, in a code block of its own:`, '', '```sh', s.command, '```', '',
      'Say they can type it in their own terminal, or here with `!` in front of it; the password is theirs to enter. Do not run it yourself.']
    : ['and that they should install the sqlite3 command-line program (3.33 or later) with their system\'s package manager.']
  return [
    '# snagon-dev-mods: a program is missing on this machine',
    '',
    `Project memory needs ${MISSING} for full-text search, and ${s.old ? 'the installed one is older' : 'it is not installed'}. The harness could not install it`,
    'because that needs an administrator password. Memory still works meanwhile, with a plain scan.',
    '',
    'At the start of your next reply, before anything else, tell the user in their language, in two or three lines:',
    `what is missing (${s.old ? 'a newer sqlite3, 3.33 or later' : 'sqlite3'}), what it is for (full-text search of project memory),`,
    ...how,
    'Tell them once in this conversation, then carry on with what they asked.',
  ].join('\n')
}
