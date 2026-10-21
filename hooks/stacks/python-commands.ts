// The Python stack's commands (R2 plan §4.2, spikes P1–P3): what S1 proposes (the venv's console scripts pytest, ruff
// and mypy), the runner a command line names and the flags that weaken it (hooks/flow-setup.ts); the root's config file
// a runner reads (hooks/flow-run.ts); how the judge runs each runner, with pytest's JUnit report and every cache off or
// in the run folder, and the environment it runs with; registry credentials in the environment and in project files.
import type { Io } from '../session'
import type { FlowCommand } from '../flow-state'
import type { Stack } from '../../flow/data/types'

const base = (x: string): string => x.slice(x.lastIndexOf('/') + 1)
const PYTHON_EXE = /^python(?:\d+(?:\.\d+)?)?$/
/** Where the runner's own words start: after the program, or after `python -m <module>`. */
const runnerAt = (argv: readonly string[]): number => (PYTHON_EXE.test(base(argv[0] ?? '')) ? argv.indexOf('-m') + 1 : 0)

/** The runner a command line names: `.venv/bin/pytest` is pytest, `python -m mypy` is mypy; else its first program. */
export function runnerOf(argv: readonly string[]): string {
  const at = runnerAt(argv)
  return at > 0 ? (argv[at] ?? '') : base(argv[0] ?? '')
}

/** What makes a failing check pass or run less than all of it (spec AC-PY-1): an exit forced to 0, pytest's selection
 * and stop flags, a plugin turned off, ruff's --exit-zero and --fix. Shown in the setup echo, not refused. */
/** An option's value: quoted whole, or one word. */
const VALUE = `(?:=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`
const WEAK = [
  /\|\|\s*(?:true|:|exit\s+0)(?![\w-])/, /;\s*exit\s+0(?![\w-])/,
  // -x alone or among short flags (-xvs); `-rx` is -r with its report characters
  /(?<!\S)-(?!r)[a-wyzA-Z]*x[a-zA-Z]*(?!\S)/, /(?<!\S)--exitfirst(?!\S)/, new RegExp(`(?<!\\S)--maxfail${VALUE}`),
  /(?<!\S)--(?:lf|last-failed|sw|stepwise|stepwise-skip|co|collect-only)(?!\S)/,
  new RegExp(`(?<!\\S)-[a-zA-Z]*k${VALUE}`), new RegExp(`(?<!(?:^|[\\s/])python[\\d.]*\\s+)(?<!\\S)-m${VALUE}`), new RegExp(`(?<!\\S)--deselect${VALUE}`), new RegExp(`(?<!\\S)--ignore(?:-glob)?${VALUE}`),
  /(?<!\S)-p\s*no:\S+/, /(?<!\S)--exit-zero(?!\S)/, /(?<!\S)--fix(?!\S)/,
]
export const weakFlags = (text: string): string[] => WEAK.flatMap(re => { const m = re.exec(text); return m ? [m[0].replace(/\s+/g, ' ')] : [] })

// A proposal the owner approves at S2 reads pyproject.toml by lines; what decides security reads it with the strict
// TOML reader (step 5).
const headerRe = (name: string): string => `^\\s*\\[\\s*${name.replace(/\./g, '\\.')}\\s*(?:\\.[^\\]\\n]*)?\\]\\s*(?:#.*)?$`
const hasTable = (text: string, name: string): boolean => new RegExp(headerRe(name), 'm').test(text)
/** Whether a requirement string in the file names the package (`"ruff>=0.16"`, `'mypy'`). */
const requires = (text: string, pkg: string): boolean => new RegExp(`["']${pkg}(?:\\[[^\\]]*\\])?\\s*(?:[<>=!~;@ ]|["'])`, 'i').test(text)
/** The lines of table `[name]` itself, up to the next table header. */
function tableBody(text: string, name: string): string {
  const lines = text.split('\n'), own = new RegExp(`^\\s*\\[\\s*${name.replace(/\./g, '\\.')}\\s*\\]`)
  const at = lines.findIndex(l => own.test(l))
  if (at < 0) return ''
  const end = lines.findIndex((l, i) => i > at && /^\s*\[\[?\s*[A-Za-z_"']/.test(l))
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n')
}

/**
 * The stack's commands from pyproject.toml (`manifest`, null when absent) and the root's names (R2 plan §4.2): `test` is
 * the venv's pytest, which also runs unittest suites; `lint` ruff check when ruff is configured or required; `typecheck`
 * mypy when it is, bare when its config names the files, else on `src` or the root (GAP-R2-0.6-42); no build. An
 * override's argv (split on spaces) replaces one, `<id>=none` drops it.
 */
export function proposeCommands(manifest: string | null, _pm: string, overrides: Readonly<Record<string, string>>, rootNames: readonly string[] = []): { commands: FlowCommand[]; scripts: Record<string, string> } {
  const text = manifest ?? '', has = (n: string): boolean => rootNames.includes(n)
  const mypyConfig = has('mypy.ini') || has('.mypy.ini'), mypyFiles = mypyConfig || /^\s*files\s*=/m.test(tableBody(text, 'tool.mypy'))
  const proposed: ReadonlyArray<readonly [string, string[] | null]> = [
    ['test', ['.venv/bin/pytest']],
    ['typecheck', hasTable(text, 'tool.mypy') || mypyConfig || requires(text, 'mypy') ? ['.venv/bin/mypy', ...(mypyFiles ? [] : [has('src') ? 'src' : '.'])] : null],
    ['lint', hasTable(text, 'tool.ruff') || has('ruff.toml') || has('.ruff.toml') || requires(text, 'ruff') ? ['.venv/bin/ruff', 'check'] : null],
    ['build', null],
  ]
  const commands: FlowCommand[] = []
  for (const [id, own] of proposed) {
    const over = overrides[id]
    if (over === 'none') continue
    const argv = over !== undefined ? over.split(/\s+/).filter(Boolean) : own
    if (argv?.length) commands.push({ id, argv, runner: runnerOf(argv), mode: 'must-pass' })
  }
  return { commands, scripts: {} }
}

/** Where each runner looks for its config in a folder, in its own order (spikes P1, P2): a file, and the section that
 * makes a shared file its config (null: the file always is). */
const CONFIGS: Readonly<Record<string, ReadonlyArray<readonly [string, RegExp | null]>>> = {
  // pytest 9 reads pytest.toml and .pytest.toml first (security review, step 3)
  pytest: [['pytest.toml', null], ['.pytest.toml', null], ['pytest.ini', null], ['.pytest.ini', null], ['pyproject.toml', /^\s*\[\s*tool\.pytest(?:\.ini_options)?\s*\]/m], ['tox.ini', /^\s*\[\s*pytest\s*\]/m], ['setup.cfg', /^\s*\[\s*tool:pytest\s*\]/m]],
  ruff: [['.ruff.toml', null], ['ruff.toml', null], ['pyproject.toml', /^\s*\[\s*tool\.ruff(?:\.[^\]\n]*)?\s*\]/m]],
  mypy: [['mypy.ini', null], ['.mypy.ini', null], ['pyproject.toml', /^\s*\[\s*tool\.mypy(?:\.[^\]\n]*)?\s*\]/m], ['setup.cfg', /^\s*\[\s*mypy\s*\]/m]],
}
/** The root's config file the command's runner reads ('' when it has none; undefined for any other program). The judge
 * pins it, so no config above the root or in the user's home is read (GAP-R2-0.6-23, -25). */
export async function configFor(io: Io, root: string, argv: readonly string[]): Promise<string | undefined> {
  const order = CONFIGS[runnerOf(argv)]
  if (!order) return undefined
  for (const [file, section] of order) {
    const text = await io.read(`${root}/${file}`).catch(() => null)
    if (text !== null && (section === null || section.test(text))) return file
  }
  return ''
}

/** The section a pytest config file keeps its options in (pytest.toml and the ini files: `[pytest]`). */
const pytestSection = (file: string): RegExp => CONFIGS.pytest?.find(([f]) => f === file)?.[1] ?? /^\s*\[\s*pytest\s*\]/m
/** The TOML value at the start of `text` as words: a basic or literal string (triple-quoted too), or an array of them
 * (an item holding white space quoted); comments and anything else left out. */
function tomlWords(text: string): string {
  const words: string[] = []
  let depth = 0, i = 0
  while (i < text.length) {
    const c = text[i] ?? ''
    if (c === '#') { const end = text.indexOf('\n', i); if (end < 0) break; i = end; continue }
    if (c === '[' || c === ']') { depth += c === '[' ? 1 : -1; i += 1; if (depth <= 0) break; continue }
    if (c === '"' || c === "'") {
      const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      let j = i + q.length, s = ''
      while (j < text.length && !text.startsWith(q, j)) { if (c === '"' && text[j] === '\\') j += 1; s += text[j] ?? ''; j += 1 }
      words.push(depth > 0 && /\s/.test(s) ? `"${s}"` : s)
      i = j + q.length
      if (depth === 0) break
      continue
    }
    if (depth === 0 && !/\s/.test(c)) break
    i += 1
  }
  return words.filter(Boolean).join(' ')
}
/** The addopts values of an INI file's pytest section as pytest's iniconfig reads them: blank and comment lines (`#`,
 * `;`, indented too) are skipped, a line that starts with white space continues the value above, and only a line in
 * column 0 starts a key or a section (code review r1). */
function iniAddopts(section: RegExp, lines: readonly string[]): string[] {
  const out: string[] = [], words = (v: readonly string[]): string => v.filter(Boolean).join(' ')
  let inside = false, value: string[] | null = null
  for (const line of lines) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue
    if (/^\s/.test(line)) { value?.push(line.trim()); continue }
    if (value) out.push(words(value))
    value = null
    if (line.startsWith('[')) inside = section.test(line)
    else if (inside) { const m = /^addopts\s*[=:]\s*(.*)$/.exec(line); if (m) value = [m[1]?.trim() ?? ''] }
  }
  return value ? [...out, words(value)] : out
}
/** The addopts values of a TOML file's pytest table: each a string or an array of strings (tomlWords). */
function tomlAddopts(section: RegExp, lines: readonly string[]): string[] {
  let inside = false
  return lines.flatMap((line, i) => {
    if (/^\s*\[/.test(line)) { inside = section.test(line); return [] }
    const m = inside ? /^\s*(?:addopts|"addopts"|'addopts')\s*=\s*(.*)$/.exec(line) : null // a quoted key too (security review r3)
    return m ? [tomlWords([m[1] ?? '', ...lines.slice(i + 1)].join('\n'))] : []
  })
}
/** pytest's addopts in a config file configFor names (R2 plan §4.5), as one line of words for the setup echo's weak
 * flags: every `addopts` of the file's pytest section (a TOML string or array, or an INI value with its continuation
 * lines); '' when there is none. Shown, never refused (GAP-R2-0.6-96). */
export function addoptsIn(file: string, text: string): string {
  const section = pytestSection(file), lines = text.split(/\r?\n/)
  return (file.endsWith('.toml') ? tomlAddopts(section, lines) : iniAddopts(section, lines)).filter(Boolean).join(' ')
}
/** The options pytest takes from the root's config file the judge pins (configFor), for the setup echo; null for any
 * other runner, or when the file holds none. A file configFor chose that cannot be read now fails S1 (code review r1). */
export async function configOptions(io: Io, root: string, argv: readonly string[]): Promise<{ file: string; text: string } | null> {
  const file = runnerOf(argv) === 'pytest' ? await configFor(io, root, argv) : undefined
  if (!file) return null
  const text = addoptsIn(file, await io.read(`${root}/${file}`))
  return text ? { file, text } : null
}

/**
 * The command as the judge runs it (AC-STK-12): pytest writes its JUnit report (xunit1, P1) into `runDir`, with no
 * cache, the root as rootdir and conftest limit, a collection error not hiding the rest, its summary in the `=` form and
 * its config pinned (GAP-R2-0.6-23); ruff and mypy keep no cache in the project and read only the pinned config
 * (GAP-R2-0.6-25). `config`: configFor's answer. Any other command runs as approved, with no report.
 */
export function judgedArgv(argv: readonly string[], runner: string, runDir: string, config?: string, load: readonly string[] = []): { argv: string[]; reportFile: string | null } {
  if (runner === 'pytest') {
    const report = `${runDir}/report.xml`
    // the venv's pytest11 plugins S2 froze, by name: autoload is off in the judge (GAP-R2-0.6-12)
    return { argv: [...argv, '-p', 'no:cacheprovider', ...load.flatMap(n => ['-p', n]), '-o', 'junit_family=xunit1', `--junitxml=${report}`, '--junit-prefix=', '--rootdir=.', '--confcutdir=.', '--continue-on-collection-errors', '--verbosity=0', '-c', config || '/dev/null'], reportFile: report }
  }
  if (runner === 'ruff') {
    // the subcommand by name: a global option's value can come first (`ruff --config x.toml check`)
    const sub = argv.slice(runnerAt(argv) + 1).find(a => a === 'check' || a === 'format')
    if (sub !== 'check' && sub !== 'format') return { argv: [...argv], reportFile: null }
    return { argv: [...argv, '--no-cache', ...(sub === 'check' ? ['--output-format=concise'] : []), config ? `--config=${config}` : '--isolated'], reportFile: null }
  }
  if (runner === 'mypy') return { argv: [...argv, `--cache-dir=${runDir}/mypy`, '--show-error-codes', `--config-file=${config ?? ''}`], reportFile: null }
  return { argv: [...argv], reportFile: null }
}

/** The interpreter's and pytest's settings in the judge (GAP-R2-0.6-2, -3, -12): bytecode only under the run folder,
 * a fixed hash seed, UTF-8 output, neither the script folder nor the user site on sys.path, no plugin autoload. */
export const judgeEnv = (o: { runDir: string }): string[] => [`PYTHONPYCACHEPREFIX=${o.runDir}/pyc`, 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONHASHSEED=0', 'PYTHONIOENCODING=utf-8', 'PYTHONSAFEPATH=1', 'PYTHONNOUSERSITE=1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD=1']

/** Registry credentials in the environment, by name (values are never read here): the stack's list, poetry's tokens and
 * passwords per repository, uv's passwords per index. An index URL that carries a password is found by its value
 * (urlEnvNames, flow-setup.ts). */
export const authEnvNames = (names: readonly string[], stack: Stack): string[] =>
  names.filter(n => stack.registryAuthEnv.includes(n) || /^(?:POETRY_(?:PYPI_TOKEN_\w+|HTTP_BASIC_\w+_PASSWORD)|UV_INDEX_\w+_PASSWORD)$/.test(n))
/** The variables a Python package tool can read a registry URL from: its own prefix (pip, uv, poetry, pdm, pipenv, twine,
 * hatch, flit) covers every index, repository, find-links and mirror variable without a list to keep. Setup refuses one
 * whose URL carries a password (R2 step 10, GAP-R2-0.6-95). */
export const urlEnvNames = (names: readonly string[]): string[] => names.filter(n => /^(?:PIP|UV|POETRY|PDM|PIPENV|TWINE|HATCH|FLIT)_/.test(n))

/** Whether a project file holds a registry credential, comment lines aside: a URL with a password in any of them (pip's
 * index-url, a requirements file's --index-url, uv's and pyproject's index urls); a password or token key; and any key
 * of poetry.toml's [pypi-token] table (`poetry config --local`). pyproject.toml is read for URLs only. */
export function hasAuth(file: string, text: string): boolean {
  const lines = text.split('\n').filter(l => !/^\s*[#;]/.test(l))
  // an empty user too (reviews r2), and one holding `@`: pip splits at the last `@` (security review r4)
  if (lines.some(l => /\b[a-z][\w+.-]*:\/\/[^/\s'"]*:[^/\s@'"]+@/i.test(l))) return true
  if (file === 'pyproject.toml') return false
  let table = ''
  return lines.some(l => {
    const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(l)?.[1]
    if (header !== undefined) { table = header; return false }
    return /^\s*["']?(?:password|token)["']?\s*[=:]/i.test(l) || (table === 'pypi-token' && /^\s*["']?[\w.-]+["']?\s*=/.test(l))
  })
}
