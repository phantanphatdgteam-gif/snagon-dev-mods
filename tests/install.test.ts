import { describe, expect, test } from 'claude-code/testing'
import { ensureSqlite, installNotice, agentNotice, manualCommand, MANUAL_COMMANDS, INSTALL_SCRIPT, INSTALL_RETRY_MS } from '../hooks/install'
import { computeFacts, type Io, type RunResult } from '../hooks/session'

const res = (stdout = '', exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '' })

/** A fake machine: sqlite3 present or not, what the install script prints, files in a map. */
function machine(o: { sqlite?: boolean; script?: string; files?: Record<string, string>; now?: number; scriptThrows?: boolean } = {}) {
  const files = new Map(Object.entries(o.files ?? {}))
  const runs: string[][] = []
  const io: Io = {
    read: async p => { const t = files.get(p); if (t === undefined) throw new Error('ENOENT'); return t },
    write: async (p, t) => { files.set(p, t) },
    exists: async p => files.has(p),
    list: async () => [],
    run: async argv => {
      runs.push(argv)
      if (argv[0] === 'sqlite3') { if (o.sqlite) return res('[{"1":1}]'); throw new Error('ENOENT: sqlite3') }
      if (argv[0] === '/bin/sh' && argv[2] === INSTALL_SCRIPT) { if (o.scriptThrows) throw new Error('timeout'); return res(`${o.script ?? 'none'}\n`) }
      return res()
    },
    now: async () => o.now ?? 10 * INSTALL_RETRY_MS,
    pluginRoot: '/mod',
  }
  return { io, files, runs }
}
const scripts = (runs: string[][]) => runs.filter(r => r[2] === INSTALL_SCRIPT)

describe('install', () => {
  test('nothing happens when sqlite3 is there', async () => {
    const m = machine({ sqlite: true })
    expect(await ensureSqlite(m.io, '/p', true)).toEqual({ state: 'present' })
    expect(scripts(m.runs)).toHaveLength(0)
    expect(m.files.size).toBe(0)
  })

  test('a missing sqlite3 starts a background install once, and records the attempt', async () => {
    const m = machine({ script: 'apt-get' })
    expect(await ensureSqlite(m.io, '/p', true)).toEqual({ state: 'started', method: 'apt-get' })
    expect(scripts(m.runs)[0]?.slice(3)).toEqual(['sh', '/p/.snagon/install.log'])
    expect(JSON.parse(m.files.get('/p/.snagon/install.json') ?? '{}')).toMatchObject({ method: 'apt-get' })
    expect(m.files.get('/p/.snagon/.gitignore')).toContain('*')
    // within a day: no second attempt
    expect(await ensureSqlite(m.io, '/p', true)).toEqual({ state: 'waiting' })
    expect(scripts(m.runs)).toHaveLength(1)
  })

  test('the attempt is retried after a day', async () => {
    const m = machine({ script: 'brew', files: { '/p/.snagon/install.json': JSON.stringify({ lastAttempt: 1 }) } })
    expect(await ensureSqlite(m.io, '/p', true)).toEqual({ state: 'started', method: 'brew' })
  })

  test('no way without a password gives the manual hint; autoInstall false does nothing', async () => {
    const m = machine({ script: 'none' })
    const s = await ensureSqlite(m.io, '/p', true)
    expect(s).toEqual({ state: 'manual', command: null, old: false })
    expect(installNotice(s)).toContain('with your system')
    expect(agentNotice(s)).toContain('package manager')
    const off = machine({ script: 'brew' })
    expect(await ensureSqlite(off.io, '/p', false)).toEqual({ state: 'off' })
    expect(scripts(off.runs)).toHaveLength(0)
    expect(installNotice({ state: 'off' })).toBeNull()
    expect(installNotice({ state: 'waiting' })).toBeNull()
    expect(installNotice({ state: 'started', method: 'brew' })).toContain('installing it in the background with brew')
  })

  test('the install script never asks for a password and never downloads a binary', () => {
    expect(INSTALL_SCRIPT).not.toMatch(/\bsudo\b|\bcurl\b|\bwget\b|\bsu\b|\bdoas\b/)
    expect(INSTALL_SCRIPT).toContain('[ "$(id -u)" = 0 ]') // system package managers only as root
    expect(INSTALL_SCRIPT).toContain('< /dev/null &') // the install runs detached
  })

  test('the attempt is recorded before the script runs, so a failed run still waits a day', async () => {
    const m = machine({ scriptThrows: true })
    await expect(ensureSqlite(m.io, '/p', true)).rejects.toThrow('timeout')
    expect(m.files.get('/p/.snagon/install.json')).toContain('lastAttempt')
    expect(await ensureSqlite(m.io, '/p', true)).toEqual({ state: 'waiting' })
  })

  test('a corrupt record or one from the future does not block the install forever', async () => {
    for (const rec of ['{bad', JSON.stringify({ lastAttempt: 99 * INSTALL_RETRY_MS })]) {
      const m = machine({ script: 'apt-get', files: { '/p/.snagon/install.json': rec } })
      expect((await ensureSqlite(m.io, '/p', true)).state).toBe('started')
    }
  })

  test('config: the project file overrides the user file, except that the user can switch installs off for good', async () => {
    const facts = async (local: object, project: object) => {
      const m = machine({ files: { '/h/.snagon/config.json': JSON.stringify(local), '/p/.snagon/config.json': JSON.stringify(project) } })
      return (await computeFacts(m.io, '/p', '/h')).config
    }
    expect(await facts({ language: 'vi' }, { language: 'en', autoInstall: false })).toMatchObject({ language: 'en', autoInstall: false })
    expect((await facts({ autoInstall: false }, { autoInstall: true })).autoInstall).toBe(false)
    expect((await facts({}, { journalDir: '.' })).journalDir).toBe('.snagon/journal')
    expect((await facts({}, { journalDir: './notes' })).journalDir).toBe('.snagon/journal')
  })

  test('an ordinary user on Linux gets the exact command for their package manager, from the user notice and from the agent', async () => {
    const m = machine({ script: 'none apt-get Linux missing' })
    const s = await ensureSqlite(m.io, '/p', true)
    expect(s).toEqual({ state: 'manual', command: 'sudo apt-get update && sudo apt-get install -y sqlite3', old: false })
    expect(installNotice(s)).toContain('missing sqlite3')
    expect(installNotice(s)).toContain('run: sudo apt-get update && sudo apt-get install -y sqlite3')
    const told = agentNotice(s) ?? ''
    expect(told).toContain('At the start of your next reply')
    expect(told).toContain('```sh\nsudo apt-get update && sudo apt-get install -y sqlite3\n```')
    expect(told).toContain('Do not run it yourself')
    expect(JSON.parse(m.files.get('/p/.snagon/install.json') ?? '{}').command).toBe('sudo apt-get update && sudo apt-get install -y sqlite3')
    expect(agentNotice({ state: 'started', method: 'brew' })).toBeNull()
    expect(agentNotice({ state: 'waiting' })).toBeNull()
  })

  test('every supported package manager has its command; macOS without Homebrew gets brew; unknown gets none', () => {
    for (const pm of ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper']) {
      expect(manualCommand(pm, 'Linux')).toBe(MANUAL_COMMANDS[pm])
      expect(MANUAL_COMMANDS[pm]).toMatch(/^sudo /)
      expect(INSTALL_SCRIPT).toContain(pm)
    }
    expect(manualCommand('', 'Darwin')).toBe('brew install sqlite')
    expect(manualCommand('', 'Linux')).toBeNull()
    expect(manualCommand('', '')).toBeNull()
  })

  test('the real script lines with an unknown package manager or OS, an old sqlite3, and no answer at all', async () => {
    const mac = await ensureSqlite(machine({ script: 'none - Darwin missing' }).io, '/p', true)
    expect(mac).toEqual({ state: 'manual', command: 'brew install sqlite', old: false })
    expect(installNotice(mac)).toContain('brew install sqlite (after installing Homebrew)')
    expect(agentNotice(mac)).toContain('once Homebrew is installed')
    expect(await ensureSqlite(machine({ script: 'none - - missing' }).io, '/p', true)).toEqual({ state: 'manual', command: null, old: false })
    const old = await ensureSqlite(machine({ script: 'none dnf Linux old' }).io, '/p', true)
    expect(old).toEqual({ state: 'manual', command: 'sudo dnf install -y sqlite', old: true })
    expect(installNotice(old)).toContain('older than 3.33')
    expect(agentNotice(old)).toContain('a newer sqlite3, 3.33 or later')
    const silent = await ensureSqlite(machine({ script: '' }).io, '/p', true)
    expect(silent).toEqual({ state: 'waiting' })
    expect(installNotice(silent)).toBeNull()
  })
})
