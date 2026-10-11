// @ts-nocheck
// Vendored from everything-claude-code 2.2.3, scripts/hooks/gateguard-fact-force.js (MIT License, Copyright (c) 2026 Affaan Mustafa; see CREDITS.md).
// Changes: CommonJS turned into ES module exports; Node-only parts (state files, environment overrides, stdin entry
// points) removed so the code runs inside a Claude Code hooks module. Logic otherwise unchanged.
import { extractCommandSubstitutions, extractSubshellGroups, extractBraceGroups } from './shell-substitution'
import { stripHeredocBodies } from './heredoc'

// SQL keywords remain a phrase check. Quoted strings are stripped before
// this regex runs so a commit message mentioning "drop table" stays passive.
// `dd if=` used to be a fourth arm here. Matching it as text could not work:
// the arm ended in `=`, so the shared trailing \b required the NEXT character
// to be a word character and `dd if=/dev/zero` slipped through while
// `echo dd if=x` — which runs no dd at all — was gated. The boundary decided
// the verdict instead of the command position, so dd moved to isDestructiveDd()
// alongside the other token-based detectors (#2642).
const DESTRUCTIVE_SQL = /\b(drop\s+table|delete\s+from|truncate)\b/i;

// Operator-supplied additional destructive patterns. Lazily compiled from
// `GATEGUARD_BASH_EXTRA_DESTRUCTIVE` (regex source) on first use, then  [not used in this module: see getExtraDestructiveRegex below]
// memoized keyed by the env-var value so a test or long-running process
// that flips the env between calls re-reads it without paying for a
// recompile on every invocation. A malformed regex is treated as
// "not configured" (the gate falls back to the built-in patterns) and
// the parse failure is logged once via `[gateguard-fact-force]` to
// stderr — hooks must never crash tool execution because of operator
// config errors.
let extraDestructiveCacheKey = null;
let extraDestructiveCacheRegex = null;
let extraDestructiveWarnLogged = false;
// Operator-supplied extra destructive patterns came from an environment variable upstream; not used here.
function getExtraDestructiveRegex() { return null; }

function stripQuotedStrings(input) {
  return input.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Promote subshell delimiters to top-level segment separators so the
 * destructive check applies inside `$(...)` and backtick subshells.
 * Without this, `echo y | $(rm -rf /tmp)` and ``echo y | `rm -rf /tmp` ``
 * slip past the segment splitter because the destructive command lives
 * inside a sub-expression. Run iteratively to handle a layer of nesting.
 *
 * @param {string} input
 * @returns {string}
 */
function explodeSubshells(input) {
  let out = input;
  for (let i = 0; i < 4; i += 1) {
    const before = out;
    out = out.replace(/\$\(([^()`]*)\)/g, ';$1;');
    out = out.replace(/`([^`]*)`/g, ';$1;');
    if (out === before) break;
  }
  return out;
}

/**
 * Split a command line into top-level segments at unquoted shell
 * separators (`;`, `|`, `&`, `&&`, `||`) and across subshells
 * (`$(...)` / backticks). Quoted strings are stripped first so
 * separators inside quotes are not split on. Per-segment comments
 * are also stripped.
 *
 * @param {string} input
 * @returns {string[]}
 */
function splitCommandSegments(input) {
  const stripped = explodeSubshells(stripQuotedStrings(input));
  return stripped
    .split(/[;|&]+/)
    .map(segment => segment.replace(/(^|\s)#.*/, '$1').trim())
    .filter(Boolean);
}

/**
 * Tokenize a single command segment by whitespace. Quoted strings
 * are already collapsed to empty quotes by `stripQuotedStrings`, so
 * naive whitespace splitting is sufficient.
 *
 * @param {string} segment
 * @returns {string[]}
 */
function tokenize(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

/**
 * Tokenize a short allowlisted shell command while preserving quoted
 * arguments. This is intentionally smaller than a full shell parser: the
 * caller rejects shell control characters before invoking it, so this only
 * needs to keep spaces inside quotes together for read-only git commands.
 *
 * @param {string} input
 * @returns {string[] | null}
 */
function tokenizeAllowlistedShellWords(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of String(input || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += '\\';
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

const SHELL_SEGMENT_SEPARATORS = new Set([';', '|', '&', '\n', '\r']);
// Keep only the lexical information needed for Bash's reserved word `time`.
// Quoted/escaped `time` is an external command, not a shell pipeline prefix.
const SHELL_TIME_TOKENS = new WeakMap();

/**
 * Quote-aware split of a command line into segments, with quotes removed from
 * the resulting words. Splits only on UNQUOTED `;`, `|`, `&`, and newlines so:
 *  - a quoted command word (`'rm'`, `"rm"`) normalizes to `rm` (the shell
 *    treats quotes around a command name as transparent), and
 *  - a newline behaves as a command separator (the shell runs each line),
 * neither of which `stripQuotedStrings` + naive splitting handles — both were
 * destructive-classifier bypasses (GHSA-4v57-ph3x-gf55).
 *
 * @param {string} input
 * @returns {string[][]} array of dequoted token arrays, one per segment
 */
function quoteAwareSegments(input) {
  const segments = [];
  let words = [];
  let timeTokens = new Set();
  let current = '';
  let hasWord = false;
  let literalWord = true;
  let quote = null;
  let escaped = false;

  const flushWord = () => {
    if (hasWord) {
      if (literalWord && ['time', '-p', '--'].includes(current)) timeTokens.add(words.length);
      words.push(current);
    }
    current = '';
    hasWord = false;
    literalWord = true;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) {
      if (timeTokens.size) SHELL_TIME_TOKENS.set(words, timeTokens);
      segments.push(words);
    }
    words = [];
    timeTokens = new Set();
  };

  const source = String(input || '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      current += ch;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      const next = source[i + 1];
      // Single quotes preserve every backslash; double quotes only escape
      // shell-special characters. env -S must receive those literal bytes.
      if (quote === '"' && next && !['$', '`', '"', '\\', '\n'].includes(next)) {
        current += ch;
        hasWord = true;
        continue;
      }
      if (next === '\n') {
        i += 1;
        continue;
      }
      literalWord = false;
      escaped = true;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      hasWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      literalWord = false;
      hasWord = true; // entering a quote starts a word, even if its content is empty
      continue;
    }
    if (SHELL_SEGMENT_SEPARATORS.has(ch)) {
      flushSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    current += ch;
    hasWord = true;
  }
  flushSegment();
  return segments;
}

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * SQL clients whose `-c`/`-e`/positional arguments carry SQL statements.
 * Quoted SQL (e.g. `psql -c "drop table users"`) is invisible to the
 * quote-stripping SQL regex, so it is re-checked here against dequoted
 * tokens where quoted content is preserved (issue #3024). Restricted to
 * known clients so `git commit -m "drop table"` and `echo "drop table"`
 * stay allowed.
 */
const SQL_CLIENT_COMMANDS = new Set([
  'psql',
  'postgres',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlite',
  'sqlcmd',
  'isql',
  'pgcli',
  'mycli',
  'duckdb',
  'bq',
]);

/**
 * Strip SQL string literals so phrases inside query data do not trigger
 * the destructive detector (e.g. `SELECT 'drop table' ...` is a read).
 * Handles single-quoted literals with '' escapes, double-quoted
 * identifiers, and dollar-quoted blocks ($$...$$ and $tag$...$tag$).
 *
 * @param {string} input
 * @returns {string}
 */
function stripSqlLiterals(input) {
  return String(input || '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g, '$$$$');
}

const SUDO_VALUE_FLAGS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-U',
  '--other-user',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-D',
  '--chdir',
  '-h',
  '--host',
  '-r',
  '--role',
  '-t',
  '--type',
  '-T',
  '--command-timeout',
]);

const DOAS_VALUE_FLAGS = new Set(['-u', '-C']);
const EXEC_VALUE_FLAGS = new Set(['-a']);
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0', '-S', '--split-string']);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split one literal env -S argument into argv, never into shell programs.
 * Operators, substitutions and variable spellings stay literal text; no host
 * environment is read. A dynamic executable name therefore remains opaque.
 * Unterminated quotes, unknown escapes and invalid quoted \c return null.
 * This is bounded literal parsing, not GNU env variable interpolation.
 *
 * @param {string} source
 * @returns {string[] | null}
 */
function splitEnvWords(source) {
  const words = [];
  let word = '';
  let hasWord = false;
  let quote = null;
  const flush = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const escapes = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\' && quote !== "'") {
      const next = source[++i];
      if (next === undefined) return null;
      if (next === 'c') {
        if (quote) return null;
        flush();
        return words;
      }
      if (next === '_') {
        if (quote) {
          word += ' ';
          hasWord = true;
        } else flush();
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(escapes, next)) word += escapes[next];
      else if (['#', '$', '"', "'", '\\'].includes(next)) word += next;
      else return null;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      hasWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true;
    } else if (ch === '#' && !hasWord) {
      break;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      word += ch;
      hasWord = true;
    }
  }
  if (quote) return null;
  flush();
  return words;
}

/** Locate a value-taking flag, including the tail of a short-option cluster. */
function wrapperValueOption(arg, valueFlags) {
  if (arg.startsWith('--')) {
    const separator = arg.indexOf('=');
    const name = separator === -1 ? arg : arg.slice(0, separator);
    return valueFlags.has(name)
      ? { name, value: separator === -1 ? undefined : arg.slice(separator + 1) }
      : null;
  }
  if (!arg.startsWith('-')) return null;
  for (let i = 1; i < arg.length; i += 1) {
    const name = `-${arg[i]}`;
    if (valueFlags.has(name)) {
      return { name, value: i + 1 < arg.length ? arg.slice(i + 1) : undefined };
    }
  }
  return null;
}

// Explicit external-launcher argv grammars for dd, SQL clients and shell-wrapper discovery.
// Unknown flags do not justify guessing which later argument executes.
// This literal allowlist cannot prove arbitrary custom-wrapper semantics or
// resolve dynamically selected executables; quoted operand text stays data.
const DD_LAUNCHER_OPTIONS = {
  xargs: {
    values: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-J', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var']),
    optional: new Set(['-e', '--eof', '-i', '--replace', '-l', '--max-lines']),
    flags: new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive', '-x', '--exit', '-o', '--open-tty', '--show-limits'])
  },
  timeout: {
    values: new Set(['-k', '--kill-after', '-s', '--signal']),
    optional: new Set(),
    flags: new Set(['-v', '--verbose', '--foreground', '--preserve-status'])
  },
  nice: { values: new Set(['-n', '--adjustment']), optional: new Set(), flags: new Set() },
  nohup: { values: new Set(), optional: new Set(), flags: new Set() },
  time: {
    values: new Set(['-f', '--format', '-o', '--output-file']),
    optional: new Set(),
    flags: new Set(['-p', '--portability', '-a', '--append', '-q', '--quiet', '-v', '--verbose']),
    nonCommand: new Set(['--help', '-V', '--version'])
  },
  stdbuf: {
    values: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
    optional: new Set(), flags: new Set()
  },
  ionice: {
    values: new Set(['-c', '--class', '-n', '--classdata']),
    optional: new Set(), flags: new Set(['-t', '--ignore']),
    // These modes query/change existing processes rather than launch argv.
    nonCommand: new Set(['-p', '--pid', '-P', '--pgid', '-u', '--uid'])
  },
  setsid: {
    values: new Set(), optional: new Set(),
    flags: new Set(['-c', '--ctty', '-f', '--fork', '-w', '--wait'])
  }
};

/** Return the command position after one explicitly supported launcher's options. */
function ddLauncherCommandIndex(argv, index, name) {
  const { values, optional, flags, nonCommand } = DD_LAUNCHER_OPTIONS[name];
  // GNU time uses getopt_long: unique prefixes resolve against its complete
  // eight-option table, including terminating help/version. Other launchers
  // retain their explicit spellings; this does not affect shell-keyword time.
  const timeLongOptions = name === 'time'
    ? [...values, ...flags, ...nonCommand].filter(flag => flag.startsWith('--'))
    : null;
  index += 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    // nice retains the historical -N / --N priority spellings.
    if (name === 'nice' && /^--?\d+$/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      let flag = separator === -1 ? arg : arg.slice(0, separator);
      if (timeLongOptions && !timeLongOptions.includes(flag)) {
        const matches = timeLongOptions.filter(option => option.startsWith(flag));
        if (matches.length !== 1) return argv.length;
        [flag] = matches;
      }
      if (nonCommand && nonCommand.has(flag)) return argv.length;
      if (values.has(flag)) index += separator === -1 ? 2 : 1;
      else if (optional.has(flag) || (separator === -1 && flags.has(flag))) index += 1;
      else return argv.length;
      continue;
    }
    let consumesNext = false;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = `-${arg[offset]}`;
      if (nonCommand && nonCommand.has(flag)) return argv.length;
      if (values.has(flag)) {
        consumesNext = offset + 1 === arg.length;
        break;
      }
      if (optional.has(flag)) break;
      if (!flags.has(flag)) return argv.length;
    }
    index += consumesNext ? 2 : 1;
  }
  // timeout's duration is data, followed by exactly one executable position.
  return name === 'timeout' ? index + 1 : index;
}

/**
 * Resolve leading assignments, shell prefixes and sudo/doas/env into command
 * argv. Wrapper-specific option values never become executable names. Every
 * wrapper/split consumes source bytes, so the input-size budget bounds nested
 * expansion without rejecting a valid long chain at an arbitrary depth.
 *
 * @param {string[]} tokens dequoted tokens for one segment
 * @param {boolean} [allowShellBuiltins] false for external argv (e.g. find -exec)
 * @param {boolean} [allowDdLaunchers] opt-in; other shared callers retain their grammar
 * @returns {string[]} normalized argv, or [] when no literal command resolves
 */
function unwrapLeadWrappers(tokens, allowShellBuiltins = true, allowDdLaunchers = false) {
  let argv = tokens.slice();
  let index = 0;
  let allowAssignments = true;
  let allowShellTime = allowShellBuiltins;
  const timeTokens = SHELL_TIME_TOKENS.get(tokens);
  let budget = tokens.reduce((size, token) => size + token.length + 1, 1);
  while (index < argv.length && budget-- > 0) {
    while (allowAssignments && index < argv.length && SHELL_ASSIGNMENT.test(argv[index])) {
      index += 1;
      allowShellTime = false;
    }
    if (index >= argv.length) return [];
    const base = commandBasename(argv[index]);
    if (allowDdLaunchers && allowShellTime && argv[index] === 'time' && timeTokens && timeTokens.has(index)) {
      // Current Bash accepts only raw -p and -- as reserved-time options.
      // Quotes/escapes make them executable words, unlike external time argv.
      // The next command/exec builtin or assignment keeps shell semantics.
      index += 1;
      if (argv[index] === '-p' && timeTokens.has(index)) index += 1;
      if (argv[index] === '--' && timeTokens.has(index)) index += 1;
      continue;
    }
    if (allowShellBuiltins && base === 'command') {
      allowShellTime = false;
      index += 1;
      while (index < argv.length && argv[index].startsWith('-') && argv[index] !== '-') {
        const flag = argv[index++];
        if (flag === '--') break;
        // -v/-V (including -pv) only describe names; no command executes.
        if (!/^-[pVv]+$/.test(flag) || /[vV]/.test(flag)) return [];
      }
      allowAssignments = false;
      continue;
    }
    if (allowShellBuiltins && base === 'exec') {
      allowShellTime = false;
      index += 1;
      while (index < argv.length && argv[index].startsWith('-') && argv[index] !== '-') {
        const flag = argv[index];
        if (flag === '--') {
          index += 1;
          break;
        }
        const option = wrapperValueOption(flag, EXEC_VALUE_FLAGS);
        const flagLetters = option ? flag.slice(1, flag.indexOf('a')) : flag.slice(1);
        if (!/^[cl]*$/.test(flagLetters)) return [];
        index += option && option.value === undefined ? 2 : 1;
      }
      // exec replaces the shell with an external executable; its argument
      // 'command' is not the shell's builtin, and A=1 is not an assignment.
      allowShellBuiltins = false;
      allowAssignments = false;
      continue;
    }
    if (allowDdLaunchers && Object.prototype.hasOwnProperty.call(DD_LAUNCHER_OPTIONS, base)) {
      index = ddLauncherCommandIndex(argv, index, base);
      allowShellTime = false;
      allowShellBuiltins = false;
      allowAssignments = false;
      continue;
    }
    if (base === 'sudo' || base === 'doas') {
      allowShellTime = false;
      allowShellBuiltins = false;
      allowAssignments = true;
      const valueFlags = base === 'sudo' ? SUDO_VALUE_FLAGS : DOAS_VALUE_FLAGS;
      index += 1;
      while (index < argv.length) {
        const flag = argv[index];
        if (flag === '--') {
          index += 1;
          break;
        }
        if (flag === '-' || !flag.startsWith('-')) break;
        const option = wrapperValueOption(flag, valueFlags);
        index += option && option.value === undefined ? 2 : 1;
      }
      continue;
    }
    if (base === 'env') {
      allowShellTime = false;
      allowShellBuiltins = false;
      allowAssignments = true;
      index += 1;
      while (index < argv.length) {
        const arg = argv[index];
        if (arg === '--') {
          index += 1;
          break;
        }
        const option = wrapperValueOption(arg, ENV_VALUE_FLAGS);
        if (option && (option.name === '-S' || option.name === '--split-string')) {
          const separate = option.value === undefined;
          const source = separate ? argv[index + 1] : option.value;
          if (source === undefined || budget-- <= 0) return [];
          const expanded = splitEnvWords(source);
          if (!expanded) return [];
          argv = [...expanded, ...argv.slice(index + (separate ? 2 : 1))];
          index = 0;
          continue;
        }
        if (option) {
          index += option.value === undefined ? 2 : 1;
          continue;
        }
        if (arg.startsWith('-') || SHELL_ASSIGNMENT.test(arg)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    return argv.slice(index);
  }
  return [];
}

/**
 * Detect destructive SQL passed as (possibly quoted) arguments to a known
 * SQL client. Operates on dequoted tokens from `quoteAwareSegments`, so
 * `psql -c "drop table users"` joins back to matchable text.
 *
 * @param {string[]} tokens dequoted tokens for one segment
 * @returns {boolean}
 */
function isDestructiveSqlClient(tokens) {
  if (!tokens || tokens.length === 0) return false;
  const argv = unwrapLeadWrappers(tokens, true, true);
  if (!SQL_CLIENT_COMMANDS.has(commandBasename(argv[0]))) return false;
  return DESTRUCTIVE_SQL.test(stripSqlLiterals(argv.join(' ')));
}

/**
 * Quote-aware destructive check: catches quoted command words, newline
 * separators, quoted `find -exec`, and `sh -c`/`bash -c` wrappers that evade
 * the quote-stripping path (GHSA-4v57-ph3x-gf55).
 *
 * @param {string} raw
 * @param {number} [depth] recursion guard for shell -c wrappers
 * @returns {boolean}
 */
function isDestructiveQuoteAware(raw, depth = 0) {
  if (depth > 4) return false;
  // The outer command was preprocessed already; shell -c introduces a new
  // program whose literal heredoc data must also stay outside execution.
  const executable = depth === 0 ? raw : stripHeredocBodies(raw);
  for (const body of collectExecutableBodies(executable)) {
    for (const tokens of quoteAwareSegments(body)) {
      if (tokens.length === 0) continue;
      if (isDestructiveRm(tokens)) return true;
      if (isDestructiveGit(tokens)) return true;
      if (isDestructiveDd(tokens)) return true;
      if (isDestructiveSqlClient(tokens)) return true;
      if (isDestructiveFindExec(tokens)) return true;
      const argv = unwrapLeadWrappers(tokens, true, true);
      if (SHELL_WRAPPERS.has(commandBasename(argv[0]))) {
        const ci = argv.indexOf('-c', 1);
        if (ci !== -1 && argv[ci + 1] && isDestructiveQuoteAware(argv[ci + 1], depth + 1)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Strip a leading path and trailing `.exe` from a command token so
 * `/usr/bin/git`, `git.exe`, and `GIT` all normalize to `git`.
 *
 * @param {string} token
 * @returns {string}
 */
function commandBasename(token) {
  if (!token) return '';
  return token
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/**
 * Detect a `dd` invocation carrying an `if=` or `of=` operand.
 * Keep the existing input-file gate and include output-only writes from stdin.
 *
 * Token-based rather than a regex arm because the verdict has to depend on
 * `dd` being the command, not on `dd if=` appearing anywhere in the line:
 * `echo dd if=/dev/zero` executes nothing. dd operands are order-free, so
 * `dd of=/dev/sda if=/dev/zero` counts too — a text pattern anchored on
 * `dd\s+if=` missed that spelling entirely.
 *
 * Leading `sudo` / `doas` / `env`, their flags, and `VAR=value` assignment
 * prefixes are skipped so `sudo dd if=/dev/zero` stays the dd invocation it is.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDestructiveDd(tokens, allowShellBuiltins = true) {
  const argv = unwrapLeadWrappers(tokens, allowShellBuiltins, true);
  return commandBasename(argv[0]) === 'dd' && argv.slice(1).some(operand => /^(?:if|of)=/i.test(operand));
}

/**
 * Detect `rm` invocations that recursively force-delete files. Handles
 * combined (`-rf`, `-fr`, `-Rf`) and split (`-r -f`) flag forms.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDestructiveRm(tokens) {
  if (tokens.length === 0 || commandBasename(tokens[0]) !== 'rm') return false;
  let hasR = false;
  let hasF = false;
  for (const t of tokens.slice(1)) {
    if (t === '--recursive') {
      hasR = true;
      continue;
    }
    if (t === '--force') {
      hasF = true;
      continue;
    }
    if (!t.startsWith('-') || t.startsWith('--')) continue;
    const body = t.slice(1);
    if (/[rR]/.test(body)) hasR = true;
    if (/f/.test(body)) hasF = true;
  }
  return hasR && hasF;
}

/**
 * Locate the git subcommand within a token list, skipping over git's
 * global options like `-c key=value`, `-C <path>`, `--git-dir=...`,
 * `--work-tree=...`, `--namespace=...`, `--super-prefix=...`.
 *
 * @param {string[]} tokens
 * @returns {{ command: string, rest: string[] } | null}
 */
function findGitSubcommand(tokens) {
  if (tokens.length === 0 || commandBasename(tokens[0]) !== 'git') return null;
  const valueConsumingShort = new Set(['-c', '-C']);
  const valueConsumingLong = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix']);
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (valueConsumingShort.has(t) || valueConsumingLong.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t.startsWith('--namespace=') || t.startsWith('--super-prefix=')) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) {
      // Unknown global option — skip without consuming a value.
      i += 1;
      continue;
    }
    return { command: t.toLowerCase(), rest: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * Branch names treated as shared history: a forced update of one of
 * these rewrites commits other clones build on, even when the push is
 * lease-checked.
 */
const SHARED_GIT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

/**
 * Decide whether the positional arguments of a `git push` name a shared
 * branch as the destination of a refspec. The first positional token is
 * the remote (unless the remote came from `--repo`); every later
 * positional token is a refspec whose destination is the part after
 * `:` (or the whole token when there is no `:`). A leading `+` force
 * marker is stripped. When no refspec is given the target is the
 * current branch, which the hook cannot know, so this returns false.
 *
 * @param {string[]} rest tokens after `push`
 * @returns {boolean}
 */
function pushTargetsSharedBranch(rest) {
  const valueConsuming = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
  const positional = [];
  let remoteViaFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--repo') {
      remoteViaFlag = true;
      i += 1;
      continue;
    }
    if (t.startsWith('--repo=')) {
      remoteViaFlag = true;
      continue;
    }
    if (valueConsuming.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) continue;
    positional.push(t);
  }
  // Unless the remote came from --repo, positional[0] is the remote and
  // the rest are refspecs.
  const refspecs = remoteViaFlag ? positional : positional.slice(1);
  for (const refspec of refspecs) {
    const cleaned = refspec.startsWith('+') ? refspec.slice(1) : refspec;
    const dst = cleaned.includes(':') ? cleaned.slice(cleaned.indexOf(':') + 1) : cleaned;
    const branch = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst;
    if (SHARED_GIT_BRANCHES.has(branch)) return true;
  }
  return false;
}

/**
 * Detect destructive `git` invocations: `reset --hard`, `checkout --`,
 * `clean -f...`, `push --force` (`--force-with-lease` only to a shared
 * branch), `commit --amend`, `rm -rf`, `branch -D`, `stash drop` /
 * `stash clear`, `reflog expire` / `reflog delete`, `update-ref -d`,
 * and `restore` against the worktree.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDestructiveGit(tokens) {
  const sub = findGitSubcommand(tokens);
  if (!sub) return false;
  const { command, rest } = sub;

  if (command === 'reset') {
    return rest.includes('--hard');
  }

  if (command === 'checkout') {
    // `git checkout -- <path>`, `git checkout .`, and the force forms
    // (`--force` / `-f`) all discard uncommitted working-tree changes,
    // mirroring the `switch` handler below.
    return rest.some(t => {
      if (t === '--' || t === '.' || t === '--force') return true;
      if (!t.startsWith('-') || t.startsWith('--')) return false;
      return t.slice(1).includes('f');
    });
  }

  if (command === 'clean') {
    // `git clean -f`, `-fd`, `-fdx`, `-df`, `--force`
    return rest.some(t => {
      if (t === '--force') return true;
      if (!t.startsWith('-') || t.startsWith('--')) return false;
      return t.slice(1).includes('f');
    });
  }

  if (command === 'push') {
    // Only `--force-with-lease` qualifies as a safety-checked force.
    // `--force-if-includes` is a no-op when used WITHOUT
    // `--force-with-lease` (per git-scm.com/docs/git-push), and when
    // combined with a bare `--force` the bare force is still in effect.
    // So `--force --force-if-includes` must be treated as destructive.
    //
    // A `+` refspec prefix (e.g. `git push origin +main`,
    // `+refs/heads/main:refs/heads/main`) also forces a non-fast-forward
    // update of that ref and is destructive on its own.
    let withLease = false;
    let bareForce = false;
    let plusRefspecForce = false;
    for (const t of rest) {
      if (t === '--force-with-lease' || t.startsWith('--force-with-lease=')) {
        withLease = true;
        continue;
      }
      if (t === '--force' || t.startsWith('--force=')) {
        bareForce = true;
        continue;
      }
      if (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes('f')) {
        bareForce = true;
        continue;
      }
      // Refspec prefix: `+<src>[:<dst>]`. Match tokens like `+main`,
      // `+refs/heads/main`, `+HEAD:branch`, `+:branch`. Exclude bare
      // `+` and numeric-only `+123` which are not refspecs.
      if (t.startsWith('+') && t.length > 1 && /^\+(?:[a-zA-Z_/.:]|HEAD)/.test(t)) {
        plusRefspecForce = true;
      }
    }
    if (bareForce || (plusRefspecForce && !withLease)) return true;
    // A lease-checked force still rewrites a shared branch's history.
    return withLease && pushTargetsSharedBranch(rest);
  }

  if (command === 'commit') {
    return rest.includes('--amend');
  }

  if (command === 'rm') {
    // `git rm -r` / `-rf` / `-r -f` — destructive within the index too.
    let hasR = false;
    for (const t of rest) {
      if (!t.startsWith('-') || t.startsWith('--')) continue;
      if (/[rR]/.test(t.slice(1))) hasR = true;
    }
    return hasR;
  }

  if (command === 'switch') {
    // `git switch` can discard local working-tree changes in three forms:
    //   --discard-changes           explicit discard
    //   --force / -f                ignore conflicts and overwrite
    //   -C <branch>                 force-create (overwrites existing branch)
    return rest.some(t => {
      if (t === '--discard-changes' || t === '--force') return true;
      if (!t.startsWith('-') || t.startsWith('--')) return false;
      // Short combined form: -f, -fC, -Cf, -C
      const body = t.slice(1);
      return /[fC]/.test(body);
    });
  }

  if (command === 'branch') {
    // `git branch -D` (long spelling: `--delete --force`) deletes a
    // branch even when it is unmerged, orphaning its commits. Plain
    // `-d` refuses when unmerged, so it is safe to leave ungated.
    let del = false;
    let force = false;
    for (const t of rest) {
      if (t === '--delete') { del = true; continue; }
      if (t === '--force') { force = true; continue; }
      if (!t.startsWith('-') || t.startsWith('--')) continue;
      const body = t.slice(1);
      if (body.includes('D')) return true;
      if (body.includes('d')) del = true;
      if (body.includes('f')) force = true;
    }
    return del && force;
  }

  if (command === 'stash') {
    // `drop` destroys one stash entry, `clear` the entire stash.
    // `list`, `show`, `pop` and `apply` keep the entries recoverable.
    return rest[0] === 'drop' || rest[0] === 'clear';
  }

  if (command === 'reflog') {
    // `expire` and `delete` remove the recovery net that makes every
    // other gated git command recoverable.
    return rest[0] === 'expire' || rest[0] === 'delete';
  }

  if (command === 'update-ref') {
    // `git update-ref -d <ref>` deletes a ref directly.
    return rest.includes('-d') || rest.includes('--delete');
  }

  if (command === 'restore') {
    // `git restore <path>` overwrites the working tree from the index
    // by default, the modern spelling of gated `git checkout -- <path>`.
    // Only `--staged` alone is non-destructive (it leaves the file on
    // disk untouched); `--worktree` (the default target) is destructive.
    const has = (long, short) => rest.some(t =>
      t === long || (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes(short)));
    const staged = has('--staged', 'S');
    const worktree = has('--worktree', 'W');
    return worktree || !staged;
  }

  return false;
}

/**
 * Decide whether a bash command line contains a destructive action
 * the fact-forcing gate should challenge. Combines SQL-keyword
 * detection (regex on quote-stripped input) with per-segment shell
 * tokenization for shell commands.
 *
 * @param {string} command
 * @returns {boolean}
 */
/**
 * Walk every executable body reachable from a raw command line and
 * return them as a flat list. Bodies that bash will execute live in
 * three different syntactic constructs, each handled by a sibling
 * extractor in `scripts/lib/shell-substitution.js`:
 *   - `$(...)` and backticks via `extractCommandSubstitutions`
 *   - plain `(...)` subshells   via `extractSubshellGroups`
 *   - `{ ...; }` brace groups   via `extractBraceGroups`
 *
 * Each extractor recurses into its own syntax. The BFS here adds
 * cross-syntax discovery — e.g. a `(...)` inside a `$(...)` body, or
 * a `{ ...; }` inside a `(...)` body — by feeding every harvested
 * body back through all three extractors. A `seen` set bounds the
 * cost to O(unique bodies).
 *
 * @param {string} raw
 * @returns {string[]}
 */
function collectExecutableBodies(raw) {
  const bodies = [raw];
  const queue = [raw];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);

    for (const body of extractCommandSubstitutions(current)) {
      if (seen.has(body)) continue;
      bodies.push(body);
      queue.push(body);
    }
    for (const body of extractSubshellGroups(current)) {
      if (seen.has(body)) continue;
      bodies.push(body);
      queue.push(body);
    }
    for (const body of extractBraceGroups(current)) {
      if (seen.has(body)) continue;
      bodies.push(body);
      queue.push(body);
    }
  }

  return bodies;
}

// Find predicates consume their arguments even when a value spells '-exec'.
const FIND_VALUE_PREDICATES = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
  '-type', '-xtype', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin',
  '-ctime', '-cmin', '-newer', '-anewer', '-cnewer', '-used', '-uid', '-gid', '-user',
  '-group', '-perm', '-size', '-inum', '-links', '-fstype', '-context', '-lname', '-ilname',
  '-printf', '-fprint', '-fprint0', '-fls', '-samefile', '-files0-from', '-regextype'
]);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * Inspect each find executable action without mistaking its argv for another
 * action. -ok/-okdir still run the command after their own confirmation, so
 * they retain the explicit destructive gate. A + terminates exec/execdir only
 * after {}; elsewhere it remains an ordinary argument.
 *
 * @param {string | string[]} command raw segment or already dequoted argv
 * @returns {boolean}
 */
function isDestructiveFindExec(command) {
  const quoteAware = Array.isArray(command);
  const tokens = quoteAware ? command : tokenize(String(command || '').trim());
  if (commandBasename(tokens[0]) !== 'find') return false;

  for (let index = 1; index < tokens.length; index += 1) {
    const action = tokens[index];
    if (action === '-fprintf') {
      index += 2;
      continue;
    }
    if (FIND_VALUE_PREDICATES.has(action) || /^-newer[a-zA-Z]{2}$/.test(action)) {
      index += 1;
      continue;
    }
    if (!FIND_EXEC_ACTIONS.has(action)) continue;
    const execTokens = [];
    for (index += 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === ';' || token === '\\;' || (
        token === '+' && (action === '-exec' || action === '-execdir') &&
        execTokens[execTokens.length - 1] === '{}'
      )) break;
      execTokens.push(token);
    }
    if (execTokens.length === 0) continue;
    // The legacy raw fallback can split quoted prose into apparent actions.
    // Preserve its old rm/Git coverage, but classify dd only from real argv.
    if (quoteAware && isDestructiveDd(execTokens, false)) return true;
    const baseCmd = commandBasename(execTokens[0]);
    // Preserve main's existing rm/rmdir/unlink and git-reset handling.
    if (baseCmd === 'rm' || baseCmd === 'rmdir' || baseCmd === 'unlink') return true;
    if (baseCmd === 'git') {
      const sub = findGitSubcommand(execTokens);
      if (sub && sub.command === 'reset' && sub.rest.includes('--hard')) return true;
    }
  }
  return false;
}

function isDestructiveBash(command) {
  // SQL phrases live in command bodies, not as flag-bearing
  // arguments, so we still match them by regex - but on the input
  // after quoting AND subshell delimiters are normalized so phrases
  // inside `$(...)` or backticks are also caught.
  const raw = String(command || '');
  // Keep main's heredoc stripping: a phrase inside a heredoc body is data, not a
  // command. dd is no longer part of this regex — see DESTRUCTIVE_SQL.
  const executable = stripHeredocBodies(raw);
  const flattened = explodeSubshells(stripQuotedStrings(executable));
  if (DESTRUCTIVE_SQL.test(flattened)) return true;

  // Operator-supplied additional destructive patterns. Same scope as the
  // built-in SQL regex: matched against the quote-stripped, subshell-
  // exploded command so a phrase inside `$(...)` or backticks is caught.
  const extra = getExtraDestructiveRegex();
  if (extra && extra.test(flattened)) return true;

  // Check for destructive find -exec patterns on raw body segments (before quote-stripping)
  // so that quoted exec binaries and compound-command prefixes are both handled correctly.
  // splitCommandSegments strips quotes before splitting, so passing its output to
  // isDestructiveFindExec would turn `find . -exec 'rm' {} \;` into `find . -exec  {} \;`
  // — the binary name disappears and the check returns false.  Using raw body text avoids
  // that false-negative while also catching `&&`, `;`, `|`, and `||` compound forms.
  const bodies = collectExecutableBodies(executable);
  for (const body of bodies) {
    for (const rawSeg of body
      .split(/[;|&]+/)
      .map(s => s.trim())
      .filter(Boolean)) {
      if (isDestructiveFindExec(rawSeg)) return true;
    }
  }

  const segments = bodies.flatMap(splitCommandSegments);
  for (const segment of segments) {
    const stripped = stripQuotedStrings(segment);
    if (DESTRUCTIVE_SQL.test(stripped)) return true;
    if (extra && extra.test(stripped)) return true;
    const tokens = tokenize(segment);
    if (isDestructiveRm(tokens)) return true;
    if (isDestructiveGit(tokens)) return true;
  }

  // Quote-aware pass: closes the quoted-command-word, newline-separator,
  // quoted-find-exec, and sh/bash -c bypasses (GHSA-4v57-ph3x-gf55).
  if (isDestructiveQuoteAware(executable)) return true;

  return false;
}

const ASCII_CONTROL_MAX = 0x1f;
const ASCII_DELETE = 0x7f;
const C1_CONTROLS = [0x80, 0x9f]; // Unicode C1 control block (U+0080..U+009F)
const BIDI_MARKS = [0x200e, 0x200f]; // LRM/RLM
const BIDI_EMBEDDINGS = [0x202a, 0x202e]; // LRE..PDF
const BIDI_ISOLATES = [0x2066, 0x2069]; // LRI..PDI
const ZERO_WIDTHS = [0x200b, 0x200d]; // ZWSP..ZWJ
const WORD_JOINER = 0x2060;
const BYTE_ORDER_MARK = 0xfeff;
const VARIATION_SELECTORS = [0xfe00, 0xfe0f];
const VARIATION_SUPPLEMENTS = [0xe0100, 0xe01ef]; // MONGOLIAN..TAGS (VS17..VS256)
const TAG_BLOCK = [0xe0000, 0xe007f]; // ASCII-smuggling tag characters
const MONGOLIAN_VOWEL_SEPARATOR = 0x180e;
const HANGUL_CHOSEONG_FILLER = 0x115f;
const HANGUL_JUNGSEONG_FILLER = 0x1160;
const HANGUL_FILLER = 0x3164;
const INVISIBLE_MATH_OPERATORS = [0x2061, 0x2064]; // FUNCTION APPLICATION..INVISIBLE PLUS
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const SANITIZED_PATH_MAX_LENGTH = 500;

function inRange(code, [lo, hi]) {
  return code >= lo && code <= hi;
}

function sanitizePath(filePath) {
  // Strip control chars (including null), bidi overrides, separators,
  // and the dangerous invisible characters defined by the constants
  // above (mirroring scripts/ci/check-unicode-safety.js), so a denial
  // message cannot carry content a human reviewer cannot see.
  let sanitized = '';
  for (const char of String(filePath || '')) {
    const code = char.codePointAt(0);
    const isAsciiControl =
      code <= ASCII_CONTROL_MAX || code === ASCII_DELETE || inRange(code, C1_CONTROLS);
    const isBidiOverride =
      inRange(code, BIDI_MARKS) || inRange(code, BIDI_EMBEDDINGS) || inRange(code, BIDI_ISOLATES);
    const isUnicodeSeparator = code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
    const isDangerousInvisible =
      inRange(code, ZERO_WIDTHS) ||
      code === WORD_JOINER ||
      code === BYTE_ORDER_MARK ||
      inRange(code, VARIATION_SELECTORS) ||
      inRange(code, VARIATION_SUPPLEMENTS) ||
      inRange(code, TAG_BLOCK) ||
      code === MONGOLIAN_VOWEL_SEPARATOR ||
      code === HANGUL_CHOSEONG_FILLER ||
      code === HANGUL_JUNGSEONG_FILLER ||
      code === HANGUL_FILLER ||
      inRange(code, INVISIBLE_MATH_OPERATORS);
    sanitized += isAsciiControl || isBidiOverride || isUnicodeSeparator || isDangerousInvisible ? ' ' : char;
  }
  return sanitized.trim().slice(0, SANITIZED_PATH_MAX_LENGTH);
}

function normalizeForMatch(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function isClaudeSettingsPath(filePath) {
  const normalized = normalizeForMatch(filePath);
  return /(^|\/)\.claude\/settings(?:\.[^/]+)?\.json$/.test(normalized);
}

function isReadOnlyGitIntrospection(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || /[\r\n;&|><`$()]/.test(trimmed)) {
    return false;
  }

  const segments = splitCommandSegments(trimmed);
  if (segments.length !== 1) {
    return false;
  }

  const tokens = tokenizeAllowlistedShellWords(trimmed);
  if (!tokens) {
    return false;
  }
  if (commandBasename(tokens[0]) !== 'git' || tokens.length < 2) {
    return false;
  }

  const subcommand = tokens[1].toLowerCase();
  const args = tokens.slice(2);

  if (subcommand === 'status') {
    return args.every(arg => ['--porcelain', '--short', '--branch'].includes(arg));
  }

  if (subcommand === 'diff') {
    const allowedDiffArgs = new Set(['--name-only', '--name-status', '--cached', '--staged', '--stat']);
    // git diff without arguments is read-only introspection
    if (args.length === 0) return true;
    return args.length <= 2 && args.every(arg => allowedDiffArgs.has(arg));
  }

  if (subcommand === 'log') {
    return args.every(arg => arg === '--oneline' || /^--max-count=\d+$/.test(arg));
  }

  if (subcommand === 'show') {
    // Permite: git show <ref>, git show --stat, git show --name-only,
    // git show <ref> --stat, git show <ref> --name-only
    if (args.length === 0) return false;
    if (args.length === 1) {
      const arg = args[0];
      if (arg === '--stat' || arg === '--name-only') return true;
      // ref
      return !arg.startsWith('--') && /^[a-zA-Z0-9._:/ -]+$/.test(arg);
    }
    if (args.length === 2) {
      const [first, second] = args;
      // ref + flag
      if (!first.startsWith('--') && /^[a-zA-Z0-9._:/ -]+$/.test(first) && (second === '--stat' || second === '--name-only')) {
        return true;
      }
      return false;
    }
    return false;
  }

  if (subcommand === 'branch') {
    return args.length === 1 && args[0] === '--show-current';
  }

  if (subcommand === 'rev-parse') {
    return args.length === 2 && args[0] === '--abbrev-ref' && /^head$/i.test(args[1]);
  }

  return false;
}

// --- Gate messages ---

/**
 * Batch-consistency warning (#3136). A first-touch denial marks the file
 * checked so the retry passes; a parallel batch of edits to one
 * not-yet-touched file therefore partially applies (first call denied,
 * siblings allowed). Hooks see calls one at a time and cannot lock a
 * batch, so the denial must say this out loud: name the file and tell
 * the agent that siblings may already have been applied.
 */
function batchSiblingWarning(safePath) {
  return (
    `If this call was sent in a parallel batch, other edits to ${safePath} from that batch ` +
    'may already have been applied. Re-read the file before building on them.'
  );
}

function editGateMsg(filePath) {
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before editing ${safe}, present these facts:`,
    '',
    '1. List ALL files that import/require this file (search the tree — Glob/Grep, or find/grep via Bash)',
    '2. List the public functions/classes affected by this change',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    batchSiblingWarning(safe),
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function writeGateMsg(filePath) {
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before creating ${safe}, present these facts:`,
    '',
    '1. Name the file(s) and line(s) that will call this new file',
    '2. Confirm no existing file serves the same purpose (search the tree — Glob/Grep, or find/grep via Bash)',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    batchSiblingWarning(safe),
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

/**
 * Condensed single-line denial used after the full-block budget is spent
 * (#2142). Carries the denial ordinal so consecutive denials differ
 * textually, and a one-line recovery hint instead of the multi-line block.
 */
function condensedGateMsg(action, filePath, ordinal) {
  const safe = sanitizePath(filePath);
  return (
    `[Fact-Forcing Gate] (denial #${ordinal} this session) First ${action} of ${safe}: ` +
    "briefly state importers/callers, affected API, data schemas if any, and the user's verbatim instruction, then retry. " +
    `${batchSiblingWarning(safe)}`
  );
}

function destructiveBashMsg() {
  return [
    '[Fact-Forcing Gate]',
    '',
    'Destructive command detected. Before running, present:',
    '',
    '1. List all files/data this command will modify or delete',
    '2. Write a one-line rollback procedure',
    "3. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function routineShellMsg(toolName) {
  const shellName = toolName === 'PowerShell' ? 'PowerShell' : 'Bash';
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before the first ${shellName} command this session, present these facts:`,
    '',
    '1. The current user request in one sentence',
    '2. What this specific command verifies or produces',
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

export { isDestructiveBash, isReadOnlyGitIntrospection, isClaudeSettingsPath, sanitizePath, tokenize, splitCommandSegments, findGitSubcommand, editGateMsg, writeGateMsg, condensedGateMsg, destructiveBashMsg, routineShellMsg }
