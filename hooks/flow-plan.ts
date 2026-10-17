// The plan (plan v7.1 §3.1): docs/flow/plan.md parsed and linted at P2, its hash approved at P3, and the feature keys
// that counters follow across re-plans. Issues come back as codes with a line and a detail; the caller renders them in
// config.language through the `lint.<code>` texts. Pure apart from the `exists` check the caller supplies.
import { hashOf } from './session'
import { isForbiddenPath } from './secrets'
import { PROTECTED_DIRS, PROTECTED_FILES } from './flow-sandbox'
import type { Counters } from './flow-state'

export type AcRow = { id: string; required: boolean; text: string }
export type PlanFile = { path: string; isNew: boolean }
export type FeatureRow = { id: string; title: string; acs: string[]; files: PlanFile[]; security: boolean | null }
export type Plan = { acs: AcRow[]; features: FeatureRow[] }
export type LintIssue = { code: LintCode; line: number; detail: string }
/**
 * root: the project's realpath; kind: what a root-relative path is on disk (null: absent); pluginRoots: realpaths of the
 * loaded plugins; testGlobs: the stack's; resolve: an absolute path's realpath (links followed), when the caller can.
 */
export type LintCtx = { root: string; kind: (rel: string) => Promise<'file' | 'dir' | 'other' | null>; pluginRoots: readonly string[]; testGlobs: readonly string[]; resolve?: (abs: string) => Promise<string> }

export const LINT_CODES = [
  'format', 'ac.syntax', 'ac.duplicate', 'ac.verification', 'ac.uncovered', 'ac.unknown',
  'f.syntax', 'f.sequence', 'f.tooMany', 'f.noAc', 'f.noTest', 'f.security', 'f.duplicate',
  'file.missing', 'file.newExists', 'file.badPath', 'file.outside', 'file.plugin', 'file.flowData', 'file.protected', 'file.private',
  'text.vague', 'text.invisible',
] as const
export type LintCode = (typeof LINT_CODES)[number]
export const MAX_FEATURES = 50
const AC_LINE = /^- (AC-\d{3}) \((Required|Optional)\): (.+)$/
const F_HEADER = /^### (F-\d{2}): (.+)$/
const VAGUE = /\b(TBD|TODO|later)\b|\bDeferred:/i
/** Any list item (`-`, `*`, `+`, `1.`, `1)`, indented or not): in the plan's sections each must be one this parser reads. */
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/
/** A Markdown fence: up to three spaces, then three or more backticks or tildes; it closes on the same character, at
 * least as long, with nothing after it. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** Zero-width and other invisible characters: they would hide a word from the checks while the owner reads it. */
const INVISIBLE = /[\p{Cf}\u034f\u115f\u1160\u3164\ufe00-\ufe0f]/u // format characters: zero-width, bidi, soft hyphen, tags
/** A plain file path: no quotes, backticks, glob characters or a trailing slash. */
const BAD_PATH = /[`"'*?[\]{}<>|\\]|\/$/

/** A glob of the stack's test-file list as a regex: `**` spans folders, `*` stays inside one, `{a,b}` is a choice. */
export function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1 }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',' && re.includes('(?:')) re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, x => `\\${x}`)
  }
  return new RegExp(`^${re}$`)
}

/** A root-relative path with `.` and `..` resolved, or null when it is absolute or climbs out of the root. */
function relPath(p: string): string | null {
  if (p.startsWith('/') || p.startsWith('~')) return null
  const out: string[] = []
  for (const seg of p.split('/')) { if (seg === '..') { if (!out.length) return null; out.pop() } else if (seg && seg !== '.') out.push(seg) }
  return out.join('/')
}
const lower = (p: string): string => p.normalize('NFC').toLowerCase()
const underAny = (rel: string, list: readonly string[]): boolean => list.some(d => lower(rel) === lower(d) || lower(rel).startsWith(`${lower(d)}/`))

function parse(text: string): { plan: Plan; issues: LintIssue[] } {
  const issues: LintIssue[] = []
  const acs: AcRow[] = [], features: FeatureRow[] = []
  let section = '', current: FeatureRow | null = null, fence = ''
  const seen = new Map<FeatureRow, Set<string>>()
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd(), n = i + 1
    const f = FENCE.exec(line)
    if (fence) { if (f && (f[1] ?? '')[0] === fence[0] && (f[1] ?? '').length >= fence.length && !(f[2] ?? '').trim()) fence = ''; return }
    if (f) { fence = f[1] ?? ''; return }
    if (/^\s*###\s+F-\d/.test(line) && section !== 'features') { issues.push({ code: 'f.syntax', line: n, detail: `${line.slice(0, 60)} (outside ## Features)` }); return }
    if (/^## /.test(line)) { section = line.slice(3).trim().toLowerCase(); current = null; return }
    if (section === 'acceptance' && (LIST_ITEM.test(line) || /\bAC-\d/.test(line))) {
      const m = AC_LINE.exec(line)
      if (!m) { issues.push({ code: 'ac.syntax', line: n, detail: line.slice(0, 80) }); return }
      if (acs.some(a => a.id === m[1])) issues.push({ code: 'ac.duplicate', line: n, detail: m[1] ?? '' })
      if (!/Verification:\s*\S/.test(m[3] ?? '')) issues.push({ code: 'ac.verification', line: n, detail: m[1] ?? '' })
      acs.push({ id: m[1] ?? '', required: m[2] === 'Required', text: m[3] ?? '' })
    } else if (section === 'features' && /^\s*#{3,}/.test(line)) {
      const m = F_HEADER.exec(line)
      if (!m) { issues.push({ code: 'f.syntax', line: n, detail: line.slice(0, 80) }); current = null; return }
      current = { id: m[1] ?? '', title: (m[2] ?? '').trim(), acs: [], files: [], security: null }
      features.push(current)
    } else if (section === 'features' && LIST_ITEM.test(line)) {
      const m = /^- (ACs|Files|Security):(.*)$/.exec(line)
      if (!m || !current) { issues.push({ code: 'f.syntax', line: n, detail: line.slice(0, 80) }); return }
      const label = m[1] ?? '', value = (m[2] ?? '').trim()
      const fields = seen.get(current) ?? new Set<string>()
      if (fields.has(label)) issues.push({ code: 'f.syntax', line: n, detail: `${current.id}: ${label} given twice` })
      seen.set(current, new Set([...fields, label]))
      const items = value.split(',').map(x => x.trim()).filter(Boolean)
      if (label === 'ACs') current.acs = items
      else if (label === 'Files') current.files = items.map(x => { const f = /^(.*?)\s+\(new\)$/.exec(x); return { path: (f ? f[1] : x) ?? '', isNew: Boolean(f) } })
      else current.security = /^yes$/i.test(value) ? true : /^no$/i.test(value) ? false : null
    } else if (section === 'features' && current && line.trim()) {
      issues.push({ code: 'f.syntax', line: n, detail: `${current.id}: ${line.trim().slice(0, 60)} (only the three field lines belong to a feature)` })
    }
  })
  return { plan: { acs, features }, issues }
}

async function fileIssue(f: PlanFile, ctx: LintCtx): Promise<LintCode | null> {
  if (BAD_PATH.test(f.path)) return 'file.badPath'
  const rel = relPath(f.path)
  if (rel === null || rel === '') return 'file.outside'
  const abs = `${ctx.root}/${rel}`
  const real = ctx.resolve ? await ctx.resolve(abs) : abs
  if (ctx.pluginRoots.some(r => [abs, real].some(x => lower(x) === lower(r) || lower(x).startsWith(`${lower(r)}/`)))) return 'file.plugin'
  if (real !== abs && !(lower(real) === lower(ctx.root) || lower(real).startsWith(`${lower(ctx.root)}/`))) return 'file.outside'
  // The path as written and, through a link, the path it reaches inside the root: both must pass.
  const names = real === abs ? [rel] : [rel, real.slice(ctx.root.length + 1)]
  if (names.some(x => underAny(x, ['.snagon']))) return 'file.flowData'
  if (names.some(x => underAny(x, PROTECTED_DIRS) || PROTECTED_FILES.some(y => lower(x) === lower(y)))) return 'file.protected'
  if (names.some(x => isForbiddenPath(x) || isForbiddenPath(lower(x)))) return 'file.private'
  const kind = await ctx.kind(rel)
  if (kind !== null && kind !== 'file') return 'file.badPath'
  if (!f.isNew && kind === null) return 'file.missing'
  if (f.isNew && kind !== null) return 'file.newExists'
  return null
}

/** P2: every §3.1 rule. `hash` is what P3 approves (hash8 is its first eight characters). */
export async function lintPlan(text: string, ctx: LintCtx): Promise<{ plan: Plan; issues: LintIssue[]; hash: string }> {
  const norm = text.replace(/\r\n/g, '\n')
  const hash = hashOf(norm)
  if (!/^## Acceptance\s*$/m.test(norm) || !/^## Features\s*$/m.test(norm)) {
    return { plan: { acs: [], features: [] }, issues: [{ code: 'format', line: 1, detail: 'missing ## Acceptance or ## Features' }], hash }
  }
  const { plan, issues } = parse(norm)
  const hidden = norm.split('\n').findIndex(l => INVISIBLE.test(l))
  if (hidden >= 0) issues.push({ code: 'text.invisible', line: hidden + 1, detail: 'zero-width or invisible character' })
  const clean = norm.split('\n').map(l => l.replace(new RegExp(INVISIBLE.source, 'gu'), '').normalize('NFKC'))
  const vague = clean.findIndex(l => VAGUE.test(l))
  if (vague >= 0) issues.push({ code: 'text.vague', line: vague + 1, detail: VAGUE.exec(clean[vague] ?? '')?.[0] ?? '' })
  const known = new Set(plan.acs.map(a => a.id))
  const used = new Set(plan.features.flatMap(f => f.acs))
  for (const a of plan.acs) if (a.required && !used.has(a.id)) issues.push({ code: 'ac.uncovered', line: 0, detail: a.id })
  if (plan.features.length > MAX_FEATURES) issues.push({ code: 'f.tooMany', line: 0, detail: String(plan.features.length) })
  else plan.features.forEach((f, i) => { if (f.id !== `F-${String(i + 1).padStart(2, '0')}`) issues.push({ code: 'f.sequence', line: 0, detail: f.id }) })
  const tests = ctx.testGlobs.map(globRe)
  const byKey = new Map<string, string>()
  for (const f of plan.features) { const k = featureKey(f), other = byKey.get(k); if (other) issues.push({ code: 'f.duplicate', line: 0, detail: `${other} and ${f.id}` }); else byKey.set(k, f.id) }
  for (const f of plan.features) {
    if (!f.acs.length) issues.push({ code: 'f.noAc', line: 0, detail: f.id })
    for (const id of f.acs) if (!known.has(id)) issues.push({ code: 'ac.unknown', line: 0, detail: `${f.id}: ${id}` })
    if (!f.files.some(x => !BAD_PATH.test(x.path) && tests.some(t => t.test(relPath(x.path) ?? '')))) issues.push({ code: 'f.noTest', line: 0, detail: f.id })
    if (f.security === null) issues.push({ code: 'f.security', line: 0, detail: f.id })
    for (const file of f.files) { const code = await fileIssue(file, ctx); if (code) issues.push({ code, line: 0, detail: `${f.id}: ${file.path}` }) }
  }
  return { plan, issues, hash }
}

/** A feature's counter key: its content (title in any spacing or case, and its AC set), not its number. */
export const featureKey = (f: Pick<FeatureRow, 'title' | 'acs'>): string =>
  `fk-${hashOf(JSON.stringify([f.title.trim().replace(/\s+/g, ' ').toLowerCase(), [...f.acs].sort()])).slice(0, 8)}`

/** P3 after a re-plan: counters of unchanged features carry over (by key); changed and new ones start at zero. */
export function carryCounters(old: Readonly<Record<string, Counters>>, features: readonly FeatureRow[]): { counters: Record<string, Counters>; carried: string[]; reset: string[] } {
  const counters: Record<string, Counters> = {}, carried: string[] = [], reset: string[] = []
  for (const f of features) {
    const key = featureKey(f), had = old[key]
    counters[key] = had ? { ...had } : { e: 0, r: 0, d: 0, retried: false };
    (had ? carried : reset).push(f.id)
  }
  return { counters, carried, reset }
}
