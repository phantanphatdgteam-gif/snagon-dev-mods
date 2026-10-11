// The session journal: where it lives, the stop reminder when files changed after the last entry, the entry written
// before a compaction, and the journal tail handed to the session after one.
import type { Io } from './session'

export type Edit = { file: string; at: number }
export const MAX_EDITS = 300
export const MAX_SHOWN = 8
export const TAIL_LINES = 60
export const TAIL_MAX_CHARS = 12_000
/** The journal folder: the one named in the user's local config when it exists in this project, else .snagon/journal. */
export async function journalDir(io: Io, root: string, configured: string): Promise<string> {
  return configured !== '.snagon/journal' && (await io.exists(`${root}/${configured}`)) ? `${root}/${configured}` : `${root}/.snagon/journal`
}

/** The journal files, newest modification first. */
export async function journalFiles(io: Io, dir: string): Promise<{ file: string; mtimeMs: number }[]> {
  try {
    return (await io.list(dir)).filter(e => e.kind === 'file' && e.name.endsWith('.md'))
      .map(e => ({ file: `${dir}/${e.name}`, mtimeMs: e.mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch { return [] }
}

const within = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`)
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

/** Files that never need a journal entry: the journal itself, the mod's data, and scratch files outside the project. */
export function isScratch(file: string, root: string, jdir: string): boolean {
  if (within(file, jdir) || within(file, `${root}/.snagon`)) return true
  if (within(file, root)) return false // project files count even when the project sits under a temp folder
  return TEMP_ROOTS.some(t => within(file, t))
}

/** Edits after `since`, newest edit per file, oldest first. */
export function editsAfter(edits: readonly Edit[], since: number, root: string, jdir: string): Edit[] {
  const latest = new Map<string, number>()
  for (const e of edits) {
    if (e.at <= since || isScratch(e.file, root, jdir)) continue
    latest.set(e.file, Math.max(e.at, latest.get(e.file) ?? 0))
  }
  return [...latest].sort((a, b) => a[1] - b[1]).map(([file, at]) => ({ file, at }))
}

/** Records an edit, keeping the newest MAX_EDITS. */
export function withEdit(edits: readonly Edit[], file: string, at: number): Edit[] {
  return [...edits.filter(e => e.file !== file), { file, at }].slice(-MAX_EDITS)
}

export const display = (file: string, root: string): string => (within(file, root) ? file.slice(root.length + 1) || file : file)

export type Words = { decision: string; lesson: string }

/** The reason a stop is held once when files changed after the last journal entry. */
export function stopReason(changed: readonly Edit[], root: string, target: string, clock: string, words: Words): string {
  const shown = changed.slice(-MAX_SHOWN).map(e => display(e.file, root))
  const more = changed.length > MAX_SHOWN ? ` (+${changed.length - MAX_SHOWN} more)` : ''
  return [
    `Session journal reminder: ${changed.length} file(s) changed after the last journal entry: ${shown.join(', ')}${more}.`,
    `Before stopping, append an entry to ${display(target, root)}: heading "## ${clock} · <topic>" (the real local time now; use it, never estimate),`,
    `the files changed, decision lines that start with "${words.decision}:", lesson lines that start with "${words.lesson}:", and the next step, in the journal's language.`,
    'If these edits need no entry, append one line saying why. This reminder fires once per stop.',
  ].join(' ')
}

/** The entry appended to the journal right before a compaction. */
export function compactEntry(clock: string, sessionId: string, files: readonly string[], manual: boolean, lang: 'en' | 'vi'): string {
  const s = sessionId.slice(-8) || 'unknown'
  if (lang === 'vi') {
    return ['', `## ${clock} · Nén ngữ cảnh (${manual ? 'chạy /compact thủ công' : 'tự động'}; mục này do hook ghi)`,
      `- Phiên \`${s}\`. File đã sửa bằng Edit/Write sau mục nhật ký trước: ${files.length ? files.map(f => `\`${f}\``).join(', ') : 'không có'}.`,
      '- Sau khi nén, phần cuối nhật ký này được nạp lại vào phiên.', ''].join('\n')
  }
  return ['', `## ${clock} · Context compaction (${manual ? 'manual /compact' : 'automatic'}; written by a hook)`,
    `- Session \`${s}\`. Files edited with Edit/Write since the previous entry: ${files.length ? files.map(f => `\`${f}\``).join(', ') : 'none'}.`,
    '- After compaction the tail of this journal is loaded back into the session.', ''].join('\n')
}

/** The context handed to the session right after a compaction. */
export function compactContext(tail: string, file: string): string {
  return [
    `Context was just compacted. Below is the tail of the session journal (${file}),`,
    'the record of what this session already did and decided; continue from it, and keep journaling after each step.',
    '',
    tail.trimEnd().slice(-TAIL_MAX_CHARS),
  ].join('\n')
}

// Phrases that suggest thinking was cut short (shown to the person, never blocking).
const SHORTCUTS: readonly RegExp[] = [
  /\bskip(?:ping)? (?:the )?tests? (?:for now|this time)\b/i,
  /\bpre-existing (?:bug|issue|failure|error)s?\b/i,
  /\bnot related to (?:my|this) change\b/i,
  /\bwill (?:fix|handle|add) (?:it |that |this )?later\b/i,
  /\bbỏ qua (?:test|kiểm thử)\b/iu,
  /\blỗi có sẵn\b/iu,
]

export function shortcutPhrase(text: string | undefined): string | null {
  if (!text) return null
  for (const re of SHORTCUTS) { const m = text.match(re); if (m) return m[0] }
  return null
}
