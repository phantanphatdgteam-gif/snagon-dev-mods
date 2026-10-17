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

/** One git call for the publish checks: whether it ran, its output, and whether the output was cut at 4 MiB. */
export type GitRead = (args: string[]) => Promise<{ ok: boolean; out: string; truncated?: boolean }>

const gitOf = (io: Io, root: string): GitRead => async args => {
  try {
    const run = await io.run(['git', '-c', 'core.quotepath=off', ...args], { cwd: root, timeoutMs: 20_000 })
    return { ok: run.exitCode === 0, out: run.stdout, truncated: run.isStdoutTruncated === true }
  } catch { return { ok: false, out: '' } }
}

export const PUSH_SCAN_MAX = 500

/** Reads git output for one scan and remembers which calls failed or were cut short (both refuse: unchecked). */
function reader(git: GitRead): { read: (args: string[]) => Promise<string>; failed: string[] } {
  const failed: string[] = []
  const read = async (args: string[]): Promise<string> => {
    const r = await git(args)
    if (!r.ok || r.truncated) failed.push(`git ${args.slice(0, 2).join(' ')}${r.ok ? ' (output over 4 MiB)' : ''}`)
    return r.out
  }
  return { read, failed }
}

/**
 * Why publishing the commits `revs` selects (rev-list syntax) would leak a secret or a private path, or null. A merge
 * is read against its first parent, so content that exists only in a merge commit is scanned too. With `headTree`
 * (flow release), every path in HEAD's tree is checked as well, not only the changed ones.
 */
export async function publishReason(git: GitRead, revs: readonly string[], opts: { headTree?: boolean } = {}): Promise<string | null> {
  const { read, failed } = reader(git)
  const count = Number((await read(['rev-list', '--count', ...revs])).trim())
  if (count > PUSH_SCAN_MAX) return `[git guard] ${count} local commits are not on any remote, more than the ${PUSH_SCAN_MAX} this guard checks, so the push is refused. Ask the user to review and push these by hand.`
  const range = [...revs, `--max-count=${PUSH_SCAN_MAX}`]
  // -z: names unquoted (git C-quotes odd characters); --text: a file git calls binary still shows its added lines.
  const names = (await read(['log', '-z', '--name-only', '--format=', '--diff-filter=d', '--diff-merges=first-parent', ...range])).split('\0')
  const diff = await read(['log', '-p', '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-merges=first-parent', '--format=', ...range])
  const tree = opts.headTree ? (await read(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).split('\0') : []
  return verdict([...names, ...tree], diff, failed)
}

/** Why a commit or push would publish a secret or a private path, or null. */
export async function gitSecretReason(io: Io, root: string, intent: GitIntent): Promise<string | null> {
  const git = gitOf(io, root)
  if (intent.commit) {
    // A commit with -a or with paths takes working-tree changes too: check all tracked changes against HEAD
    // (before the first commit there is no HEAD, and the index is all that is tracked).
    const { read, failed } = reader(git)
    const wide = (intent.commitAll || intent.commitPaths) && (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).ok
    const base = wide ? ['HEAD'] : ['--cached']
    const names = (await read(['diff', ...base, '--name-only', '-z', '--diff-filter=d'])).split('\0')
    const found = verdict(names, await read(['diff', ...base, '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv']), failed)
    if (found) return found
  }
  // Every local commit no remote has yet, on any branch or a detached HEAD (and tags when the push sends tags):
  // whatever refspec the push names is among them.
  if (intent.push) return publishReason(git, ['HEAD', '--branches', ...(intent.pushTags ? ['--tags'] : []), ...intent.pushRefs, '--not', '--remotes'])
  return null
}

function verdict(names: readonly string[], diff: string, failed: readonly string[]): string | null {
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
