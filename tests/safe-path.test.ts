import { describe, expect, test } from 'claude-code/testing'
import { filteredPath, realPathOf, safePath, settingsPlaces, SYSTEM_PATH, TEMP_PLACES } from '../hooks/safe-path'

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
})
