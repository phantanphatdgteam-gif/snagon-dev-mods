// The vendored methods in tickets (plan v7.1 §8): a role's method reaches its agent as ticket text only, under
// `## Reference method (agent-skills, MIT, <sha8>)`, then flow/vendor/overrides.md. The texts are the role's routed
// skills and, for B1, the testing-patterns sections §8.1 cites. A vendored file that cannot be read, or a lock without a
// commit, fails the ticket loudly; a change to them after S2 is caught by the plugin integrity hash at flow_check.
import { RED_TESTING, ROUTING } from '../flow/data/routing'
import type { Role } from '../flow/data/types'
import type { Io } from './session'

export const VENDOR_DIR = 'flow/vendor/agent-skills'
export const VENDOR_LOCK = 'flow/vendor/agent-skills.lock.json'
export const OVERRIDES = 'flow/vendor/overrides.md'

type Heading = { at: number; level: number; text: string }
/** The headings outside fenced code (``` or ~~~, closed by a run of the same character at least as long). */
function headingsOf(lines: readonly string[]): Heading[] {
  const out: Heading[] = []
  let fence = ''
  lines.forEach((line, at) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (f?.[1] && f[1][0] === fence[0] && f[1].length >= fence.length && !(f[2] ?? '').trim()) fence = ''
      return
    }
    if (f?.[1]) return void (fence = f[1])
    const h = /^(#{1,6}) (.*)$/.exec(line)
    if (h?.[1]) out.push({ at, level: h[1].length, text: (h[2] ?? '').trim() })
  })
  return out
}
/** A cited heading names the start of a heading in whole words ("Test Naming" is "Test Naming Conventions"). */
const cites = (heading: string, cited: string): boolean => heading === cited || (heading.startsWith(cited) && /^[\s(]/.test(heading.slice(cited.length)))

/** The sections whose headings `wanted` cites, in that order, each from its heading to the next heading at its level or
 * above. A cited heading that is not there fails loudly: the vendored text and the citation no longer match. */
export function sectionsOf(text: string, wanted: readonly string[]): string[] {
  const lines = text.split('\n'), heads = headingsOf(lines)
  return wanted.map(w => {
    const i = heads.findIndex(x => cites(x.text, w)), h = heads[i]
    if (!h) throw new Error(`flow: the vendored text has no section "${w}"`)
    const end = heads.slice(i + 1).find(x => x.level <= h.level)?.at ?? lines.length
    return lines.slice(h.at, end).join('\n').trim()
  })
}

/** §8: the heading with the locked commit, the method texts, then the overrides. */
export const methodSection = (sha: string, texts: readonly string[], overrides: string): string =>
  [`## Reference method (agent-skills, MIT, ${sha.slice(0, 8)})`, ...texts.map(t => t.trim()), overrides.trim()].join('\n\n')

/** The method section of a role's ticket ('' for a role without one), read from the installed mod. */
export async function methodText(io: Pick<Io, 'read' | 'pluginRoot'>, role: Role): Promise<string> {
  const read = async (rel: string): Promise<string> => {
    try {
      return await io.read(`${io.pluginRoot}/${rel}`)
    } catch (e) {
      throw new Error(`flow: the vendored file ${rel} could not be read (${e instanceof Error ? e.message : String(e)}); reinstall the mod`)
    }
  }
  const texts = [
    ...(await Promise.all(ROUTING.skills[role].map(s => read(`${VENDOR_DIR}/skills/${s}/SKILL.md`)))),
    ...(role === 'red' ? sectionsOf(await read(`${VENDOR_DIR}/references/${RED_TESTING.reference}.md`), RED_TESTING.sections) : []),
  ]
  if (!texts.length) return ''
  const lock = await read(VENDOR_LOCK)
  let sha: unknown
  try {
    sha = (JSON.parse(lock) as { sha?: unknown } | null)?.sha
  } catch {
    sha = undefined
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`flow: ${VENDOR_LOCK} names no commit sha; reinstall the mod`)
  return methodSection(sha, texts, await read(OVERRIDES))
}
