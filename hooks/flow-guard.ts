// Flow guards (plan v7.1 §2.3, step 8): the allow-lists the native sandbox does not cover, decided in `tool.check` while a
// flow is active, for main and for subagents alike. Everything fails closed: a thrown error, a path that cannot be placed or
// an input of an unknown shape denies. Bash runs inside the sandbox, so the Bash rules here are a fallback (git publishing,
// publish verbs, screen capture). The wiring (step 10) builds GuardCtx from the frozen lists, closes the S2b window on
// `closeS2b`, turns the sandbox switch off with `stripCall` in `tool.call`, and places an Edit target again after the call
// (`recheck`): `tool.call` runs before `tool.check`, so that second placing is the only check later than the verdict.
import { gitIntent } from './git-intent'
import { stripHeredocBodies } from './vendor/heredoc'
import { PROTECTED_DIRS, PROTECTED_FILES } from './flow-sandbox'
import { sha256 } from './flow-review'
import type { FlowRecord, ListResult } from './flow-state'
import type { Stack } from '../flow/data/types'

/** `$.fs.stat(path, { resolve: true })` with null for a missing path (ENOENT; any other failure throws); `links`: the link
 * count of an existing file; `read`: a file's text, or null when it is missing. */
export type GuardFs = { stat(path: string): Promise<{ realPath?: string } | null>; links(path: string): Promise<number>; read(path: string): Promise<string | null> }
/** The S2b window (§2.2): one Write of exactly `post` to the settings file at `path` (a realpath) while it still hashes to
 * `preHash` (null: the file was absent). */
export type S2bWindow = { path: string; post: string; preHash: string | null }
export type GuardCtx = {
  /** The project's realpath, and every spelling of it a tool may use (the realpath, the session folder as given); `cwd`: the
   * working directory at this call (classic.PreToolUse `cwd`; Bash cd moves it), where a Grep or Glob without a path searches. */
  root: string; rootAliases: readonly string[]; cwd: string; home: string
  /** darwin and win32: paths compare after NFC and lower case, as the file system does. */
  caseFold: boolean
  allowTools: readonly string[]; allowMcp: readonly string[]; modTools: readonly string[]; skills: readonly string[]; freeSpawn: readonly string[]
  /** Realpaths no tool may write: every loaded plugin root, the git common dir, a worktree's .git file. */
  protectedRoots: readonly string[]
  /** Root-relative Files while the active F's last B3 is red (in verify: the union of all F Files). */
  redScope?: readonly string[]
  /** F44-A: the journal folder frozen at S2, root-relative (`.snagon/journal`): `*.md` files directly inside it may change,
   * the one way through the .snagon protection, red scope or not (the journal is not part of the tree). */
  journalDir?: string
  s2b?: S2bWindow
  /** The permission mode as the wiring last saw it (classic.PreToolUse `permission_mode`; F26). */
  permissionMode?: string
  /** The engine's config folder when CLAUDE_CONFIG_DIR moves it (default ~/.claude): its `projects` holds the transcripts. */
  claudeDir?: string
  publish: Stack['publish']; fs: GuardFs
}
export type Call = { tool: string; input: unknown; agentId?: string }
/** `pass` leaves the call to the engine (`next(e)`); `closeS2b`: the call named the S2b path, so the window closes. */
export type Verdict = { decision: 'deny'; reason: string; closeS2b?: true } | { decision: 'pass'; closeS2b?: true }
/** An Edit target: the path as written (absolute), where it lands, its root-relative path, and whether it exists. */
export type Placed = { literal: string; real: string; rel: string; exists: boolean }
type ReadCtx = Pick<GuardCtx, 'cwd' | 'home' | 'caseFold' | 'fs' | 'claudeDir'>
type PlaceCtx = Pick<GuardCtx, 'root' | 'rootAliases' | 'home' | 'caseFold' | 'fs'>

const PASS: Verdict = { decision: 'pass' }
const deny = (reason: string): Verdict => ({ decision: 'deny', reason })
const EDIT_KEY: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const READ_KEYS: Readonly<Record<string, readonly string[]>> = { Read: ['file_path'], Glob: ['path', 'pattern'], Grep: ['path'], LSP: ['filePath'] }
// What else passes while the flow state is unknown or the mode is bypassPermissions (reading passes, kept out of hidden places).
const NO_EFFECT = new Set(['ToolSearch', 'TodoWrite', 'AskUserQuestion'])
const BASH_KEYS = new Set(['command', 'timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox'])
const AGENT_REFUSED = ['name', 'isolation', 'team_name', 'mode', 'cwd'] as const
const SCREEN_COMMANDS = new Set(['screencapture', 'osascript'])
const SCREEN_TOOL = /computer|screen/i
const HIDDEN_TEXT = /(^|[^\w.-])\.snagon(?![\w.-])|\.claude\/+projects/i
const FLOW_SKILL = /(^|[:/])flow-/i
const MAX_DEPTH = 32 // nesting an MCP input may have; deeper is refused unread
const BYPASS = 'the permission mode is bypassPermissions, which lets commands leave the sandbox unasked; switch to another mode (shift+tab)'
const MONITOR = 'flow: Monitor does not run while flow is active: whether the sandbox wraps its command is not confirmed yet, and a WebSocket leaves the sandbox network list; run the command with Bash in the foreground instead'
const BACKGROUND = 'flow: nothing runs in the background while flow is active (owner decision F47-A): a process left running could change what the judge runs between its checks and its run; run the command in the foreground (an & in text that a shell or eval runs counts too)'
// F47-A: programs that keep a process running after the Bash call returns, wherever the word stands (any program can run
// its arguments, so where a command starts cannot be told; `nohup` and `disown` need an `&`, which loneAmp finds); the
// shells and builtins that run text as commands, anywhere (rawAmp then reads all of it); and the `&` operator (loneAmp).
const BACKGROUND_WORDS = new Set(['setsid', 'coproc', 'tmux', 'screen', 'daemonize'])
const SHELLS = new Set(['eval', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'trap', 'source', '.', 'alias', 'watch'])
const OPERATOR_BEFORE = '&;|><' // `&&`, `;&`, `|&`, `>&`, `<&`: an `&` after these is not the background operator
const WORD_START_BEFORE = ' \t\n;&|(<>' // a `#` after these (or first) starts a comment; not after `)`, which may end `$(…)`
const GIT_REASON ='flow: git push, git through a wrapper or in another repository, and git aliases do not run while flow is active; the mod pushes at release (/flow-ship)'

// APFS folds case fully (ſ is s, ß is ss, ς is σ) but keeps the dotless ı apart from i (both checked on macOS).
const folder = (on: boolean) => (s: string): string => (on ? s.normalize('NFC').split('ı').map(x => x.toLowerCase().toUpperCase().toLowerCase()).join('ı').normalize('NFC') : s)
const DATA_VOLUME = '/System/Volumes/Data' // a macOS firmlink spelling: /System/Volumes/Data/Users/x is /Users/x
const SYSTEM_LINK = /^\/(tmp|var|etc)(?=\/|$)/ // macOS links to /private/…, not writable by Bash
/** The folders no tool reads, under both spellings (a firmlink spelling mapped back first). */
const hiddenOf = (ctx: Pick<GuardCtx, 'home' | 'claudeDir'>): string[] => {
  const unfirm = (p: string): string => (lexical(p).toLowerCase().startsWith(`${DATA_VOLUME.toLowerCase()}/`) ? lexical(p).slice(DATA_VOLUME.length) : lexical(p))
  return [`${unfirm(ctx.claudeDir ?? `${ctx.home}/.claude`)}/projects`, `${unfirm(ctx.home)}/.snagon/flow`].flatMap(x => [x, `${DATA_VOLUME}${x}`])
}
const within = (path: string, dir: string, f: (s: string) => string): boolean => { const x = f(path), d = f(dir).replace(/\/+$/, ''); return x === d || x.startsWith(`${d}/`) }
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const safely = async (run: () => Promise<Verdict>): Promise<Verdict> => { try { return await run() } catch (err) { return deny(`flow: the guard could not check this call (${errText(err)}), so it is refused`) } }

/** The path as an absolute one, `~` being HOME (tools open it); a relative path (it lands where Bash last cd'ed), `~user` or a
 * NUL cannot be placed (a `//` network path is refused by its empty part). */
function absolute(path: string, home: string): string | null {
  if (path.includes('\0')) return null
  if (path === '~' || path.startsWith('~/')) return `${lexical(home)}${path.slice(1)}`
  return path.startsWith('/') ? path : null
}
const UNPLACED = 'cannot be placed (a relative path, ~user or a NUL); name it by its absolute path'
function lexical(abs: string): string { return `/${abs.split('/').reduce<string[]>((a, s) => (s === '..' ? a.slice(0, -1) : s && s !== '.' ? [...a, s] : a), []).join('/')}` }
const oddPart = (abs: string): boolean => abs !== '/' && abs.split('/').slice(1).some(p => p === '' || p === '.' || p === '..')

/**
 * Where an Edit-family path lands (§2.3): a plain absolute spelling (no empty, "." or ".." part) under a root spelling that
 * differs from the realpath root only by a system link (/tmp, /var, /etc; a spelling that is a link of its own could be
 * re-pointed), whose realpath, from the nearest existing ancestor plus the parts still missing, is the root as spelled (NFC
 * only: a case-sensitive volume may hold a sibling `kit` beside `Kit`) followed by the same parts (folded). A path through any
 * link is refused, since a link (or a folder) can be re-pointed between the check and the write; the reason names the real
 * path to use. Parts are compared one by one: NFC and case folding change lengths.
 */
export async function placeEdit(path: unknown, ctx: PlaceCtx): Promise<Placed | string> {
  if (typeof path !== 'string' || !path) return 'flow: the call names no file'
  const abs = absolute(path, ctx.home)
  if (abs === null) return `flow: ${path} ${UNPLACED}`
  if (oddPart(abs)) return `flow: ${path} has an empty, "." or ".." part; name the file by its plain absolute path`
  const parts = abs.split('/').slice(1)
  const f = folder(ctx.caseFold), root = lexical(ctx.root).normalize('NFC')
  const alias = ctx.rootAliases.find(a => lexical(a).replace(SYSTEM_LINK, '/private/$1').normalize('NFC') === root && within(abs, a, f) && f(abs) !== f(lexical(a)))
  if (alias === undefined) return `flow: ${path} is outside the project; only files under ${ctx.root} change while flow is active`
  const rel = parts.slice(lexical(alias).split('/').length - 1).join('/')
  for (let k = parts.length; k >= 0; k -= 1) {
    const st = await ctx.fs.stat(`/${parts.slice(0, k).join('/')}`)
    if (st === null) continue
    if (st.realPath === undefined) return `flow: ${path} leads nowhere (a broken link)`
    const real = [st.realPath.replace(/\/+$/, ''), ...parts.slice(k)].join('/'), r = real.normalize('NFC')
    if (r.startsWith(`${root}/`) && f(r.slice(root.length + 1)) === f(rel)) return { literal: abs, real, rel, exists: k === parts.length }
    if (!within(real, ctx.root, f)) return `flow: ${path} leads outside the project (${real})`
    return r.startsWith(`${root}/`) ? `flow: ${path} goes through a link; write ${real} by its own path` : `flow: ${path} spells the project folder another way; write it under ${ctx.root}`
  }
  return `flow: ${path} cannot be placed`
}

/** The protected-set entries (§2.3) a root-relative path hits: a folder as any part (`.config/git` as a run), a file as the
 * last part, at any depth as in the native sandbox's own list; a file listed with a folder (docs/flow/verify.md) at the root. */
function protectedHits(rel: string, f: (s: string) => string): string[] {
  const parts = f(rel).split('/'), joined = `/${parts.join('/')}/`
  return [...PROTECTED_DIRS.filter(d => (d.includes('/') ? joined.includes(`/${f(d)}/`) : parts.includes(f(d)))),
    ...PROTECTED_FILES.filter(n => f(n) === (n.includes('/') ? parts.join('/') : parts[parts.length - 1]))]
}

/** F44-A: a `*.md` file directly inside the journal folder. `rel` is a plain path (placeEdit), so a folder that is not a plain
 * root-relative path never matches. */
function inJournal(rel: string, dir: string | undefined, f: (s: string) => string): boolean {
  const at = rel.lastIndexOf('/')
  return dir !== undefined && at > 0 && f(rel.slice(0, at)) === f(dir) && /.\.md$/.test(f(rel.slice(at + 1)))
}

async function editVerdict(tool: string, input: Record<string, unknown>, ctx: GuardCtx): Promise<Verdict> {
  const raw = input[EDIT_KEY[tool] ?? '']
  const f = folder(ctx.caseFold)
  const placed = await placeEdit(raw, ctx)
  const literal = typeof raw === 'string' ? absolute(raw, ctx.home) : null
  const w = ctx.s2b
  const touches = w !== undefined && [literal, typeof placed === 'string' ? null : placed.real].some(p => p !== null && f(p) === f(w.path))
  const v = typeof placed === 'string' ? deny(placed) : await placedVerdict(tool, input, placed, touches ? w : undefined, ctx)
  return touches ? { ...v, closeS2b: true } : v
}

async function placedVerdict(tool: string, input: Record<string, unknown>, p: Placed, w: S2bWindow | undefined, ctx: GuardCtx): Promise<Verdict> {
  const f = folder(ctx.caseFold)
  const pluginOrGit = ctx.protectedRoots.find(r => within(p.real, r, f))
  if (pluginOrGit !== undefined) return deny(`flow: ${p.literal} is inside ${pluginOrGit}, which no tool changes while flow is active`)
  if (p.exists && (await ctx.fs.links(p.real)) > 1) return deny(`flow: ${p.literal} has more than one name (a hard link), and another name may be protected`)
  if (w) return s2bVerdict(tool, input, p, w, ctx)
  const journal = inJournal(p.rel, ctx.journalDir, f), hits = protectedHits(p.rel, f)
  if (hits.length && !(journal && hits.every(h => h === '.snagon'))) return deny(`flow: ${p.literal} is protected (${hits[0]}); no tool changes it while flow is active`)
  if (ctx.redScope && !journal && !ctx.redScope.some(x => f(x) === f(p.rel))) return deny(`flow: the last check is red, so only this feature's Files change now: ${ctx.redScope.join(', ')}`)
  return PASS
}

/** S2b: the one Write of exactly the approved text, while the file still holds what was echoed; never an edit. */
async function s2bVerdict(tool: string, input: Record<string, unknown>, p: Placed, w: S2bWindow, ctx: GuardCtx): Promise<Verdict> {
  if (tool !== 'Write') return deny('flow: the settings file takes only the one approved Write, never an edit')
  if (Object.keys(input).some(k => k !== 'file_path' && k !== 'content') || input.content !== w.post) return deny('flow: that Write is not exactly the approved settings text; the owner runs /flow-setup again')
  const now = await ctx.fs.read(p.real)
  return (now === null ? null : await sha256(now)) === w.preHash ? PASS : deny('flow: the settings file changed since the approval; the owner runs /flow-setup again')
}

/** The folder an absolute (or `~`) glob starts from, up to its first wildcard; null for a relative pattern. */
function globBase(pattern: string): string | null {
  if (!pattern.startsWith('/') && !pattern.startsWith('~')) return null
  const cut = pattern.search(/[*?[{]/)
  const head = cut < 0 ? pattern : pattern.slice(0, cut)
  return head.slice(0, head.lastIndexOf('/')) || '/'
}

/** Read and LSP never reach the transcripts or the flow record, and Grep and Glob, which search below where they start (`cwd`
 * when no path is given), never start at or above them: checked on the path as written and where it lands, under both
 * firmlink spellings. A start must exist now (a link put there later is caught by `recheckRead`) and have no empty, "." or
 * ".." part; one under a dot folder at the top (`/.vol`, `/.nofollow`, `/.resolve`) or through a link (but /tmp, /var, /etc)
 * is refused: background Bash can re-point a link between this check and the read. */
async function readVerdict(tool: string, input: Record<string, unknown>, ctx: ReadCtx): Promise<Verdict> {
  const f = folder(ctx.caseFold)
  const hidden = hiddenOf(ctx)
  const search = tool === 'Grep' || tool === 'Glob'
  const starts: string[] = search && input.path === undefined ? [ctx.cwd] : []
  for (const key of READ_KEYS[tool] ?? []) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return deny(`flow: ${tool} ${key} must be text`)
    if (key === 'pattern' && value.split('/').includes('..')) return deny('flow: a Glob pattern with ".." leaves its folder')
    const start = key === 'pattern' ? globBase(value) : value
    if (start !== null) starts.push(start)
  }
  const at = (p: string): boolean => /^\/\./.test(p) || hidden.some(h => within(p, h, f) || (search && within(h, p, f)))
  const hiddenReason = (start: string) => deny(`flow: ${start} is or holds flow data or transcripts, which are not read while flow is active`)
  for (const start of starts) {
    const given = absolute(start, ctx.home)
    if (given === null) return deny(`flow: ${start} ${UNPLACED}`)
    const abs = given.replace(/(.)\/+$/, '$1') // a folder may be written with a closing slash
    if (oddPart(abs)) return deny(`flow: ${start} has an empty, "." or ".." part; name it by its plain absolute path`)
    if (at(abs)) return hiddenReason(start)
    const st = await ctx.fs.stat(abs)
    if (st === null) return deny(`flow: ${start} does not exist`)
    if (st.realPath === undefined) return deny(`flow: ${start} leads nowhere (a broken link)`)
    if (at(st.realPath)) return hiddenReason(start)
    if (f(st.realPath) !== f(abs.replace(SYSTEM_LINK, '/private/$1'))) return deny(`flow: ${start} goes through a link; read ${st.realPath} by its own path`)
  }
  return PASS
}

/** tool.call, after a Read, Grep, Glob or LSP ran: its start checked again, since a link may have appeared during the call;
 * a reason means the wiring withholds the result and blocks the flow (tampered). Never throws. */
export async function recheckRead(call: Call, ctx: ReadCtx): Promise<string | null> {
  const v = await safely(async () => (typeof call.input === 'object' && call.input !== null ? readVerdict(call.tool, call.input as Record<string, unknown>, ctx) : deny(`flow: ${call.tool} was called without its arguments object`)))
  return v.decision === 'deny' ? v.reason : null
}

/** A command's words for the fallback lists: heredoc bodies dropped, quotes and backslashes removed (so `sh -c 'npm publish'`
 * and `n\pm` read as their words), split at shell separators. More false alarms than a parser, never fewer words. */
function looseWords(command: string): string[][] {
  const text = String(stripHeredocBodies(command)).replace(/\$(?=['"])/g, '').replace(/['"\\]/g, '')
  return text.split(/[;&|()`<>{}\n]|\$\(/).map(s => s.split(/\s+/).filter(Boolean)).filter(s => s.length > 0)
}
const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1)

/** A `&` that sends a command to the background (F47-A), in a command as the shell reads it (the caller drops heredoc
 * bodies): not escaped and not part of `&&`, `;&`, `|&`, `>&`, `<&` or `&>`. Text in single, ANSI-C or double quotes is
 * data; a quote that never closes is a plain character; a `#` that starts a word starts a comment. A double-quoted string
 * that holds a command substitution (whose own quotes nest) hands the rest of the command to rawAmp. More false alarms
 * than a parser (arithmetic, a `#` after a subshell), never fewer. */
function loneAmp(s: string): boolean {
  let escaped = -1 // the index of the last character a backslash escaped: it is a plain character
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '', prev = i === 0 ? '' : i - 1 === escaped ? 'a' : (s[i - 1] ?? '')
    if (c === '\\') { escaped = i + 1; i += 1; continue }
    const end = c === "'" ? (ansiQuote(s, i, escaped) ? closing(s, i + 1, "'") : s.indexOf("'", i + 1)) : c === '"' ? closing(s, i + 1, '"') : -1
    if (c === '"' && /\$\(|`/.test(s.slice(i + 1, end < 0 ? s.length : end))) return rawAmp(s.slice(i + 1))
    if (end >= 0) { i = end; continue }
    if (c === '#' && (prev === '' || WORD_START_BEFORE.includes(prev))) {
      const nl = s.indexOf('\n', i)
      if (nl < 0) return false
      i = nl
      continue
    }
    const next = s[i + 1] ?? ''
    if (c === '&' && !(prev !== '' && OPERATOR_BEFORE.includes(prev)) && !(next !== '' && '&>'.includes(next))) return true
  }
  return false
}
/** An `&` in text a shell reads again (after eval, sh -c, a heredoc, a substitution): its quotes and backslashes may belong
 * to either reading, so every `&` counts but those in `&&`, `;&`, `|&`, `>&`, `<&` and `&>` with no backslash before either
 * character. */
function rawAmp(s: string): boolean {
  const plain = (k: number): boolean => s[k - 1] !== '\\'
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '&') continue
    const prev = s[i - 1] ?? '', next = s[i + 1] ?? ''
    const paired = (prev !== '' && OPERATOR_BEFORE.includes(prev) && plain(i - 1)) || (next !== '' && '&>'.includes(next))
    if (!plain(i) || !paired) return true
  }
  return false
}
/** A `'` that opens an ANSI-C string: after an odd run of unescaped `$` (`$$` is the shell's process id). */
function ansiQuote(s: string, at: number, escaped: number): boolean {
  let n = 0
  for (let k = at - 1; k >= 0 && s[k] === '$' && k !== escaped; k -= 1) n += 1
  return n % 2 === 1
}
/** Where a quote that takes backslash escapes closes, or -1. */
function closing(s: string, from: number, quote: string): number {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === '\\') i += 1
    else if (s[i] === quote) return i
  }
  return -1
}

/** The publish command in a segment: any word that is a tool, followed past its options by a publish subcommand (`yarn npm
 * publish` reads at `npm`), or a release tool anywhere (`npx changeset publish`, `bunx semantic-release`). */
function publishVerb(words: readonly string[], p: Stack['publish']): string | null {
  for (const [i, word] of words.entries()) {
    const tool = base(word)
    if (p.releaseTools.includes(tool)) return tool
    if (!p.tools.includes(tool)) continue
    let j = i + 1
    for (; j < words.length; j += 1) {
      const w = words[j] ?? ''
      if (p.valueOptions.includes(w)) j += 1
      else if (!w.startsWith('-')) break
    }
    if (p.subcommands.includes(words[j] ?? '')) return `${tool} ${words[j]}`
  }
  return null
}

/** Bash: its own four keys only (F25; the sandbox switch only when off), no git publishing, screen capture (F39) or publish verb. */
function bashVerdict(input: Record<string, unknown>, ctx: GuardCtx): Verdict {
  const extra = Object.keys(input).filter(k => !BASH_KEYS.has(k))
  const off = input.dangerouslyDisableSandbox
  if (extra.length || (off !== undefined && off !== false)) return deny(`flow: Bash runs in the sandbox with only command, timeout, description and run_in_background${extra.length ? ` (not ${extra.join(', ')})` : ''}`)
  const bg = input.run_in_background
  if (bg !== undefined && bg !== false) return deny(BACKGROUND)
  return typeof input.command === 'string' ? commandVerdict(input.command, ctx) : deny('flow: Bash needs a command')
}

/** A Bash command: no git publishing, screen capture (F39) or publish verb. */
function commandVerdict(command: string, ctx: GuardCtx): Verdict {
  const git = gitIntent(command)
  if (git.push || git.indirect || git.otherRepo || git.aliases.length) return deny(GIT_REASON)
  const words = looseWords(command)
  const keeps = words.flat().map(base).find(w => BACKGROUND_WORDS.has(w))
  if (keeps !== undefined) return deny(`flow: ${keeps} keeps a process running after the call, and nothing runs in the background while flow is active (owner decision F47-A); where the word is only text (a search, a message), use the Grep tool or other words`)
  // a shell or a builtin that runs text reads quoted text and heredoc bodies as commands: then every `&` in the command counts
  const shell = words.flat().some(w => SHELLS.has(base(w)))
  if (shell ? rawAmp(command) : loneAmp(String(stripHeredocBodies(command)))) return deny(BACKGROUND)
  const screen = words.flat().map(base).find(w => SCREEN_COMMANDS.has(w))
  if (screen !== undefined) return deny(`flow: ${screen} could read the screen, where approvals and the release code show; it does not run while flow is active`)
  const verb = words.map(s => publishVerb(s, ctx.publish)).find(v => v !== null)
  return verb ? deny(`flow: "${verb}" publishes; nothing is published before the owner's release (/flow-ship)`) : PASS
}

/** Agent: never from a subagent; from main a ticket line (agent.spawn checks and rewrites it) or a free type; never named,
 * isolated, teamed or with a mode, and a ticket keeps its routed effort. */
function agentVerdict(input: Record<string, unknown>, agentId: string | undefined, ctx: GuardCtx): Verdict {
  if (agentId !== undefined) return deny('flow: a subagent does not start agents while flow is active')
  const set = AGENT_REFUSED.filter(k => input[k] !== undefined)
  if (set.length) return deny(`flow: an agent started in flow takes no ${set.join(', ')}`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (/^TICKET [\w-]+$/.test(prompt)) return input.effort === undefined ? PASS : deny('flow: a ticket agent runs at its routed effort; leave effort out')
  if (prompt.includes('TICKET ')) return deny('flow: a ticket spawn takes exactly "TICKET <id>" as its prompt')
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
  return ctx.freeSpawn.includes(type) ? PASS : deny(`flow: only a ticket or a ${ctx.freeSpawn.join(' or ')} agent starts while flow is active`)
}

function skillVerdict(input: Record<string, unknown>, ctx: GuardCtx): Verdict {
  const name = typeof input.skill === 'string' ? input.skill.trim() : ''
  if (FLOW_SKILL.test(name)) return deny('flow: flow-* commands are the owner\'s and never run as a skill')
  return ctx.skills.includes(name) ? PASS : deny(`flow: the skill ${name || '(none)'} is not on the flow list`)
}

/** Text naming flow data or transcripts as a file system would read it: as given and percent-decoded, each folded, `\` read
 * as `/`, with and without its `.` and `..` parts folded; or a path at or above a hidden folder, which a file-system server
 * would walk into (so `/`, `~` and HOME are refused too). */
const hiddenText = (s: string, ctx: ReadCtx): boolean => [s, s.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))]
  .some(x => {
    const slashed = x.replace(/\\/g, '/'), t = folder(true)(slashed)
    if (HIDDEN_TEXT.test(t) || HIDDEN_TEXT.test(lexical(t))) return true
    const p = /^(~(\/|$)|\/)/.test(slashed) ? absolute(slashed, ctx.home) : null
    return p !== null && hiddenOf(ctx).some(h => within(h, lexical(p), folder(ctx.caseFold)))
  })
const mentionsHidden = (v: unknown, ctx: ReadCtx, depth = 0): boolean => {
  if (typeof v === 'string') return hiddenText(v, ctx)
  if (typeof v !== 'object' || v === null) return false
  return depth >= MAX_DEPTH || Object.entries(v).some(([k, x]) => hiddenText(k, ctx) || mentionsHidden(x, ctx, depth + 1))
}

/** MCP: the mod's own tools; else the exact name on the list, never a screen tool (F39), never naming flow data (F21). */
function mcpVerdict(tool: string, input: Record<string, unknown>, ctx: GuardCtx): Verdict {
  if (ctx.modTools.includes(tool)) return PASS
  if (SCREEN_TOOL.test(tool)) return deny(`flow: ${tool} could read the screen, where approvals and the release code show`)
  if (!ctx.allowMcp.includes(tool)) return deny(`flow: ${tool} is not on the flow MCP list; add it with /flow-setup mcp=+${tool}`)
  return mentionsHidden(input, ctx) ? deny('flow: an MCP call may not name flow data (.snagon), transcripts (.claude/projects) or a folder above them') : PASS
}

async function decide({ tool, input, agentId }: Call, ctx: GuardCtx): Promise<Verdict> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return deny(`flow: ${tool} was called without its arguments object`)
  const args = input as Record<string, unknown>
  if (tool.startsWith('mcp__')) return mcpVerdict(tool, args, ctx)
  if (tool === 'Monitor') return deny(MONITOR) // F42-A: listed or not, until a spike shows the sandbox wraps its command
  if (!ctx.allowTools.includes(tool)) return deny(`flow: ${tool} is not on the flow allow-list; add it with /flow-setup tools=+${tool}`)
  if (Object.hasOwn(EDIT_KEY, tool)) return editVerdict(tool, args, ctx)
  if (Object.hasOwn(READ_KEYS, tool)) return readVerdict(tool, args, ctx)
  if (tool === 'Bash') return bashVerdict(args, ctx)
  if (tool === 'Agent' || tool === 'Task') return agentVerdict(args, agentId, ctx)
  if (tool === 'Skill') return skillVerdict(args, ctx)
  return PASS
}

async function restricted({ tool, input }: Call, ctx: ReadCtx & Pick<GuardCtx, 'modTools'>, why: string): Promise<Verdict> {
  if (ctx.modTools.includes(tool) || NO_EFFECT.has(tool)) return PASS
  if (Object.hasOwn(READ_KEYS, tool) && typeof input === 'object' && input !== null) return readVerdict(tool, input as Record<string, unknown>, ctx)
  return deny(`flow: ${why}; only reading is allowed meanwhile`)
}

/** The `tool.check` verdict while a flow is active (fail-closed). */
export const checkCall = (call: Call, ctx: GuardCtx): Promise<Verdict> =>
  safely(() => (ctx.permissionMode === 'bypassPermissions' ? restricted(call, ctx, BYPASS) : decide(call, ctx)))

/** The verdict while the flow state is unknown (`why`): reading, the todo list, tool search, questions and the mod's tools. */
export const guardUnknown = (call: Call, ctx: ReadCtx & Pick<GuardCtx, 'modTools'>, why: string): Promise<Verdict> => safely(() => restricted(call, ctx, why))

/** tool.call, before `next`: a Bash call's sandbox switch is turned off (tool.check still denies it if this rewrite failed). */
export function stripCall<T extends Record<string, unknown>>(e: T): T {
  return e.tool === 'Bash' && e.dangerouslyDisableSandbox !== undefined && e.dangerouslyDisableSandbox !== false ? { ...e, dangerouslyDisableSandbox: false } : e
}

/** tool.call, after the tool answered without error: the target placed again. Another realpath, a path that no longer places
 * (a link appeared), a file gone (written through a link, then removed), a second name (a hard link), or for a Write
 * (`written`: its content) other text: it changed during the call, so the wiring withholds the result and blocks the flow
 * (tampered). Never throws: a check that fails is a change. */
export async function recheck(before: Placed, ctx: PlaceCtx, written?: string): Promise<string | null> {
  try {
    const after = await placeEdit(before.literal, ctx)
    if (typeof after === 'string') return `flow: ${before.literal} changed during the call (${after})`
    if (folder(ctx.caseFold)(after.real) !== folder(ctx.caseFold)(before.real)) return `flow: ${before.literal} moved during the call (${before.real} → ${after.real})`
    if (!after.exists) return `flow: ${before.literal} is gone after the call`
    if ((await ctx.fs.links(after.real)) > 1) return `flow: ${before.literal} gained a second name (a hard link) during the call`
    return written !== undefined && (await ctx.fs.read(after.real)) !== written ? `flow: ${before.literal} does not hold the written text after the call` : null
  } catch (err) { return `flow: ${before.literal} could not be checked after the call (${errText(err)})` }
}

/** F39: MCP tools that could read the screen (computer use, screenshots, screencasts); /flow-setup refuses them in allowMcp. */
export const screenMcpRefusals = (names: readonly string[]): string[] => names.filter(n => SCREEN_TOOL.test(n))

export type FlowView = { mode: 'off' } | { mode: 'on'; record: FlowRecord } | { mode: 'unknown'; why: string }
/** Whether this repository has one active flow, none, or a state the guard cannot know (then only reading passes). */
export function viewOf(list: ListResult): FlowView {
  if (!list.ok) return { mode: 'unknown', why: `the flow record could not be read (${list.reason})` }
  if (list.invalid.length) return { mode: 'unknown', why: `flow ${list.invalid.join(', ')} cannot be read` }
  if (list.active.length > 1) return { mode: 'unknown', why: `${list.active.length} flows are active in this repository; /flow-off <id8> ends one` }
  return list.active[0] ? { mode: 'on', record: list.active[0] } : { mode: 'off' }
}

export const ACTIVE_TTL_MS = 5_000 // F14: a session opened before /flow-setup learns of the flow within this long
/** The active-flow lookup `tool.check` asks on every call, loaded at most once per ACTIVE_TTL_MS; a failed load is unknown. */
export function activeLookup(load: () => Promise<FlowView>): { get(now: number): Promise<FlowView>; drop(): void } {
  let at = 0, held: Promise<FlowView> | undefined
  return {
    get(now) {
      if (!held || now - at >= ACTIVE_TTL_MS || now < at) {
        at = now
        held = load().catch((err: unknown): FlowView => ({ mode: 'unknown', why: `the flow record could not be read (${errText(err)})` }))
      }
      return held
    },
    drop() { held = undefined },
  }
}
