// Secret patterns shared by memory saves, the git guard and flow's redaction. Matches report the pattern's name, never the value.

const BEGIN_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ // PEM, OpenSSH and PGP armor
const END_KEY = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/
/** Secrets that fit on one line: redactSecrets replaces each where it stands. */
const TOKEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'quoted password or key assignment', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
]
export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [{ name: 'private key block', re: BEGIN_KEY }, ...TOKEN_PATTERNS]

/** Names of the secret patterns found in `text` (empty when none). */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => p.name)
}

export const REDACTED_LINE = '[line removed: it looked like a secret]'
const KEY_TEXT = '[secret removed: private key]'
const TOKENS = TOKEN_PATTERNS.map(p => ({ text: `[secret removed: ${p.name}]`, re: new RegExp(p.re.source, `${p.re.flags}g`) }))
/** Escapes a string may hold in a key: `\n`, `\r`, `\/` (PHP), `+` (.NET), also encoded twice (`\\n`). Bounded, so a
 * run of backslashes costs linear time. */
const ESCAPES = /\\{1,4}(?:[nr/]|u[0-9a-fA-F]{4})/g
/** A BEGIN marker with the body and END that follow it on its line (a key held in one string), else a marker alone. */
const KEY_INLINE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:\\{1,4}(?:[nr/]|u[0-9a-fA-F]{4})|[A-Za-z0-9+/=\s:,.-])*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)?|-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g
const FULL_LINE = 60 // PEM wraps key bodies at 64 characters, OpenSSH at 70, MIME base64 at 76

type Kind = 'full' | 'short' | 'sum' | 'header' | null
/** A line of a key as a file, a diff or a code string holds it: around its text may stand a diff sign, indentation, a
 * leading `+` (Java style), a string prefix and quote, escapes, and a closing quote with `+`, `,` or `;`. full: a whole
 * base64 line; short: a shorter one (a body's last); sum: an armor checksum (`=AbCd`); header: an armor header or a blank.
 * The end is trimmed without a regex: two whitespace runs before `$` backtrack in cubic time on long lines. */
function lineKind(line: string): Kind {
  let core = line.replace(ESCAPES, '').replace(/^[+\- ]?\s*(?:\+\s*)?(?:[bru]{1,2}(?=["'`]))?["'`]?/i, '').trimEnd()
  if (/[+,;]$/.test(core)) core = core.slice(0, -1).trimEnd()
  if (/["'`]$/.test(core)) core = core.slice(0, -1)
  if (core === '' || /^[A-Za-z][\w-]*: /.test(core)) return 'header'
  if (/^=[A-Za-z0-9+/]{4}$/.test(core)) return 'sum'
  if (!/^(?=.{4})[A-Za-z0-9+/]+={0,2}$/.test(core)) return null
  return core.length >= FULL_LINE ? 'full' : 'short'
}

/** The lines of key bodies: below a BEGIN line (after its armor headers and blank line), full lines and then at most one
 * shorter line; above an END line, an armor checksum, at most one shorter line and then full lines. A run counts only with
 * a full line in it, so code beside a stray or fake marker stays; skipped header lines are never hidden. */
function keyBody(lines: readonly string[]): Set<number> {
  const kinds = lines.map(lineKind), body = new Set<number>()
  const walk = (from: number, step: 1 | -1): void => {
    const run: number[] = []
    let i = from + step
    if (step > 0) while (kinds[i] === 'header') i += step
    if (step < 0 && kinds[i] === 'sum') { run.push(i); i += step }
    if (step < 0 && kinds[i] === 'short') { run.push(i); i += step }
    for (; kinds[i] === 'full'; i += step) run.push(i)
    if (step > 0 && run.length && kinds[i] === 'short') run.push(i)
    if (run.some(j => kinds[j] === 'full')) for (const j of run) body.add(j)
  }
  lines.forEach((line, i) => { if (BEGIN_KEY.test(line)) walk(i, 1); if (END_KEY.test(line)) walk(i, -1) })
  return body
}

/** `text` with each one-line secret replaced where it stands (the rest of its line stays, so code beside a fake token is
 * still shown), each private-key marker replaced, and each line of a key body replaced whole, also in a text cut inside a
 * key. Redact before cutting text: a cut can split a secret into halves that no pattern matches. */
export function redactSecrets(text: string): string {
  const lines = text.split('\n'), body = keyBody(lines)
  return lines.map((line, i) => (body.has(i) ? REDACTED_LINE : TOKENS.reduce((acc, t) => acc.replace(t.re, t.text), line.replace(KEY_INLINE, KEY_TEXT)))).join('\n')
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

/** A unified diff in order: each file a `+++` header names (`text` null; the tab git writes after a name with a space
 * dropped), then each added line with its file (`(unknown file)` before a header names one). */
function* walk(diff: string): Generator<{ file: string; text: string | null }> {
  let file = ''
  let header = false // between "diff --git" or "--- " and the first "@@": "+++ " names the file there, and only there
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && !file)) { header = true; continue }
    if (header && line.startsWith('--- ')) continue
    if (header && line.startsWith('+++ ')) { file = line.slice(4).replace(/\t$/, '').replace(/^b\//, ''); yield { file, text: null }; continue }
    if (line.startsWith('@@')) { header = false; continue }
    if (header || !line.startsWith('+')) continue
    yield { file: file || '(unknown file)', text: line.slice(1) }
  }
}

/** Secret findings in a unified diff's added lines, as `file: pattern` (one per file and pattern). */
export function scanDiff(diff: string): string[] {
  const found = new Set<string>()
  for (const a of walk(diff)) if (a.text !== null) for (const name of findSecrets(a.text)) found.add(`${a.file}: ${name}`)
  return [...found]
}

/** A unified diff's added lines by file; a file whose header shows with no line added (lines removed only) maps to []. */
export function addedLines(diff: string): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const a of walk(diff)) {
    if (!by.has(a.file)) by.set(a.file, [])
    if (a.text !== null) by.get(a.file)?.push(a.text)
  }
  return by
}

/** The private paths whose content may show they hold no secret: a PEM file can carry only certificates (public). */
export const CERT_PATH = /\.pem$/i
const CERT_ARMOR = /^-----(BEGIN|END) CERTIFICATE-----$/
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/
/** Lines a certificate file may hold between its blocks: blank, a `#` comment, openssl's subject and issuer lines. */
const BETWEEN_BLOCKS = /^(?:$|#|subject=|issuer=)/
/** Whether a PEM text holds certificates and nothing else: blocks under certificate markers that pair up (one at least),
 * only base64 inside them, only blank, comment, subject and issuer lines between them, and no secret pattern anywhere (a
 * private key marker, a token in a comment). A key in any other form (PuTTY, JWK, another armor) fails one of these.
 * The base64 inside a block is not decoded. */
export function isCertificateOnly(text: string): boolean {
  if (findSecrets(text).length) return false
  let open = false, blocks = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim(), m = CERT_ARMOR.exec(line)
    if (m) {
      if ((m[1] === 'BEGIN') === open) return false // a BEGIN inside a block, or an END outside one
      open = !open
      if (!open) blocks += 1
    } else if (!(open ? BASE64_LINE : BETWEEN_BLOCKS).test(line)) return false
  }
  return !open && blocks > 0
}
/** Whether lines a diff adds to a certificate file could all belong to one (markers, base64, blank, comment, subject and
 * issuer lines) with no secret pattern among them: what a commit range adds to a `.pem` before its last version. */
export function isCertificateLines(lines: readonly string[]): boolean {
  return lines.every(raw => { const line = raw.trim(); return CERT_ARMOR.test(line) || BASE64_LINE.test(line) || BETWEEN_BLOCKS.test(line) }) && !findSecrets(lines.join('\n')).length
}
