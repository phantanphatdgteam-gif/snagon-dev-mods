// Instruction files a plugin cannot ship as CLAUDE.md or .claude/rules: `instructions/always/**.md` (shared) and
// `~/.snagon/instructions/**.md` (the user's own, for every project) join the claudeMd block; `instructions/paths/**.md`,
// rules with `paths:` globs, are appended (by register.ts) the first time a file tool touches a matching file.
import { matchesAny, pathsOf, stripForLoad, type PathRule } from './rules'
import type { Io } from './session'

export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Every .md file under `dir`, recursively, sorted; none when the folder is missing. */
export async function markdownFiles(io: Io, dir: string): Promise<string[]> {
  let entries
  try { entries = await io.list(dir) } catch { return [] }
  const found: string[] = []
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'dir') found.push(...(await markdownFiles(io, path)))
    else if (entry.kind === 'file' && entry.name.endsWith('.md')) found.push(path)
  }
  return found.sort()
}

/** The flow rules (plan §10 step 11). Never a skill the model calls (the flow guard refuses `flow-*` skill names): loaded
 * here for every conversation, after the shared rules it amends; a subagent gets main's instruction files (checked live
 * on 2.1.302), so every agent of a ticket reads it too. Its text speaks only while a flow is active. */
export const FLOW_LOOP = 'skills/flow-loop/SKILL.md'

/** The always-on instruction files: the mod's, its flow rules, the user's own for every project (`~/.snagon/instructions`),
 * and this project's personal file `.snagon/CLAUDE.md` (written by /snagon-setup, never in git). */
export async function instructionFiles(io: Io, projectRoot?: string, home?: string): Promise<{ path: string; kind: 'project'; content: string }[]> {
  const personal = projectRoot ? `${projectRoot}/.snagon/CLAUDE.md` : ''
  const flowLoop = `${io.pluginRoot}/${FLOW_LOOP}`
  const paths = [
    ...(await markdownFiles(io, `${io.pluginRoot}/instructions/always`)),
    ...((await io.exists(flowLoop)) ? [flowLoop] : []),
    ...(home ? await markdownFiles(io, `${home}/.snagon/instructions`) : []),
    ...(personal && (await io.exists(personal)) ? [personal] : []),
  ]
  return Promise.all(paths.map(async path => ({ path, kind: 'project' as const, content: stripForLoad(await io.read(path)) })))
}

async function readRules(io: Io): Promise<PathRule[]> {
  const root = `${io.pluginRoot}/instructions/paths`
  const rules = await Promise.all((await markdownFiles(io, root)).map(async path => {
    const text: string = await io.read(path)
    return { id: path.slice(root.length + 1), path, globs: pathsOf(text), body: stripForLoad(text) }
  }))
  return rules.filter(rule => rule.globs.length > 0)
}

// The path rules, read once per load of the module (a reload of the mod reads them again); a failed read retries.
let rulesLoad: Promise<PathRule[]> | undefined
export const loadRules = (io: Io): Promise<PathRule[]> => {
  rulesLoad ??= readRules(io).catch(err => { rulesLoad = undefined; throw err })
  return rulesLoad
}

/** The rules `file` matches among those not appended yet. */
export const matching = (rules: readonly PathRule[], done: ReadonlySet<string>, file: string): PathRule[] =>
  rules.filter(rule => !done.has(rule.id) && matchesAny(file, rule.globs))

export const ruleText = (fresh: readonly PathRule[], file: string): string =>
  fresh.map(rule => `Contents of ${rule.path} (a path rule of the snagon-dev-mods harness, loaded because ${file} matches ${rule.globs.join(', ')}):\n\n${rule.body}`).join('\n\n')
