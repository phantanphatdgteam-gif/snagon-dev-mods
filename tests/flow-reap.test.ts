import { describe, expect, test } from 'claude-code/testing'
import { launcherArgv, markedProcs, pidsUnderRoot, groupToEnd, survivorPids, reapRun, RUN_MARKER_VAR } from '../hooks/flow-reap'

describe('reaping judged runs (R2 step 7, GAP-R2-0.6-26)', () => {
  test('launcherArgv wraps the command so it leads its own group and records the group id', () => {
    const a = launcherArgv(['/x/.venv/bin/pytest', '-q'])
    expect(a[0]).toBe('/bin/sh')
    expect(a[1]).toBe('-c')
    expect(a[2]).toContain('set -m')
    expect(a[2]).toContain('"$TMPDIR/pgid"')
    expect(a[3]).toBe('sh')
    expect(a.slice(4)).toEqual(['/x/.venv/bin/pytest', '-q'])
  })

  test('markedProcs keeps only the pid and pgid of processes carrying this run\'s marker, never other environments', () => {
    const ps = [
      ` 101 101 node serve ${RUN_MARKER_VAR}=run8 PATH=/usr/bin`,
      ' 202 200 other --flag AWS_SECRET_ACCESS_KEY=topsecret',
      ` 303 101 child ${RUN_MARKER_VAR}=run8`,
    ].join('\n')
    const got = markedProcs(ps, 'run8')
    expect(got).toEqual([{ pid: 101, pgid: 101 }, { pid: 303, pgid: 101 }])
    expect(JSON.stringify(got)).not.toContain('topsecret')
    expect(markedProcs(ps, '')).toEqual([])
    expect(markedProcs(ps, 'run9')).toEqual([])
    // the whole value, not a prefix (run8 vs run80) and not glued to another token (code review LOW)
    expect(markedProcs([` 404 400 x ${RUN_MARKER_VAR}=run80`, ` 505 500 x X${RUN_MARKER_VAR}=run8`].join('\n'), 'run8')).toEqual([])
  })

  test('pidsUnderRoot flags a process whose cwd or open file is at or under the root, and no other', () => {
    const lsof = ['p300', 'n/root/proj/sub/f.txt', 'p400', 'n/elsewhere/x', 'p500', 'n/root/proj'].join('\n')
    expect(pidsUnderRoot(lsof, '/root/proj').sort((a, b) => a - b)).toEqual([300, 500])
    expect(pidsUnderRoot(lsof, '/root/projelse')).toEqual([])
  })

  test('groupToEnd signals only an integer > 1 confirmed by a marked member, never a pre-existing group, and fails closed when the scan failed', () => {
    const marked = [{ pgid: 555 }]
    const groups = new Set([1, 42]) // other groups were alive before the run; 555 (from set -m) was not
    expect(groupToEnd('555\n', marked, groups)).toBe(555)
    expect(groupToEnd('1', marked, groups)).toBe(null) // 1 is special to kill
    expect(groupToEnd('0', marked, groups)).toBe(null)
    expect(groupToEnd('-5', marked, groups)).toBe(null)
    expect(groupToEnd('notanumber', marked, groups)).toBe(null)
    expect(groupToEnd('777', marked, groups)).toBe(null) // no marked member in group 777 (e.g. a forged pgid file)
    // a group that existed before the run is never ended, even with a marked member in it (the mod's own group; S-HIGH)
    expect(groupToEnd('555', marked, new Set([555, 1]))).toBe(null)
    // an empty before-set means the pgid scan failed: fail closed, never fall back to the confirmation alone (round 2)
    expect(groupToEnd('555', marked, new Set())).toBe(null)
  })

  test('reapRun ends the run\'s marked processes in one kill call, and every ps/lsof/kill call carries a time limit', async () => {
    const calls: { argv: string[]; init?: { timeoutMs?: number } }[] = []
    const io = {
      list: async () => [] as { name: string; kind: string; size: number; mtimeMs: number }[],
      read: async () => '',
      exists: async () => false,
      write: async () => {},
      now: async () => 0,
      pluginRoot: '/mod',
      run: async (argv: string[], init?: { timeoutMs?: number }) => {
        calls.push({ argv, init })
        if (argv[0] === '/bin/ps' && argv.includes('-E')) return { exitCode: 0, stdout: ` 11 11 n ${RUN_MARKER_VAR}=m\n 22 22 n ${RUN_MARKER_VAR}=m\n`, stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const left = await reapRun(io, '/run', '/root', 'm', new Set<number>(), new Set([1]))
    expect(left).toEqual([11, 22]) // both marked processes reported as survivors
    const kills = calls.filter(c => c.argv[0] === '/bin/kill')
    expect(kills.length).toBe(1) // one signal call, not one per pid (small pid-reuse window)
    expect(kills[0]?.argv).toEqual(['/bin/kill', '-KILL', '11', '22'])
    expect(calls.every(c => c.init?.timeoutMs === 10000)).toBe(true) // no scan or signal can hang reapRun
  })

  type Init = { timeoutMs?: number }
  const stubIo = (run: (argv: string[], init?: Init) => { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }) => ({
    list: async () => [] as { name: string; kind: string; size: number; mtimeMs: number }[],
    read: async () => '', exists: async () => false, write: async () => {}, now: async () => 0, pluginRoot: '/mod',
    run: async (argv: string[], init?: Init) => run(argv, init),
  })
  const rejects = async (p: Promise<unknown>): Promise<boolean> => { try { await p; return false } catch { return true } }

  test('reapRun fails closed when the ps survivor scan is truncated, so a run is never trusted on an incomplete scan', async () => {
    let ps = 0
    const io = stubIo(argv => argv[0] === '/bin/ps' && argv.includes('-E')
      ? (++ps >= 2 ? { exitCode: 0, stdout: ` 11 11 n ${RUN_MARKER_VAR}=m`, stderr: '', isStdoutTruncated: true } : { exitCode: 0, stdout: '', stderr: '' })
      : { exitCode: 0, stdout: '', stderr: '' })
    expect(await rejects(reapRun(io, '/run', '/root', 'm', new Set<number>(), new Set([1])))).toBe(true)
  })

  test('reapRun fails closed when the lsof survivor scan is truncated or fails', async () => {
    const io = stubIo(argv => argv[0] === '/usr/sbin/lsof'
      ? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: true }
      : { exitCode: 0, stdout: '', stderr: '' }) // ps returns empty, ok
    expect(await rejects(reapRun(io, '/run', '/root', 'm', new Set([5]), new Set([1])))).toBe(true)
  })

  test('survivorPids reports every marked process and the new ones under the root, dropping only pre-existing ones', () => {
    const got = survivorPids({ marked: [{ pid: 101 }], underRoot: [202, 303, 500], before: new Set([303, 500]), hostKids: new Set() })
    expect(got).toEqual([101, 202]) // 303 and 500 pre-existing under the root: dropped
    expect(survivorPids({ marked: [], underRoot: [], before: new Set(), hostKids: new Set() })).toEqual([])
    // a marked pid is reported even when its number was reused and was in the before-set (code review LOW)
    expect(survivorPids({ marked: [{ pid: 303 }], underRoot: [], before: new Set([303]), hostKids: new Set() })).toEqual([303])
  })

  test('survivorPids drops a new process under the root that the host started itself (Claude Code\'s caffeinate, trial M-1), never a marked one', () => {
    // 404: caffeinate, a direct child of the host started during the run, cwd the root; 505: a judged process left behind
    expect(survivorPids({ marked: [], underRoot: [404, 505], before: new Set([1]), hostKids: new Set([404]) })).toEqual([505])
    // the marker outranks the parent: a process carrying this run's marker is the run's
    expect(survivorPids({ marked: [{ pid: 404 }], underRoot: [404], before: new Set([1]), hostKids: new Set([404]) })).toEqual([404])
  })

  test('reapRun asks for the host\'s direct children with a time limit and leaves them out of the root scan (M-1)', async () => {
    const lsof = { exitCode: 0, stdout: ['p404', 'n/root', 'p505', 'n/root/x'].join('\n'), stderr: '' }
    const asked: Init[] = []
    const io = stubIo((argv, init) => {
      if (argv[0] === '/usr/sbin/lsof') return lsof
      if (argv[0] === '/bin/sh' && argv.join(' ').includes('/usr/bin/pgrep -P "$PPID"')) { asked.push(init ?? {}); return { exitCode: 0, stdout: '404\n', stderr: '' } }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    expect(await reapRun(io, '/run', '/root', 'm', new Set([1]), new Set([1]))).toEqual([505])
    expect(asked.map(i => i.timeoutMs)).toEqual([10000])
    // a children scan that fails leaves nothing out: the report only grows (pgrep exits 2 or 3 on an error)
    const failed = stubIo(argv => (argv[0] === '/usr/sbin/lsof' ? lsof : argv[0] === '/bin/sh' ? { exitCode: 3, stdout: '404\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }))
    expect(await reapRun(failed, '/run', '/root', 'm', new Set([1]), new Set([1]))).toEqual([404, 505])
  })
})
