import { describe, expect, test } from 'claude-code/testing'
import { flowCheck } from '../hooks/flow-check'
import { flowStatus } from '../hooks/flow-turn'
import { paneCode } from '../hooks/flow-owner'
import { blockFlow } from '../hooks/flow-host'
import { HOME, ROOT } from './flow-fakes'
import { frozenOf } from '../hooks/flow-ship'
import { added, AUTHOR_TREE, diffKey, latest, remoteGit, run, SRC, START, TEST_FILE, toH0, toV1, type DriveOpts, type Remote, type W } from './flow-drive'

const HEAD_SHA = 'e'.repeat(40)

/** Verified and committed (HEAD's flow tree is the verified tree); the remote branch does not exist yet. */
async function shipped(o: Partial<Remote> = {}): Promise<{ w: W; d: DriveOpts; rm: Remote }> {
  const ctx = await toH0()
  const rm: Remote = { head: HEAD_SHA, tip: null, pushes: 0, ...o }
  const before = ctx.d.run
  ctx.d.run = argv => remoteGit(rm)(argv) ?? before?.(argv)
  ctx.w.setHeadTree(AUTHOR_TREE)
  return { ...ctx, rm }
}
const hash8 = (w: W): string => w.session().value?.pending.release?.hash.slice(0, 8) ?? ''

describe('flow-ship: H0 and the release echo', () => {
  test('work not committed yet: main is asked to commit it and the owner runs /flow-ship again', async () => {
    const { w } = await toH0()
    w.setHeadTree(START)
    expect((await run(w, 'flow-ship')).text).toContain('not committed yet')
    expect(w.submitted.at(-1)).toContain('git commit')
    expect(w.submitted.at(-1)).toContain('Do not push')
    expect(latest(w)).toMatchObject({ task: 'H0', awaiting: '/flow-ship' })
    expect(paneCode()).toBeNull()
  })

  test('work changed after verify: /flow-verify again, nothing is committed', async () => {
    const { w } = await toH0()
    w.setTree('9'.repeat(40))
    const submitted = w.submitted.length
    expect((await run(w, 'flow-ship')).text).toContain('changed after verify')
    expect(w.submitted.length).toBe(submitted)
    expect(latest(w)?.task).toBe('H0')
  })

  test('a reformatting commit hook (plan line 555): /flow-ship asks for verify again, and /flow-verify starts V1 with no round used', async () => {
    const { w } = await toH0()
    w.setTree('9'.repeat(40)) // the hook rewrote the files: neither the worktree nor HEAD holds the verified tree
    w.setHeadTree('9'.repeat(40))
    expect((await run(w, 'flow-ship')).text).toContain('changed after verify')
    const counters = latest(w)?.counters
    expect((await run(w, 'flow-verify')).text).toContain('Verify starts')
    expect(latest(w)).toMatchObject({ phase: 'verify', task: 'V1' })
    expect(latest(w)?.awaiting).toBeUndefined()
    expect(latest(w)?.counters).toEqual(counters)
    expect(w.submitted.at(-1)).toContain('flow_check')
  })

  test('the same after the release echo (H1): verification starts over and the release echo is dropped', async () => {
    const { w } = await shipped()
    await run(w, 'flow-ship')
    expect(w.session().value?.pending.release).toBeDefined()
    w.setTree('9'.repeat(40))
    expect((await run(w, 'flow-ship')).text).toContain('changed after verify')
    await run(w, 'flow-verify')
    expect(latest(w)).toMatchObject({ phase: 'verify', task: 'V1' })
    expect(w.session().value?.pending.release).toBeUndefined()
    expect(w.session().value?.release).toBeNull()
  })

  test('committed: the release echo shows the commit, branch, remote and push settings, with a code only the pane draws', async () => {
    const { w } = await shipped()
    const reply = (await run(w, 'flow-ship')).text
    expect(reply).toContain('Shown in the flow pane')
    const echo = w.session().value?.pending.release
    expect(echo?.title).toBe('Release for the project owner to approve')
    const lines = echo?.lines.join('\n') ?? ''
    expect(lines).toContain(`Commit ${HEAD_SHA.slice(0, 12)} to main`)
    expect(lines).toContain('https://github.com/o/r.git')
    expect(lines).toContain('docs/flow/verify.md')
    expect(latest(w)).toMatchObject({ phase: 'ship', task: 'H1', awaiting: '/flow-approve release' })
    expect(w.panes.at(-1)?.id).toBe('flow-echo')
    expect(paneCode()).toMatch(/^[A-Z2-9]{6}$/)
  })

  test('the echo lists the commits (50, then a count), the scan, unreviewed and untracked files, blocks, the tree and the report', async () => {
    const { w } = await shipped({ count: 60, subjects: Array.from({ length: 50 }, (_, i) => `abc${String(i).padStart(4, '0')} change ${i}`).join('\n') })
    await run(w, 'flow-ship')
    const lines = w.session().value?.pending.release?.lines ?? []
    expect(lines).toContain('Commits to publish: 60')
    expect(lines).toContain('  abc0049 change 49')
    expect(lines).toContain('  +10 more')
    expect(lines).toContain('Remote: https://github.com/o/r.git (refs/heads/main)')
    expect(lines.some(l => l.startsWith('Publish scan: no private data found'))).toBe(true)
    expect(lines).toContain('Changed after the last review: none')
    expect(lines).toContain('Untracked, not in the release: none')
    expect(lines).toContain('Blocks the agent caused: 0')
    expect(lines).toContain(`Release tree: ${AUTHOR_TREE.slice(0, 12)}`)
    // D10: the report stays in its file, named with its hash; the echo fits a screen
    expect(lines.some(l => /^Verify report: docs\/flow\/verify\.md \([0-9a-f]{8}\)$/.test(l))).toBe(true)
    expect(lines).not.toContain('- AC-001: passed')
    expect(lines.filter(l => !l.startsWith('  ')).length).toBeLessThan(20) // besides the commit list, a dozen lines
  })

  test('a secret in a commit subject is redacted in the echo', async () => {
    const { w } = await shipped({ subjects: `eeeeeee add key ghp_${'k'.repeat(36)}` })
    await run(w, 'flow-ship')
    expect(JSON.stringify(w.session().value?.pending.release)).not.toContain('kkkkkkkk')
  })

  test('the global config files to check follow the environment: GIT_CONFIG_GLOBAL, else ~/.gitconfig and $XDG_CONFIG_HOME/git/config', async () => {
    const { w } = await shipped()
    const r = latest(w)
    if (!r) throw new Error('no record')
    expect((await frozenOf(w.host, r)).configFiles).toEqual([`${HOME}/.gitconfig`, `${HOME}/.config/git/config`])
    expect((await frozenOf({ ...w.host, env: { ...w.host.env, XDG_CONFIG_HOME: '/x' } }, r)).configFiles).toEqual([`${HOME}/.gitconfig`, '/x/git/config'])
    expect((await frozenOf({ ...w.host, env: { ...w.host.env, GIT_CONFIG_GLOBAL: '/g/cfg', GIT_CONFIG_SYSTEM: '/s/cfg' } }, r)).configFiles).toEqual(['/g/cfg', '/s/cfg'])
  })

  test('the folders Bash can write, for the config-include check: TMPDIR and the approved allowWrite with ~ expanded', async () => {
    const { w } = await shipped()
    const r = latest(w)
    if (!r) throw new Error('no record')
    expect((await frozenOf(w.host, r)).writable).toEqual(expect.arrayContaining(['/private/var/folders/t', `${HOME}/.npm`]))
  })

  test('F37: the release code reaches no reply, prompt, journal line, state, status, check, record or view', async () => {
    const { w } = await shipped()
    const reply = (await run(w, 'flow-ship')).text
    const code = paneCode() ?? 'NO-CODE'
    const texts = [reply, ...w.submitted, ...w.journal, JSON.stringify(w.session()), await flowStatus(w.host), await flowCheck(w.host), ...w.files.values(), ...w.panes.map(p => p.title)]
    expect(code).not.toBe('NO-CODE')
    expect(texts.filter(t => t.includes(code))).toEqual([])
  })
})

describe('flow-ship: H1 approval and H2 push', () => {
  test('the right code from the prompt: pushed, the remote checked, the flow done and its record ended', async () => {
    const { w, rm } = await shipped()
    await run(w, 'flow-ship')
    const reply = (await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)).text
    expect(reply).toContain(`Released ${HEAD_SHA.slice(0, 12)} to main`)
    expect(rm.pushes).toBe(1)
    expect(rm.tip).toBe(HEAD_SHA)
    expect(latest(w)).toBeUndefined()
    expect([...w.files.entries()].some(([k, v]) => k.endsWith('.end') && v.includes('"end":"done"'))).toBe(true)
    expect(w.session().value?.pending.release).toBeUndefined()
    expect(w.session().value?.release).toBeNull()
    expect(paneCode()).toBeNull()
  })

  test('the verify report edited after the echo: the approval is refused, nothing is pushed, /flow-ship blocks', async () => {
    const { w, rm } = await shipped()
    await run(w, 'flow-ship')
    w.files.set(`${ROOT}/docs/flow/verify.md`, '# edited\n')
    expect((await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)).text).toContain('changed after it was shown')
    expect(rm.pushes).toBe(0)
    await run(w, 'flow-ship')
    expect(latest(w)?.blocked).toEqual({ reason: 'reportChanged', vars: { file: 'docs/flow/verify.md' } })
    expect(latest(w)?.selfBlocks).toBe(1)
  })

  test('files edited after the echo (not committed): the approval pushes nothing', async () => {
    const { w, rm } = await shipped()
    await run(w, 'flow-ship')
    w.setTree('9'.repeat(40))
    expect((await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)).text).toContain('changed after verify')
    expect(rm.pushes).toBe(0)
  })

  test('another branch checked out: /flow-ship names it and shows no release', async () => {
    const { w, d } = await shipped()
    const before = d.run
    d.run = argv => (argv.includes('symbolic-ref') ? { exitCode: 0, stdout: 'dev\n', stderr: '' } : before?.(argv))
    expect((await run(w, 'flow-ship')).text).toContain('The current branch is dev, not main')
    expect(paneCode()).toBeNull()
  })

  test('an open block other than a publish one: /flow-ship shows the card and no release', async () => {
    const { w } = await shipped()
    await blockFlow(w.host, latest(w)?.flowId ?? '', { reason: 'tampered', vars: { file: 'x' } })
    await run(w, 'flow-ship')
    expect(paneCode()).toBeNull()
    expect(w.session().value?.pending.release).toBeUndefined()
  })

  test('a wrong code is spent: refused, nothing pushed, /flow-ship shows a new one', async () => {
    const { w, rm } = await shipped()
    await run(w, 'flow-ship')
    const first = paneCode()
    expect((await run(w, `flow-approve release ${hash8(w)} WRONG2`)).text).toContain('The release code does not match')
    expect(rm.pushes).toBe(0)
    expect(paneCode()).toBeNull()
    await run(w, 'flow-ship')
    expect(paneCode()).toMatch(/^[A-Z2-9]{6}$/)
    expect(paneCode()).not.toBe(first)
  })

  test('HEAD moved after the echo: the approval is refused and nothing is pushed', async () => {
    const { w, rm } = await shipped()
    await run(w, 'flow-ship')
    const code = paneCode() ?? ''
    rm.head = 'd'.repeat(40)
    expect((await run(w, `flow-approve release ${hash8(w)} ${code}`)).text).toContain('changed')
    expect(rm.pushes).toBe(0)
  })

  test('the remote refuses the push: blocked for the owner, and /flow-verify starts over', async () => {
    const { w, rm } = await shipped({ push: { exitCode: 1, stdout: '', stderr: '! [rejected] main -> main (fetch first)' } })
    await run(w, 'flow-ship')
    await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)
    expect(rm.pushes).toBe(1)
    expect(latest(w)?.blocked).toMatchObject({ reason: 'pushRejected', vars: { detail: expect.stringContaining('rejected') } })
    await run(w, 'flow-verify')
    expect(latest(w)).toMatchObject({ phase: 'verify', task: 'V1' })
    expect(latest(w)?.blocked).toBeUndefined()
    expect(latest(w)?.frozen.scanBase).toBeUndefined()
  })

  test('after the owner takes in the moved remote, verify scans from merge-base(HEAD, remote tip) when it descends from baseSha', async () => {
    const tip = '1'.repeat(40)
    const { w, d, rm } = await shipped({ push: { exitCode: 1, stdout: '', stderr: '! [rejected] main -> main (fetch first)' } })
    await run(w, 'flow-ship')
    await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)
    rm.tip = tip
    rm.tipHere = true
    const gitOut = d.gitOut ?? {}
    gitOut[diffKey(tip, AUTHOR_TREE)] = added('tests/add.test.ts', TEST_FILE) + added('src/add.ts', SRC)
    // from baseSha the diff also holds the remote's own commits, junk included: not this flow's work
    gitOut[diffKey('a'.repeat(40), AUTHOR_TREE)] = gitOut[diffKey(tip, AUTHOR_TREE)] + added('src/theirs.ts', "console.log('theirs')\n")
    await run(w, 'flow-verify')
    expect(latest(w)?.frozen.scanBase).toBe(tip)
    await flowCheck(w.host)
    expect(latest(w)?.task).toBe('H0')
  })

  test('a merge-base that does not descend from baseSha keeps the scans on baseSha', async () => {
    const { w, rm } = await shipped({ push: { exitCode: 1, stdout: '', stderr: '! [rejected]' } })
    await run(w, 'flow-ship')
    await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)
    rm.tip = '1'.repeat(40)
    rm.descends = false
    await run(w, 'flow-verify')
    expect(latest(w)?.frozen.scanBase).toBeUndefined()
  })

  test('the remote branch moved to a commit this repository lacks: blocked before any push', async () => {
    const { w, rm } = await shipped({ tip: '7'.repeat(40) })
    await run(w, 'flow-ship')
    expect(latest(w)?.blocked).toMatchObject({ reason: 'pushRejected', vars: { detail: expect.stringContaining('pull first') } })
    expect(w.session().value?.pending.release).toBeUndefined()
    expect(rm.pushes).toBe(0)
  })

  test('a secret in the commits to publish blocks the release', async () => {
    const { w, rm } = await shipped({ log: `diff --git a/src/add.ts b/src/add.ts\n+++ b/src/add.ts\n@@ -0,0 +1 @@\n+const t = 'ghp_${'k'.repeat(36)}'\n` })
    await run(w, 'flow-ship')
    const b = latest(w)?.blocked
    expect(b?.reason).toBe('publish')
    expect(JSON.stringify(b)).not.toContain('kkkkkkkk')
    expect(rm.pushes).toBe(0)
    rm.log = ''
    expect((await run(w, 'flow-ship')).text).toContain('Shown in the flow pane')
    expect(latest(w)).toMatchObject({ task: 'H1', awaiting: '/flow-approve release' })
    expect(latest(w)?.blocked).toBeUndefined()
  })

  test('the remote cannot be reached at the push: back to H0, and after /flow-retry check /flow-ship shows a new release', async () => {
    const { w, rm } = await shipped()
    await run(w, 'flow-ship')
    rm.down = true
    await run(w, `flow-approve release ${hash8(w)} ${paneCode() ?? ''}`)
    expect(latest(w)).toMatchObject({ task: 'H0', awaiting: '/flow-ship', blocked: { reason: 'couldNotRun' } })
    expect(w.session().value?.release).toBeNull()
    await run(w, 'flow-retry check')
    rm.down = false
    expect((await run(w, 'flow-ship')).text).toContain('Shown in the flow pane')
    expect(rm.pushes).toBe(0)
  })

  test('/flow-ship before verify is done only shows the card', async () => {
    const { w } = await toV1()
    const shape = (): string => JSON.stringify({ ...latest(w), version: 0 })
    const before = shape()
    await run(w, 'flow-ship')
    expect(shape()).toBe(before)
    expect(paneCode()).toBeNull()
  })

  test('the verify report edited after verify blocks the release', async () => {
    const { w } = await shipped()
    w.files.set(`${ROOT}/docs/flow/verify.md`, '# edited\n')
    await run(w, 'flow-ship')
    expect(latest(w)?.blocked).toEqual({ reason: 'reportChanged', vars: { file: 'docs/flow/verify.md' } })
    expect(JSON.parse(await flowStatus(w.host)).next).toContain('/flow-verify')
    await run(w, 'flow-verify')
    await flowCheck(w.host)
    expect(latest(w)).toMatchObject({ task: 'H0', awaiting: '/flow-ship' })
    expect(latest(w)?.blocked).toBeUndefined()
  })
})
