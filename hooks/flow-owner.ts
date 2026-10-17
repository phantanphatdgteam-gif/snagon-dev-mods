// Owner commands (plan v7.1 §2.5, §3): who may run them (origin), what they parse to, echoes bound to the hash of what
// the pane showed, approvals checked against that hash and the current draft, and the release code (a module variable,
// shown only in the pane, single use). Pure apart from the pane and the code; the command.run wiring is step 10.
import { fill } from '../flow/data/templates'
import type { Language } from '../flow/data/types'
import type { Approval } from './flow-state'
import { sha256 } from './flow-review'

export const OWNER_COMMANDS = ['flow-setup', 'flow-plan', 'flow-build', 'flow-verify', 'flow-ship', 'flow-approve', 'flow-decide', 'flow-retry', 'flow-waive', 'flow-reject', 'flow-off', 'flow-status'] as const
export type OwnerName = (typeof OWNER_COMMANDS)[number]
export type EchoKind = Approval['kind']
export type Origin = { readonly kind: string }
export type ApproveCmd = { name: 'flow-approve'; kind: EchoKind; hash8: string; code?: string }
export type OwnerCmd =
  | { name: 'flow-setup'; overrides: Record<string, string>; tools: string[]; mcp: string[] }
  | { name: 'flow-build' | 'flow-verify' | 'flow-ship' | 'flow-status' }
  | { name: 'flow-plan'; intent?: string }
  | { name: 'flow-off'; id?: string }
  | ApproveCmd
  | { name: 'flow-decide'; id: string; choice: 'fix' | 'reject' | 'followup' }
  | { name: 'flow-retry'; scope: string }
  | { name: 'flow-waive'; target: string; reason: string }
  | { name: 'flow-reject'; what: 'plan' }

export const USAGE: Readonly<Record<OwnerName, string>> = {
  'flow-setup': '/flow-setup [test|lint|typecheck|build="<argv>"] [tools=+<Tool>] [mcp=+<server>]',
  'flow-plan': '/flow-plan [<what to build>]', 'flow-build': '/flow-build', 'flow-verify': '/flow-verify', 'flow-ship': '/flow-ship', 'flow-off': '/flow-off [<id8>]', 'flow-status': '/flow-status',
  'flow-approve': '/flow-approve setup|baseline|plan|waive <hash8> · /flow-approve release <hash8> <code>',
  'flow-decide': '/flow-decide <X-n> fix|reject|followup',
  'flow-retry': '/flow-retry plan|F-NN|verify|check|cost',
  'flow-waive': '/flow-waive check:<cmdId>|FL-n|J-n <reason>',
  'flow-reject': '/flow-reject plan',
}
const HASH8 = /^[0-9a-f]{8}$/, CODE = /^[A-Za-z0-9]{6}$/, CMD_ID = /^(?:test|lint|typecheck|build)$/
/** Words of the arguments; `key="a b"` keeps its quoted value as one word. */
const words = (args: string): string[] => [...args.matchAll(/([^\s=]+=)?"([^"]*)"|\S+/g)].map(m => (m[2] !== undefined ? `${m[1] ?? ''}${m[2]}` : m[0]))

/** A typed owner command, or the usage line of a malformed one. */
export function parseOwner(command: string, args: string): OwnerCmd | { error: string } {
  if (!(OWNER_COMMANDS as readonly string[]).includes(command)) return { error: `unknown command ${command}` }
  const name = command as OwnerName, w = words(args), bad = { error: USAGE[name] }
  switch (name) {
    case 'flow-approve': {
      const [kind, hash8, code, ...rest] = w
      if (rest.length || !hash8 || !HASH8.test(hash8)) return bad
      if (kind === 'release') return code && CODE.test(code) ? { name, kind, hash8, code: code.toUpperCase() } : bad
      return (kind === 'setup' || kind === 'baseline' || kind === 'plan' || kind === 'waive') && code === undefined ? { name, kind, hash8 } : bad
    }
    case 'flow-decide': return w.length === 2 && /^[A-Z]+-\d+$/.test(w[0] ?? '') && /^(?:fix|reject|followup)$/.test(w[1] ?? '') ? { name, id: w[0] ?? '', choice: w[1] as 'fix' | 'reject' | 'followup' } : bad
    case 'flow-retry': return w.length === 1 && /^(?:plan|verify|check|cost|F-\d{2})$/.test(w[0] ?? '') ? { name, scope: w[0] ?? '' } : bad
    case 'flow-waive': {
      const m = /^\s*(check:[\w-]+|FL-\d+|J-\d+)\s+(\S[\s\S]*?)\s*$/.exec(args)
      return m ? { name, target: m[1] ?? '', reason: m[2] ?? '' } : bad
    }
    case 'flow-reject': return w.length === 1 && w[0] === 'plan' ? { name, what: 'plan' } : bad
    case 'flow-plan': return args.trim() ? { name, intent: args.trim() } : { name }
    case 'flow-off': return w.length === 0 ? { name } : w.length === 1 && HASH8.test(w[0] ?? '') ? { name, id: w[0] ?? '' } : bad
    case 'flow-setup': {
      const out = { name, overrides: {} as Record<string, string>, tools: [] as string[], mcp: [] as string[] }
      for (const word of w) {
        const [key = '', value = ''] = [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]
        if (!word.includes('=') || !value) return bad
        if (key === 'tools' || key === 'mcp') { if (!/^\+[\w.:-]+$/.test(value)) return bad; out[key].push(value.slice(1)) }
        else if (CMD_ID.test(key)) out.overrides[key] = value
        else return bad
      }
      return out
    }
    default: return w.length ? bad : { name }
  }
}

const OWNER_ORIGINS = new Set(['composer', 'bridge'])
/** Owner commands come from the owner's Enter at the prompt, or the bridge; a release approval only from the prompt. */
export const originOk = (cmd: OwnerCmd, origin: Origin): boolean =>
  OWNER_ORIGINS.has(origin.kind) && !(cmd.name === 'flow-approve' && cmd.kind === 'release' && origin.kind !== 'composer')

/** JSON with object keys sorted, so the same content always hashes the same. Only plain JSON is accepted: a Set, Map,
 * Date or class instance, undefined, a non-finite number, a function or a bigint would collapse into one string. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null))
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  throw new Error(`flow: an echo value is not plain JSON (${typeof v === 'object' ? Object.prototype.toString.call(v) : typeof v})`)
}
export type EchoContent = { kind: EchoKind; title: string; lines: readonly string[]; fields: unknown; files: Readonly<Record<string, string>> }
/** Control and format characters (ANSI escapes, bidi overrides, tag characters) made visible as `\u{…}`, so agent-written
 * text (a commit subject, a script body) can neither hide nor reorder what the pane shows, nor get the pane refused. */
export const visible = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, c => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`)
/** §2.5: sha256 of everything the pane shows (title, lines, as drawn), the fields behind it and every file hash it names. */
export const echoHash = (c: EchoContent): Promise<string> => sha256(canonical({ kind: c.kind, title: visible(c.title), lines: c.lines.map(visible), fields: c.fields, files: c.files }))
export const makeEcho = async (c: EchoContent): Promise<Echo> => ({ kind: c.kind, hash: await echoHash(c), title: visible(c.title), lines: c.lines.map(visible) })

export type Echo = { kind: EchoKind; hash: string; title: string; lines: readonly string[] }
export type Pending = Readonly<Partial<Record<EchoKind, Echo>>>
/** The pending echoes without one kind: after its approval, a rejection, `/flow-off` or a phase change. */
export const dropEcho = (pending: Pending, kind: EchoKind): Pending => Object.fromEntries(Object.entries(pending).filter(([k]) => k !== kind)) as Pending
export type EchoUi = { open(p: { id: string; title: string; focus: true }): Promise<{ isPlaced: boolean }> }
export const ECHO_PANE = 'flow-echo'
/** Shows an echo in the focused pane. Only an owner command binds it, and only when a surface draws the pane; a pane that
 * waits undrawn drops any echo of that kind. The caller puts the echo where the pane renderer reads it before calling. */
export async function showEcho(ui: EchoUi, pending: Pending, echo: Echo, origin: Origin): Promise<{ pending: Pending; shown: boolean }> {
  if (!OWNER_ORIGINS.has(origin.kind)) return { pending, shown: false }
  const { isPlaced } = await ui.open({ id: ECHO_PANE, title: echo.title, focus: true })
  const rest = dropEcho(pending, echo.kind)
  return isPlaced ? { pending: { ...rest, [echo.kind]: echo }, shown: true } : { pending: rest, shown: false }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols: no 0/O or 1/I, and a byte maps without bias
let releaseCode: string | null = null
/** A new release code; it lives only in this module (a reload drops it) and is read only by the pane renderer. */
export function rotateCode(): void { releaseCode = [...crypto.getRandomValues(new Uint8Array(6))].map(b => CODE_ALPHABET[b % 32]).join('') }
export const paneCode = (): string | null => releaseCode
/** Checks a typed code and spends the current one whatever the outcome: one attempt per code. */
export function takeCode(typed: string | undefined): boolean {
  const ok = releaseCode !== null && typed?.toUpperCase() === releaseCode
  releaseCode = null
  return ok
}

/** originRelease: a release approval from anywhere but the prompt (it spent the code; the wiring flags it on the card). */
export type Refusal = 'origin' | 'originRelease' | 'originCommand' | 'noEcho' | 'hash' | 'code'
export type ApproveCtx = { origin: Origin; pending: Pending; at: number; recompute: (kind: EchoKind) => Promise<string | undefined> }
/** §2.5 approval, the one gate for /flow-approve (the wiring sends it here before any origin check): a release attempt
 * spends the code first, then the origin, an echo shown for this kind, the typed hash8, and the echo rebuilt from the
 * current draft and files (`recompute`; undefined when it cannot be). On success the wiring drops the approved kind from
 * the pending echoes as they are then (`dropEcho`), not from this call's snapshot. */
export async function approve(cmd: ApproveCmd, ctx: ApproveCtx): Promise<{ ok: true; approval: Approval } | { ok: false; refuse: Refusal }> {
  const codeOk = cmd.kind === 'release' ? takeCode(cmd.code) : true
  const echo = ctx.pending[cmd.kind]
  if (!originOk(cmd, ctx.origin)) return { ok: false, refuse: cmd.kind === 'release' ? 'originRelease' : 'origin' }
  if (!echo) return { ok: false, refuse: 'noEcho' }
  if (echo.hash.slice(0, 8) !== cmd.hash8 || (await ctx.recompute(cmd.kind)) !== echo.hash) return { ok: false, refuse: 'hash' }
  if (!codeOk) return { ok: false, refuse: 'code' }
  return { ok: true, approval: { kind: cmd.kind, echoHash: echo.hash, at: ctx.at, origin: ctx.origin.kind } }
}

/** The command that shows each echo (again). Only one waiver waits at a time: a new /flow-waive replaces it. */
const SHOW_AGAIN: Readonly<Record<EchoKind, string>> = { setup: '/flow-setup', baseline: '/flow-status', plan: '/flow-plan', waive: '/flow-waive <FL-n|J-n|check:<cmdId>> <reason>', release: '/flow-ship' }
/** What the pane draws: the title, the echoed lines, and the approval line (for a release it holds the code: the one
 * place the code shows). */
export function paneLines(lang: Language, address: string, echo: Echo, code: string | null): string[] {
  const release = echo.kind === 'release'
  const command = `/flow-approve ${echo.kind} ${echo.hash.slice(0, 8)}${release ? ` ${code ?? '<code>'}` : ''}`
  return [echo.title, ...echo.lines, fill(lang, 'echo.approveWith', { command, address })]
}
/** A refusal in the owner's language; `originCommand` is for a non-approval command from another origin. */
export function refusalText(lang: Language, address: string, refuse: Refusal, kind: EchoKind): string {
  return fill(lang, `refuse.${refuse}`, { address, command: SHOW_AGAIN[kind] })
}
/** The transcript line after an echo: where to look, or why nothing shows. Never the code. */
export const shownText = (lang: Language, address: string, shown: boolean): string =>
  shown ? fill(lang, 'echo.shown', { address }) : fill(lang, 'card.blocked', { cause: fill(lang, 'blocked.noSurface', {}) })
