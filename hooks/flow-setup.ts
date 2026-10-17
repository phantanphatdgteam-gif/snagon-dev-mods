// S1 (plan v7.1 §5.1, §2.2): what /flow-setup proposes. It finds the stack and its commands, the sandbox block for
// .claude/settings.local.json, the remote and branch a release goes to, and every reason flow cannot start here, all at
// once; then the echo the owner approves (its hash binds what S2 freezes) and the redacted draft view.
import { dataDir, hashOf } from './session'
import { git, gitPaths, pushFacts, urlProblem, type GitPaths, type PushFacts } from './flow-git'
import { commandSources, scriptNames } from './flow-sources'
import { authEnvNames, detectManagers, effectiveOf, flowDenyRead, npmrcHasAuth, pluginRootRefusals, postText, proposeBlock, sandboxRefusals, type Layer, type SandboxBlock, type Settings } from './flow-sandbox'
import { screenMcpRefusals } from './flow-guard'
import { viewText } from './flow-pack'
import { findSecrets } from './secrets'
import { branchOf, pluginRoots, realOf, staticsOf, type FlowHost } from './flow-host'
import type { EchoContent } from './flow-owner'
import type { FlowCommand } from './flow-state'
import { PROVISIONAL_USD } from './flow-turn'
import { TYPESCRIPT } from '../flow/data/stacks'
import { ROUTING } from '../flow/data/routing'
import { CAPS } from '../flow/data/phases'
import { fill } from '../flow/data/templates'
import type { CapScope, Caps } from '../flow/data/types'

export type SetupArgs = { overrides: Readonly<Record<string, string>>; tools: readonly string[]; mcp: readonly string[] }
/** Everything S2 freezes, as S1 found it. `sources`: the command sources' hashes by name (flow-sources.ts). */
export type SetupDraft = {
  root: string; stack: string; commands: FlowCommand[]; scripts: Record<string, string>; managers: string[]; pkgHash: string
  sources: Record<string, string>; block: SandboxBlock; pre: string | null; post: string; layers: string[]
  remote: string; branch: string; facts: PushFacts; allowTools: string[]; allowMcp: string[]; journalDir: string
  secretNames: string[]; writeYourself: boolean; pluginProject: boolean; caps: Record<CapScope, Caps>; sessionCap: number
}
export type Detected = { ok: true; draft: SetupDraft } | { ok: false; refusals: string[] }
type Say = (key: string, vars?: Readonly<Record<string, string | number>>) => void

export const LOCAL_SETTINGS = '.claude/settings.local.json'
export const DRAFT_VIEW = '.snagon/flow/setup-draft.md'
const LAYERS: readonly Layer[] = ['user', 'project', 'local', 'flag', 'policy']
const RUNNERS = ['vitest', 'jest', 'tsc', 'eslint']
/** The mod's own data folders: never the journal (owner decision 2026-10-17). */
const JOURNAL_DATA = ['.snagon', '.snagon/flow', '.snagon/handoff']
/** Environment names that look like a secret; only names are ever read (F19). */
const SECRET_NAME = /TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL/i
/** What makes a failing check pass, in a command line or a script body. */
const WEAK = [/--pass-?with-?no-?tests(?![\w-])/i, /\|\|\s*(?:true|:|exit\s+0)(?![\w-])/, /;\s*exit\s+0(?![\w-])/, /--no-error-on-unmatched-pattern(?![\w-])/]
const SHOWN_SOURCES = 20

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const base = (x: string): string => x.slice(x.lastIndexOf('/') + 1)
const unique = (xs: readonly string[]): string[] => [...new Set(xs)]
const short = (text: string | null): string => (text === null ? 'absent' : hashOf(text).slice(0, 8))

/** The runner a command line or script body names (`npx vitest run` is vitest), else its first program. */
export const runnerOf = (tokens: readonly string[]): string => {
  const names = tokens.map(base).filter(n => n && !n.includes('='))
  return names.find(n => RUNNERS.includes(n)) ?? names.find(n => n !== 'npx') ?? ''
}
/** The flags in a command line or script body that make a failing check pass. */
export const weakFlags = (text: string): string[] => WEAK.flatMap(re => { const m = re.exec(text); return m ? [m[0].replace(/\s+/g, ' ')] : [] })

async function readOrNull(h: FlowHost, path: string): Promise<string | null> {
  try { return await h.io.read(path) } catch (err) { if (await h.io.exists(path)) throw err; return null }
}
const expandHome = (h: FlowHost, p: string): string => (p === '~' || p.startsWith('~/') ? `${h.home}${p.slice(1)}` : p)

/** The stack's commands: a package script per id (`npm test`, `pnpm run lint`), an override's argv (split on spaces, no
 * shell quoting), or none (`<id>=none` drops it, GAP-step10-11). */
function commandsOf(pkg: Record<string, unknown> | null, pm: string, overrides: SetupArgs['overrides']): { commands: FlowCommand[]; scripts: Record<string, string> } {
  const scripts = isObj(pkg?.scripts) ? pkg.scripts : {}
  const commands: FlowCommand[] = [], bodies: Record<string, string> = {}
  for (const [id, names] of Object.entries(TYPESCRIPT.scripts)) {
    const over = overrides[id]
    if (over === 'none') continue
    const name = names.find(n => typeof scripts[n] === 'string')
    const argv = over !== undefined ? over.split(/\s+/).filter(Boolean) : name ? (name === 'test' && pm !== 'bun' ? [pm, 'test'] : [pm, 'run', name]) : []
    if (!argv.length) continue
    const run = scriptNames([argv])[0], body = run !== undefined ? scripts[run] : undefined
    if (typeof body === 'string') bodies[id] = body
    commands.push({ id, argv, runner: runnerOf(typeof body === 'string' ? body.split(/\s+/) : argv), mode: 'must-pass' })
  }
  return { commands, scripts: bodies }
}

async function projectPart(h: FlowHost, root: string, args: SetupArgs, say: Say) {
  const has = (f: string): Promise<boolean> => h.io.exists(`${root}/${f}`)
  if (!(await Promise.all(TYPESCRIPT.detect.files.map(has))).some(Boolean)) say('setup.noStack')
  const pkgText = await readOrNull(h, `${root}/package.json`)
  const pkg: unknown = pkgText === null ? null : JSON.parse(pkgText)
  const names = [...new Set([...TYPESCRIPT.packageManagers.flatMap(m => m.lockfiles), 'package.json'])]
  const managers = detectManagers(TYPESCRIPT, (await Promise.all(names.map(async n => ((await has(n)) ? n : '')))).filter(Boolean))
  const { commands, scripts } = commandsOf(isObj(pkg) ? pkg : null, managers[0] ?? 'npm', args.overrides)
  if (!commands.some(c => c.id === 'test')) say('setup.noTest')
  for (const c of commands) {
    // The judge runs with this PATH (frozen at S2), so the program must be found through it.
    const found = await h.io.run(['/bin/sh', '-c', 'command -v "$1"', 'sh', c.argv[0] ?? ''], { env: { PATH: h.env.PATH } })
    if (found.exitCode !== 0) say('setup.argv', { id: c.id, argv: c.argv.join(' ') })
  }
  return { managers, commands, scripts, pkgHash: pkgText === null ? 'absent' : hashOf(pkgText) }
}

/** Names only: the values never leave the child (sed keeps what stands before the first `=`). */
async function envNames(h: FlowHost): Promise<string[]> {
  const r = await h.io.run(['/bin/sh', '-c', "env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'"])
  if (r.exitCode !== 0) throw new Error(`flow: the environment names could not be read (${r.stderr.trim().slice(0, 200)})`)
  return unique(r.stdout.split('\n').filter(n => /^[A-Za-z_]\w*$/.test(n)))
}
async function envPart(h: FlowHost, root: string, say: Say): Promise<{ secretNames: string[] }> {
  const names = await envNames(h), auth = authEnvNames(names, TYPESCRIPT)
  if (auth.length) say('setup.authEnv', { names: auth.join(', ') })
  for (const file of ['.npmrc', '.yarnrc.yml']) {
    const text = await readOrNull(h, `${root}/${file}`)
    if (text !== null && npmrcHasAuth(text)) say('setup.npmrc', { file })
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
async function sandboxPart(h: FlowHost, root: string, managers: readonly string[], roots: readonly string[], say: Say) {
  const block = proposeBlock(TYPESCRIPT, managers, flowDenyRead(h.home, h.claudeDir))
  const pre = await readOrNull(h, `${root}/${LOCAL_SETTINGS}`)
  let post = ''
  try { post = postText(pre, block) } catch { say('setup.localJson') }
  const layers = Object.fromEntries(await Promise.all(LAYERS.map(async l => [l, await h.settings(l)] as const))) as Record<Layer, Settings>
  const ctx = { home: h.home, root, protectedPaths: [h.claudeDir, `${h.home}/.snagon`, ...roots], denyRead: block.filesystem.denyRead, resolve: (x: string) => realOf(h, x) }
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

/** S1: everything /flow-setup proposes, or every reason flow cannot start here, in the owner's words. */
export async function detectSetup(h: FlowHost, args: SetupArgs): Promise<Detected> {
  const why: string[] = []
  const say: Say = (key, vars = {}) => { why.push(fill(h.language, key, vars)) }
  const s = await staticsOf(h), root = s.rootReal
  let p: GitPaths
  try { p = await gitPaths(h.io, root) } catch { return { ok: false, refusals: [fill(h.language, 'setup.noGit', {})] } }
  const project = await projectPart(h, root, args, say)
  const env = await envPart(h, root, say)
  const release = await remotePart(h, p, say)
  const sandbox = await sandboxPart(h, root, project.managers, await pluginRoots(h), say)
  const allowMcp = unique(args.mcp)
  const screen = screenMcpRefusals(allowMcp)
  if (screen.length) say('setup.screen', { names: screen.join(', ') })
  await journalPart(h, root, s.caseFold, say)
  if (why.length || !release.facts) return { ok: false, refusals: why }
  const sources = (await commandSources(h.io, p, project.commands.map(c => c.argv))).hashes
  return {
    ok: true,
    draft: {
      root, stack: TYPESCRIPT.id, ...project, sources, ...sandbox, remote: release.remote, branch: release.branch, facts: release.facts,
      allowTools: unique([...ROUTING.allowTools, ...args.tools]), allowMcp, journalDir: h.journalDir, ...env,
      writeYourself: findSecrets(sandbox.post).length > 0, pluginProject: await h.io.exists(`${root}/.claude-plugin/plugin.json`),
      caps: { ...CAPS }, sessionCap: PROVISIONAL_USD.session,
    },
  }
}

/** The setup echo (§2.5): every line the pane shows, the fields S2 freezes and the hash of every file it names. Lines
 * pass through the view redaction, so a secret in a script body never reaches the pane or the session state. */
export function setupEcho(h: Pick<FlowHost, 'language' | 'address'>, d: SetupDraft): EchoContent {
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => fill(h.language, key, vars)
  const files = Object.keys(d.sources).filter(k => !k.includes(':'))
  const listed = [...files.slice(0, SHOWN_SOURCES), ...(files.length > SHOWN_SOURCES ? [`+${files.length - SHOWN_SOURCES}`] : []), ...(d.sources['closure:truncated'] ? ['…'] : [])]
  const lines = [
    ...d.commands.flatMap(c => {
      const body = d.scripts[c.id], weak = weakFlags(`${c.argv.join(' ')}\n${body ?? ''}`)
      return [t('echo.cmd', { id: c.id, argv: c.argv.join(' '), runner: c.runner }), ...(body !== undefined ? [t('echo.script', { body })] : []), ...(weak.length ? [t('echo.weak', { flags: weak.join(', ') })] : [])]
    }),
    t('echo.sources', { count: files.length, list: listed.join(', ') || '—' }),
    t('echo.sandbox', { pre: short(d.pre), post: short(d.post) }),
    ...JSON.stringify(d.block, null, 2).split('\n').map(l => `  ${l}`),
    ...(d.layers.length ? [t('echo.layers', { layers: d.layers.join('; ') })] : []),
    t('echo.tools', { tools: d.allowTools.join(', ') }),
    t('echo.mcp', { mcp: d.allowMcp.join(', ') || '—' }),
    t('echo.journal', { dir: d.journalDir }),
    t('echo.remote', { url: d.facts.url, branch: d.branch }),
    ...(d.secretNames.length ? [t('echo.secrets', { names: d.secretNames.join(', ') })] : []),
    t('echo.caps', { pe: d.caps.plan.e, fe: d.caps.feature.e, fr: d.caps.feature.r, fd: d.caps.feature.d, ve: d.caps.verify.e, vd: d.caps.verify.d, cap: d.sessionCap }),
    ...(d.writeYourself ? [t('echo.writeYourself')] : []),
  ]
  const { pre, post, ...fields } = d
  return {
    kind: 'setup', title: t('echo.setup', { address: h.address }), lines: viewText(lines.join('\n')).text.split('\n'),
    fields: { ...fields, preHash: pre === null ? 'absent' : hashOf(pre), postHash: hashOf(post) },
    files: { 'package.json': d.pkgHash, [LOCAL_SETTINGS]: pre === null ? 'absent' : hashOf(pre), ...d.sources },
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
