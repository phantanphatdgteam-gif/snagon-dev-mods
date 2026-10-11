import { describe, expect, test } from 'claude-code/testing'
import { gateDecision, noVerifyReason, gitIntent, isProtectedConfig, BASH_KEY, FULL_DENIALS, isHarnessData } from '../hooks/gate'

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
    const none = { commit: false, commitAll: false, commitPaths: false, push: false, staging: false, otherRepo: false, indirect: false }
    expect(gitIntent('git commit -m "fix: a b"')).toEqual({ ...none, commit: true })
    expect(gitIntent('git add . && git commit -am x')).toEqual({ ...none, commit: true, commitAll: true, staging: true })
    expect(gitIntent('git commit -m x src/a.py')).toEqual({ ...none, commit: true, commitPaths: true })
    expect(gitIntent('git commit -F msg.txt')).toEqual({ ...none, commit: true })
    expect(gitIntent('git commit --author "A <a@b>" -m x -- docs')).toEqual({ ...none, commit: true, commitPaths: true })
    expect(gitIntent('git -C ../other commit -m x')).toEqual({ ...none, commit: true, otherRepo: true })
    expect(gitIntent('git push origin main')).toEqual({ ...none, push: true })
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
