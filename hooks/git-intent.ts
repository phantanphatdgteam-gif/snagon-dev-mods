// Which git commands a Bash command runs, read from the command text (environment prefixes, shell syntax, aliases on
// the command line), and the alias and autocorrect lookups that only the repository or user config can answer.
import { findGitSubcommand, splitCommandSegments, tokenize } from './vendor/destructive'
import { stripHeredocBodies } from './vendor/heredoc'
import type { Io } from './session'

export type GitIntent = { commit: boolean; commitAll: boolean; commitPaths: boolean; push: boolean; pushTags: boolean; pushRefs: string[]; staging: boolean; otherRepo: boolean; indirect: boolean; aliases: string[] }

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

// `NAME=value git push` runs git with extra environment: the assignments are skipped to find the command.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
// Environment that points git at another repository, or injects config (and so aliases) the guard cannot read.
const REPO_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|NAMESPACE|OBJECT_DIRECTORY)=/
// Environment that changes which config git reads (and so which aliases exist), for non-builtin subcommands.
const CONFIG_ENV = /^(GIT_CONFIG(_[A-Z0-9_]*)?|HOME|XDG_CONFIG_HOME)=/
// git builtins: git never lets an alias hide one, so any other subcommand may be an alias of commit or push.
const GIT_BUILTINS = new Set(('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore ' +
  'check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config ' +
  'count-objects credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack ' +
  'filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc grep hash-object help hook http-push index-pack init ' +
  'interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-tree mergetool mktag ' +
  'mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune pull push range-diff read-tree rebase receive-pack refs ' +
  'reflog remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show ' +
  'show-branch show-ref sparse-checkout stage stash status stripspace submodule subtree switch symbolic-ref tag unpack-objects update-index ' +
  'update-ref upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs').split(' '))
const ALIAS_DEPTH = 5
// Separate programs git runs by name: an alias of the same name wins when the program is missing.
const OPTIONAL_PROGRAMS = new Set(['lfs', 'subtree', 'send-email'])
// Shell words that can stand before a command: `(git push)`, `{ git push; }`, `! git push`, `then git commit …`,
// `case x in *) git push`, `coproc git push`; `function f` and `case x` also skip the name that follows them.
const SHELL_WORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'in', 'esac', 'coproc', 'select'])
const NAMED_SHELL_WORDS = new Set(['function', 'case', 'for', 'select'])
const FUNCTION_HEAD = /^[A-Za-z_][\w-]*\(\)\{?$|^\(\)\{?$/ // `f(){`, `f()`
// Global options that take their value as the next word, which findGitSubcommand would read as the subcommand.
const VALUE_GLOBALS = new Set(['--attr-source', '--config-env', '--exec-path'])
// git subcommands that run other commands (`submodule foreach`, `rebase -x`, `bisect run`, `for-each-repo`).
const runsCommands = (sub: string, rest: readonly string[]): boolean =>
  (sub === 'submodule' && rest.includes('foreach')) || (sub === 'rebase' && rest.some(w => w === '-x' || w.startsWith('--exec'))) ||
  (sub === 'bisect' && rest[0] === 'run') || sub === 'for-each-repo'
const COMMIT_OR_PUSH = /\b(commit|push|send-pack|http-push)\b/
const BARE_PUBLISH = new Set(['commit', 'push', 'send-pack', 'http-push'])

type Git = { command?: string; rest?: string[] } | null
const SUBTREE_VALUE_OPTIONS = new Set(['-P', '--prefix', '-b', '--branch', '--onto', '--annotate', '-m', '--message'])
/** The first word that is neither an option nor an option's value (`git subtree -P lib push …` → push). */
function firstWord(rest: readonly string[]): string {
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i] ?? ''
    if (SUBTREE_VALUE_OPTIONS.has(w)) { i += 1; continue }
    if (!w.startsWith('-')) return w
  }
  return ''
}
const isPush = (sub: string, rest: readonly string[]): boolean =>
  sub === 'push' || sub === 'send-pack' || sub === 'http-push' || ((sub === 'subtree' || sub === 'lfs') && firstWord(rest) === 'push')
const aliasWords = (value: string): string[] => value.replace(/["'\\]/g, '').split(/\s+/).filter(Boolean) // git's split_cmdline drops quotes

/** The words of a segment after any leading shell syntax and `NAME=value` assignments (collected in env). */
function commandWords(segment: string, env: string[]): string[] {
  const words = (tokenize(segment) as string[]).map(w => w.replace(/^\(+/, ''))
  let i = 0
  for (; i < words.length; i += 1) {
    const w = words[i] ?? ''
    if (w === '' || SHELL_WORDS.has(w) || FUNCTION_HEAD.test(w) || (/\)$/.test(w) && !w.includes('('))) continue // `*)` case patterns
    if (NAMED_SHELL_WORDS.has(w)) { i += 1; continue }
    if (ENV_ASSIGN.test(w)) { env.push(w); continue }
    break
  }
  return words.slice(i).map(w => w.replace(/\)+$/, ''))
}

/** Which git commands a Bash command runs (heredoc bodies and quoted text are data, not commands). */
export function gitIntent(command: string): GitIntent {
  const out: GitIntent = { commit: false, commitAll: false, commitPaths: false, push: false, pushTags: false, pushRefs: [], staging: false, otherRepo: false, indirect: false, aliases: [] }
  let changedDir = false
  const exported: string[] = [] // `export GIT_DIR=…;` or a bare `GIT_DIR=…;` before git applies to the commands after it
  // Heredoc bodies are data; then line continuations join and every other line break separates commands, like `;`.
  const text = (stripHeredocBodies(command) as string).replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ; ')
  const mentionsPublish = COMMIT_OR_PUSH.test(text)
  for (const segment of splitCommandSegments(text) as string[]) {
    const env: string[] = []
    const tokens = commandWords(segment, env)
    const head = tokens[0] ?? ''
    const base = head.slice(head.lastIndexOf('/') + 1)
    if (!tokens.length || ['export', 'declare', 'typeset', 'local'].includes(base)) {
      exported.push(...env, ...tokens.filter(w => ENV_ASSIGN.test(w)))
      continue
    }
    env.unshift(...exported)
    if (base === 'cd' || base === 'pushd') changedDir = true
    if (WRAPPERS.has(base) && WRAPPED_GIT.test(text)) out.indirect = true
    // `"git" push`, `g''it push`, `$G push`: a command word the guard cannot read, in a command that mentions commit or push
    if (/['"\\$`]/.test(head) && mentionsPublish) { out.indirect = true; continue }
    const git = findGitSubcommand(tokens) as Git
    // `git $(echo push)`: the substitution was split off, so git is left without a readable subcommand
    // `git $(echo push)` or `$(which git) push`: a substitution was split off, leaving git without a readable subcommand
    // or a bare subcommand as a command of its own
    if (!git?.command) { if ((base === 'git' || BARE_PUBLISH.has(base)) && /\$\(|`/.test(text)) out.indirect = true; continue }
    const userRest = git.rest ?? []
    const raw = tokens[tokens.length - userRest.length - 1] ?? ''
    const globals = tokens.slice(1, tokens.length - userRest.length - 1)
    const elsewhere = env.some(t => REPO_ENV.test(t)) ||
      globals.some(t => t === '-C' || t === '--git-dir' || t === '--work-tree' || t.startsWith('--git-dir=') || t.startsWith('--work-tree='))
    // `git "push"`, `git pu"sh"`, `git pu\sh`, `git "$C"`, `git --attr-source HEAD push`: the guard cannot read the command
    if (/['"\\$`]/.test(raw) || VALUE_GLOBALS.has(globals[globals.length - 1] ?? '')) { out.indirect = true; continue }
    let sub = git.command
    let rest = userRest
    if (raw !== sub) out.aliases.push(sub) // git matches builtins by exact case; `git Commit` may reach an alias
    const inlineDefines = globals.some((g, i) => globals[i - 1] === '-c' && g.toLowerCase().startsWith(`alias.${sub}=`))
    if (OPTIONAL_PROGRAMS.has(sub) && !inlineDefines) out.aliases.push(sub)
    if (!GIT_BUILTINS.has(sub) || (OPTIONAL_PROGRAMS.has(sub) && inlineDefines)) {
      const resolved = expandInlineAlias(sub, env, globals)
      if (resolved === 'indirect') { out.indirect = true; continue }
      if ('unknown' in resolved) { out.aliases.push(resolved.unknown); if (elsewhere || changedDir) out.otherRepo = true; continue }
      sub = resolved.sub
      rest = [...resolved.rest, ...userRest]
    }
    if (runsCommands(sub, rest) && mentionsPublish) { out.indirect = true; continue }
    if (sub === 'add' || sub === 'rm' || sub === 'mv' || sub === 'stage') out.staging = true
    if (sub === 'commit') {
      out.commit = true
      const shape = commitShape(rest)
      if (shape.all) out.commitAll = true
      if (shape.paths) out.commitPaths = true
      if (elsewhere) out.otherRepo = true
    }
    if (isPush(sub, rest)) {
      out.push = true
      if (elsewhere) out.otherRepo = true
      if (rest.some(w => w === '--tags' || w === '--follow-tags' || w === '--mirror' || w.includes('refs/tags/'))) out.pushTags = true
      out.pushRefs.push(...pushSources(sub === 'push' ? rest : []))
    }
  }
  if (changedDir && (out.commit || out.push)) out.otherRepo = true
  return out
}

/**
 * Follows aliases given on the command line (`-c alias.p=push`, chains, leading global options) to a builtin;
 * 'indirect' when the command line injects config the guard cannot read or runs a shell alias; `unknown` names the
 * alias only the repository or user config can resolve (checked by gitAliasReason).
 */
function expandInlineAlias(sub: string, env: readonly string[], globals: readonly string[]): { sub: string; rest: string[] } | { unknown: string } | 'indirect' {
  const values = globals.filter((_, i) => globals[i - 1] === '-c')
  const inline = new Map<string, string>()
  for (const v of values) { const m = /^alias\.([^=]+)=(.*)$/i.exec(v); if (m) inline.set((m[1] ?? '').toLowerCase(), (m[2] ?? '').trim()) }
  const injected = env.some(t => CONFIG_ENV.test(t)) || globals.some(t => t.startsWith('--config-env')) ||
    values.some(v => v === '' || /^(''|"")$/.test(v) || /^(include|includeif|help)\./i.test(v))
  let name = sub
  let rest: string[] = []
  for (let depth = 0; depth < ALIAS_DEPTH; depth += 1) {
    const value = inline.get(name)
    if (value === undefined) return injected ? 'indirect' : { unknown: name }
    if (value === '' || value.startsWith('!') || /^(''|"")/.test(value)) return 'indirect'
    const next = findGitSubcommand(['git', ...aliasWords(value)]) as Git
    if (!next?.command) return 'indirect'
    rest = [...(next.rest ?? []), ...rest]
    if (GIT_BUILTINS.has(next.command)) return { sub: next.command, rest }
    name = next.command
  }
  return 'indirect'
}

const PUSH_VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
const REF_NAME = /^[A-Za-z0-9._/@{}~^-]+$/
/** The local sources a push names (`git push origin v1.0 a:b` → v1.0, a), so commits no branch holds are scanned too. */
function pushSources(rest: readonly string[]): string[] {
  const words: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i] ?? ''
    if (PUSH_VALUE_OPTIONS.has(w)) { i += 1; continue }
    if (!w.startsWith('-')) words.push(w)
  }
  return words.slice(1).map(r => (r.replace(/^\+/, '').split(':')[0] ?? '')).filter(r => r && r !== 'HEAD' && !r.startsWith('-') && REF_NAME.test(r))
}

/** Whether git config turns an unknown command into the closest one (help.autocorrect), which may be commit or push. */
async function autocorrects(io: Io, root: string): Promise<boolean> {
  try {
    const r = await io.run(['git', 'config', '--get', 'help.autocorrect'], { cwd: root, timeoutMs: 5_000 })
    if (r.exitCode === 1) return false
    return r.exitCode !== 0 || !/^(0|false|no|off|never|show)$/i.test(r.stdout.trim())
  } catch { return true }
}
const autocorrectReason = (name: string): string =>
  `[git guard] "git ${name}" is not a git command or alias, and help.autocorrect would run the closest command instead (it may be commit or push). Type the command name exactly.`

export const ALIAS_REASON = '[git guard] Run git commit and git push by their own names, not through a git alias, so the guard can check what would be published.'

/** Refuses a git alias (repository or user config, followed through chains) that runs commit or push; a failed lookup refuses too. */
export async function gitAliasReason(io: Io, root: string, names: readonly string[]): Promise<string | null> {
  for (const start of names) {
    let name = start
    for (let depth = 0; ; depth += 1) {
      if (depth >= ALIAS_DEPTH) return ALIAS_REASON
      let value = ''
      try {
        const r = await io.run(['git', 'config', '--get', `alias.${name}`], { cwd: root, timeoutMs: 5_000 })
        if (r.exitCode === 1) { if (!GIT_BUILTINS.has(name) && (await autocorrects(io, root))) return autocorrectReason(name); break } // no such alias
        if (r.exitCode !== 0) return ALIAS_REASON
        value = r.stdout.trim()
      } catch { return ALIAS_REASON }
      if (value.startsWith('!')) {
        // A shell alias gets the user's words appended: `!git` (or one that passes "$@" to git) runs whatever follows.
        const body = value.slice(1).trim()
        const first = (aliasWords(body)[0] ?? '').replace(/^.*\//, '')
        const forwards = WRAPPERS.has(first) || /\$[@*1-9]/.test(body) || (/\bgit\b/.test(body) && !(findGitSubcommand(aliasWords(body)) as Git)?.command)
        if (forwards || /\b(commit|push|send-pack|http-push)\b/.test(body)) return ALIAS_REASON
        break
      }
      const next = findGitSubcommand(['git', ...aliasWords(value)]) as Git
      if (!next?.command) return ALIAS_REASON // only global options: the user's next word becomes the command
      const words = next.rest ?? []
      if (next.command === 'commit' || isPush(next.command, words)) return ALIAS_REASON
      // subtree and lfs push when the words after the alias say so: an alias that leaves that open is refused
      if ((next.command === 'subtree' || next.command === 'lfs') && !words.some(w => !w.startsWith('-'))) return ALIAS_REASON
      if (GIT_BUILTINS.has(next.command)) break
      name = next.command
    }
  }
  return null
}
