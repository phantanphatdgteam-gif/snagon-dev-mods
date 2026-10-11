// The end-of-session handoff: at session end the mod lets go of one `claude -p` process that writes
// `.snagon/handoff/<date>.md` from the journal (a session-end hook has only about 1.5 s); the next session loads it.
import type { Io } from './session'
import { findSecrets } from './secrets'

export const HANDOFF_PROMPT = [
  'Write the end-of-session handoff in English, concise, based ONLY on the session journal below.',
  'The journal may be in another language: translate what you use, and keep commands, paths, identifiers and verbatim quotes unchanged.',
  'Sections in exactly this order: 1. Objective 2. Current status 3. Files to read first 4. Next tasks in priority order',
  '5. Decisions in force (each with its reason; a temporary decision, for example one made because of a quota, a budget or a',
  'deadline, keeps its condition or expiry and is not called final) 6. Things to avoid',
  '7. Prompt handoff (one paste-ready ``` block, under 3000 characters, condensing sections 1-6).',
  'Do not invent anything; write "unknown" when information is missing. Output markdown only.',
].join('\n')
export const MAX_JOURNAL_CHARS = 200_000

export type HandoffPlan = { prompt: string; promptFile: string; outFile: string; logFile: string }

/** The handoff to write, or null when the journal did not change since the last handoff. */
/** Journal text with every line that looks like a secret, and every private-key block, replaced. */
export function redact(text: string): string {
  let inKey = false
  return text.split('\n').map(line => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = true
    const hide = inKey || findSecrets(line).length > 0
    if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = false
    return hide ? '[line removed: it looked like a secret]' : line
  }).join('\n')
}

export function planHandoff(journalText: string, journalMtime: number, lastMtime: number, addendum: string, dir: string, date: string, sessionId: string): HandoffPlan | null {
  if (journalMtime <= lastMtime) return null
  const tail = journalText.length > MAX_JOURNAL_CHARS ? journalText.slice(-MAX_JOURNAL_CHARS) : journalText
  const journal = redact(tail)
  const prompt = [HANDOFF_PROMPT, addendum.trim(), '', '<journal>', journal, '</journal>', ''].filter((p, i) => i !== 1 || p).join('\n')
  return { prompt, promptFile: `${dir}/prompt-${sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(-8) || 'session'}.md`, outFile: `${dir}/${date}.md`, logFile: `${dir}/handoff.log` }
}

// The worker: runs outside the session, never loads this mod again (plugin folders unset, worker marker set), and
// only replaces the handoff file when claude answered with something.
export const WORKER_SCRIPT = [
  'root="$1"; prompt="$2"; out="$3"; log="$4"; settings="$5"',
  '(',
  '  cd "$root" || exit 1',
  '  if ! command -v claude >/dev/null 2>&1; then echo "$(date "+%F %T") no claude on PATH" >> "$log"; rm -f "$prompt"; exit 1; fi',
  '  if env -u CLAUDE_CODE_PLUGIN_DIRS SNAGON_WORKER=1 HANDOFF_WORKER=1 claude -p --model sonnet --effort medium --permission-mode dontAsk --tools "" --strict-mcp-config --no-session-persistence --settings "$settings" --max-budget-usd 1 --output-format text < "$prompt" > "$out.tmp" 2>> "$log" && [ -s "$out.tmp" ]; then',
  '    mv "$out.tmp" "$out" && echo "$(date "+%F %T") ok $out" >> "$log"',
  '  else',
  '    echo "$(date "+%F %T") failed" >> "$log"; rm -f "$out.tmp"',
  '  fi',
  '  rm -f "$prompt"',
  ') >/dev/null 2>&1 </dev/null &',
].join('\n')

export async function spawnHandoff(io: Io, root: string, plan: HandoffPlan): Promise<void> {
  await io.write(plan.promptFile, plan.prompt)
  await io.run(['/bin/sh', '-c', WORKER_SCRIPT, 'sh', root, plan.promptFile, plan.outFile, plan.logFile, '{"disableAllHooks":true}'], { timeoutMs: 1000 })
}

/** The newest handoff file of the folder, or null. */
export async function latestHandoff(io: Io, dir: string): Promise<{ path: string; content: string } | null> {
  let names: string[]
  try { names = (await io.list(dir)).filter(e => e.kind === 'file' && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)).map(e => e.name).sort() } catch { return null }
  const name = names.at(-1)
  if (!name) return null
  try { return { path: `${dir}/${name}`, content: await io.read(`${dir}/${name}`) } } catch { return null }
}
