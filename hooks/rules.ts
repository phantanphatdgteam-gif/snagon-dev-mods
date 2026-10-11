// Pure helpers of snagon-dev-mods's register module: how instruction files and path rules are read.

/** A rule under instructions/paths/: loaded the first time a matching file is read or edited in a session. */
export type PathRule = { id: string; path: string; globs: readonly string[]; body: string }

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/
const BLOCK_COMMENT = /<!--[\s\S]*?-->\n?/g

/** The text the engine loads from an instruction file: frontmatter and HTML block comments removed. */
export function stripForLoad(text: string): string {
  return text.replace(FRONTMATTER, '').replace(BLOCK_COMMENT, '').replace(/^\n+/, '')
}

/** The `paths:` globs of a rule's frontmatter: a block list, an inline list or one string, quoted or bare; none when absent. */
export function pathsOf(text: string): string[] {
  const front = text.match(FRONTMATTER)
  if (!front) return []
  const globs: string[] = []
  let inPaths = false
  for (const line of (front[1] ?? '').split('\n')) {
    const head = line.match(/^paths:\s*(.*)$/)
    if (head) {
      const rest = (head[1] ?? '').trim()
      if (rest === '') { inPaths = true; continue }
      const items = rest.startsWith('[') ? rest.replace(/^\[|\]$/g, '').split(',') : [rest]
      return items.map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s !== '')
    }
    if (!inPaths) continue
    const item = line.match(/^\s+-\s*(["']?)(.+?)\1\s*$/)
    if (!item || item[2] === undefined) break
    globs.push(item[2])
  }
  return globs
}

// ponytail: `**`, `*` and `?` only, which is every glob the copied rules use; add `{a,b}` when a rule needs it.
/** A glob as a regular expression over a path without its leading slash. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i)
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** Whether `file` (absolute or relative) matches one of `globs`. */
export function matchesAny(file: string, globs: readonly string[]): boolean {
  const path = file.replace(/^\/+/, '')
  return globs.some(glob => globToRegExp(glob).test(path))
}
