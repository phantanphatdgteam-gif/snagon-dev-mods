// Sandbox setup for flow (plan v7.1 §2.2, §5.1; key lists from the Claude Code sandboxing docs): the proposed block,
// the bytes of .claude/settings.local.json before and after, the refusals per settings layer, the effective sandbox
// (the merged `sandbox` object plus the permission rules that widen it), and the judge's sandbox-exec profile and argv.
// Pure functions: the caller reads settings, files and the environment.
import type { Stack } from '../flow/data/types'
import { COMMON_DENY_READ } from '../flow/data/common'
import { RUN_MARKER_VAR } from './flow-reap'

export type Layer = 'user' | 'project' | 'local' | 'flag' | 'policy'
export type Settings = Record<string, unknown>
export type SandboxBlock = {
  enabled: true; allowUnsandboxedCommands: false
  network: { allowedDomains: string[] }; filesystem: { allowWrite: string[]; denyRead: string[] }
}
/** why: loosens (a key that widens the sandbox), unknown (a key flow does not know), protected (write access reaching a
 * protected path), reopens (read access inside a hidden path), allHosts (a rule that opens every host). */
export type Refusal = { layer: Layer; key: string; value?: string; why: 'loosens' | 'unknown' | 'protected' | 'reopens' | 'allHosts' }
export type Effective = { sandbox: unknown; webFetchDomains: string[]; editAllow: string[]; additionalDirectories: string[] }

/** Paths under the root the judge may never write and the Edit tools may never touch (plan §2.3 PS, under the root). */
export const PROTECTED_DIRS = ['.git', '.claude', '.vscode', '.idea', '.snagon', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.config/git']
export const PROTECTED_FILES = ['.mcp.json', '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', 'docs/flow/verify.md']
/** Hidden from Bash and the judge besides the credential files (the stack's and COMMON_DENY_READ). */
export const FLOW_DENY_READ = ['~/.claude/projects', '~/.snagon/flow']
/** FLOW_DENY_READ with the transcripts where CLAUDE_CONFIG_DIR puts them (F41). */
export const flowDenyRead = (home: string, claudeDir: string): string[] =>
  claudeDir.replace(/\/+$/, '') === `${home}/.claude` ? [...FLOW_DENY_READ] : [`${claudeDir.replace(/\/+$/, '')}/projects`, '~/.snagon/flow']

// Each sandbox key the docs list, by what it does ("Repository settings under an admin-required sandbox" names the
// loosening ones). A key not listed here is refused until it is classified.
const LOOSEN_IF_ANY = new Set(['excludedCommands', 'ignoreViolations', 'network.allowUnixSockets', 'network.allowMachLookup'])
const LOOSEN_IF_SET = new Set(['network.httpProxyPort', 'network.socksProxyPort'])
const LOOSEN_IF_TRUE = new Set(['enableWeakerNestedSandbox', 'enableWeakerNetworkIsolation', 'network.allowAllUnixSockets', 'network.allowLocalBinding', 'allowAppleEvents', 'filesystem.disabled', 'allowUnsandboxedCommands'])
const NEUTRAL = new Set(['enabled', 'failIfUnavailable', 'autoAllowBashIfSandboxed', 'allowManagedDomainsOnly', 'allowManagedReadPathsOnly', 'network.deniedDomains', 'network.strictAllowlist', 'network.tlsTerminate', 'filesystem.denyWrite', 'filesystem.denyRead', 'credentials'])
const LEAF_OBJECTS = new Set(['credentials', 'network.tlsTerminate', 'ignoreViolations'])

const isObject = (v: unknown): v is Settings => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const unique = (xs: string[]): string[] => [...new Set(xs)]
const fold = (p: string): string => p.normalize('NFC').toLowerCase().replace(/\/+$/, '') // macOS paths ignore case
const overlaps = (a: string, b: string): boolean => { const x = fold(a), y = fold(b); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) }
/** The path up to the last `/` before the first glob character: `~/.c*` is `~/`, so a partial name never hides a match. */
const literalPrefix = (p: string): string => { const i = p.search(/[*?[{]/); if (i < 0) return p; const j = p.lastIndexOf('/', i); return j < 0 ? '' : p.slice(0, j + 1) }
/** Collapses `.`, `..` and repeated slashes, so `/a/../.claude` is `/.claude` and `/` stays `/`. */
const normalize = (p: string): string => { const out: string[] = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg) } return `/${out.join('/')}` }
/** The edit tools: a permission allow rule for any of them widens the sandbox's write set (docs: Permission rules). */
const EDIT_RULE = /^(Edit|Write|MultiEdit|NotebookEdit)(?:\((.*)\))?$/
const hasGlob = (p: string): boolean => /[*?[{]/.test(p)

/** Whether a root file name matches one of a stack's names: the same, or with `*` standing for any characters
 * (`requirements*.txt`). */
export const nameMatches = (pattern: string, name: string): boolean =>
  pattern.includes('*') ? new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name) : pattern === name

/** Lockfile managers found among the root's file names; a bare manifest means the stack's first manager (npm for
 * package.json). */
export function detectManagers(stack: Stack, rootFiles: readonly string[]): string[] {
  const found = stack.packageManagers.filter(m => m.lockfiles.some(f => rootFiles.some(n => nameMatches(f, n)))).map(m => m.id)
  const first = stack.packageManagers[0]?.id
  return found.length || !first || !rootFiles.includes(stack.manifest) ? found : [first]
}

/** What Bash and the judge may not read: the stack's credential files, COMMON_DENY_READ, flow's own, in this order (the
 * bytes 0.5.4 froze). The proposed block and the judge's fallback when the frozen sandbox lists none both use it. */
export const stackDenyRead = (stack: Stack, flowDeny: readonly string[] = FLOW_DENY_READ): string[] => unique([...stack.sandbox.denyRead, ...COMMON_DENY_READ, ...flowDeny])

export function proposeBlock(stack: Stack, managers: readonly string[], flowDeny: readonly string[] = FLOW_DENY_READ): SandboxBlock {
  const used = stack.packageManagers.filter(m => managers.includes(m.id))
  return {
    enabled: true, allowUnsandboxedCommands: false,
    network: { allowedDomains: unique(used.flatMap(m => m.domains)).sort() },
    filesystem: { allowWrite: unique(used.flatMap(m => m.cacheDirs)), denyRead: stackDenyRead(stack, flowDeny) },
  }
}

/** The local settings file after S2b: every other key kept, `sandbox` replaced. */
export function postText(pre: string | null, block: SandboxBlock): string {
  const parsed: unknown = JSON.parse(pre ?? '{}')
  if (!isObject(parsed)) throw new Error('settings.local.json is not a JSON object')
  return `${JSON.stringify({ ...parsed, sandbox: block }, null, 2)}\n`
}

function leaves(v: Settings, prefix = ''): Array<[string, unknown]> {
  return Object.entries(v).flatMap(([k, x]): Array<[string, unknown]> => {
    const path = prefix ? `${prefix}.${k}` : k
    return isObject(x) && !LEAF_OBJECTS.has(path) ? leaves(x, path) : [[path, x]]
  })
}

/** `resolve` maps an absolute path to its realpath (the longest existing prefix resolved), so a symbolic link counts. */
type Ctx = { home: string; root: string; protectedPaths: readonly string[]; denyRead: readonly string[]; resolve?: (p: string) => Promise<string> }
/** Where a layer's files live: a sandbox path's relative form and a permission rule's `/` form start here (docs). */
const baseOf = (layer: Layer, ctx: Ctx): string => (layer === 'project' || layer === 'local' ? ctx.root : `${ctx.home}/.claude`)
/**
 * A settings path as absolute candidates: `~/` is home and `//` absolute. A sandbox path: `/x` absolute, `x` from the
 * layer's base. A permission rule: `/x` from the layer's base (absolute counted too), `x` from the working directory (the
 * root). Each candidate is also resolved through symbolic links when the caller can.
 */
async function candidates(p: string, layer: Layer, ctx: Ctx, rule: boolean): Promise<string[]> {
  const lit = literalPrefix(p)
  const base = baseOf(layer, ctx)
  const lexical = lit === '~' || lit.startsWith('~/') ? [`${ctx.home}/${lit.slice(1)}`]
    : lit.startsWith('//') ? [lit]
    : lit.startsWith('/') ? (rule ? [`${base}/${lit}`, lit] : [lit])
    : rule ? [`${ctx.root}/${lit}`] : [`${base}/${lit}`]
  const plain = [...new Set(lexical.map(normalize))]
  const resolved = ctx.resolve ? await Promise.all(plain.map(c => ctx.resolve?.(c) ?? c)) : []
  return [...new Set([...plain, ...resolved])]
}
const reachesProtected = async (p: string, layer: Layer, ctx: Ctx, rule: boolean): Promise<boolean> => (await candidates(p, layer, ctx, rule)).some(c => ctx.protectedPaths.some(x => overlaps(c, x)))
/** With a resolver, protected and hidden paths count in both forms too (a linked ~/.claude is protected at its target). */
async function withTargets(ctx: Ctx): Promise<Ctx> {
  const home = (x: string): string => (x === '~' || x.startsWith('~/') ? normalize(`${ctx.home}/${x.slice(1)}`) : x)
  const both = async (xs: readonly string[]): Promise<string[]> => { const abs = xs.map(home); return [...new Set([...abs, ...(ctx.resolve ? await Promise.all(abs.map(x => ctx.resolve?.(x) ?? x)) : [])])] }
  return { ...ctx, protectedPaths: await both(ctx.protectedPaths), denyRead: await both(ctx.denyRead) }
}

/** Suffixes under which anyone can publish a host; `*.` before one of them opens every such host. */
const PUBLIC_SUFFIXES = ['co.uk', 'com.au', 'co.jp', 'com.br', 'github.io', 'gitlab.io', 'githubusercontent.com', 'amazonaws.com', 'cloudfront.net', 'core.windows.net', 'azurewebsites.net', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'r2.dev', 'fly.dev', 'onrender.com', 'trycloudflare.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'blogspot.com', 'ngrok.io', 'ngrok-free.app', 'googleapis.com', 'digitaloceanspaces.com', 'supabase.co', 'deno.dev']
/** A host entry wider than one domain or one `*.domain`: `*`, `**`, `*.*`, `a.*`, `*.github.io`, a CIDR range or a URL. */
const wideHost = (d: string): boolean => {
  const t = d.trim().toLowerCase().replace(/\.+$/, '') // a trailing dot names the same host
  if (t.startsWith('*.') && PUBLIC_SUFFIXES.some(s => t.slice(2) === s || t.slice(2).endsWith(`.${s}`))) return true
  return /\*/.test(t.replace(/^\*\.(?=[^*]*\.[^*]+$)/, '')) || t.includes('/')
}

async function sandboxKeyRefusals(layer: Layer, sandbox: Settings, ctx: Ctx): Promise<Refusal[]> {
  const out: Refusal[] = []
  for (const [key, value] of leaves(sandbox)) {
    const many = Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0
    if (LOOSEN_IF_ANY.has(key)) { if (many) out.push({ layer, key, why: 'loosens' }) }
    else if (LOOSEN_IF_SET.has(key)) { if (value !== undefined && value !== null) out.push({ layer, key, why: 'loosens' }) }
    else if (LOOSEN_IF_TRUE.has(key)) { if (value === true) out.push({ layer, key, why: 'loosens' }) }
    else if (key === 'network.allowedDomains') { for (const d of strings(value)) if (wideHost(d)) out.push({ layer, key, value: d, why: 'allHosts' }) }
    else if (key === 'filesystem.allowWrite') { for (const p of strings(value)) if (await reachesProtected(p, layer, ctx, false)) out.push({ layer, key, value: p, why: 'protected' }) }
    else if (key === 'filesystem.allowRead') {
      for (const p of strings(value)) if (hasGlob(p) || (await candidates(p, layer, ctx, false)).some(c => ctx.denyRead.some(d => overlaps(c, d)))) out.push({ layer, key, value: p, why: 'reopens' })
    } else if (!NEUTRAL.has(key)) out.push({ layer, key, why: 'unknown' })
  }
  return out
}

/** The domain a WebFetch allow rule opens to sandboxed commands: a bare rule counts as every host. */
const webFetchDomain = (rule: string): string | null => { const m = /^WebFetch(?:\((?:domain:)?(.*)\))?$/.exec(rule.trim()); return m ? (m[1] ?? '*') : null }

async function permissionRefusals(layer: Layer, permissions: Settings, ctx: Ctx): Promise<Refusal[]> {
  const out: Refusal[] = []
  for (const rule of strings(permissions.allow)) {
    const edit = EDIT_RULE.exec(rule.trim())
    if (edit && (edit[2] === undefined || (await reachesProtected(edit[2], layer, ctx, true)))) out.push({ layer, key: 'permissions.allow', value: rule, why: 'protected' })
    const host = webFetchDomain(rule)
    if (host !== null && wideHost(host)) out.push({ layer, key: 'permissions.allow', value: rule, why: 'allHosts' })
  }
  for (const dir of strings(permissions.additionalDirectories)) if (await reachesProtected(dir, layer, ctx, true)) out.push({ layer, key: 'permissions.additionalDirectories', value: dir, why: 'protected' })
  return out
}

/**
 * What S1 refuses, per settings layer. The local layer's `sandbox` is replaced by the approved block, so only its
 * permission rules count. `ctx.protectedPaths` are absolute (~/.claude, ~/.snagon, every plugin root).
 */
export async function sandboxRefusals(layers: Partial<Record<Layer, Settings>>, given: Ctx): Promise<Refusal[]> {
  const ctx = await withTargets(given)
  const out: Refusal[] = []
  for (const [layer, s] of Object.entries(layers) as Array<[Layer, Settings]>) {
    if (layer !== 'local' && isObject(s.sandbox)) out.push(...(await sandboxKeyRefusals(layer, s.sandbox, ctx)))
    if (isObject(s.permissions)) out.push(...(await permissionRefusals(layer, s.permissions, ctx)))
  }
  return out
}

/** The sandbox as it acts: the merged object plus the permission rules that widen it (docs: Permission rules). */
export function effectiveOf(merged: Settings): Effective {
  const p = isObject(merged.permissions) ? merged.permissions : {}
  const allow = strings(p.allow).map(r => r.trim())
  return {
    sandbox: merged.sandbox ?? null,
    webFetchDomains: unique(allow.flatMap(r => webFetchDomain(r) ?? [])).sort(),
    editAllow: unique(allow.filter(r => EDIT_RULE.test(r))).sort(),
    additionalDirectories: unique(strings(p.additionalDirectories)).sort(),
  }
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/** After the S2b write (and at every session start): the names of what differs; empty means the sandbox is as approved. */
export function verifyAfterWrite(o: { local: unknown; merged: Settings; approved: Effective; post: string }): string[] {
  const out: string[] = []
  if (stable(o.local) !== stable(JSON.parse(o.post))) out.push('local')
  const sb = isObject(o.merged.sandbox) ? o.merged.sandbox : {}
  if (sb.enabled !== true) out.push('sandbox.enabled')
  if (sb.allowUnsandboxedCommands !== false) out.push('sandbox.allowUnsandboxedCommands')
  const now = effectiveOf(o.merged)
  for (const k of ['sandbox', 'webFetchDomains', 'editAllow', 'additionalDirectories'] as const) if (stable(now[k]) !== stable(o.approved[k])) out.push(k)
  return out
}

/** Loaded plugin roots (realpaths) the agent could write: inside the project, a writable path or a temp folder. */
export function pluginRootRefusals(roots: readonly string[], ctx: { root: string; allowWrite: readonly string[]; tempDirs: readonly string[] }): Array<{ root: string }> {
  const under = (p: string, d: string): boolean => fold(p) === fold(d) || fold(p).startsWith(`${fold(d)}/`)
  return roots.filter(r => under(r, ctx.root) || under(ctx.root, r) || [...ctx.allowWrite, ...ctx.tempDirs].some(d => under(r, d))).map(root => ({ root }))
}

const sbString = (p: string): string => {
  if (!p.startsWith('/') || /[\n\r\0"]/.test(p)) throw new Error(`judge profile: not an absolute single-line path without quotes: ${JSON.stringify(p)}`)
  return `"${p.replace(/\\/g, '\\\\')}"`
}
/** A regex for `root/<name>` in any letter case (APFS ignores case, the sandbox does not): `.VSCODE` is `.vscode`. */
const anyCase = (root: string, name: string): string => {
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\/]/g, c => `\\${c}`)
  const ci = [...name].map(c => (c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : esc(c))).join('')
  return `(regex #"^${esc(root)}/${ci}(/|$)")`
}
/** Mach services the judge may look up: Claude Code's own sandbox base list (2.1.296) without LaunchServices. */
export const JUDGE_MACH_SERVICES = [
  'com.apple.audio.systemsoundserver', 'com.apple.distributed_notifications@Uv3', 'com.apple.FontObjectsServer', 'com.apple.fonts',
  'com.apple.logd', 'com.apple.PowerManagement.control', 'com.apple.system.logger', 'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.bsd.dirhelper', 'com.apple.securityd.xpc',
]
/** The devices every judged run may write and ioctl. */
const DEVICES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper']
type JudgeOptions = { root: string; tmpDir: string; commonDir: string; denyRead: readonly string[]; loopbackPorts: readonly number[] }
/**
 * The judge's sandbox-exec profile (paths are realpaths). It runs code the agent wrote, outside Claude Code's sandbox,
 * so every channel to other processes is closed: mach lookups beyond a base list, LaunchServices and Apple Events, job
 * creation, terminals (a TIOCSTI ioctl could type into the owner's session), signals and process info outside it.
 * A test-runner port opens loopback only (F4).
 */
export function judgeProfile(o: JudgeOptions): string {
  return `${['(version 1)', '(allow default)', ...judgeRules(o)].join('\n')}\n`
}
/** The judge's own rules, after the profile's default line: the live profile and the strict trial share them. */
function judgeRules(o: JudgeOptions): string[] {
  const sub = (p: string): string => `(subpath ${sbString(p)})`
  const lit = (p: string): string => `(literal ${sbString(p)})`
  const devices = DEVICES.map(lit).join(' ')
  const ports = o.loopbackPorts.filter(p => Number.isInteger(p) && p > 0 && p < 65536)
  return [
    '(deny file-write*)',
    `(allow file-write* ${sub(o.root)} ${sub(o.tmpDir)} ${devices})`,
    `(deny file-write* ${[sub(o.commonDir), ...PROTECTED_DIRS.map(d => sub(`${o.root}/${d}`)), ...PROTECTED_FILES.map(f => lit(`${o.root}/${f}`))].join(' ')})`,
    `(deny file-write* ${[...PROTECTED_DIRS, ...PROTECTED_FILES].map(n => anyCase(o.root, n)).join(' ')})`,
    ...(o.denyRead.length ? [`(deny file-read* ${o.denyRead.map(sub).join(' ')})`] : []),
    '(deny file-read* file-write* (regex #"^/dev/(tty|pty|ptmx|ttys|cu\\.|console)"))',
    // links allowed only within the tree and the run folder (the project's own os.link, e.g. 535 ingest); macOS already
    // refuses a link to a file the run may not write, so protected paths stay unreachable (NK-03, Q-3a step 7)
    `(deny file-link) (allow file-link ${sub(o.root)} ${sub(o.tmpDir)})`,
    `(deny file-ioctl) (allow file-ioctl ${devices})`,
    `(deny mach-lookup) (allow mach-lookup ${JUDGE_MACH_SERVICES.map(n => `(global-name "${n}")`).join(' ')})`,
    '(deny mach-register)', '(deny lsopen)', '(deny appleevent-send)', '(deny job-creation)',
    '(deny signal) (allow signal (target same-sandbox))',
    '(deny process-info*) (allow process-info* (target same-sandbox))',
    '(deny network*)',
    ...ports.flatMap(p => [`(allow network-outbound (remote ip "localhost:${p}"))`, `(allow network-bind network-inbound (local ip "localhost:${p}"))`]),
  ]
}

/** Where the strict trial's base comes from (spike P6, run at step 11): Claude Code's sandbox runtime, the fixed rules
 * of its macOS profile with no option on (no weaker network isolation, no Apple Events, no extra mach names, no pty). */
export const STRICT_BASE_SOURCE = '@anthropic-ai/sandbox-runtime 0.0.80 (npm, Apache-2.0), dist/sandbox/macos-sandbox-utils.js generateSandboxProfile'
const STRICT_SYSCTLS = [
  'hw.activecpu', 'hw.busfrequency_compat', 'hw.byteorder', 'hw.cacheconfig', 'hw.cachelinesize_compat', 'hw.cpufamily', 'hw.cpufrequency', 'hw.cpufrequency_compat',
  'hw.cputype', 'hw.l1dcachesize_compat', 'hw.l1icachesize_compat', 'hw.l2cachesize_compat', 'hw.l3cachesize_compat', 'hw.logicalcpu', 'hw.logicalcpu_max', 'hw.machine',
  'hw.memsize', 'hw.ncpu', 'hw.nperflevels', 'hw.packages', 'hw.pagesize_compat', 'hw.pagesize', 'hw.physicalcpu', 'hw.physicalcpu_max', 'hw.tbfrequency_compat',
  'hw.vectorunit', 'kern.argmax', 'kern.bootargs', 'kern.hostname', 'kern.maxfiles', 'kern.maxfilesperproc', 'kern.maxproc', 'kern.ngroups', 'kern.osproductversion',
  'kern.osrelease', 'kern.ostype', 'kern.osvariant_status', 'kern.osversion', 'kern.secure_kernel', 'kern.tcsm_available', 'kern.tcsm_enable', 'kern.usrstack64',
  'kern.version', 'kern.willshutdown', 'machdep.cpu.brand_string', 'machdep.ptrauth_enabled', 'security.mac.lockdown_mode_state', 'sysctl.proc_cputype', 'vm.loadavg',
]
const STRICT_SYSCTL_PREFIXES = ['hw.optional.arm', 'hw.optional.arm.', 'hw.optional.armv8_', 'hw.perflevel', 'kern.proc.all', 'kern.proc.pgrp.', 'kern.proc.pid.', 'machdep.cpu.', 'net.routetable.']
/**
 * The base as published (STRICT_BASE_SOURCE), one rule per line, without what the live judge closes: the LaunchServices
 * names (com.apple.lsd.mapdb, com.apple.coreservices.launchservicesd; its mach list is otherwise JUDGE_MACH_SERVICES),
 * com.apple.SecurityServer and the /dev/tty ioctl. For one operation Seatbelt lets a rule with a filter win over a rule
 * without one, whatever their order (spike P6, step 11), so the judge's bare `(deny mach-lookup)` and `(deny file-ioctl)`
 * after the base could not close them.
 */
const STRICT_BASE = [
  '(allow process-exec)', '(allow process-fork)', '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))', '(allow mach-priv-task-port (target same-sandbox))',
  '(allow user-preference-read)',
  `(allow mach-lookup ${JUDGE_MACH_SERVICES.map(n => `(global-name "${n}")`).join(' ')})`,
  '(allow ipc-posix-shm)', '(allow ipc-posix-sem)',
  '(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient") (iokit-user-client-class "IOSurfaceSendRight"))',
  '(allow iokit-get-properties)',
  '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
  `(allow sysctl-read ${[...STRICT_SYSCTLS.map(n => `(sysctl-name "${n}")`), ...STRICT_SYSCTL_PREFIXES.map(n => `(sysctl-name-prefix "${n}")`)].join(' ')})`,
  '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
  '(allow distributed-notification-post)',
  ...DEVICES.map(d => `(allow file-ioctl (literal "${d}"))`),
  '(allow file-ioctl file-read-data file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
]
/**
 * F28 trial (R2 plan §4.6), inactive: flow never uses it in R2. The judge's profile built the strict way, like Claude
 * Code's own: `(deny default)`, the sandbox runtime's fixed rules, its read rule for a deny list (`(allow file-read*)`, the
 * judge's denyRead after it), then the live judge's rules as they are, so nothing the live judge refuses is allowed.
 * Only `(deny default)` carries `tag`, so the denials the system log holds under it are what the strict way takes away
 * beyond the live judge (tests/judge-strict.check.mjs lists them for AC-F28-1).
 */
// ASSUMPTION(GAP-R2-0.6-102): the base without the channels the live judge closes, then the live rules; the runtime's
// directory metadata allow and move blocking stay out (they serve its allowWithinDeny; the judge writes only in the root
// and the run folder).
export function judgeProfileStrict(o: JudgeOptions & { tag: string }): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.tag)) throw new Error(`judge profile: the tag must be 1 to 64 letters, digits, - or _ (got ${JSON.stringify(o.tag.slice(0, 80))})`)
  return `${['(version 1)', `(deny default (with message "${o.tag}"))`, ...STRICT_BASE, '(allow file-read*)', ...judgeRules(o)].join('\n')}\n`
}

/** The variables the core sets in the judge: a stack's line may not set one again (with `env -i` the later one wins, so
 * a stack could replace the PATH frozen at S2). A stack line is `NAME=value`. */
const CORE_ENV = new RegExp(`^(?:PATH|HOME|TMPDIR|LANG|TZ|CI|${RUN_MARKER_VAR}|GIT_[A-Za-z0-9_]*)=`)
/**
 * The judge's command line: an empty environment with only these variables, then sandbox-exec (plan §5.1). `stack`:
 * the lines the stack's tools need (its code's judgeEnv: for TypeScript, no user or global npm config). Throws on a
 * stack line that is malformed or sets a core variable; judgedRun turns that into couldNotRun.
 */
export function judgeArgv(profile: string, argv: readonly string[], env: { PATH: string; HOME: string; TMPDIR: string; LANG?: string; TZ?: string; marker?: string; stack: readonly string[] }): string[] {
  const bad = env.stack.find(l => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l) || CORE_ENV.test(l))
  if (bad !== undefined) throw new Error(`judge environment: the stack may not set "${bad.split('=')[0]?.slice(0, 40) ?? ''}"`)
  const vars = [`PATH=${env.PATH}`, `HOME=${env.HOME}`, `TMPDIR=${env.TMPDIR}`, ...(env.LANG ? [`LANG=${env.LANG}`] : []), ...(env.TZ ? [`TZ=${env.TZ}`] : []), ...(env.marker ? [`${RUN_MARKER_VAR}=${env.marker}`] : [])]
  const fixed = ['CI=1', ...env.stack, 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0']
  return ['/usr/bin/env', '-i', ...vars, ...fixed, '/usr/bin/sandbox-exec', '-p', profile, ...argv]
}

/** The one Bash command main runs to show the sandbox is on (§2.2): the sandboxing docs' own probe. With `--noproxy`
 * the command has no route around the sandbox proxy, so inside the sandbox the name does not resolve (curl exit 6), in
 * every permission mode and with no dialog; a host outside the allowed domains sent through the proxy would instead
 * make the engine ask the owner to allow it in acceptEdits mode, or hold it until `-m` ran out (dry run, GAP-step13-4). */
/** The absolute path and `-q` first: no `curl` shim on PATH and no curlrc (`doh-url`, `dns-servers`) can shape the
 * answer (security review of step 13, SEC13-1). */
export const PROBE_COMMAND = "/usr/bin/curl -q --noproxy '*' -s -S -m 5 -o /dev/null -w %{http_code} https://example.com"
/** The control the mod runs itself, outside Claude's sandbox: the same request by the same direct route (`--noproxy`),
 * so main's refused probe counts only when that route works from this machine. A machine that gets out only through a
 * proxy cannot pass the probe and blocks as inconclusive, never as "on" (SEC13-1, S13-7, S13-11). */
export const CONTROL_ARGV = ['/usr/bin/curl', '-q', '--noproxy', '*', '-s', '-S', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com']
/** The sandbox-active probe from main's Bash was refused by the sandbox: no route out (exit 6, "Could not resolve
 * host"), or the proxy's own refusal where the allowlist is strict (exit 56, a deny line). */
export const probeShowsSandbox = (exitCode: number, text: string): boolean => exitCode === 6 || exitCode === 56 || /Could not resolve host|deny network-outbound|sandbox_violations/i.test(text)
