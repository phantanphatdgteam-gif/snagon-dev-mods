// S1 (plan v7.1 §5.1, §2.2): what /flow-setup proposes. It finds the stack and its commands, the sandbox block for
// .claude/settings.local.json, the remote and branch a release goes to, and every reason flow cannot start here, all at
// once; then the echo the owner approves (its hash binds what S2 freezes) and the redacted draft view.
import { dataDir, hashOf } from './session'
import { cfgDetail, cfgHash, git, gitPaths, partsDrift, pushFacts, seenHash, urlProblem, writableIncludes, type GitPaths, type PushFacts } from './flow-git'
import { settingsPlaces, writePlaces } from './safe-path'
import { detectManagers, effectiveOf, flowDenyRead, nameMatches, pluginRootRefusals, postText, proposeBlock, sandboxRefusals, type Layer, type SandboxBlock, type Settings } from './flow-sandbox'
import { STACK_ENTRIES, stackById, stackOf, type StackEntry } from './stacks/index'
import { screenMcpRefusals } from './flow-guard'
import { viewText } from './flow-pack'
import { findSecrets } from './secrets'
import { activeView, branchOf, pluginRoots, realOf, staticsOf, type FlowHost } from './flow-host'
import type { EchoContent } from './flow-owner'
import { treeProblem, type RunnerState } from './flow-tree'
import type { FlowCommand } from './flow-state'
import { STACKS } from '../flow/data/stacks'
import { ROUTING } from '../flow/data/routing'
import { CAPS } from '../flow/data/phases'
import { fill } from '../flow/data/templates'
import type { CapScope, Caps } from '../flow/data/types'

export type SetupArgs = { overrides: Readonly<Record<string, string>>; tools: readonly string[]; mcp: readonly string[]; stack?: string }
/** Everything S2 freezes, as S1 found it. `sources`: the command sources' hashes by name (the stack's commandSources). */
export type SetupDraft = {
  root: string; stack: string; commands: FlowCommand[]; scripts: Record<string, string>; managers: string[]; pkgHash: string
  sources: Record<string, string>; block: SandboxBlock; pre: string | null; post: string; layers: string[]
  remote: string; branch: string; facts: PushFacts; allowTools: string[]; allowMcp: string[]; journalDir: string
  secretNames: string[]; writeYourself: boolean; pluginProject: boolean; caps: Record<CapScope, Caps>
  /** The filtered PATH S2 freezes for the judge, the git the mod runs (its real path) and the host PATH entries left out
   * (NK-02); the approval binds all three. */
  path: string; git: string; pathDropped: string[]
  /** A re-freeze: the repository config and git hooks that differ from the flow's freeze or were not recorded then;
   * `cfgSeen`: the hash of the H_cfg parts as S1 read them (seenHash), which the approval binds and the probe checks. */
  cfgDrift: string[]; cfgSeen: string
  /** Runner integrity as S1 hashed it (R2 step 6): S2 freezes it, so the approval binds it. */
  runner: RunnerState
  /** Every stack whose marker files the root holds (AC-STK-15); more than one only when `stack=<id>` picked `stack`. */
  stacks: string[]
  /** Weakening flags a command's runner takes from the project's config (Python: pytest's addopts), by command id. */
  configWeak: Record<string, { file: string; flags: string[] }>
  /** The base interpreters' standard libraries, hashed once here for the echo (GAP-R2-0.6-7); never frozen. */
  bases: Array<{ path: string; hash: string | null }>
}
export type Detected = { ok: true; draft: SetupDraft } | { ok: false; refusals: string[] }
type Say = (key: string, vars?: Readonly<Record<string, string | number>>) => void

export const LOCAL_SETTINGS = '.claude/settings.local.json'
export const DRAFT_VIEW = '.snagon/flow/setup-draft.md'
const LAYERS: readonly Layer[] = ['user', 'project', 'local', 'flag', 'policy']
/** The mod's own data folders: never the journal (owner decision 2026-10-17). */
const JOURNAL_DATA = ['.snagon', '.snagon/flow', '.snagon/handoff']
/** Environment names that look like a secret; only names are ever read (F19). */
const SECRET_NAME = /TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL/i
const SHOWN_SOURCES = 20
/** The report formats the judge asks runners for, by file extension (TypeScript: JSON; Python: JUnit XML). */
const REPORT_FORMAT: Readonly<Record<string, string>> = { '.json': 'JSON', '.xml': 'JUnit XML' }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const unique = (xs: readonly string[]): string[] => [...new Set(xs)]
const short = (text: string | null): string => (text === null ? 'absent' : hashOf(text).slice(0, 8))

async function readOrNull(h: FlowHost, path: string): Promise<string | null> {
  try { return await h.io.read(path) } catch (err) { if (await h.io.exists(path)) throw err; return null }
}
const expandHome = (h: FlowHost, p: string): string => (p === '~' || p.startsWith('~/') ? `${h.home}${p.slice(1)}` : p)

/** S1's stack (AC-STK-15, GAP-R2-11): the one stack whose marker files the root holds, or the one `stack=<id>` picks
 * among them. Several and no pick, a pick that flow does not know or the project does not match, or none: refused,
 * naming what is here; the checks go on with a stack all the same, so every refusal shows at once (GAP-R2-0.6-28). */
async function stackPart(h: FlowHost, root: string, pick: string | undefined, say: Say): Promise<{ entry: StackEntry; matched: StackEntry[] }> {
  const names = (await h.io.list(root)).map(i => i.name)
  const matched = STACK_ENTRIES.filter(s => s.data.detect.files.some(f => names.some(n => nameMatches(f, n))))
  const found = matched.map(s => s.data.id), picked = matched.find(s => s.data.id === pick)
  if (picked) return { entry: picked, matched }
  // a known stack the project does not match names what was found; with no pick or an unknown one, what is wrong with
  // the stacks here shows too (code review r3)
  const known = pick !== undefined && stackById(pick) !== null
  if (known) say('setup.stackAbsent', { id: pick, needs: fill(h.language, `setup.needs.${pick}`, {}), found: found.join(', ') || '—' })
  else if (pick !== undefined) say('setup.stackUnknown', { id: pick, known: STACK_ENTRIES.map(s => s.data.id).join(', ') })
  if (!known && matched.length > 1) say('setup.stacks', { ids: found.join(', '), first: found[0] ?? '' })
  if (!known && !matched.length) say('setup.noStack', { needs: STACK_ENTRIES.map(s => fill(h.language, `setup.needs.${s.data.id}`, {})).join('; ') })
  return { entry: matched[0] ?? (STACK_ENTRIES[0] as StackEntry), matched }
}

/** The stack's commands from its manifest (`<id>=<argv>` and `<id>=none` overrides, GAP-step10-11), each found on the
 * frozen PATH from the root (where the judge runs it), the manifest's hash, and the weakening flags each command's runner
 * takes from the project's config (Python: pytest's addopts, R2 plan §4.5). */
async function projectPart(h: FlowHost, root: string, s: StackEntry, args: SetupArgs, say: Say) {
  const pkgText = await readOrNull(h, `${root}/${s.data.manifest}`)
  const names = (await h.io.list(root)).map(i => i.name)
  const managers = detectManagers(s.data, names)
  const { commands, scripts } = s.code.proposeCommands(pkgText, managers[0] ?? s.data.packageManagers[0]?.id ?? '', args.overrides, names)
  if (!commands.some(c => c.id === 'test')) say(`setup.noTest.${s.data.id}`)
  const configWeak: Record<string, { file: string; flags: string[] }> = {}
  for (const c of commands) {
    // The judge runs with this PATH (frozen at S2) in the root, so the program must be found through it from there.
    const found = await h.io.run(['/bin/sh', '-c', 'command -v "$1"', 'sh', c.argv[0] ?? ''], { cwd: root, env: { PATH: h.env.PATH } })
    if (found.exitCode !== 0) say('setup.argv', { id: c.id, argv: c.argv.join(' ') })
    const opts = await s.code.configOptions?.(h.io, root, c.argv)
    const flags = opts ? s.code.weakFlags(opts.text) : []
    if (opts && flags.length) configWeak[c.id] = { file: opts.file, flags }
  }
  return { managers, commands, scripts, pkgHash: pkgText === null ? 'absent' : hashOf(pkgText), configWeak }
}

/** Names only: the values never leave the child. sed keeps what stands before the first `=` of each line, and printenv
 * drops a "name" that is only a line inside another variable's value; any other printenv failure fails the listing
 * (security review r1). */
export const ENV_NAMES_SCRIPT = `set +xv; set -o pipefail; /usr/bin/env | /usr/bin/sed -n 's/^\\([^=][^=]*\\)=.*/\\1/p' | while IFS= read -r n; do x=$(/usr/bin/printenv -- "$n"); s=$?; if [ "$s" -eq 0 ]; then printf '%s\\n' "$n"; elif [ "$s" -ne 1 ]; then exit 4; fi; done && printf '=\\n'`
async function envNames(h: FlowHost): Promise<string[]> {
  const r = await h.io.run(['/bin/sh', '-c', ENV_NAMES_SCRIPT])
  // the exit status only: an inherited trace can put a value on stderr (security review r3); a run without its end mark
  // `=` stopped early, as under an inherited noexec, and is never read as "no names" (security review r4)
  if (r.exitCode !== 0 || !r.stdout.endsWith('=\n')) throw new Error(`flow: the environment names could not be read (exit ${r.exitCode}${r.exitCode === 0 ? ', unfinished' : ''})`)
  // any name the environment holds, also one with characters outside [A-Za-z0-9_] (npm's `npm_config_//<host>/:_authToken`)
  return unique(r.stdout.split('\n').filter(n => /^[^=\n]+$/.test(n)))
}
/** The given variables whose value holds a URL with a password (`scheme://user:password@`, the URL rule hasAuth reads
 * files with): each value is read only inside this child, which prints names (F19); a name that is not set, or grep
 * failing (any status but match or no match), fails the check rather than passing it (security review r1). An
 * inherited xtrace is turned off first, and a user part may be empty (`https://:token@host`, reviews r2). */
export const URL_AUTH_SCRIPT = `set +xv; for n do v=$(/usr/bin/printenv -- "$n") || exit 3; printf '%s\\n' "$v" | /usr/bin/grep -Eq '[A-Za-z][A-Za-z0-9+.-]*://[^/[:space:]]*:[^/[:space:]@]+@'; s=$?; if [ "$s" -eq 0 ]; then printf '%s\\n' "$n" || exit 5; elif [ "$s" -ne 1 ]; then exit 4; fi; done; printf '=\\n' || exit 5; exit 0`
async function urlAuthNames(h: FlowHost, names: readonly string[]): Promise<string[]> {
  const r = await h.io.run(['/bin/sh', '-c', URL_AUTH_SCRIPT, 'sh', ...names])
  // the exit status only: the child's output stays out of the error text (security review r2); without its end mark the
  // check did not run to the end (security review r4)
  if (r.exitCode !== 0 || !r.stdout.endsWith('=\n')) throw new Error(`flow: the registry URLs in the environment could not be checked (exit ${r.exitCode}${r.exitCode === 0 ? ', unfinished' : ''})`)
  return r.stdout.split('\n').filter(n => names.includes(n))
}
/** Registry credentials of every stack the project matches, not only the chosen one's (security review r2): in the
 * environment by name and, for a registry URL with a password (PIP_INDEX_URL, UV_INDEX, …), by value in the child
 * (AC-STK-10); and in each stack's auth files at the root. */
async function envPart(h: FlowHost, root: string, stacks: readonly StackEntry[], say: Say): Promise<{ secretNames: string[] }> {
  const names = await envNames(h), byName = unique(stacks.flatMap(s => s.code.authEnvNames(names)))
  const urls = unique(stacks.flatMap(s => s.code.urlEnvNames?.(names) ?? [])).filter(n => !byName.includes(n))
  const auth = [...byName, ...(urls.length ? await urlAuthNames(h, urls) : [])]
  if (auth.length) say('setup.authEnv', { names: auth.join(', ') })
  // a name with `*` stands for the root's files it matches (`requirements*.txt`)
  const rootNames = (await h.io.list(root)).map(i => i.name)
  for (const s of stacks) {
    for (const file of s.data.authFiles.flatMap(f => (f.includes('*') ? rootNames.filter(n => nameMatches(f, n)) : [f]))) {
      const text = await readOrNull(h, `${root}/${file}`)
      if (text !== null && s.code.hasAuth(file, text)) say('setup.npmrc', { file })
    }
  }
  return { secretNames: names.filter(n => SECRET_NAME.test(n)).sort() }
}

/** The branch's remote (else origin) and what a push to it depends on; a release needs one (GAP-step10-12). */
async function remotePart(h: FlowHost, p: GitPaths, say: Say): Promise<{ remote: string; branch: string; facts: PushFacts | null }> {
  const branch = await branchOf(h)
  if (!branch) say('setup.detached')
  const cfg = branch ? await git(h.io, p.top, ['config', '--get', `branch.${branch}.remote`]) : null
  const remote = cfg?.exitCode === 0 && cfg.stdout.trim() ? cfg.stdout.trim() : 'origin'
  const url = await git(h.io, p.top, ['remote', 'get-url', '--push', remote])
  const none = { remote, branch, facts: null }
  if (url.exitCode !== 0) return (say('setup.noRemote'), none)
  const problem = urlProblem(url.stdout.trim())
  if (problem) return (say('setup.remote', { detail: problem }), none)
  try {
    const facts = await pushFacts(h.io, p, remote)
    if (facts.repoCredentialKeys.length) say('setup.remote', { detail: `not allowed for a push: ${facts.repoCredentialKeys.join(', ')}` })
    return { remote, branch, facts }
  } catch (err) { return (say('setup.remote', { detail: String(err).slice(0, 200) }), none) }
}

/** Per layer, what else shapes the sandbox: its sandbox keys (the local one is replaced) and the rules that widen it. */
function layerParts(layers: Readonly<Record<Layer, Settings>>): string[] {
  return LAYERS.flatMap(l => {
    const s = layers[l], e = effectiveOf({ permissions: s.permissions })
    const keys = l !== 'local' && isObj(s.sandbox) ? Object.keys(s.sandbox).map(k => `sandbox.${k}`) : []
    const items = [...keys, ...e.webFetchDomains.map(d => `WebFetch(${d})`), ...e.editAllow, ...e.additionalDirectories.map(d => `additionalDirectories ${d}`)]
    return items.length ? [`${l}: ${items.join(', ')}`] : []
  })
}
/** S-12: the git common dir when it lies outside the project root (a worktree's, a submodule's): it holds the config and
 * hooks of the git the mod runs outside the sandbox, so no setting may make it writable; inside the project the H_cfg
 * freeze covers them. S1 and the recheck at the probe and at each flow_check use it (security review r4). */
export const outsideCommon = (root: string, commonDir: string): string[] => (commonDir === root || commonDir.startsWith(`${root}/`) ? [] : [commonDir])
async function sandboxPart(h: FlowHost, root: string, s: StackEntry, managers: readonly string[], roots: readonly string[], o: { commonDir: string; others: readonly StackEntry[] }, say: Say) {
  // the other stacks the project matches keep their credential files hidden too, after COMMON_DENY_READ (one stack: the
  // 0.5.4 bytes, GAP-R2-0.6-29); their registries stay closed
  const block = proposeBlock(s.data, managers, [...o.others.flatMap(x => x.data.sandbox.denyRead), ...flowDenyRead(h.home, h.claudeDir)])
  const pre = await readOrNull(h, `${root}/${LOCAL_SETTINGS}`)
  let post = ''
  try { post = postText(pre, block) } catch { say('setup.localJson') }
  const layers = Object.fromEntries(await Promise.all(LAYERS.map(async l => [l, await h.settings(l)] as const))) as Record<Layer, Settings>
  const ctx = { home: h.home, root, protectedPaths: [h.claudeDir, `${h.home}/.snagon`, ...roots, ...outsideCommon(root, o.commonDir)], denyRead: block.filesystem.denyRead, resolve: (x: string) => realOf(h, x) }
  for (const r of await sandboxRefusals(layers, ctx)) {
    const key = r.key.startsWith('permissions.') ? r.key : `sandbox.${r.key}`
    say('setup.sandbox', { layer: r.layer, key, value: r.value === undefined ? '' : ` "${r.value}"`, why: fill(h.language, `setup.why.${r.why}`, {}) })
  }
  const temps = unique(['/tmp', '/private/tmp', ...(h.env.TMPDIR ? [h.env.TMPDIR, await realOf(h, h.env.TMPDIR)] : [])])
  for (const r of pluginRootRefusals(roots, { root, allowWrite: block.filesystem.allowWrite.map(x => expandHome(h, x)), tempDirs: temps })) say('setup.pluginRoot', { root: r.root })
  return { block, pre, post, layers: layerParts(layers) }
}

/** The journal folder: under .snagon/ (not the mod's own folders) or ignored by git, so no entry is ever committed. */
async function journalPart(h: FlowHost, root: string, caseFold: boolean, say: Say): Promise<void> {
  const dir = h.journalDir.replace(/\/+$/, ''), f = (x: string): string => (caseFold ? x.normalize('NFC').toLowerCase() : x)
  if (JOURNAL_DATA.some(d => f(d) === f(dir))) return say('setup.journalData', { dir })
  if (f(dir).startsWith('.snagon/')) return
  if ((await git(h.io, root, ['check-ignore', '-q', '--', dir])).exitCode !== 0) say('setup.journal', { dir })
}

/** The git the mod runs outside the sandbox, found on the filtered PATH (NK-02): its real path for the echo, refused when
 * it lies where the agent's Bash could write it, with the same places the PATH filter uses (the project, the temp
 * folders, the settings' write places, every stack's caches, the proposed block), as a link may lead. */
async function gitPart(h: FlowHost, root: string, block: SandboxBlock, say: Say): Promise<string> {
  const found = (await h.io.run(['/bin/sh', '-c', 'command -v "$1"', 'sh', 'git'])).stdout.trim()
  if (!found) { say('setup.gitMissing', { path: h.env.PATH, dropped: (h.pathDropped ?? []).join(', ') || '—' }); return '' }
  const real = (await h.stat(found))?.realPath ?? found
  const extra = [...settingsPlaces(await h.settings()), ...STACKS.flatMap(s => s.packageManagers.flatMap(m => m.cacheDirs)), ...block.filesystem.allowWrite]
  const places = await writePlaces({ root, tmp: h.env.TMPDIR, home: h.home, extra }, async p => (await h.stat(p))?.realPath)
  if (writableIncludes([found, real], places).length) say('setup.gitUnsafe', { path: real })
  return real
}

/** NK-05, GAP-054-13: the stack's dependency and build-output folders (those ignoredSkip in flow-baseline.ts leaves
 * out); one git tracks, or one holding files git neither tracks nor ignores, goes into flowTree and the release commit
 * (`git add -A`). */
const outputDirs = (s: StackEntry): string[] => [...s.data.dependencyDirs, ...s.data.buildOutputs.filter(x => x.endsWith('/'))].map(d => d.replace(/\/+$/, ''))
async function outputsPart(h: FlowHost, root: string, s: StackEntry, say: Say): Promise<void> {
  for (const dir of outputDirs(s)) {
    // `-t` tags each path: `?` git neither tracks nor ignores it, any other letter a tracked file; nothing: ignored or absent
    const r = await git(h.io, root, ['ls-files', '-t', '-c', '-o', '--exclude-standard', '--directory', '--no-empty-directory', '--', dir])
    if (r.exitCode !== 0) say('blocked.couldNotRun', { detail: `git ls-files -- ${dir}: ${r.stderr.trim().slice(0, 200)}` })
    else if (/^[^?\n]/m.test(r.stdout)) say('setup.tracked', { dir })
    else if (r.stdout.trim()) say('setup.notIgnored', { dir })
  }
}

/** Runner integrity at S1 (R2 step 6): the hash the approval binds, or why the runner cannot be pinned (a link out of
 * the tree, a file it cannot hash, a read error: S-13), with the stack's refusals (Python: O-4, A-6, S-4). */
async function runnerPart(h: FlowHost, p: GitPaths, s: StackEntry, commands: readonly FlowCommand[], say: Say): Promise<RunnerState | null> {
  try {
    const state = await s.code.runnerIntegrity(h.io, p.top, commands, h.home)
    for (const x of state.problems) say(x.key, x.vars)
    return state
  } catch (err) {
    const x = treeProblem(err)
    if (!x) throw err
    say(x.key, x.vars)
    return null
  }
}

/** A re-freeze approves the repository config and git hooks as S1 read them (`cfg`; the approval binds them), so the
 * echo names what differs from the flow's freeze; a flow frozen before 0.5.4 never recorded the hooks path, so those
 * parts are named too. */
async function driftPart(h: FlowHost, cfg: { hash: string; parts: Readonly<Record<string, string>> }): Promise<string[]> {
  const view = await activeView(h)
  return view.mode === 'on' && view.record.frozen.hCfg !== undefined ? partsDrift(view.record.frozen, cfg) ?? [] : []
}

/** S1: everything /flow-setup proposes, or every reason flow cannot start here, in the owner's words. */
export async function detectSetup(h: FlowHost, args: SetupArgs): Promise<Detected> {
  const why: string[] = []
  const say: Say = (key, vars = {}) => { why.push(fill(h.language, key, vars)) }
  const s = await staticsOf(h), root = s.rootReal
  let p: GitPaths
  try { p = await gitPaths(h.io, root) } catch { return { ok: false, refusals: [fill(h.language, 'setup.noGit', {})] } }
  const { entry: stack, matched } = await stackPart(h, root, args.stack, say)
  const project = await projectPart(h, root, stack, args, say)
  const runner = await runnerPart(h, p, stack, project.commands, say)
  const env = await envPart(h, root, matched.length ? matched : [stack], say)
  const release = await remotePart(h, p, say)
  const sandbox = await sandboxPart(h, root, stack, project.managers, await pluginRoots(h), { commonDir: p.commonDir, others: matched.filter(s => s !== stack) }, say)
  const allowMcp = unique(args.mcp)
  const screen = screenMcpRefusals(allowMcp)
  if (screen.length) say('setup.screen', { names: screen.join(', ') })
  await journalPart(h, root, s.caseFold, say)
  await outputsPart(h, root, stack, say)
  const gitPath = await gitPart(h, root, sandbox.block, say)
  const cfg = await cfgHash(h.io, root, p, h.home).catch((err: unknown) => { say('blocked.couldNotRun', { detail: fill(h.language, 'cfg.unreadable', { detail: cfgDetail(err) }) }); return null })
  if (why.length || !release.facts || !cfg || !runner) return { ok: false, refusals: why }
  const sources = (await stack.code.commandSources(h.io, p, project.commands.map(c => c.argv))).hashes
  const drift = await driftPart(h, cfg)
  const bases = (await stack.code.baseLibraries?.(h.io, p.top, project.commands)) ?? []
  return {
    ok: true,
    draft: {
      root, stack: stack.data.id, ...project, sources, ...sandbox, remote: release.remote, branch: release.branch, facts: release.facts,
      allowTools: unique([...ROUTING.allowTools, ...args.tools]), allowMcp, journalDir: h.journalDir, ...env,
      writeYourself: findSecrets(sandbox.post).length > 0, pluginProject: await h.io.exists(`${root}/.claude-plugin/plugin.json`),
      caps: { ...CAPS }, path: h.env.PATH, git: gitPath, pathDropped: [...(h.pathDropped ?? [])], cfgDrift: drift, cfgSeen: seenHash(cfg.parts, root),
      runner, stacks: matched.map(s => s.data.id), bases,
    },
  }
}

/** The setup echo (§2.5): every line the pane shows, the fields S2 freezes and the hash of every file it names. Lines
 * pass through the view redaction, so a secret in a script body never reaches the pane or the session state. */
export function setupEcho(h: Pick<FlowHost, 'language' | 'address'>, d: SetupDraft): EchoContent {
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => fill(h.language, key, vars)
  const stack = stackOf({ setup: d }), files = Object.keys(d.sources).filter(k => !k.includes(':'))
  const listed = [...files.slice(0, SHOWN_SOURCES), ...(files.length > SHOWN_SOURCES ? [`+${files.length - SHOWN_SOURCES}`] : []), ...(d.sources['closure:truncated'] ? ['…'] : [])]
  const others = d.stacks.filter(x => x !== d.stack)
  // where a command's results come from (§4.5, AC-STK-12): the report the judge asks its runner for, or none
  const results = (c: FlowCommand, body: string | undefined): string => {
    const file = stack.code.judged(c.argv, c.runner, '/run', body).reportFile
    return file === null ? t('echo.noReport') : t('echo.results', { format: REPORT_FORMAT[file.slice(file.lastIndexOf('.'))] ?? file.slice(file.lastIndexOf('/') + 1) })
  }
  const lines = [
    others.length ? t('echo.stackPicked', { stack: d.stack, others: others.join(', ') }) : t('echo.stack', { stack: d.stack }),
    ...d.commands.flatMap(c => {
      const body = d.scripts[c.id], weak = stack.code.weakFlags(`${c.argv.join(' ')}\n${body ?? ''}`), fromConfig = d.configWeak[c.id]
      return [
        t('echo.cmd', { id: c.id, argv: c.argv.join(' '), runner: c.runner }), ...(body !== undefined ? [t('echo.script', { body })] : []),
        ...(weak.length ? [t('echo.weak', { flags: weak.join(', ') })] : []), ...(fromConfig ? [t('echo.weakConfig', { file: fromConfig.file, flags: fromConfig.flags.join(', ') })] : []),
        results(c, body),
      ]
    }),
    t('echo.sources', { count: files.length, list: listed.join(', ') || '—' }),
    // the plugins the judge loads by name (Python: the venv's pytest11 entry points, GAP-R2-0.6-12)
    ...(d.runner.load.length ? [t(`echo.load.${d.stack}`, { names: d.runner.load.join(', ') })] : []),
    // the base interpreter's standard library, hashed only here (GAP-R2-0.6-7)
    ...d.bases.map(b => (b.hash === null ? t(`echo.baseLibNone.${d.stack}`, { path: b.path }) : t(`echo.baseLib.${d.stack}`, { path: b.path, hash: b.hash.slice(0, 8) }))),
    t('echo.sandbox', { pre: short(d.pre), post: short(d.post) }),
    ...JSON.stringify(d.block, null, 2).split('\n').map(l => `  ${l}`),
    ...(d.layers.length ? [t('echo.layers', { layers: d.layers.join('; ') })] : []),
    t('echo.tools', { tools: d.allowTools.join(', ') }),
    t('echo.mcp', { mcp: d.allowMcp.join(', ') || '—' }),
    t('echo.journal', { dir: d.journalDir }),
    t('echo.remote', { url: d.facts.url, branch: d.branch }),
    t('echo.git', { path: d.git || '—' }), t('echo.path', { path: d.path }),
    ...(d.pathDropped.length ? [t('echo.pathDropped', { entries: d.pathDropped.join(', ') })] : []),
    ...(d.cfgDrift.length ? [t('echo.cfgDrift', { files: [...d.cfgDrift.slice(0, 8), ...(d.cfgDrift.length > 8 ? [`+${d.cfgDrift.length - 8}`] : [])].join(', ') })] : []),
    ...(d.secretNames.length ? [t('echo.secrets', { names: d.secretNames.join(', ') })] : []),
    t('echo.caps', { pe: d.caps.plan.e, fe: d.caps.feature.e, fr: d.caps.feature.r, fd: d.caps.feature.d, ve: d.caps.verify.e, vd: d.caps.verify.d }),
    ...(d.writeYourself ? [t('echo.writeYourself')] : []),
  ]
  const { pre, post, ...fields } = d
  return {
    kind: 'setup', title: t('echo.setup', { address: h.address }), lines: viewText(lines.join('\n')).text.split('\n'),
    fields: { ...fields, preHash: pre === null ? 'absent' : hashOf(pre), postHash: hashOf(post) },
    files: { [stack.data.manifest]: d.pkgHash, [LOCAL_SETTINGS]: pre === null ? 'absent' : hashOf(pre), ...d.sources },
  }
}

/** A view main and the owner can read (§7), under the root's .snagon (ignored by git), redacted. */
export async function writeView(h: FlowHost, rel: string, text: string): Promise<string> {
  const root = (await staticsOf(h)).rootReal
  await dataDir(h.io, root)
  const path = `${root}/${rel}`
  await h.io.write(path, viewText(text).text)
  return path
}
/** The setup draft as a view (`.snagon/flow/setup-draft.md`). */
export const writeDraftView = (h: FlowHost, text: string): Promise<string> => writeView(h, DRAFT_VIEW, text)
