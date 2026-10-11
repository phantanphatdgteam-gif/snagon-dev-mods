// The safety gate on tool calls: fact-forcing before the first edit of each file, the first Bash command of a
// session and every destructive command (logic and messages vendored, see vendor/); git hook-bypass flags always
// refused; lint and formatter configs protected; and a secret and private-path scan before git commit or push.
import {
  condensedGateMsg, destructiveBashMsg, editGateMsg, findGitSubcommand, isClaudeSettingsPath, isDestructiveBash,
  isReadOnlyGitIntrospection, routineShellMsg, splitCommandSegments, tokenize, writeGateMsg,
} from './vendor/destructive'
import { stripHeredocBodies } from './vendor/heredoc'
import { checkCommand } from './vendor/no-verify'
import { hashOf, type Io } from './session'
import { isForbiddenPath, scanDiff } from './secrets'

export type GateState = { checked: readonly string[]; denials: number }
export type GateCall = { tool: string; file_path?: unknown; command?: unknown; edits?: unknown; agentId?: unknown }
export type GateOutcome = { deny?: string; mark: string[]; denials: number }

export const FULL_DENIALS = 3 // after this many first-touch refusals, the shorter message
export const BASH_KEY = '__bash_session__'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Whether `file` lies inside the project's `.snagon/` folder: the harness's own per-user data, never in git. */
export function isHarnessData(file: string, root: string | undefined): boolean {
  if (!root || !file) return false
  const abs = file.startsWith('/') ? file : `${root}/${file}`
  const parts: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const base = root.replace(/\/+$/, '')
  return `/${parts.join('/')}`.startsWith(`${base}/.snagon/`)
}

function fileGate(file: string, write: boolean, st: GateState, root?: string): GateOutcome {
  // Owner-approved (2026-10-11): the harness's own data folder needs no facts before a first edit.
  if (!file || isClaudeSettingsPath(file) || isHarnessData(file, root) || st.checked.includes(file)) return { mark: [], denials: st.denials }
  const denials = st.denials + 1
  const deny = denials > FULL_DENIALS ? condensedGateMsg(write ? 'creation' : 'edit', file, denials) : write ? writeGateMsg(file) : editGateMsg(file)
  return { deny, mark: [file], denials }
}

/** The fact-forcing decision for one call (pure: the hook stores `mark` and `denials`). */
export function gateDecision(call: GateCall, st: GateState, root?: string): GateOutcome {
  const pass: GateOutcome = { mark: [], denials: st.denials }
  if (call.tool === 'Edit' || call.tool === 'Write') {
    if (typeof call.agentId === 'string' && call.agentId) return pass // the parent session already passed this gate
    return fileGate(str(call.file_path), call.tool === 'Write', st, root)
  }
  if (call.tool === 'MultiEdit') {
    if (typeof call.agentId === 'string' && call.agentId) return pass
    const files = [str(call.file_path), ...(Array.isArray(call.edits) ? call.edits.map(e => str((e as { file_path?: unknown })?.file_path)) : [])]
    for (const f of files) {
      const out = fileGate(f, false, st, root)
      if (out.deny) return out
    }
    return pass
  }
  if (call.tool === 'Bash') {
    const command = str(call.command)
    if (isReadOnlyGitIntrospection(command)) return pass
    if (isDestructiveBash(command)) {
      const key = `destructive:${hashOf(command)}`
      return st.checked.includes(key) ? pass : { deny: destructiveBashMsg(), mark: [key], denials: st.denials }
    }
    return st.checked.includes(BASH_KEY) ? pass : { deny: routineShellMsg('Bash'), mark: [BASH_KEY], denials: st.denials }
  }
  return pass
}

/** Why a command that bypasses git hooks is refused, or null. */
export function noVerifyReason(command: string): string | null {
  const r = checkCommand(command) as { blocked: boolean; reason?: string }
  return r.blocked ? r.reason ?? 'BLOCKED: git hook bypass flag.' : null
}

export type GitIntent = { commit: boolean; commitAll: boolean; commitPaths: boolean; push: boolean; staging: boolean; otherRepo: boolean; indirect: boolean }

// Wrappers that run a git command the guard cannot read: sh -c 'git commit', eval, xargs git push, env X=1 git commit ...
const WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'env', 'xargs', 'command', 'exec', 'nohup', 'time', 'sudo', 'nice', 'timeout', 'watch', 'parallel'])
const WRAPPED_GIT = /\bgit\b[^;&|]*\b(commit|push)\b/

// git commit options that take a value (so the value is not a pathspec)
const COMMIT_VALUE_OPTIONS = new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author', '--date', '--template', '-t', '--fixup', '--squash', '--trailer', '--cleanup', '-S', '--gpg-sign'])
const COMMIT_SHORT_VALUE = new Set(['m', 'F', 'C', 'c', 't'])

/** Reads a commit's arguments: whether it commits all tracked changes, or named paths (both widen what it commits). */
export function commitShape(rest: readonly string[]): { all: boolean; paths: boolean } {
  let all = false, paths = false
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? ''
    if (a === '--') { paths = paths || i + 1 < rest.length; break }
    if (a === '--all') { all = true; continue }
    if (a === '--include' || a === '--only' || a === '-i' || a === '-o' || a.startsWith('--pathspec-from-file')) { paths = true; if (a === '--pathspec-from-file') i += 1; continue }
    if (COMMIT_VALUE_OPTIONS.has(a)) { i += 1; continue }
    if (a.startsWith('--')) continue
    if (/^-[A-Za-z]+$/.test(a)) {
      const letters = a.slice(1)
      for (let j = 0; j < letters.length; j += 1) {
        const ch = letters[j] ?? ''
        if (ch === 'a') all = true
        if (COMMIT_SHORT_VALUE.has(ch)) { if (j === letters.length - 1) i += 1; break } // the rest of the cluster, or the next word, is the value
      }
      continue
    }
    if (a.startsWith('-')) continue
    paths = true
  }
  return { all, paths }
}

/** Which git commands a Bash command runs (heredoc bodies and quoted text are data, not commands). */
export function gitIntent(command: string): GitIntent {
  const out: GitIntent = { commit: false, commitAll: false, commitPaths: false, push: false, staging: false, otherRepo: false, indirect: false }
  let changedDir = false
  const text = stripHeredocBodies(command) as string // quoted text stays here; the segments below have it blanked
  for (const segment of splitCommandSegments(text) as string[]) {
    const tokens = tokenize(segment) as string[]
    const head = (tokens[0] ?? '').replace(/^\(+/, '')
    const base = head.slice(head.lastIndexOf('/') + 1)
    if (base === 'cd' || base === 'pushd') changedDir = true
    if (WRAPPERS.has(base) && WRAPPED_GIT.test(text)) out.indirect = true
    const git = findGitSubcommand(tokens) as { command?: string; rest?: string[] } | null
    if (!git?.command) continue
    const globals = tokens.slice(1, tokens.length - (git.rest ?? []).length - 1)
    const elsewhere = globals.some(t => t === '-C' || t === '--git-dir' || t === '--work-tree' || t.startsWith('--git-dir=') || t.startsWith('--work-tree='))
    if (git.command === 'add' || git.command === 'rm' || git.command === 'mv' || git.command === 'stage') out.staging = true
    if (git.command === 'commit') {
      out.commit = true
      const shape = commitShape(git.rest ?? [])
      if (shape.all) out.commitAll = true
      if (shape.paths) out.commitPaths = true
      if (elsewhere) out.otherRepo = true
    }
    if (git.command === 'push') { out.push = true; if (elsewhere) out.otherRepo = true }
  }
  if (changedDir && (out.commit || out.push)) out.otherRepo = true
  return out
}

export const SPLIT_REASON = '[git guard] This command stages files and commits in the same call, so what it would commit cannot be checked before it runs. Run the git add (or git rm / git mv) as its own command first, then git commit.'
export const OTHER_REPO_REASON = '[git guard] Run git commit and git push from the project folder, without cd, -C, --git-dir or --work-tree, so the guard can check what would be published.'
export const INDIRECT_REASON = '[git guard] Run git commit and git push as plain commands (not inside sh -c, eval, env, xargs or another wrapper), so the guard can check what would be published.'

export const PUSH_REMINDER = '[git guard] Review what will be pushed (git status; git log @{u}..HEAD) before pushing, and push only when the user asked for it.'

// Lint and formatter configs: editing an existing one to silence findings is refused (upstream config-protection list).
const PROTECTED_FILES = new Set([
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs',
  'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', '.prettierrc', '.prettierrc.js', '.prettierrc.cjs',
  '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'biome.json',
  'biome.jsonc', '.biome.json', '.biome.jsonc', '.ruff.toml', 'ruff.toml', '.shellcheckrc', '.stylelintrc', '.stylelintrc.json',
  '.stylelintrc.yml', '.stylelintrc.yaml', '.stylelintrc.js', '.stylelintrc.cjs', '.stylelintrc.mjs', 'stylelint.config.js',
  'stylelint.config.cjs', 'stylelint.config.mjs', 'stylelint.config.ts', 'stylelint.config.mts', 'stylelint.config.cts', '.markdownlint.json',
  '.markdownlint.jsonc', '.markdownlint.yaml', '.markdownlint.yml', '.markdownlint.cjs', '.markdownlint.mjs', '.markdownlintrc',
  '.markdownlint-cli2.jsonc', '.markdownlint-cli2.yaml', '.markdownlint-cli2.cjs', '.markdownlint-cli2.mjs', '.eslintignore', '.prettierignore',
  '.stylelintignore', '.markdownlintignore',
])
const PROTECTED_PATTERNS = [
  /^(eslint|prettier|stylelint|commitlint|oxlint)\.config(\.[A-Za-z0-9_-]+)*\.(js|mjs|cjs|ts|mts|cts)$/i,
  /^\.(eslintrc|prettierrc|stylelintrc|markdownlintrc)(\.[A-Za-z0-9_-]+)*\.(js|cjs|mjs|json|jsonc|yml|yaml|toml)$/i,
]

export function isProtectedConfig(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1)
  return PROTECTED_FILES.has(base) || PROTECTED_FILES.has(base.toLowerCase()) || PROTECTED_PATTERNS.some(re => re.test(base))
}

export const configReason = (file: string): string =>
  `BLOCKED: Modifying ${file.slice(file.lastIndexOf('/') + 1)} is not allowed. Fix the source code to satisfy linter/formatter rules instead of weakening the config. If this is a legitimate config change, ask the user to make it.`

async function git(io: Io, root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const run = await io.run(['git', '-c', 'core.quotepath=off', ...args], { cwd: root, timeoutMs: 20_000 })
    return { ok: run.exitCode === 0, out: run.stdout }
  } catch { return { ok: false, out: '' } }
}

const PUSH_SCAN_MAX = 500

/** Why a commit or push would publish a secret or a private path, or null. */
export async function gitSecretReason(io: Io, root: string, intent: GitIntent): Promise<string | null> {
  const names: string[] = []
  let diff = ''
  const failed: string[] = []
  const read = async (args: string[]): Promise<string> => {
    const r = await git(io, root, args)
    if (!r.ok) failed.push(`git ${args.slice(0, 2).join(' ')}`)
    return r.out
  }
  if (intent.commit) {
    // A commit with -a or with paths takes working-tree changes too: check all tracked changes against HEAD
    // (before the first commit there is no HEAD, and the index is all that is tracked).
    const wide = (intent.commitAll || intent.commitPaths) && (await git(io, root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok
    const base = wide ? ['HEAD'] : ['--cached']
    names.push(...(await read(['diff', ...base, '--name-only', '-z', '--diff-filter=d'])).split('\0'))
    diff += await read(['diff', ...base, '-U0', '--no-color', '--no-ext-diff'])
  }
  if (intent.push) {
    // Every local commit no remote has yet, on any branch: whatever refspec the push names is among them.
    const range = ['--branches', '--not', '--remotes', `--max-count=${PUSH_SCAN_MAX}`]
    const count = Number((await read(['rev-list', '--count', '--branches', '--not', '--remotes'])).trim())
    if (count > PUSH_SCAN_MAX) return `[git guard] ${count} local commits are not on any remote, more than the ${PUSH_SCAN_MAX} this guard checks, so the push is refused. Ask the user to review and push these by hand.`
    names.push(...(await read(['log', '--name-only', '--format=', '--diff-filter=d', ...range])).split('\n'))
    diff += await read(['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=', ...range])
  }
  if (failed.length) return `[git guard] Could not check what this would publish (${[...new Set(failed)].join(', ')} failed), so it is refused. Check that this is a git repository and retry; if git keeps failing, tell the user.`
  const forbidden = [...new Set(names.map(n => n.trim()).filter(n => n && isForbiddenPath(n)))]
  const secrets = scanDiff(diff)
  if (!forbidden.length && !secrets.length) return null
  return [
    '[git guard] This would publish private data, so it is refused:',
    ...forbidden.map(f => `- private path: ${f}`),
    ...secrets.map(s => `- possible secret in ${s}`),
    'Remove the secret or unstage the file (git restore --staged <file>), then retry. Per-user data (.snagon/), .env files and keys never go to git.',
  ].join('\n')
}
