import { describe, expect, test } from 'claude-code/testing'
import { gateDecision, noVerifyReason, gitIntent, gitAliasReason, ALIAS_REASON, isProtectedConfig, BASH_KEY, FULL_DENIALS, isHarnessData } from '../hooks/gate'
import type { Io } from '../hooks/session'

const fresh = { checked: [] as string[], denials: 0 }

describe('gate', () => {
  test('first edit of a file is refused with the fact list and marked; the retry passes', () => {
    const first = gateDecision({ tool: 'Edit', file_path: '/p/src/a.py' }, fresh)
    expect(first.deny).toContain('[Fact-Forcing Gate]')
    expect(first.deny).toContain('Before editing /p/src/a.py')
    expect(first.mark).toEqual(['/p/src/a.py'])
    expect(first.denials).toBe(1)
    const retry = gateDecision({ tool: 'Edit', file_path: '/p/src/a.py' }, { checked: first.mark, denials: 1 })
    expect(retry.deny).toBeUndefined()
  })

  test('Write asks the creation facts; settings files and subagent calls pass untouched', () => {
    expect(gateDecision({ tool: 'Write', file_path: '/p/new.py' }, fresh).deny).toContain('Before creating /p/new.py')
    expect(gateDecision({ tool: 'Write', file_path: '/p/.claude/settings.local.json' }, fresh)).toEqual({ mark: [], denials: 0 })
    expect(gateDecision({ tool: 'Edit', file_path: '/p/a.py', agentId: 'agent-1' }, fresh)).toEqual({ mark: [], denials: 0 })
  })

  test(`after ${FULL_DENIALS} full refusals the message is the short one`, () => {
    const out = gateDecision({ tool: 'Edit', file_path: '/p/d.py' }, { checked: [], denials: FULL_DENIALS })
    expect(out.deny).toContain(`(denial #${FULL_DENIALS + 1} this session)`)
    expect(out.deny).not.toContain('GATEGUARD')
  })

  test('MultiEdit checks the top-level file and each edit file', () => {
    expect(gateDecision({ tool: 'MultiEdit', file_path: '/p/m.py', edits: [] }, fresh).mark).toEqual(['/p/m.py'])
    expect(gateDecision({ tool: 'MultiEdit', edits: [{ file_path: '/p/n.py' }] }, fresh).mark).toEqual(['/p/n.py'])
  })

  test('first Bash command of a session asks for the request; read-only git introspection is free', () => {
    const first = gateDecision({ tool: 'Bash', command: 'ls src' }, fresh)
    expect(first.deny).toContain('Before the first Bash command this session')
    expect(first.mark).toEqual([BASH_KEY])
    expect(gateDecision({ tool: 'Bash', command: 'ls src' }, { checked: [BASH_KEY], denials: 0 }).deny).toBeUndefined()
    expect(gateDecision({ tool: 'Bash', command: 'git status' }, fresh)).toEqual({ mark: [], denials: 0 })
  })

  test('each destructive command is refused once with the rollback questions, then passes', () => {
    const st = { checked: [BASH_KEY], denials: 0 }
    const out = gateDecision({ tool: 'Bash', command: 'rm -rf build' }, st)
    expect(out.deny).toContain('Destructive command detected')
    expect(out.mark[0]).toMatch(/^destructive:[0-9a-f]{16}$/)
    expect(gateDecision({ tool: 'Bash', command: 'rm -rf build' }, { checked: [BASH_KEY, ...out.mark], denials: 0 }).deny).toBeUndefined()
    expect(gateDecision({ tool: 'Bash', command: 'git reset --hard HEAD~1' }, { checked: [BASH_KEY, ...out.mark], denials: 0 }).deny).toContain('Destructive')
  })

  test('hook-bypass flags are always refused; mentions in text are not', () => {
    expect(noVerifyReason('git commit --no-verify -m x')).toContain('BLOCKED')
    expect(noVerifyReason('git -c core.hooksPath=/dev/null commit -m x')).toContain('BLOCKED')
    expect(noVerifyReason('git commit -m "about --no-verify"')).toBeNull()
    expect(noVerifyReason('echo --no-verify')).toBeNull()
  })

  test('git intent sees commit, commit -a, commit with paths, staging, push and other repositories, not text inside a heredoc', () => {
    const none = { commit: false, commitAll: false, commitPaths: false, push: false, pushTags: false, pushRefs: [], staging: false, otherRepo: false, indirect: false, aliases: [] }
    expect(gitIntent('git commit -m "fix: a b"')).toEqual({ ...none, commit: true })
    expect(gitIntent('git add . && git commit -am x')).toEqual({ ...none, commit: true, commitAll: true, staging: true })
    expect(gitIntent('git commit -m x src/a.py')).toEqual({ ...none, commit: true, commitPaths: true })
    expect(gitIntent('git commit -F msg.txt')).toEqual({ ...none, commit: true })
    expect(gitIntent('git commit --author "A <a@b>" -m x -- docs')).toEqual({ ...none, commit: true, commitPaths: true })
    expect(gitIntent('git -C ../other commit -m x')).toEqual({ ...none, commit: true, otherRepo: true })
    expect(gitIntent('git push origin main')).toEqual({ ...none, push: true, pushRefs: ['main'] })
    expect(gitIntent("cat > notes.md <<'EOF'\ngit push origin main\nEOF")).toEqual(none)
    expect(gitIntent('echo "git push"')).toEqual(none)
    expect(gitIntent('git log --grep commit')).toEqual(none)
  })

  test('git run through cd, a nested shell or a wrapper cannot be checked, so it is flagged', () => {
    expect(gitIntent('cd ../other && git commit -m x').otherRepo).toBe(true)
    expect(gitIntent('cd src && ls').otherRepo).toBe(false)
    for (const c of ["bash -c 'git commit -m x'", 'sh -c "git push"', 'eval git push', 'env GIT_TRACE=1 git commit -m x', 'echo main | xargs git push origin']) {
      expect(gitIntent(c).indirect).toBe(true)
    }
    expect(gitIntent("bash -c 'git status'").indirect).toBe(false)
  })

  test('an environment prefix, an alias or injected config cannot hide git commit or push from the guard', () => {
    expect(gitIntent('A=1 git push origin main').push).toBe(true)
    expect(gitIntent('GIT_TRACE=1 git commit -m x').commit).toBe(true)
    expect(gitIntent('GIT_DIR=../o/.git git push').otherRepo).toBe(true)
    expect(gitIntent('GIT_WORK_TREE=/tmp/x git commit -m x').otherRepo).toBe(true)
    expect(gitIntent('git -c alias.p=push p origin main').push).toBe(true)
    expect(gitIntent('git -c alias.c=commit c -m x').commit).toBe(true)
    expect(gitIntent("git -c 'alias.p=!git push' p").indirect).toBe(true)
    expect(gitIntent('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p').indirect).toBe(true)
    expect(gitIntent('git -c include.path=/tmp/a p').indirect).toBe(true)
    expect(gitIntent('git --config-env=alias.p=X p').indirect).toBe(true)
    expect(gitIntent('git p origin main').aliases).toEqual(['p'])
    expect(gitIntent('C=push; git $C origin main').indirect).toBe(true)
    expect(gitIntent('git send-pack origin main').push).toBe(true)
    expect(gitIntent('git "push" origin main').indirect).toBe(true)
    expect(gitIntent('C=push; git "$C" origin main').indirect).toBe(true)
    expect(gitIntent('git -c alias.p=q -c alias.q=push p origin main').push).toBe(true)
    expect(gitIntent('git -c alias.p=--no-pager p push origin main').indirect).toBe(true)
    expect(gitIntent('export GIT_DIR=../o/.git; git push').otherRepo).toBe(true)
    expect(gitIntent('HOME=/tmp/h git p origin main').indirect).toBe(true)
    expect(gitIntent('git Commit -m x').commit).toBe(true)
    expect(gitIntent('git Commit -m x').aliases).toEqual(['commit'])
    expect(gitIntent('git http-push https://example.invalid/r main').push).toBe(true)
    expect(gitIntent('git lfs push origin main').push).toBe(true)
    expect(gitIntent('git lfs ls-files').push).toBe(false)
    expect(gitIntent('git -c core.pager="less -R" lg').indirect).toBe(false)
    expect(gitIntent('A=1 git status').push || gitIntent('A=1 git status').indirect).toBe(false)
    expect(gitIntent('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git log').indirect).toBe(false)
    expect(gitIntent('git status && git log').aliases).toEqual([])
    expect(noVerifyReason('A=1 git commit --no-verify -m x')).not.toBeNull()
  })

  test('commands on separate lines, behind shell keywords or in a group are each read; hidden subcommands are refused', () => {
    expect(gitIntent('git status\ngit push origin main').push).toBe(true)
    expect(gitIntent('echo ok\ngit push').push).toBe(true)
    expect(gitIntent('git commit \\\n  -m x').commit).toBe(true)
    expect(gitIntent('git commit -m "line one\nline two"').commit).toBe(true)
    expect(gitIntent('git commit -m "line one\nline two"').push).toBe(false)
    for (const c of ['(git push)', '{ git push; }', '! git push', 'if true; then git push; fi', 'for b in a; do git push; done']) expect(gitIntent(c).push).toBe(true)
    expect(gitIntent('if git diff --cached --quiet; then :; else git commit -m x; fi').commit).toBe(true)
    for (const c of ['git pu"sh" origin main', 'git pu\\sh origin main', "git p''ush origin main", 'git $(echo push) origin main', 'git `echo push` origin main', 'git --attr-source HEAD push']) {
      expect(gitIntent(c).indirect).toBe(true)
    }
    expect(gitIntent('git commit -m "$(cat msg.txt)"').indirect).toBe(false)
    expect(gitIntent('git -C "$(pwd)" status').indirect).toBe(false)
    expect(gitIntent('git -c core.editor=true -C "$(pwd)" $(echo push)').indirect).toBe(true)
    expect(gitIntent('git subtree -P lib push origin main').push).toBe(true)
    expect(gitIntent('git -c alias.lfs=push lfs origin main').push).toBe(true)
    expect(gitIntent('git lfs ls-files').aliases).toEqual(['lfs'])
    expect(gitIntent('git push --tags').pushTags).toBe(true)
    expect(gitIntent('git push origin main').pushTags).toBe(false)
    expect(gitIntent('git push origin v1.0 a:b +c:d :gone').pushRefs).toEqual(['v1.0', 'a', 'c'])
    expect(gitIntent('git subtree -P lib -b br --onto X push origin main').push).toBe(true)
    for (const c of ['"git" push origin main', "g''it push", 'g\\it push', 'G=git; $G push', '$(which git) push origin main',
      'git -c help.autocorrect=immediate psuh origin main', 'git submodule foreach git push', "git rebase -x 'git push origin HEAD' main", 'git bisect run git push']) {
      expect(gitIntent(c).indirect).toBe(true)
    }
    for (const c of ['f(){ git push; }; f', 'f() { git push; }; f', 'function f { git push; }; f', 'case x in *) git push;; esac', 'coproc git push']) {
      expect(gitIntent(c).push).toBe(true)
    }
    expect(gitIntent("grep -rn 'git $(' hooks/").indirect).toBe(false)
    expect(gitIntent("git commit -m 'fix: refuse git $(x) forms'").indirect).toBe(false)
    expect(gitIntent('"$EDITOR" notes.md').indirect).toBe(false)
  })

  test('a git alias that runs commit or push is refused; other aliases and missing ones pass', async () => {
    const aliases: Record<string, string> = {
      p: 'push origin', c: 'commit -m wip', sh: '!git push --force', st: 'status -sb', l: 'log --oneline',
      a: 'b', b: 'push', np: '--no-pager push', sub: 'subtree', loop: 'loop2', loop2: 'loop',
      g: '!git', f: '!f(){ git "$@"; }; f', q: '"pu"sh', opt: '--no-pager', lg: '!git log --graph', lfsl: 'lfs ls-files', sts: 'subtree split -P lib',
      x: '!sh', ev: '!eval', all: '!"$@"',
    }
    const io = { run: async (argv: string[]) => { const k = (argv[argv.length - 1] ?? '').replace(/^alias\./, ''); return k === 'bad' ? { exitCode: 128, stdout: '', stderr: '' } : k in aliases ? { exitCode: 0, stdout: `${aliases[k]}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' } } } as unknown as Io
    for (const name of ['p', 'c', 'sh', 'a', 'np', 'sub', 'loop', 'bad', 'g', 'f', 'q', 'opt', 'x', 'ev', 'all']) expect(await gitAliasReason(io, '/p', [name])).toBe(ALIAS_REASON)
    for (const name of ['st', 'l', 'missing', 'lg', 'lfsl', 'sts']) expect(await gitAliasReason(io, '/p', [name])).toBeNull()
    expect(await gitAliasReason(io, '/p', [])).toBeNull()
    const broken = { run: async () => { throw new Error('git missing') } } as unknown as Io
    expect(await gitAliasReason(broken, '/p', ['p'])).toBe(ALIAS_REASON)
  })

  test('an unknown git command is refused when help.autocorrect would run the closest one', async () => {
    const io = (auto: string | null) => ({ run: async (argv: string[]) => (argv[argv.length - 1] === 'help.autocorrect' && auto !== null ? { exitCode: 0, stdout: `${auto}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }) }) as unknown as Io
    expect(await gitAliasReason(io('immediate'), '/p', ['psuh'])).toContain('help.autocorrect')
    expect(await gitAliasReason(io('1'), '/p', ['psuh'])).toContain('help.autocorrect')
    expect(await gitAliasReason(io('0'), '/p', ['psuh'])).toBeNull()
    expect(await gitAliasReason(io(null), '/p', ['psuh'])).toBeNull()
    expect(await gitAliasReason(io('immediate'), '/p', ['lfs'])).toBeNull()
  })

  test('lint and formatter configs are protected, ordinary files are not', () => {
    expect(isProtectedConfig('/p/ruff.toml')).toBe(true)
    expect(isProtectedConfig('/p/.eslintrc.json')).toBe(true)
    expect(isProtectedConfig('/p/eslint.config.local.mjs')).toBe(true)
    expect(isProtectedConfig('/p/pyproject.toml')).toBe(false)
    expect(isProtectedConfig('/p/src/ruff.py')).toBe(false)
  })

  test('the project .snagon folder is exempt from the first-edit gate, and only that folder', () => {
    const st = { checked: [], denials: 0 }
    expect(gateDecision({ tool: 'Write', file_path: '/p/.snagon/CLAUDE.md' }, st, '/p').deny).toBeUndefined()
    expect(gateDecision({ tool: 'Edit', file_path: '.snagon/config.json' }, st, '/p').deny).toBeUndefined()
    expect(gateDecision({ tool: 'MultiEdit', file_path: '/p/.snagon/a.md', edits: [] }, st, '/p').deny).toBeUndefined()
    for (const f of ['/p/.snagon/../src/a.py', '/p/src/.snagon/x', '/other/.snagon/x', '/p/.snagonx/a', '/p/.snagon']) {
      expect(isHarnessData(f, '/p')).toBe(false)
      expect(gateDecision({ tool: 'Write', file_path: f }, st, '/p').deny).toBeDefined()
    }
    expect(gateDecision({ tool: 'Write', file_path: '/p/.snagon/x' }, st).deny).toBeDefined() // no root known: gated
    expect(gateDecision({ tool: 'Bash', command: 'rm -rf .snagon' }, st, '/p').deny).toBeDefined() // Bash is unchanged
  })

  test('the .snagon exemption with a trailing-slash root, and MultiEdit mixing exempt and other files', () => {
    const st = { checked: [], denials: 0 }
    expect(isHarnessData('/p/.snagon/a', '/p/')).toBe(true)
    expect(isHarnessData('/p/.snagon/a', '/')).toBe(false)
    expect(isHarnessData('/.snagon/a', '/')).toBe(true)
    expect(gateDecision({ tool: 'MultiEdit', file_path: '/p/.snagon/a.md', edits: [{ file_path: '/p/src/b.py' }] }, st, '/p').deny).toBeDefined()
  })
})
