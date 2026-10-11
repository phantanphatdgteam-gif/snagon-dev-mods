// Cost and context: a status line, one row per turn in `.snagon/cost.jsonl`, informational cost notices, a reminder
// to journal and consider /compact as the context fills, and a reminder to choose each subagent's model and effort.

export const COST_LEVELS = [5, 10, 50] as const // USD, informational notices
export const COMPACT_START = 70 // percent of the context window
export const COMPACT_STEP = 5

export type Notices = { lines: string[]; fired: string[] }

export function usageNotices(usd: number, percent: number | undefined, fired: readonly string[]): Notices {
  const lines: string[] = []
  const next = [...fired]
  const level = [...COST_LEVELS].reverse().find(l => usd >= l)
  if (level !== undefined && !fired.includes(`cost:${level}`)) {
    for (const l of COST_LEVELS) if (l <= level && !next.includes(`cost:${l}`)) next.push(`cost:${l}`)
    lines.push(`[cost] Session total about $${usd.toFixed(2)} (over $${level}). Informational only, not an instruction to stop.`)
  }
  if (percent !== undefined && percent >= COMPACT_START) {
    const mark = COMPACT_START + COMPACT_STEP * Math.floor((percent - COMPACT_START) / COMPACT_STEP)
    if (!fired.includes(`ctx:${mark}`)) {
      next.push(`ctx:${mark}`)
      lines.push(`[strategic compact] Context is at ${Math.round(percent)}% of the window: bring the session journal up to date, then the user may run /compact before the next phase.`)
    }
  }
  return { lines, fired: next }
}

export const statusText = (usd: number | undefined, percent: number | undefined): string =>
  [usd !== undefined ? `$${usd.toFixed(2)}` : '', percent !== undefined ? `ctx ${Math.round(percent)}%` : ''].filter(Boolean).join(' · ')

const SKILL = 'cost-aware-claude-pipeline'

/** The reminder added when the main agent spawns a subagent (never blocks or rewrites the spawn). */
export function subagentReminder(input: { model?: unknown; effort?: unknown; subagent_type?: unknown }): string {
  const model = typeof input.model === 'string' ? input.model : ''
  const effort = typeof input.effort === 'string' ? input.effort : ''
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
  const lead = model
    ? `Subagent "${type}" was spawned on model "${model}".`
    : `Subagent "${type}" was spawned without a model, so it runs on its definition's model, CLAUDE_CODE_SUBAGENT_MODEL, or the session model - usually the most expensive option.`
  const effortNote = effort ? ` Effort: "${effort}".` : model === 'haiku' ? '' : ' No effort set: it falls back to the definition, settings or session level.'
  return `[${SKILL}] ${lead}${effortNote} For each spawn pick the cheapest tier that fits: haiku = search/scan/summarize (no effort), sonnet = implement/tests/clear-criteria review (medium), sonnet or opus = research/verification feeding a decision (high), opus = architecture/hard debugging/security (high-max); fable only on explicit request. See skill ${SKILL}, section 9.`
}
