import { describe, expect, test } from 'claude-code/testing'
import { filteredPath, realPathOf, safePath, settingsPlaces, SYSTEM_PATH, TEMP_PLACES } from '../hooks/safe-path'
import { childEnvWith, ENV_LIST_ARGV, funcNamesOf, ioOf, resetSafeEnv, SHELL_RESET } from '../hooks/engine-io'

const ROOT = '/Users/u/dev/app'
const PLACES = [ROOT, '/private/tmp', '/Users/u/.npm']

describe('safe PATH for the processes the mod starts (NK-02)', () => {
  test('drops empty and relative entries and those in or under a place Bash can write; keeps the rest in order', () => {
    const r = safePath(`${ROOT}/node_modules/.bin::bin:./x:/usr/local/bin:${ROOT}:/private/tmp/t/bin:/Users/u/.npm/_npx/1/node_modules/.bin:/usr/bin:/bin`, PLACES)
    expect(r.path).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(r.dropped).toEqual([`${ROOT}/node_modules/.bin`, '', 'bin', './x', ROOT, '/private/tmp/t/bin', '/Users/u/.npm/_npx/1/node_modules/.bin'])
  })

  test('compares spellings as the release check does: letter case, NFD, trailing slashes, dot segments', () => {
    const viRoot = '/Users/u/dự-án'
    const path = ['/USERS/U/DEV/APP/bin', `${viRoot.normalize('NFD')}/bin`, `${ROOT}/`, `/opt/..${ROOT}/bin`, '/opt/homebrew/bin'].join(':')
    expect(safePath(path, [...PLACES, viRoot]).path).toBe('/opt/homebrew/bin')
  })

  test('an entry whose real path lies in a writable place is dropped', () => {
    expect(safePath('/usr/local/bin:/opt/homebrew/bin', PLACES, { '/usr/local/bin': `${ROOT}/tools/bin` })).toEqual({ path: '/opt/homebrew/bin', dropped: ['/usr/local/bin'] })
  })

  test('with nothing left, or no PATH at all, the system folders, never an empty PATH', () => {
    expect(safePath('', PLACES).path).toBe(SYSTEM_PATH)
    expect(safePath(`${ROOT}/bin:.`, PLACES).path).toBe(SYSTEM_PATH)
  })

  test('a duplicate safe entry stays where it stands; a dropped entry is listed once', () => {
    expect(safePath(`/usr/bin:${ROOT}/b:/usr/bin:${ROOT}/b`, PLACES)).toEqual({ path: '/usr/bin:/usr/bin', dropped: [`${ROOT}/b`] })
  })

  test('the temp folders in both spellings; a place that is the whole disk leaves only the system folders', () => {
    expect(safePath('/var/folders/ab/T/bin:/private/var/tmp/b:/var/tmp/c:/usr/local/bin', TEMP_PLACES).path).toBe('/usr/local/bin')
    expect(safePath('/usr/local/bin:/usr/bin:/opt/homebrew/bin:/bin', ['/'])).toEqual({ path: '/usr/bin:/bin', dropped: ['/usr/local/bin', '/opt/homebrew/bin'] })
    expect(safePath('/usr/local/bin:/usr/bin', ['/..']).path).toBe('/usr/bin')
    expect(safePath('/usr/local/bin:/usr/bin', ['/tmp/..']).path).toBe('/usr/bin')
    expect(safePath('/usr/local/bin:/usr/bin', ['/tmp/../x']).path).toBe('/usr/local/bin:/usr/bin')
    expect(settingsPlaces({ permissions: { allow: ['Edit(//**)'] } })).toEqual(['/'])
  })

  test('realPathOf lands a path that does not exist yet through its deepest existing ancestor', async () => {
    const real: Record<string, string> = { '/opt/t': '/Users/u/proj', '/opt': '/opt' }
    const of = async (p: string): Promise<string | undefined> => real[p]
    expect(await realPathOf('/opt/t/bin/x', of)).toBe('/Users/u/proj/bin/x')
    expect(await realPathOf('/opt/t', of)).toBe('/Users/u/proj')
    expect(await realPathOf('/nowhere/at/all', of)).toBeUndefined()
    const out = await filteredPath('/opt/t/bin:/opt/other/bin', { root: '/Users/u/proj', tmp: '', home: '/Users/u', extra: [] }, of)
    expect(out).toEqual({ path: '/opt/other/bin', dropped: ['/opt/t/bin'] })
  })

  test('the settings places: sandbox allowWrite, extra directories, absolute and home Edit rules up to their first glob', () => {
    const merged = {
      sandbox: { filesystem: { allowWrite: ['~/.npm', '/opt/cache'] } },
      permissions: { allow: ['Bash(npm test)', 'Edit(~/notes/**)', 'Write(//srv/out/*.md)', 'Edit(src/**)', 'Edit(/docs/**)', 'MultiEdit(~/a*b/c)'], additionalDirectories: ['~/shared'] },
    }
    expect(settingsPlaces(merged)).toEqual(['~/.npm', '/opt/cache', '~/shared', '~/notes', '/srv/out', '~'])
    expect(settingsPlaces(undefined)).toEqual([])
    expect(settingsPlaces({ sandbox: 'x', permissions: { allow: 'Edit(~/x)' } })).toEqual([])
  })

  test('filteredPath takes the project, TMPDIR, the temp folders and the extra places, each also at its real path', async () => {
    const real: Record<string, string> = { '/Users/u/proj': '/Volumes/d/proj', '/usr/local/bin': '/Volumes/d/proj/bin', '/Users/u/link-bin': '/Users/u/.npm/bin' }
    const out = await filteredPath('/Volumes/d/proj/x:/usr/local/bin:/Users/u/link-bin:/var/folders/t/T/b:/Users/u/shared/bin:/opt/homebrew/bin', { root: '/Users/u/proj', tmp: '/var/folders/t/T', home: '/Users/u', extra: ['~/.npm', '~/shared'] }, async p => real[p])
    expect(out).toEqual({ path: '/opt/homebrew/bin', dropped: ['/Volumes/d/proj/x', '/usr/local/bin', '/Users/u/link-bin', '/var/folders/t/T/b', '/Users/u/shared/bin'] })
  })

  test('every child of the mod gets the shell\'s start-up variables empty and the filtered PATH, over what the caller passes (owner decision, step 11)', () => {
    const env = childEnvWith('/usr/bin:/bin', { SHELLOPTS: 'noexec:xtrace', BASH_ENV: '/tmp/x.sh', PATH: '/tmp/evil', GIT_CONFIG_NOSYSTEM: '1' })
    expect(env).toEqual({ GIT_CONFIG_NOSYSTEM: '1', SHELLOPTS: '', BASHOPTS: '', BASH_ENV: '', ENV: '', PATH: '/usr/bin:/bin' })
    expect(childEnvWith('/usr/bin')).toEqual({ SHELLOPTS: '', BASHOPTS: '', BASH_ENV: '', ENV: '', PATH: '/usr/bin' })
  })

  test('every child gets each BASH_FUNC_<name>%% empty, the host\'s listed names and any the caller passes: bash imports a function from it (owner decision, after step 11)', () => {
    const env = childEnvWith('/usr/bin', { 'BASH_FUNC_find%%': '() { echo forged; }', GIT_X: '1' }, ['BASH_FUNC_cd%%', 'BASH_FUNC_/usr/bin/true%%'])
    expect(env).toEqual({ GIT_X: '1', ...SHELL_RESET, 'BASH_FUNC_cd%%': '', 'BASH_FUNC_/usr/bin/true%%': '', 'BASH_FUNC_find%%': '', PATH: '/usr/bin' })
  })

  test('the names listing: only its BASH_FUNC_<name>%% lines count; one that failed or stopped before its end mark throws, never reads as none, its output kept out of the error', () => {
    const run = (exitCode: number, stdout: string) => ({ exitCode, stdout, stderr: 'SECRET-ERR' })
    expect(funcNamesOf(run(0, 'HOME\nBASH_FUNC_cd%%\nBASH_FUNC_%%\nX_BASH_FUNC_y%%\nBASH_FUNC_z\nBASH_FUNC_cd%%\n=\n'))).toEqual(['BASH_FUNC_cd%%', 'BASH_FUNC_%%'])
    expect(funcNamesOf(run(0, 'HOME\n=\n'))).toEqual([])
    const errors = [run(0, 'BASH_FUNC_cd%%\n'), run(0, ''), run(0, 'HOME\n=\nX\n'), run(2, 'SECRET-OUT\n=\n')].map(r => { try { funcNamesOf(r); return 'no error' } catch (e) { return String(e) } })
    expect(errors.every(e => e.includes('the environment\'s names could not be listed') && !e.includes('SECRET'))).toBe(true)
    expect(errors[3]).toContain('exit 2')
  })

  const fakeHost = (run: (argv: readonly string[], init: unknown) => { exitCode: number; stdout: string; stderr: string }) => {
    const vars: Record<string, string> = { PATH: '/usr/bin:/bin', TMPDIR: '/private/tmp', HOME: '/Users/u' }
    return {
      fs: { stat: async (p: string) => ({ realPath: p }) }, settings: { read: async () => ({}) }, session: { root: async () => ROOT }, plugin: { root: '/mod' },
      env: { get: async (name: string) => vars[name] },
      process: { run: async (argv: readonly string[], init: unknown) => run(argv, init) },
    } as unknown as Parameters<typeof ioOf>[0]
  }

  test('ioOf lists the host\'s names once, then runs each command with the caller\'s variables through childEnv, every BASH_FUNC name empty (code review of the shell reset; owner decision, after step 11)', async () => {
    resetSafeEnv()
    const seen: unknown[] = []
    const io = ioOf(fakeHost((argv, init) => { seen.push([argv, init]); return { exitCode: 0, stdout: argv[0] === '/usr/bin/awk' ? 'PATH\nBASH_FUNC_cd%%\n=\n' : '', stderr: '' } }))
    await io.run(['/usr/bin/git', 'status'], { env: { GIT_X: '1', SHELLOPTS: 'xtrace' } })
    await io.run(['/usr/bin/true'])
    expect(seen).toEqual([
      [ENV_LIST_ARGV, { env: childEnvWith('/usr/bin:/bin') }],
      [['/usr/bin/git', 'status'], { env: childEnvWith('/usr/bin:/bin', { GIT_X: '1' }, ['BASH_FUNC_cd%%']) }],
      [['/usr/bin/true'], { env: childEnvWith('/usr/bin:/bin', {}, ['BASH_FUNC_cd%%']) }],
    ])
    resetSafeEnv()
  })

  test('a names listing that fails starts no child, and the next child lists again (fail closed)', async () => {
    resetSafeEnv()
    const seen: string[] = []
    let fails = 1
    const io = ioOf(fakeHost(argv => {
      seen.push(argv[0] ?? '')
      if (argv[0] === '/usr/bin/awk') return fails-- > 0 ? { exitCode: 1, stdout: '', stderr: 'x' } : { exitCode: 0, stdout: '=\n', stderr: '' }
      return { exitCode: 0, stdout: 'ran', stderr: '' }
    }))
    await expect(io.run(['/usr/bin/true'])).rejects.toThrow('the environment\'s names could not be listed (exit 1)')
    expect(seen).toEqual(['/usr/bin/awk'])
    expect((await io.run(['/usr/bin/true'])).stdout).toBe('ran')
    expect(seen).toEqual(['/usr/bin/awk', '/usr/bin/awk', '/usr/bin/true'])
    resetSafeEnv()
  })

  test('children started together share one listing: when it fails all of them reject and none starts; the next ones list once again (code review)', async () => {
    resetSafeEnv()
    const seen: string[] = []
    let fails = 1
    const io = ioOf(fakeHost(argv => {
      seen.push(argv[0] ?? '')
      if (argv[0] === '/usr/bin/awk') return fails-- > 0 ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: '=\n', stderr: '' }
      return { exitCode: 0, stdout: 'ran', stderr: '' }
    }))
    const failed = await Promise.allSettled([io.run(['/usr/bin/true']), io.run(['/usr/bin/true'])])
    expect(failed.map(r => r.status)).toEqual(['rejected', 'rejected'])
    expect(seen).toEqual(['/usr/bin/awk'])
    await Promise.all([io.run(['/usr/bin/true']), io.run(['/usr/bin/true'])])
    expect(seen).toEqual(['/usr/bin/awk', '/usr/bin/awk', '/usr/bin/true', '/usr/bin/true'])
    resetSafeEnv()
  })
})
