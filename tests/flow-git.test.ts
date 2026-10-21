import { describe, expect, test } from 'claude-code/testing'
import type { Io, RunResult } from '../hooks/session'
import { blobsAt, gitPaths, ignoredLoadable, release, pushFacts, cfgHash, flowTree, urlProblem, writableIncludes, HARDENED_ENV, type GitPaths } from '../hooks/flow-git'
import { hashOf } from '../hooks/session'
import { PYTHON } from '../flow/data/stacks/python'
import { publishReason, type GitRead } from '../hooks/gate'

const HEAD = 'a'.repeat(40), TIP = 'b'.repeat(40)
const P: GitPaths = { top: '/r', commonDir: '/r/.git', gitDir: '/r/.git', index: '/r/.git/index' }
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const none: RunResult = { exitCode: 1, stdout: '', stderr: '' }

type Answer = RunResult | RunResult[] | ((stdin: string) => RunResult)
/** A git that answers by command (the env -u prefix and -c pairs stripped); a list is consumed call by call. */
function fakeGit(answers: Record<string, Answer>) {
  const calls: Array<{ key: string; env?: Record<string, string>; hardened: boolean; unset: string[] }> = []
  const io: Io = {
    read: async p => { throw new Error(`ENOENT ${p}`) }, write: async () => undefined, exists: async () => false, list: async () => [],
    run: async (argv, init) => {
      const at = argv.indexOf('git')
      if (at < 0) return ok()
      const unset = argv.slice(0, at).filter((_, i, all) => all[i - 1] === '-u')
      const args = [...argv.slice(at + 1)]
      const hardened = args.includes('core.attributesFile=/dev/null')
      while (args[0] === '-c') args.splice(0, 2)
      const key = args.join(' ')
      calls.push({ key, env: init?.env, hardened, unset })
      const a = Object.entries(answers).find(([k]) => key === k || key.startsWith(`${k} `))?.[1]
      if (typeof a === 'function') return a(init?.stdin ?? '')
      if (Array.isArray(a)) return a.length > 1 ? (a.shift() as RunResult) : (a[0] ?? none)
      return a ?? none
    },
    now: async () => 1, pluginRoot: '/m',
  }
  return { io, calls }
}

const batch = (type: string) => (stdin: string): RunResult => ok(stdin.trim().split('\n').map(x => `${x} ${type}`).join('\n') + '\n')
const releaseGit = (over: Record<string, Answer> = {}) => fakeGit({
  'remote get-url --push origin': ok('https://example.invalid/r.git\n'),
  'rev-parse --verify HEAD^{commit}': ok(`${HEAD}\n`),
  'config --show-origin --null --includes --list': ok('file:/etc/gitconfig\0user.name\nX\0file:.git/config\0core.bare\nfalse\0'),
  'ls-remote -- https://example.invalid/r.git refs/heads/main': ok(`${TIP}\trefs/heads/main\n`),
  'cat-file --batch-check=%(objectname) %(objecttype)': batch('commit'), 'rev-list --count': ok('1\n'), 'log -z --name-only': ok('src/a.ts\0'), 'log -p': ok(''), 'ls-tree -r': ok('src/a.ts\0'),
  [`rev-list ${HEAD} --not ${TIP}`]: ok(`${HEAD}\n`),
  ...over,
})
async function frozenOf(io: Io, revsHash?: string) {
  return { remote: 'origin', branch: 'main', hCfg: (await cfgHash(io, '/r', P, '/h')).hash, facts: await pushFacts(io, P, 'origin'), revsHash }
}

describe('flow git', () => {
  test('paths come from one rev-parse; an incomplete answer throws', async () => {
    const good = fakeGit({ 'rev-parse --path-format=absolute': ok('/r\n/r/.git\n/r/.git/worktrees/w\n/r/.git/worktrees/w/index\n') })
    expect(await gitPaths(good.io, '/r')).toEqual({ top: '/r', commonDir: '/r/.git', gitDir: '/r/.git/worktrees/w', index: '/r/.git/worktrees/w/index' })
    expect(good.calls[0]?.hardened && good.calls[0]?.env).toEqual(HARDENED_ENV)
    for (const v of ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_INDEX_FILE']) expect(good.calls[0]?.unset).toContain(v)
    await expect(gitPaths(fakeGit({ 'rev-parse --path-format=absolute': ok('/r\n') }).io, '/r')).rejects.toThrow()
  })

  test('the flow tree uses its own temp index, never the real one, and output cut at 4 MiB is an error', async () => {
    const g = fakeGit({ 'rev-parse --verify --quiet HEAD^{tree}': ok('t\n'), 'read-tree': ok(), 'add -A': ok(), 'ls-files -s -z': ok('100644 abc 0\tsrc/a.ts\0'), 'ls-files -o --exclude-standard -z': ok(''), 'rm --cached': ok(), 'write-tree': ok('tree1\n') })
    expect(await flowTree(g.io, P, 'worktree', 'tok', [])).toBe('tree1')
    expect(g.calls.filter(c => c.key !== 'rev-parse --verify --quiet HEAD^{tree}').every(c => c.env?.GIT_INDEX_FILE === '/r/.git/index.flow-tok.tmp' && !c.unset.includes('GIT_INDEX_FILE'))).toBe(true)
    const corrupt = fakeGit({ 'rev-parse --verify --quiet HEAD^{tree}': { exitCode: 128, stdout: '', stderr: 'fatal: bad object' } })
    await expect(flowTree(corrupt.io, P, 'head', 'tok', [])).rejects.toThrow()
    const cut = fakeGit({ 'rev-parse --verify --quiet HEAD^{tree}': ok('t\n'), 'read-tree': ok(), 'add -A': ok(), 'ls-files -s -z': ok(''), 'ls-files -o --exclude-standard -z': ok(''), 'rm --cached': ok(), 'write-tree': { exitCode: 0, stdout: 'x', stderr: '', isStdoutTruncated: true } })
    await expect(flowTree(cut.io, P, 'worktree', 'tok', [])).rejects.toThrow()
  })

  test('add never enters a submodule (its path is excluded), and a gitlink that appears during add is an error', async () => {
    const tree = (afterAdd: string) => fakeGit({ 'rev-parse --verify --quiet HEAD^{tree}': ok('t\n'), 'read-tree': ok(), 'ls-files -s -z': [ok('160000 abc 0\tlib\0'), ok(afterAdd)], 'add -A': ok(), 'rm --cached': ok(), 'write-tree': ok('tree1\n') })
    const g = tree('160000 abc 0\tlib\0')
    expect(await flowTree(g.io, P, 'worktree', 'tok', [])).toBe('tree1')
    expect(g.calls.find(c => c.key.startsWith('add -A'))?.key).toBe('add -A -- . :(exclude,literal)lib')
    const raced = tree('160000 abc 0\tlib\x00160000 def 0\tsrc/vendor\x00')
    await expect(flowTree(raced.io, P, 'worktree', 'tok', [])).rejects.toThrow('nested repository appeared at src/vendor')
  })

  test('the release echo scans from the real remote tip and returns the hash of the commits to publish', async () => {
    const g = releaseGit()
    const echo = await release(g.io, '/r', P, '/h', await frozenOf(g.io), false)
    expect(echo.ok && echo.head).toBe(HEAD)
    expect(g.calls.some(c => c.key.startsWith('push'))).toBe(false)
    expect(g.calls.filter(c => c.key.startsWith('ls-remote')).every(c => !c.hardened && c.env?.GIT_TERMINAL_PROMPT === '0' && c.env?.GIT_CONFIG_GLOBAL === undefined && c.env?.GIT_ALLOW_PROTOCOL === 'https:ssh:git' && c.unset.includes('GIT_CONFIG_COUNT') && !c.unset.includes('GIT_SSH_COMMAND'))).toBe(true)
    expect(g.calls.filter(c => c.key.startsWith('log ')).every(c => c.hardened && c.key.includes('--diff-merges=first-parent'))).toBe(true)
  })

  test('the push needs the echoed commits, lands, and is checked against the remote afterwards', async () => {
    const g0 = releaseGit()
    const echo = await release(g0.io, '/r', P, '/h', await frozenOf(g0.io), false)
    const hash = echo.ok ? echo.revsHash : ''
    const changed = releaseGit()
    expect(await release(changed.io, '/r', P, '/h', await frozenOf(changed.io, 'other'), true)).toMatchObject({ ok: false, reason: 'frozenChanged' })
    const refused = releaseGit({ push: { exitCode: 1, stdout: '', stderr: '! [rejected] (non-fast-forward)' } })
    expect(await release(refused.io, '/r', P, '/h', await frozenOf(refused.io, hash), true)).toMatchObject({ ok: false, reason: 'pushRejected' })
    const stale = releaseGit({ push: ok() })
    expect(await release(stale.io, '/r', P, '/h', await frozenOf(stale.io, hash), true)).toMatchObject({ ok: false, reason: 'pushRejected' })
    const landed = releaseGit({ push: ok(), 'ls-remote -- https://example.invalid/r.git refs/heads/main': [ok(`${TIP}\trefs/heads/main\n`), ok(`${HEAD}\trefs/heads/main\n`)] })
    const done = await release(landed.io, '/r', P, '/h', await frozenOf(landed.io, hash), true)
    expect(done.ok).toBe(true)
    expect(landed.calls.find(c => c.key.startsWith('push'))?.key).toBe(`push --recurse-submodules=no -- https://example.invalid/r.git ${HEAD}:refs/heads/main`)
  })

  test('a config file the push reads that sits in a folder Bash can write stops the release (the repository\'s own are H_cfg\'s)', async () => {
    const g = releaseGit({ 'config --show-origin --null --includes --list': ok('file:/home/u/.gitconfig\0include.path\n/r/tools/x.inc\0file:/r/tools/x.inc\0core.sshCommand\nssh\0') })
    const out = await release(g.io, '/r', P, '/h', await frozenOf(g.io), false)
    expect(out).toMatchObject({ ok: false, reason: 'tampered', detail: expect.stringContaining('/r/tools/x.inc') })
    expect(JSON.stringify(out)).not.toContain('.gitconfig')
  })

  test('an include the push would read stops the release when its target is in a folder Bash can write, even before the file exists', async () => {
    const missing = releaseGit({ 'config --show-origin --null --includes --list': ok('file:/home/u/.gitconfig\0include.path\n/r/tools/later.inc\0file:/home/u/.gitconfig\0includeif.gitdir:/r/.path\nrel.inc\0') })
    const out = await release(missing.io, '/r', P, '/h', await frozenOf(missing.io), false)
    expect(out).toMatchObject({ ok: false, reason: 'tampered', detail: expect.stringContaining('/r/tools/later.inc') })
    expect(JSON.stringify(out)).not.toContain('rel.inc')
    const xdg = releaseGit()
    const out2 = await release(xdg.io, '/r', P, '/h', { ...(await frozenOf(xdg.io)), writable: ['/h/.config'] }, false)
    expect(out2).toMatchObject({ ok: false, reason: 'tampered', detail: expect.stringContaining('/h/.config/git/config') })
  })

  test('includes inside an included file count even when git did not take them (a condition false now)', async () => {
    const g = releaseGit({
      'config --show-origin --null --includes --list': ok('file:/home/u/.gitconfig\0user.name\nX\0'),
      'config --no-includes --null --file /home/u/.gitconfig --get-regexp': ok('includeif.onbranch:release/*.path\n/home/u/rel.inc\0'),
      'config --no-includes --null --file /home/u/rel.inc --get-regexp': ok('include.path\n/r/team.inc\0'),
    })
    const io = { ...g.io, exists: async (p: string) => p === '/home/u/.gitconfig' || p === '/home/u/rel.inc' }
    const out = await release(io, '/r', P, '/h', { ...(await frozenOf(io)), configFiles: ['/home/u/.gitconfig'] }, false)
    expect(out).toMatchObject({ ok: false, reason: 'tampered', detail: expect.stringContaining('/r/team.inc') })
  })

  test('a relative global file (GIT_CONFIG_GLOBAL=gitconfig) is taken from the folder git runs in, the worktree', async () => {
    const g = releaseGit()
    const out = await release(g.io, '/r', P, '/h', { ...(await frozenOf(g.io)), configFiles: ['gitconfig'] }, false)
    expect(out).toMatchObject({ ok: false, reason: 'tampered', detail: expect.stringContaining('/r/gitconfig') })
  })

  test('the global files to check come from the environment git sees (GIT_CONFIG_GLOBAL, XDG_CONFIG_HOME)', async () => {
    const g = releaseGit()
    const out = await release(g.io, '/r', P, '/h', { ...(await frozenOf(g.io)), configFiles: ['/r/xdg/git/config'] }, false)
    expect(out).toMatchObject({ ok: false, reason: 'tampered', detail: expect.stringContaining('/r/xdg/git/config') })
  })

  test('a remote tip this repository does not have, an unreachable remote, or a secret stop the release with a reason', async () => {
    const missing = releaseGit({ 'cat-file --batch-check=%(objectname) %(objecttype)': batch('missing') })
    expect(await release(missing.io, '/r', P, '/h', await frozenOf(missing.io), false)).toMatchObject({ ok: false, reason: 'pushRejected' })
    const offline = releaseGit({ 'ls-remote -- https://example.invalid/r.git refs/heads/main': { exitCode: 128, stdout: '', stderr: 'fatal: unable to access' } })
    expect(await release(offline.io, '/r', P, '/h', await frozenOf(offline.io), false)).toMatchObject({ ok: false, reason: 'couldNotRun' })
    const leak = releaseGit({ 'ls-tree -r': ok('src/a.ts\0.env\0') })
    expect(await release(leak.io, '/r', P, '/h', await frozenOf(leak.io), false)).toMatchObject({ ok: false, reason: 'publish' })
    const g = releaseGit()
    const frozen = await frozenOf(g.io)
    expect(await release(g.io, '/r', P, '/h', { ...frozen, facts: { ...frozen.facts, url: 'https://other.invalid/r.git' } }, false)).toMatchObject({ ok: false, reason: 'remoteChanged', detail: 'url' })
    expect(await release(g.io, '/r', P, '/h', { ...frozen, hCfg: 'x' }, false)).toMatchObject({ ok: false, reason: 'tampered' })
    const lookalike = releaseGit({ 'ls-remote -- https://example.invalid/r.git refs/heads/main': ok(`${TIP}\trefs/heads/main-old\n`), 'ls-remote --heads --tags -- https://example.invalid/r.git': ok(''), [`rev-list ${HEAD}`]: ok(`${HEAD}\n`) })
    const fresh = await release(lookalike.io, '/r', P, '/h', await frozenOf(lookalike.io), false)
    expect(fresh.ok && lookalike.calls.some(c => c.key === `rev-list --count ${HEAD}`)).toBe(true) // refs/heads/main-old is not the branch
  })

  test('a config include inside the worktree is writable by Bash, so it is named; includes elsewhere are fine', () => {
    expect(writableIncludes(['/r/tools/git.inc', '/r/.git/../x.inc', '/home/u/.gitconfig.local', '/r-other/x', '/R/Tools/x.inc', '/private/tmp/t.inc', '/home/u/.npm/c.inc'], ['/r', '/private/tmp', '/home/u/.npm'])).toEqual(['/r/tools/git.inc', '/r/.git/../x.inc', '/R/Tools/x.inc', '/private/tmp/t.inc', '/home/u/.npm/c.inc'])
  })

  test('a remote URL with a transport helper, a token or a password cannot be pushed to', () => {
    for (const u of ['ext::sh -c touch% /tmp/x', 'fd::17', 'https://ghp_abc@github.com/o/r.git', 'https://u:p@github.com/o/r.git', 'ssh://u:p@host/r.git', 'ftp://host/r.git', 'http://github.com/o/r.git', 'file:///srv/r.git', '/srv/r.git', '../r.git', 'r.git']) expect([u, urlProblem(u) === null]).toEqual([u, false])
    for (const u of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'git://127.0.0.1:9418/r.git']) expect([u, urlProblem(u)]).toEqual([u, null])
  })

  test('the publish scan refuses when git output was cut at 4 MiB, and reads merges against their first parent', async () => {
    const seen: string[][] = []
    const read: GitRead = async args => { seen.push(args); return args[1] === '-p' ? { ok: true, out: '', truncated: true } : { ok: true, out: args[0] === 'rev-list' ? '1\n' : '' } }
    expect(await publishReason(read, ['HEAD', '--not', '--remotes'])).toContain('output over 4 MiB')
    expect(seen.filter(a => a[0] === 'log').every(a => a.includes('--diff-merges=first-parent'))).toBe(true)
    expect(seen.find(a => a[1] === '-p')).toContain('--no-textconv')
    expect(seen.find(a => a[1] === '-p')).toEqual(expect.arrayContaining(['--src-prefix=a/', '--dst-prefix=b/'])) // a repo's diff prefix cannot move names
  })

  test('a .pem of certificates alone is published; a key in it, another block, a key earlier in the range or an unreadable copy is refused (535 trial, M-10)', async () => {
    const cert = ['-----BEGIN CERTIFICATE-----', 'MIIB'.repeat(16), 'AA==', '-----END CERTIFICATE-----']
    const key = ['-----BEGIN EC ' + 'PRIVATE KEY-----', 'MHcC'.repeat(16), '-----END EC ' + 'PRIVATE KEY-----']
    const added = (path: string, lines: string[]) => [`diff --git a/${path} b/${path}`, '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n')
    const repo = (o: { names?: string; diff?: string; tree?: string; head?: string }): GitRead => async args =>
      args[0] === 'rev-list' ? { ok: true, out: '1\n' }
        : args[0] === 'log' ? { ok: true, out: (args.includes('--name-only') ? o.names : o.diff) ?? '' }
          : args[0] === 'ls-tree' ? { ok: true, out: o.tree ?? '' }
            : args[0] === 'cat-file' && o.head !== undefined ? { ok: true, out: o.head } : { ok: false, out: '' }
    const revs = ['HEAD', '--not', '--remotes'], release = { headTree: true }
    // a release: the certificate sits unchanged in HEAD's tree (the FreeTSA CA of 535's tests)
    expect(await publishReason(repo({ tree: 't/ca.pem\0src/a.py\0', head: cert.join('\n') }), revs, release)).toBeNull()
    const keyed = await publishReason(repo({ tree: 't/ca.pem\0', head: [...cert, ...key].join('\n') }), revs, release)
    expect(keyed).toContain('private path: t/ca.pem')
    expect(keyed).toContain('A .pem passes only when it holds certificates alone')
    expect(await publishReason(repo({ tree: 't/ca.pem\0' }), revs, release)).toContain('Could not check')
    // a key added earlier in the range and a certificate at HEAD: the key still reaches the remote
    expect(await publishReason(repo({ names: 't/ca.pem\0', diff: added('t/ca.pem', key), tree: 't/ca.pem\0', head: cert.join('\n') }), revs, release)).toContain('private path: t/ca.pem')
    // a push (no tree): the lines added are the file
    expect(await publishReason(repo({ names: 't/ca.pem\0', diff: added('t/ca.pem', cert) }), revs)).toBeNull()
    expect(await publishReason(repo({ names: 't/ca.pem\0', diff: added('t/ca.pem', ['-----BEGIN EC PARAMETERS-----', 'BggqhkjOPQMBBw==', '-----END EC PARAMETERS-----']) }), revs)).toContain('private path: t/ca.pem')
    expect(await publishReason(repo({ names: 't/ca.pem\0', diff: added('t/ca.pem', cert.slice(1, 3)) }), revs)).toContain('private path: t/ca.pem') // body lines only: unknown
    // other key formats stay refused by name, whatever they hold
    expect(await publishReason(repo({ names: 't/ca.key\0', diff: added('t/ca.key', cert) }), revs)).toContain('private path: t/ca.key')
    // security review: names match exactly, and a changed name must show under its own diff header
    const header = (name: string, plus: string, lines: string[]) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, plus, `@@ -1 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n')
    const leak = ['db_password=hunter2-prod'] // text no secret pattern catches
    expect(await publishReason(repo({ names: 't/my ca.pem\0', diff: header('t/my ca.pem', '+++ b/t/my ca.pem\t', leak), tree: 't/my ca.pem\0', head: cert.join('\n') }), revs, release)).toContain('private path: t/my ca.pem')
    expect(await publishReason(repo({ names: 't/my ca.pem\0', diff: header('t/my ca.pem', '+++ b/t/my ca.pem\t', cert), tree: 't/my ca.pem\0', head: cert.join('\n') }), revs, release)).toBeNull()
    expect(await publishReason(repo({ names: 't/we"ird.pem\0', diff: header('t/we"ird.pem', '+++ "b/t/we\\"ird.pem"', cert), tree: 't/we"ird.pem\0', head: cert.join('\n') }), revs, release)).toContain('private path: t/we"ird.pem')
    expect(await publishReason(repo({ names: 't/ca.pem\0t/ca.pem \0', diff: [added('t/ca.pem', cert), header('t/ca.pem ', '+++ b/t/ca.pem \t', leak)].join('\n') }), revs)).toContain('private path: t/ca.pem')
    // lines removed only (a certificate dropped from a bundle): the header shows, and HEAD's copy decides
    expect(await publishReason(repo({ names: 't/ca.pem\0', diff: ['diff --git a/t/ca.pem b/t/ca.pem', '--- a/t/ca.pem', '+++ b/t/ca.pem', '@@ -5,4 +4,0 @@', ...cert.map(l => `-${l}`)].join('\n'), tree: 't/ca.pem\0', head: cert.join('\n') }), revs, release)).toBeNull()
  })

  test('push facts keep only a hash of config values and the key names, so a token in a url or credential key never reaches the record', async () => {
    const secret = 'ghp_' + 'Z9'.repeat(18)
    const g = fakeGit({
      'remote get-url --push origin': ok('https://example.invalid/r.git\n'),
      'config --includes --null --get-regexp ^url\\.': ok(`url.https://${secret}@github.com/.insteadof\nhttps://github.com/\0`),
      'config --includes --null --global': ok(`credential.helper\n!echo password=${secret}\0`),
    })
    const facts = await pushFacts(g.io, P, 'origin')
    expect(JSON.stringify(facts).includes(secret)).toBe(false)
    expect(facts.keyNames).toContain('credential.helper')
    const other = fakeGit({ 'remote get-url --push origin': ok('https://example.invalid/r.git\n'), 'config --includes --null --global': ok('credential.helper\nosxkeychain\0') })
    expect((await pushFacts(other.io, P, 'origin')).globalKeys).not.toBe(facts.globalKeys)
    const repo = fakeGit({ 'remote get-url --push origin': ok('https://example.invalid/r.git\n'), 'config --includes --null --file /r/.git/config': ok(`credential.https://oauth2:${secret}@gitlab.com.helper\nstore\0core.askpass\n/tmp/p.sh\0`) })
    const repoFacts = await pushFacts({ ...repo.io, exists: async (p: string) => p === '/r/.git/config' }, P, 'origin')
    expect(repoFacts.repoCredentialKeys).toEqual(['credential.https://***@gitlab.com.helper', 'core.askpass'])
    expect(JSON.stringify(repoFacts).includes(secret)).toBe(false)
    await expect(pushFacts(fakeGit({ 'remote get-url --push origin': ok(`https://${secret}@github.com/o/r.git\n`) }).io, P, 'origin')).rejects.toThrow('token')
  })
})

describe('the scans\' git reads (R2 step 4 and 5)', () => {
  test('blobsAt reads each file at the tree with every call hardened (a blank context line stays one); over 4 MiB throws', async () => {
    const g = fakeGit({ 'cat-file blob t1:a.py': ok('text\n'), 'cat-file blob t1:big.py': { exitCode: 0, stdout: 'x', stderr: '', isStdoutTruncated: true } })
    const argvs: string[][] = [], io: Io = { ...g.io, run: async (argv, init) => { argvs.push(argv); return g.io.run(argv, init) } }
    expect(await blobsAt(io, P, 't1', ['a.py', 'gone.py'])).toEqual({ 'a.py': 'text\n' })
    expect(argvs[0]).toEqual(expect.arrayContaining(['diff.suppressBlankEmpty=false', 'core.attributesFile=/dev/null']))
    await expect(blobsAt(io, P, 't1', ['big.py'])).rejects.toThrow('over 4 MiB')
  })

  test('ignoredLoadable hashes the stack\'s loadable ignored files by content, outside dependency, build, hidden and skipped folders', async () => {
    const g = fakeGit({ 'ls-files -z -o -i --exclude-standard --': ok('gen/x.py\0b.so\0') })
    const io: Io = { ...g.io, read: async p => (p === '/r/gen/x.py' ? 'x = 1\n' : Promise.reject(new Error('EACCES'))) }
    expect(await ignoredLoadable(io, P, PYTHON, ['__pycache__'])).toEqual({ 'b.so': 'unreadable', 'gen/x.py': hashOf('x = 1\n') })
    const key = g.calls[0]?.key ?? ''
    for (const spec of [':(glob)**/*.pth', ':(glob)**/sitecustomize.py', ':(exclude,glob)**/.venv/**', ':(exclude,glob)**/.*/**', ':(exclude,glob)**/__pycache__/**', ':(exclude,glob)**/*.egg-info/**', ':(exclude,glob)**/build/**'])
      expect([spec, key.includes(spec)]).toEqual([spec, true])
  })
})
