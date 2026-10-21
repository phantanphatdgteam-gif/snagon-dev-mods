// The vendored methods in tickets (plan v7.1 §8): a role's method reaches its agent as ticket text only, under
// `## Reference method (agent-skills, MIT, <sha8>)`, then flow/vendor/overrides.md. The texts are the role's routed
// skills and, for B1, the flow stack's testing sections (R2 plan §4.4): the testing-patterns ones §8.1 cites, or those of
// one of the mod's own skills under its own heading. A file that cannot be read, or a lock without a commit, fails the
// ticket loudly; a change to them after S2 is caught by the plugin integrity hash at flow_check.
import { ROUTING } from '../flow/data/routing'
import type { Role, Stack } from '../flow/data/types'
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
 * above. A cited heading that is not there fails loudly, naming the text (`from`, its file): the text and the citation
 * no longer match. */
export function sectionsOf(text: string, wanted: readonly string[], from = 'the vendored text'): string[] {
  const lines = text.split('\n'), heads = headingsOf(lines)
  return wanted.map(w => {
    const i = heads.findIndex(x => cites(x.text, w)), h = heads[i]
    if (!h) throw new Error(`flow: ${from} has no section "${w}"`)
    const end = heads.slice(i + 1).find(x => x.level <= h.level)?.at ?? lines.length
    return lines.slice(h.at, end).join('\n').trim()
  })
}

/** §8: the heading with the locked commit, the method texts, then the overrides; `own`, sections of one of the mod's own
 * skills (R2 plan §4.4), goes before the overrides under that skill's heading. */
export const methodSection = (sha: string, texts: readonly string[], overrides: string, own?: { readonly name: string; readonly texts: readonly string[] }): string => [
  ...(texts.length ? [`## Reference method (agent-skills, MIT, ${sha.slice(0, 8)})`, ...texts.map(t => t.trim())] : []),
  ...(own?.texts.length ? [`## Reference method (${own.name}, MIT)`, ...own.texts.map(t => t.trim())] : []),
  overrides.trim(),
].join('\n\n')

/** The method section of a role's ticket ('' for a role without one), read from the installed mod. B1's quotes the flow
 * stack's testing text (`testing`, its data's `redTesting`); the other roles take none. */
export async function methodText(io: Pick<Io, 'read' | 'pluginRoot'>, role: Role, testing?: Stack['redTesting']): Promise<string> {
  const read = async (rel: string): Promise<string> => {
    try {
      return await io.read(`${io.pluginRoot}/${rel}`)
    } catch (e) {
      throw new Error(`flow: the mod's file ${rel} could not be read (${e instanceof Error ? e.message : String(e)}); reinstall the mod`)
    }
  }
  if (role === 'red' && !testing) throw new Error("flow: a RED ticket needs the flow stack's testing text")
  const red = role === 'red' ? testing : undefined
  const cited = async (rel: string, wanted: readonly string[]): Promise<string[]> => sectionsOf(await read(rel), wanted, rel)
  const texts = [
    ...(await Promise.all(ROUTING.skills[role].map(s => read(`${VENDOR_DIR}/skills/${s}/SKILL.md`)))),
    ...(red?.from === 'reference' ? await cited(`${VENDOR_DIR}/references/${red.name}.md`, red.sections) : []),
  ]
  const own = red?.from === 'skill' ? { name: red.name, texts: await cited(`skills/${red.name}/SKILL.md`, red.sections) } : undefined
  if (!texts.length && !own) return ''
  const lock = await read(VENDOR_LOCK)
  let sha: unknown
  try {
    sha = (JSON.parse(lock) as { sha?: unknown } | null)?.sha
  } catch {
    sha = undefined
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`flow: ${VENDOR_LOCK} names no commit sha; reinstall the mod`)
  return methodSection(sha, texts, await read(OVERRIDES), own)
}
