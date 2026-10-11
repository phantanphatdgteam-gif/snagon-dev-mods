// The safety gate on tool calls: fact-forcing before the first edit of each file, the first Bash command of a
// session and every destructive command (logic and messages vendored, see vendor/); git hook-bypass flags always
// refused; lint and formatter configs protected; and a secret and private-path scan before git commit or push.
import {
  condensedGateMsg, destructiveBashMsg, editGateMsg, isClaudeSettingsPath, isDestructiveBash,
  isReadOnlyGitIntrospection, routineShellMsg, writeGateMsg,
} from './vendor/destructive'
import { checkCommand } from './vendor/no-verify'
import { hashOf, type Io } from './session'
import { isForbiddenPath, scanDiff } from './secrets'
import type { GitIntent } from './git-intent'

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

export { gitIntent, gitAliasReason, commitShape, ALIAS_REASON, type GitIntent } from './git-intent'

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
    // Every local commit no remote has yet, on any branch or a detached HEAD (and tags when the push sends tags):
    // whatever refspec the push names is among them.
    const reach = ['HEAD', '--branches', ...(intent.pushTags ? ['--tags'] : []), ...intent.pushRefs, '--not', '--remotes']
    const range = [...reach, `--max-count=${PUSH_SCAN_MAX}`]
    const count = Number((await read(['rev-list', '--count', ...reach])).trim())
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
