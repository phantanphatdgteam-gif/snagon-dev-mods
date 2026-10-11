// Secret patterns shared by memory saves and the git guard. Matches report the pattern's name, never the value.

export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'quoted password or key assignment', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
]

/** Names of the secret patterns found in `text` (empty when none). */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => p.name)
}

// Paths that hold per-user data or credentials and never belong in a commit.
const FORBIDDEN_PATHS: readonly RegExp[] = [
  /(^|\/)\.snagon\//,
  /(^|\/)mods\/[^/]+\/local\//,
  /(^|\/)\.env(\.(?!(example|sample|template|dist)$)[^/]*)?$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)memory\.(jsonl|db)$/,
]

/** Whether a repository path must never be committed. */
export function isForbiddenPath(path: string): boolean {
  return FORBIDDEN_PATHS.some(re => re.test(path))
}

/** Secret findings in a unified diff's added lines, as `file: pattern` (one per file and pattern). */
export function scanDiff(diff: string): string[] {
  const found = new Set<string>()
  let file = ''
  let header = false // between "diff --git" or "--- " and the first "@@": "+++ " names the file there, and only there
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && !file)) { header = true; continue }
    if (header && line.startsWith('--- ')) continue
    if (header && line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue }
    if (line.startsWith('@@')) { header = false; continue }
    if (header || !line.startsWith('+')) continue
    for (const name of findSecrets(line.slice(1))) found.add(`${file || '(unknown file)'}: ${name}`)
  }
  return [...found]
}
