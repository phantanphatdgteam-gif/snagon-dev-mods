// Feature packs (plan v7.1 §7): what a RED, author or debug ticket holds about one feature, in a fixed order: flow rules,
// the stack rules for its files, its plan section, the ACs it cites, its files, one pattern file. Every part is redacted
// before anything is cut; over the room the ticket leaves, the largest files shrink to their changed lines ±40, then the
// pattern file goes, then the feature is split (§3.2). Views pass the same redaction (a leak in verify.md blocks, V8).
// Pure: the caller reads the plan, the rules and the files.
import type { FeatureRow, Plan, PlanFile } from './flow-plan'
import { TICKET_CAP, type Range } from './flow-review'
import { matchesAny, type PathRule } from './rules'
import { isForbiddenPath, redactSecrets } from './secrets'

export const HUNK_CONTEXT = 40
export type Room = { lines: number; chars: number }
export type PackFile = { path: string; text: string }
/** stack: the flow's stack (a rule folder under instructions/paths); files: the feature's Files that exist now (its tests
 * among them); hunks: its changed lines since its start tree (new side, as changedHunks gives them), which a large file
 * shrinks to. */
export type PackIn = { f: string; plan: Plan; flowRules: string; stack: string; rules: readonly PathRule[]; files: readonly PackFile[]; pattern?: PackFile; hunks?: readonly Range[] }
/** split: shrunk and without the pattern file, the feature still does not fit one ticket (`blocked: split`). */
export type Pack = { ok: true; text: string; shrunk: string[]; patternDropped: boolean } | { ok: false; split: true }

const yesNo = (b: boolean | null): string => (b === null ? 'not set' : b ? 'yes' : 'no')
const gap = (from: number, to: number): string => `[flow: lines ${from}-${to} not shown]`
/** A code fence longer than any run of backticks in the text, so the text cannot close it. */
const fenceFor = (text: string): string => '`'.repeat([...text.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3))

function block(file: PlanFile, text: string | undefined): string {
  if (text === undefined) return `#### ${file.path} (${file.isNew ? 'new, not written yet' : 'not in the tree now'})`
  const fence = fenceFor(text)
  return [`#### ${file.path}${file.isNew ? ' (new)' : ''}`, fence, text, fence].join('\n')
}

/** The lines within HUNK_CONTEXT of a change; each hidden run is named by its line numbers. No change: the text as it is. */
function shrink(text: string, hunks: readonly Range[]): string {
  const lines = text.split('\n'), n = text.endsWith('\n') ? lines.length - 1 : lines.length // a final line break ends a line
  // a window past the end (a hunk older than the text) is dropped; one before line 1 starts at `next`
  const windows = hunks.map(h => [h.start - HUNK_CONTEXT, Math.min(n, h.end + HUNK_CONTEXT)] as const).filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0])
  if (!windows.length) return text
  const out: string[] = []
  let next = 1
  for (const [from, to] of windows) {
    if (to < next) continue
    const start = Math.max(from, next)
    if (start > next) out.push(gap(next, start - 1))
    out.push(...lines.slice(start - 1, to))
    next = to + 1
  }
  if (next <= n) out.push(gap(next, n))
  return out.join('\n')
}

/** Flow rules, the flow stack's rules whose globs match a file of the feature (other stacks' rules match `*.ts` too, and
 * all of them together outgrow a ticket), the feature as the plan has it, the ACs it cites; each part redacted on its own. */
function header(p: PackIn, f: FeatureRow): string {
  const rules = p.rules.filter(r => r.id.startsWith(`${p.stack}/`) && f.files.some(x => matchesAny(x.path, r.globs)))
  return [
    ...(p.flowRules.trim() ? ['### Flow rules', p.flowRules.trim()] : []),
    ...rules.flatMap(r => [`### Stack rules (${r.id})`, r.body.trim()]),
    '### Feature', `${f.id}: ${f.title}`, `- ACs: ${f.acs.join(', ')}`, `- Files: ${f.files.map(x => (x.isNew ? `${x.path} (new)` : x.path)).join(', ')}`, `- Security: ${yesNo(f.security)}`,
    '### Acceptance criteria', ...p.plan.acs.filter(a => f.acs.includes(a.id)).map(a => `- ${a.id} (${a.required ? 'Required' : 'Optional'}): ${a.text}`),
  ].map(part => redactSecrets(part)).join('\n')
}

/** §7: the pack of feature `p.f` within `room` (the ticket cap, or what a ticket frame leaves: roomLeft). Holds nothing of
 * another feature: a file outside its Files fails loudly. */
export function featurePack(p: PackIn, room: Room = TICKET_CAP): Pack {
  const f = p.plan.features.find(x => x.id === p.f)
  if (!f) throw new Error(`flow: ${p.f} is not a feature of the approved plan`)
  const stray = p.files.find(x => !f.files.some(y => y.path === x.path))
  if (stray) throw new Error(`flow: ${stray.path} is not a file of ${p.f}`)
  // the pattern file is checked as the plan lint checks Files, lower-cased too (case-insensitive volumes)
  if (p.pattern && (isForbiddenPath(p.pattern.path) || isForbiddenPath(p.pattern.path.toLowerCase()))) throw new Error(`flow: the pattern file ${p.pattern.path} is private (keys, .env, flow data) and never goes into a pack`)
  const head = header(p, f)
  const texts = new Map(p.files.map(x => [x.path, redactSecrets(x.text)] as const)) // redacted before anything is cut
  const pattern = p.pattern ? block({ path: p.pattern.path, isNew: false }, redactSecrets(p.pattern.text)) : undefined
  const shown = new Map(texts), shrunk: string[] = []
  const assemble = (withPattern: boolean): string =>
    [head, '### Files', ...f.files.map(x => block(x, shown.get(x.path))), ...(withPattern && pattern ? ['### Pattern file (follow its conventions)', pattern] : [])].join('\n')
  const fits = (t: string): boolean => t.length <= room.chars && t.split('\n').length <= room.lines
  let text = assemble(true)
  for (const [path, full] of [...texts].sort((a, b) => b[1].length - a[1].length)) {
    if (fits(text)) break
    const cut = shrink(full, (p.hunks ?? []).filter(h => h.path === path))
    if (cut.length >= full.length) continue
    shown.set(path, cut)
    shrunk.push(path)
    text = assemble(true)
  }
  if (fits(text)) return { ok: true, text, shrunk, patternDropped: false }
  const without = assemble(false)
  return pattern && fits(without) ? { ok: true, text: without, shrunk, patternDropped: true } : { ok: false, split: true }
}

/** The room a ticket frame leaves for its pack: the frame is the ticket built with an empty pack (''), whose one empty line
 * the pack replaces. */
export const roomLeft = (frame: string): Room => ({ lines: TICKET_CAP.lines - frame.split('\n').length + 1, chars: TICKET_CAP.chars - frame.length })

/** §7: a view (the setup draft, a boundary view, debug.jsonl, verify.md) as it is written: redacted; `leak` when anything
 * was removed, which in verify.md blocks the flow (V8). */
export function viewText(text: string): { text: string; leak: boolean } {
  const out = redactSecrets(text)
  return { text: out, leak: out !== text }
}
