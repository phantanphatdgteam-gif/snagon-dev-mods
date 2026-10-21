// Whole-tree hashing for runner integrity (R2 plan §4.2, step 6; security review S-13), one mechanism for every stack:
// each file under the given folders by content, in one process; a link as its text, its target's real path and, for a
// file, the target's content; a link that leads out of the folders refused unless it is a pinned link's target (a
// venv's interpreter), a file under an allowed folder (the package managers' caches) or anything in the project (a
// workspace package: recorded by its real path, its files are the project's own, which the diff scan reads; one the
// interpreter loads at start is hashed too); a name or link text with a line break or a tab, anything that is not a plain
// file, a folder or a link, and any error of find, stat or the hash fail the hash.
// Every tool is named by its absolute path, so no PATH entry decides what runs (NK-02). The full content hash runs
// before every judged run: spike P4 found the (dev, ino, size, mtime, ctime) pass slower than hashing (GAP-R2-0.6-17
// as changed in step 0).
import type { Io } from './session'

export type TreeSpec = {
  /** Absolute folders hashed whole; none of them present: 'absent'. */
  readonly roots: readonly string[]
  /** Folder names or tails left out at any depth (`__pycache__`, `node_modules/.cache`). */
  readonly prune: readonly string[]
  /** Absolute folders a file link may lead into. */
  readonly outside: readonly string[]
  /** Absolute links whose real target may lie anywhere; their real paths come back. */
  readonly pinned: readonly string[]
  /** The project's root: links into it (outside the roots) are recorded by their real path, not refused. */
  readonly project?: string
  /** ERE on the absolute path: files whose content hash comes back, and small text files whose lines come back. */
  readonly report?: string
  readonly lines?: string
}
export type Tree = {
  readonly hash: string
  /** Reported files' content hashes (a link's: its target's), by path. */
  readonly hashes: Readonly<Record<string, string>>
  readonly lines: Readonly<Record<string, readonly string[]>>
  /** Each pinned link's real path, and that file's content hash. */
  readonly pinned: Readonly<Record<string, { readonly real: string; readonly hash: string }>>
}
/** A setup refusal: a template key and its values. */
export type Problem = { readonly key: string; readonly vars: Readonly<Record<string, string>> }
/** What a stack's runner integrity pins (StackCode.runnerIntegrity): one hash over what the approved runners can load
 * ('absent': nothing installed in the project, never counted as integrity, AC-STK-9); the facts a re-baseline compares
 * (StackCode.rebaseBlock; '' when the stack has none); the plugins the judge loads by name; the refusals S1 shows. */
export type RunnerState = { readonly hash: string; readonly facts: string; readonly load: readonly string[]; readonly problems: readonly Problem[] }
/** Why a tree cannot be pinned: a link out of it (`detail` its target's real path), a file it cannot hash safely, a
 * read error. */
export class TreeError extends Error {
  readonly kind: 'link' | 'file' | 'read'
  readonly path: string
  readonly detail: string
  constructor(kind: 'link' | 'file' | 'read', path: string, detail = '') {
    super(`flow: runner integrity: ${kind} ${path}${detail ? ` (${detail})` : ''}`)
    this.kind = kind
    this.path = path
    this.detail = detail
  }
}
/** A TreeError as a setup refusal (template key and its values); null for any other error. */
export function treeProblem(err: unknown): Problem | null {
  if (!(err instanceof TreeError)) return null
  if (err.kind === 'link') return { key: 'setup.runnerLink', vars: { path: err.path, target: err.detail } }
  return err.kind === 'file' ? { key: 'setup.runnerFile', vars: { path: err.path } } : { key: 'setup.runnerRead', vars: { detail: `${err.path} ${err.detail}`.trim() } }
}

// Output lines: e (hashed), h (a file link's target, hashed after), p (a pinned link), q (a reported link), r (a reported
// file), x (a reported file's line). Errors: `<kind>\t<path>\t<detail>` on stderr, exit 3.
const AWK = String.raw`
BEGIN {
  nr = split(ENVIRON["ROOTS"], R, "\n"); na = split(ENVIRON["ALLOW"], A, "\n"); np = split(ENVIRON["PRUNE"], P, "\n"); nq = split(ENVIRON["PROJECT"], Q, "\n")
  rep = ENVIRON["REPORT"]; lin = ENVIRON["LINES"]
  n = split(ENVIRON["PINS"], X, "\n")
  for (i = 1; i <= n; i++) if (X[i] != "") { split(X[i], kv, "\t"); pin[kv[2]] = 1; print "p\t" X[i]; print "h\t" kv[2] }
}
function under(p, L, n,   i) { for (i = 1; i <= n; i++) if (L[i] != "" && (p == L[i] || index(p, L[i] "/") == 1)) return 1; return 0 }
function pruned(p,   i) { for (i = 1; i <= np; i++) if (P[i] != "" && index(p "/", "/" P[i] "/") > 0) return 1; return 0 }
function bad(kind, path, why) { if (!failed) printf "%s\t%s\t%s\n", kind, path, why > "/dev/stderr"; failed = 1; exit 3 }
function report(path, file,   ln, st, k) {
  if (lin == "" || path !~ lin) return
  k = 0
  while ((st = (getline ln < file)) > 0) { print "x\t" path "\t" ln; if (++k > 5000) bad("read", path, "over 5000 lines") }
  if (st < 0) bad("read", path, "unreadable")
  close(file)
}
$0 == "" { next }
$1 == "bad" { bad("file", substr($0, 5), "") }
$1 == "l" { if (NF != 4 || $4 != ".") bad("link", $2, "a line break or tab in its text"); print "e\t" $0; next }
$1 == "t" {
  if (NF != 5 || $5 != ".") bad("link", $3, "a line break or tab in its target")
  type = $2; path = $3; real = $4
  if (type == "Directory") {
    if (under(real, R, nr) ? pruned(real) : !under(real, Q, nq)) bad("link", path, real)
    print "e\t" $0; next
  }
  if (type == "Regular File") {
    known = under(real, R, nr) || under(real, A, na) || (real in pin)
    if (!known && !under(real, Q, nq)) bad("link", path, real)
    start = (rep != "" && path ~ rep) || (lin != "" && path ~ lin)
    print "e\t" $0
    if (known || start) print "h\t" real
    if (rep != "" && path ~ rep) print "q\t" path "\t" real
    report(path, real); next
  }
  if (type == "Symbolic Link") { print "e\t" $0; next }
  bad("file", path, type)
}
match($0, /^[0-9a-f]+ \*\//) && RLENGTH == 67 {
  print "e\t" $0; path = substr($0, 67)
  if (rep != "" && path ~ rep) print "r\t" path "\t" substr($0, 1, 64)
  report(path, path); next
}
{ bad("read", "output", $0) }
END { if (failed) exit 3 }
`
const SCRIPT = String.raw`set -u
(set -o pipefail) 2>/dev/null && set -o pipefail
set -f
export LC_ALL=C
NL='
'
TAB=$(printf '\t')
IFS=$NL
REPORT=$1; LINES=$2; OUTSIDE=$3; PINNED=$4; PRUNE=$5; PROJECT_IN=$6; AWK=$7
shift 7
fail() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >&2; exit 3; }
# REAL: the real path of $1, kept whole (a sentinel stops $(...) from dropping a trailing line break); 2: it holds a line
# break or a tab
real() {
  REAL=$(/bin/realpath "$1" && printf .) || return 1
  case $REAL in *"$NL"*"$NL".|*"$TAB"*) return 2;; esac
  REAL=$(printf '%s' "$REAL" | /usr/bin/sed '$d')
}
roots=''
for r in "$@"; do
  [ -e "$r" ] || continue
  real "$r"; st=$?
  [ $st = 2 ] && fail file "$r" ''
  [ $st = 0 ] || fail read "$r" realpath
  [ -d "$REAL" ] || fail file "$r" ''
  roots="$roots$REAL$NL"
done
[ -n "$roots" ] || { echo absent; exit 0; }
allow=''
for d in $OUTSIDE; do real "$d" 2>/dev/null; st=$?; [ $st = 2 ] && fail file "$d" ''; [ $st = 0 ] && allow="$allow$REAL$NL"; done
project=''
for d in $PROJECT_IN; do real "$d" 2>/dev/null; st=$?; [ $st = 2 ] && fail file "$d" ''; [ $st = 0 ] && project="$project$REAL$NL"; done
pins=''
for l in $PINNED; do real "$l"; st=$?; [ $st = 2 ] && fail file "$l" ''; [ $st = 0 ] || fail read "$l" realpath; pins="$pins$l$TAB$REAL$NL"; done
expr='-false'
for t in $PRUNE; do expr="$expr$NL-o$NL-path$NL*/$t"; done
set -- $roots
out=$(/usr/bin/find -P "$@" \( -type d \( $expr \) \) -prune -o \( -name "*$NL*" -o -name "*$TAB*" -o -lname "*$NL*" -o -lname "*$TAB*" -o \( ! -type f ! -type d ! -type l \) \) -exec /usr/bin/printf 'bad\t%s\n' {} + -o -type f -exec /usr/bin/openssl dgst -sha256 -r {} + -o -type l -exec /usr/bin/stat -f 'l%t%N%t%Y%t.' {} + -exec /usr/bin/stat -L -f 't%t%HT%t%N%t%R%t.' {} + 2>&1) || fail read "$(printf '%s\n' "$out" | /usr/bin/grep -v -e '^[0-9a-f]* \*/' -e "^[lt]$TAB" -e "^bad$TAB" | /usr/bin/head -n 1)" ''
export ROOTS="$roots" ALLOW="$allow" PINS="$pins" PROJECT="$project" PRUNE REPORT LINES
res=$(printf '%s\n' "$out" | /usr/bin/awk -F "$TAB" "$AWK") || exit 3
targets=$(printf '%s\n' "$res" | /usr/bin/sed -n "s/^h$TAB//p")
th=''
if [ -n "$targets" ]; then
  th=$(printf '%s\n' "$targets" | /usr/bin/sort -u | /usr/bin/tr '\n' '\000' | /usr/bin/xargs -0 /usr/bin/openssl dgst -sha256 -r) || fail read 'link targets' ''
fi
digest=$({ printf '%s\n' "$res" | /usr/bin/sed -n "s/^e$TAB//p"; printf '%s\n' "$th"; } | /usr/bin/sort | /usr/bin/openssl dgst -sha256 -r) || fail read digest ''
printf 'hash\t%s\n' "$digest"
# the target hashes the caller reads back: reported and pinned links only (a symlinked cache can have thousands)
export NEED="$(printf '%s\n' "$res" | /usr/bin/awk -F "$TAB" '$1 == "q" || $1 == "p" { print $3 }')"
printf '%s\n' "$th" | /usr/bin/awk 'BEGIN { n = split(ENVIRON["NEED"], N, "\n"); for (i = 1; i <= n; i++) if (N[i] != "") need[N[i]] = 1 } (substr($0, 67) in need) { print "y\t" $0 }'
printf '%s\n' "$res" | /usr/bin/grep "^[pqrx]$TAB" || :
`

/** Content hashes of every file under each path (a file, or a folder walked whole), by path, links followed: a file link
 * by its target's bytes, a folder link walked (a link into a package cache stays covered, security review round 4); a
 * dangling link by its text; `siblings`: also `<path>.*` (a Python module's extension, source and sourceless forms).
 * Bytecode caches aside; one io.run; any error fails (TreeError); a link loop is walked once (find skips the cycle, whose
 * files it reaches by their own path). For the start modules and the toolchain packages a re-baseline must leave as
 * they were. */
export async function pathsHashes(io: Io, paths: readonly string[], siblings = false): Promise<Record<string, string>> {
  if (!paths.length) return {}
  // a name or a link text with a line break or a tab could forge a line: refused (as in SCRIPT)
  const script = `set -u; NL='
'; TAB=$(printf '\t'); for m in "$@"; do for c in "$m"${siblings ? ' "$m".*' : ''}; do [ -e "$c" ] || continue; /usr/bin/find -L "$c" \\( -name "*$NL*" -o -name "*$TAB*" -o -lname "*$NL*" -o -lname "*$TAB*" \\) -exec /usr/bin/printf 'bad\t%s\n' {} + -o -name __pycache__ -prune -o -type f -exec /usr/bin/openssl dgst -sha256 -r {} + -o -type l -exec /usr/bin/stat -f 'link %N%t%Y' {} + || exit 3; done; done`
  const r = await io.run(['/bin/sh', '-c', script, 'sh', ...paths], { timeoutMs: 120_000 })
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw new TreeError('read', paths[0] ?? '', r.stderr.trim().split('\n')[0] ?? '')
  const bad = r.stdout.split('\n').find(l => l.startsWith('bad\t'))
  if (bad !== undefined) throw new TreeError('file', bad.slice(4), '')
  return Object.fromEntries(r.stdout.split('\n').flatMap(l => { const m = /^([0-9a-f]{64}) \*(.*)$/.exec(l) ?? /^link (.*)\t(.*)$/.exec(l); return m ? [l.startsWith('link ') ? [m[1] ?? '', `link:${m[2] ?? ''}`] : [m[2] ?? '', m[1] ?? '']] : [] }))
}
/** The first toolchain package whose files differ between two freezes (added, changed or gone), or null; both stacks'
 * re-baseline refuse it (owner decision 2026-10-19). */
export function toolChanged(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): string | null {
  const x = a ?? {}, y = b ?? {}, k = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().find(n => x[n] !== y[n])
  return k === undefined ? null : `${k} (toolchain)`
}
/** One digest per path over the files pathsHashes finds under it (`siblings`: and its `<path>.*`), keyed by `key`; a
 * path with no file is left out. */
export async function digestsOf(io: Io, paths: readonly string[], siblings: boolean, key: (p: string) => string): Promise<Record<string, string>> {
  const files = await pathsHashes(io, [...new Set(paths)], siblings), out: Record<string, string> = {}
  for (const m of new Set(paths)) {
    const own = Object.fromEntries(Object.entries(files).filter(([p]) => p === m || p.startsWith(`${m}/`) || (siblings && p.startsWith(`${m}.`))))
    if (Object.keys(own).length) out[key(m)] = await mapDigest(own)
  }
  return out
}
/** One SHA-256 over a map's entries, sorted. */
export async function mapDigest(m: Readonly<Record<string, string>>): Promise<string> {
  const text = Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}\t${v}`).join('\n')
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** One hash over the trees (`spec`), with what it reports; throws TreeError. */
export async function treeDigest(io: Io, spec: TreeSpec): Promise<Tree> {
  const none: Tree = { hash: 'absent', hashes: {}, lines: {}, pinned: {} }
  if (!spec.roots.length) return none
  const odd = [...spec.roots, ...spec.prune, ...spec.outside, ...spec.pinned, spec.project ?? ''].find(x => /[\n\t]/.test(x))
  if (odd !== undefined) throw new TreeError('file', odd)
  const r = await io.run(['/bin/sh', '-c', SCRIPT, 'sh', spec.report ?? '', spec.lines ?? '', spec.outside.join('\n'), spec.pinned.join('\n'), spec.prune.join('\n'), spec.project ?? '', AWK, ...spec.roots], { timeoutMs: 300_000 })
  if (r.exitCode !== 0) {
    const m = [...r.stderr.matchAll(/^(link|file|read)\t([^\t\n]*)\t?([^\n]*)$/gm)].at(-1)
    throw new TreeError((m?.[1] ?? 'read') as TreeError['kind'], m?.[2] ?? '', m ? (m[3] ?? '') : r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`)
  }
  if (r.isStdoutTruncated) throw new TreeError('read', spec.roots[0] ?? '', 'the report is over 4 MiB')
  const out = r.stdout.split('\n')
  if (out[0] === 'absent') return none
  const hash = /^hash\t([0-9a-f]{64}) /.exec(out[0] ?? '')?.[1]
  if (!hash) throw new TreeError('read', spec.roots[0] ?? '', 'no hash')
  const targets = new Map<string, string>(), hashes: Record<string, string> = {}, lines: Record<string, string[]> = {}, pins: Record<string, string> = {}
  for (const l of out) { const m = /^y\t([0-9a-f]{64}) \*(.*)$/.exec(l); if (m) targets.set(m[2] ?? '', m[1] ?? '') }
  for (const l of out.slice(1)) {
    const [kind, a = '', ...rest] = l.split('\t'), b = rest.join('\t')
    if (kind === 'r') hashes[a] = b
    else if (kind === 'q') hashes[a] = targets.get(b) ?? ''
    else if (kind === 'x') (lines[a] ??= []).push(b)
    else if (kind === 'p') pins[a] = b
  }
  return { hash, hashes, lines, pinned: Object.fromEntries(Object.entries(pins).map(([k, real]) => [k, { real, hash: targets.get(real) ?? '' }])) }
}
