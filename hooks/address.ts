// How the agent addresses the user. The configured form (for example "anh Minh") is used every time; a bare pronoun
// ("anh" alone) in a reply is counted at the stop, and the next prompt carries a short reminder. Nothing is blocked.

// Vietnamese words that are a form of address only together with a name.
export const PRONOUNS = ['anh', 'chị', 'em', 'bạn', 'cô', 'chú', 'ông', 'bà', 'cậu', 'bác'] as const
// "tiếng Anh" (English), "nước Anh", "người Anh", "Anh Quốc", "Anh ngữ": the country or language, not the user.
const NOT_ADDRESS_BEFORE = new Set(['tiếng', 'nước', 'người', 'bằng', 'từ'])
const NOT_ADDRESS_AFTER = new Set(['quốc', 'ngữ', 'văn'])

const words = (s: string): string[] => s.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []

/** The pronoun to watch for a configured form such as "anh Minh", or null when the form does not start with one. */
export function pronounOf(address: string): string | null {
  const parts = words(address)
  if (parts.length < 2) return null
  const first = parts[0] ?? ''
  return (PRONOUNS as readonly string[]).includes(first) ? first : null
}

/** How many times `text` uses the pronoun of `address` without the rest of the form (code blocks and inline code skipped). */
export function bareAddressCount(text: string, address: string): number {
  const pronoun = pronounOf(address)
  if (!pronoun || !text) return 0
  const rest = words(address).slice(1)
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const w = words(prose)
  let count = 0
  for (let i = 0; i < w.length; i += 1) {
    if (w[i] !== pronoun) continue
    if (rest.every((r, j) => w[i + 1 + j] === r)) continue
    if (NOT_ADDRESS_BEFORE.has(w[i - 1] ?? '') || NOT_ADDRESS_AFTER.has(w[i + 1] ?? '')) continue
    count += 1
  }
  return count
}

/** The reminder for the next prompt after a reply with bare pronouns. */
export function addressReminder(address: string, count: number): string {
  const pronoun = pronounOf(address) ?? ''
  return [
    '# snagon-dev-mods: how to address the user',
    '',
    `Your last reply called the user "${pronoun}" on its own ${count === 1 ? 'once' : `${count} times`}. Address them as "${address}" every time, never with the bare "${pronoun}". Do not apologise or mention this; just use the full form from now on.`,
  ].join('\n')
}
