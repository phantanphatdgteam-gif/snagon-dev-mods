#!/bin/sh
# Live flow evals (plan v7.1 §9, §10 row 13): each run builds a fixture TypeScript repository, starts a fresh
# interactive `claude` session with the mod loaded (pty-drive.sh, tmux), plays the project owner (types the
# /flow-* commands, reads hash8 and the release code from the pane) and keeps the evidence under results/.
# Scenario steps live in scenarios.sh; metrics.mjs reads a run folder afterwards.
#
# Usage: run.sh <scenario> [-n <runs>] [-w <workdir>] [-k] [--model <model>] [--stack typescript|python]
#   scenario: dryrun | H123 | H4 | H5 | S1 … S12 | list | selftest
#   -n runs (default 1), -w work folder (default ${TMPDIR:-/tmp}/flow-evals), -k keep the fixture folders
#   --stack the fixture's stack (default typescript, or FLOW_EVAL_STACK)
#   SNAP=1 run.sh dryrun  also takes the snapshots S3, S6, S7 and H5 restore (plan §4.7)
#   run.sh daemon-stop   stops the git daemon that serves the local remotes
#   run.sh fixture <dir> [stack]  builds the fixture alone in <dir> (tests/judge-strict.check.mjs)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=$(cd "$HERE/../.." && pwd)
# The session loads a synced copy of the mod (GAP-step13-3): the engine watches a --plugin-dir folder and reloads it on
# any save, and the mod hashes its own tree at every flow_check, so the source stays editable while runs go on. Not under
# a temp folder, which /flow-setup refuses as a plugin root.
MOD_COPY=${FLOW_EVAL_MOD:-$HOME/.snagon/flow-eval-mod}
# the copy is synced with rsync --delete: only a folder of its own under ~/.snagon may be named, spelled plainly (no `.`,
# `..`, `//` or trailing slash), never the flow records (security review, SEC13-7, SEC13R2-5)
case "$MOD_COPY" in "$HOME/.snagon/"?*) ;; *) echo "run.sh: FLOW_EVAL_MOD must be a folder under $HOME/.snagon (got '$MOD_COPY')" >&2; exit 2 ;; esac
case "$MOD_COPY" in *'/../'*|*'/..'|*'/./'*|*'/.'|*'//'*|*'/'|"$HOME/.snagon/flow"|"$HOME/.snagon/flow/"*) echo "run.sh: FLOW_EVAL_MOD must be a plain path of its own (got '$MOD_COPY')" >&2; exit 2 ;; esac
DRIVE="$HERE/pty-drive.sh"
WORK=${FLOW_EVAL_WORK:-${TMPDIR:-/tmp}/flow-evals}
# Outside the plugin root: the mod hashes its own tree at every flow_check (pluginIntegrity), so nothing may be
# written under the mod while a run goes on; the reports copied into evals/flow/results/ come after all runs.
RESULTS=${FLOW_EVAL_RESULTS:-$WORK/results}
PORT=9419
RUNS=1; KEEP=0; STACK=${FLOW_EVAL_STACK:-typescript}; UNTIL=''
# Extra arguments on every claude the harness starts, split on spaces. Empty unless a scenario sets it.
# S4 sets "--mcp-config <file>" so the fake GitHub server is the only MCP server (--strict-mcp-config).
EXTRA_ARGS=${EXTRA_ARGS-}
# Snapshots of dry-run states (plan §4.7, GAP-R2-0.6-107/108): outside every allowWrite and temp folder, in a folder of
# their own under ~/.snagon/evals, spelled plainly (restore writes only where its manifest and checks allow)
SNAPS=${FLOW_EVAL_SNAPS:-$HOME/.snagon/evals/snapshots}
case "$SNAPS" in "$HOME/.snagon/evals/"?*) ;; *) echo "run.sh: FLOW_EVAL_SNAPS must be a folder under $HOME/.snagon/evals (got '$SNAPS')" >&2; exit 2 ;; esac
case "$SNAPS" in *'/../'*|*'/..'|*'/./'*|*'/.'|*'//'*|*'/') echo "run.sh: FLOW_EVAL_SNAPS must be a plain path (got '$SNAPS')" >&2; exit 2 ;; esac
# The session: the mod alone (the user's other plugins off, no MCP servers), edits accepted, Bash allowed by
# the fixture's settings; the sandbox block then comes from /flow-setup.
OFF='{"enabledPlugins":{"ponytail@ponytail":false,"i-have-adhd@i-have-adhd":false,"hookify@claude-plugins-official":false,"humanizer@humanizer":false,"playground@claude-plugins-official":false,"skill-creator@claude-plugins-official":false,"mcp-server-dev@claude-plugins-official":false,"perplexity@perplexity-mcp-server":false,"oxylabs@oxylabs-agent-skills":false,"chrome-devtools-mcp@claude-plugins-official":false,"context7@claude-plugins-official":false,"playwright@claude-plugins-official":false,"github@claude-plugins-official":false}}'

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "${RUN_LOG:-/dev/null}" >&2; }
die() { log "run.sh: $*"; exit 2; }
drive() { "$DRIVE" "$@"; }
sync_mod() { # rsync --delete runs only into a folder the harness made (its marker file), never through a symlink (SEC13R2-5)
  [ ! -L "$MOD_COPY" ] || die "mod copy $MOD_COPY is a symlink"
  if [ -d "$MOD_COPY" ] && [ ! -f "$MOD_COPY/.flow-eval-copy" ] && [ -n "$(ls -A "$MOD_COPY")" ]; then die "mod copy $MOD_COPY holds files the harness did not write (no .flow-eval-copy marker)"; fi
  mkdir -p "$MOD_COPY" && rsync -a --delete --exclude 'evals/' --exclude '.claude-plugin/types/' --exclude '.snagon/' --exclude '.DS_Store' --exclude '.flow-eval-copy' "$MOD/" "$MOD_COPY/" || die 'mod sync failed'
  [ -f "$MOD_COPY/.flow-eval-copy" ] || : > "$MOD_COPY/.flow-eval-copy"
}

# ---------------------------------------------------------------- fixture
fixture() { # <dir> [stack]: the fixture repository of that stack (default $STACK)
  case "${2:-$STACK}" in typescript) fixture_ts "$1" ;; python) fixture_py "$1" ;; *) die "no fixture for stack ${2:-$STACK}" ;; esac
}
# Both stacks: the project's tool allow-list (the sandbox block itself comes from /flow-setup), the journal folder, git.
fixture_common() { # <dir>
  d=$1; mkdir -p "$d/.claude" "$d/.snagon" || die "cannot create $d"
  printf '%s\n' '{ "permissions": { "allow": ["Bash", "Read", "Glob", "Grep", "Agent", "Skill", "TodoWrite", "mcp__snagon-dev-mods__flow_status", "mcp__snagon-dev-mods__flow_check", "mcp__snagon-dev-mods__memory_save", "mcp__snagon-dev-mods__memory_search", "mcp__snagon-dev-mods__memory_get"] } }' > "$d/.claude/settings.json"
  printf '%s\n' '{ "journalDir": ".snagon/journal" }' > "$d/.snagon/config.json"
  printf '# Written by the snagon-dev-mods mod: everything here is per-user, per-machine data.\n*\n' > "$d/.snagon/.gitignore"
}
fixture_git() { # <dir> <first commit message>
  (cd "$1" && git init -q -b main && git config user.name fx && git config user.email fx@example.invalid && git add -A && git commit -q -m "$2") || die 'git init failed'
}
# The TypeScript fixture: vitest green, eslint red (a known unused helper: S4), tsc green; sum drops negative
# numbers (the seeded bug F-02 fixes), stats.ts holds a console.log (pre-existing junk the scan must not
# flag), src/clamp.ts does not exist yet (F-01, "(new)"), stats.ts gets a new export (F-03, RED missing-export).
fixture_ts() { # <dir>
  d=$1; mkdir -p "$d/src" "$d/tests" "$d/.claude" "$d/.snagon" || die "cannot create $d"
  cat > "$d/package.json" <<'EOF'
{
  "name": "flow-fixture", "version": "0.1.0", "private": true, "type": "module",
  "scripts": { "test": "vitest run", "lint": "eslint src tests", "typecheck": "tsc --noEmit" },
  "devDependencies": { "@typescript-eslint/parser": "^8.46.0", "eslint": "^9.39.0", "typescript": "^5.9.3", "vitest": "^3.2.4" }
}
EOF
  printf '%s\n' '{ "compilerOptions": { "target": "es2022", "module": "esnext", "moduleResolution": "bundler", "strict": true, "noEmit": true, "skipLibCheck": true, "types": [] }, "include": ["src", "tests"] }' > "$d/tsconfig.json"
  cat > "$d/eslint.config.js" <<'EOF'
import parser from '@typescript-eslint/parser'
export default [
  { files: ['**/*.ts'], languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' }, rules: { 'no-unused-vars': 'error', 'prefer-const': 'error' } },
]
EOF
  cat > "$d/src/sum.ts" <<'EOF'
/** Adds the numbers of a list. */
export const sum = (xs: readonly number[]): number => xs.filter(x => x > 0).reduce((a, b) => a + b, 0)
EOF
  cat > "$d/src/stats.ts" <<'EOF'
import { sum } from './sum'

/** The arithmetic mean of a non-empty list. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('mean of an empty list')
  console.log('mean of', xs.length, 'numbers')
  return sum(xs) / xs.length
}
EOF
  cat > "$d/src/legacy.ts" <<'EOF'
/** Kept for an old caller; the unused helper is a known lint error. */
const unusedHelper = (x: number): number => x * 2
export const legacyDouble = (x: number): number => x + x
EOF
  cat > "$d/tests/sum.test.ts" <<'EOF'
import { expect, it } from 'vitest'
import { sum } from '../src/sum'

it('sums positive numbers', () => {
  expect(sum([1, 2, 3])).toBe(6)
})
it('sums an empty list to zero', () => {
  expect(sum([])).toBe(0)
})
EOF
  cat > "$d/tests/stats.test.ts" <<'EOF'
import { expect, it } from 'vitest'
import { mean } from '../src/stats'

it('mean of positive numbers', () => {
  expect(mean([2, 4, 6])).toBe(4)
})
EOF
  mkdir -p "$d/docs" && cat > "$d/docs/intent.md" <<'EOF'
# What to build

Three small features for this TypeScript library, in this order.

- F-01: a new module `src/clamp.ts` (new) exporting `clamp(x, lo, hi)` that limits `x` to the range `[lo, hi]` and throws a `RangeError` when `lo > hi`; tests in `tests/clamp.test.ts` (new).
- F-02: fix `sum` in `src/sum.ts` so it adds negative numbers too (today it drops them): `sum([1, -2, 3])` is 2 and `sum([-5])` is -5; keep the existing tests green; tests in `tests/sum.test.ts`; mark F-02 `Security: yes` (sum is the library's input boundary).
- F-03: add a new export `median(xs)` to the existing module `src/stats.ts` (the middle value of the sorted list, the mean of the two middle values for an even count, a `RangeError` for an empty list); tests in `tests/stats.test.ts`.

Two acceptance criteria per feature, all Required except one Optional criterion on F-03 (the even-count case of `median`). Keeping the existing tests green is part of the definition of done, not an acceptance criterion.
EOF
  printf 'node_modules/\n' > "$d/.gitignore"
  printf '# Fixture project\n\nA tiny TypeScript library used by the flow evals. Run `npm test`, `npm run lint`, `npm run typecheck`.\n' > "$d/README.md"
  fixture_common "$d"
  (cd "$d" && npm install --no-audit --no-fund --loglevel=error > /dev/null 2>&1) || die 'npm install failed'
  fixture_git "$d" 'fixture: sum, stats, legacy'
}
# The Python fixture (AC-06-2, GAP-R2-0.6-111), the same three features: pytest green, ruff red (a known unused import:
# S4), mypy green on src, in a uv project (uv.lock, .venv ignored; no build system, so the project is not installed);
# total drops negative numbers (the seeded bug F-02 fixes), stats.py holds a print( (pre-existing junk), clamp.py does
# not exist yet (F-01, "(new)"), stats.py gets a new function (F-03, RED: the name cannot be imported).
fixture_py() { # <dir>
  d=$1; mkdir -p "$d/src/fx" "$d/tests" "$d/docs" || die "cannot create $d"
  cat > "$d/pyproject.toml" <<'EOF'
[project]
name = "flow-fixture"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = []

[dependency-groups]
dev = ["pytest>=8", "ruff>=0.6", "mypy>=1.11"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]

[tool.ruff]
line-length = 100

[tool.mypy]
strict = true
EOF
  printf '"""A tiny Python library used by the flow evals."""\n' > "$d/src/fx/__init__.py"
  cat > "$d/src/fx/adder.py" <<'EOF'
"""Sums of number lists."""


def total(xs: list[int]) -> int:
    """Adds the numbers of a list."""
    return sum(x for x in xs if x > 0)
EOF
  cat > "$d/src/fx/stats.py" <<'EOF'
"""Statistics of number lists."""
from fx.adder import total


def mean(xs: list[int]) -> float:
    """The arithmetic mean of a non-empty list."""
    if not xs:
        raise ValueError("mean of an empty list")
    print("mean of", len(xs), "numbers")
    return total(xs) / len(xs)
EOF
  cat > "$d/src/fx/legacy.py" <<'EOF'
"""Kept for an old caller; the unused import is a known lint error."""
import os


def legacy_double(x: int) -> int:
    return x + x
EOF
  cat > "$d/tests/test_adder.py" <<'EOF'
from fx.adder import total


def test_sums_positive_numbers() -> None:
    assert total([1, 2, 3]) == 6


def test_sums_an_empty_list_to_zero() -> None:
    assert total([]) == 0
EOF
  cat > "$d/tests/test_stats.py" <<'EOF'
from fx.stats import mean


def test_mean_of_positive_numbers() -> None:
    assert mean([2, 4, 6]) == 4
EOF
  cat > "$d/docs/intent.md" <<'EOF'
# What to build

Three small features for this Python library (the package `fx` under `src/`), in this order.

- F-01: a new module `src/fx/clamp.py` (new) with `clamp(x, lo, hi)` that limits `x` to the range `[lo, hi]` and raises a `ValueError` when `lo > hi`; tests in `tests/test_clamp.py` (new).
- F-02: fix `total` in `src/fx/adder.py` so it adds negative numbers too (today it drops them): `total([1, -2, 3])` is 2 and `total([-5])` is -5; keep the existing tests green; tests in `tests/test_adder.py`; mark F-02 `Security: yes` (total is the library's input boundary).
- F-03: add a new function `median(xs)` to the existing module `src/fx/stats.py` (the middle value of the sorted list, the mean of the two middle values for an even count, a `ValueError` for an empty list); tests in `tests/test_stats.py`.

Two acceptance criteria per feature, all Required except one Optional criterion on F-03 (the even-count case of `median`). Keeping the existing tests green is part of the definition of done, not an acceptance criterion.
EOF
  printf '.venv/\n__pycache__/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n' > "$d/.gitignore"
  printf '# Fixture project\n\nA tiny Python library used by the flow evals. Run `.venv/bin/pytest`, `.venv/bin/ruff check`, `.venv/bin/mypy src`.\n' > "$d/README.md"
  fixture_common "$d"
  (cd "$d" && uv sync --quiet > /dev/null 2>&1) || die 'uv sync failed'
  fixture_git "$d" 'fixture: adder, stats, legacy'
}

# ---------------------------------------------------------------- local remote (git://, served by git daemon)
daemon_start() { # the mod refuses a path remote (its hooks would run outside the sandbox): git:// on loopback
  mkdir -p "$WORK/remotes"; [ -d "$WORK/remotes/probe.git" ] || git init -q --bare "$WORK/remotes/probe.git"
  serves() { git ls-remote "git://127.0.0.1:$PORT/probe.git" > /dev/null 2>&1; }
  serves && return 0
  git daemon --export-all --enable=receive-pack --base-path="$WORK/remotes" --listen=127.0.0.1 --port=$PORT --pid-file="$WORK/remotes/daemon.pid" --detach --reuseaddr || die 'git daemon failed'
  sleep 1; serves || die "port $PORT does not serve $WORK/remotes (another git daemon on it?)"
  # loopback only, but it takes any local push: it lives for this invocation, not beyond (SEC13-7)
  trap 'daemon_stop' EXIT
}
daemon_stop() { [ -f "$WORK/remotes/daemon.pid" ] && kill "$(cat "$WORK/remotes/daemon.pid")" 2>/dev/null; rm -f "$WORK/remotes/daemon.pid"; }
remote_add() { # <dir> <name> [branch]: a bare remote for this run, `origin` of the fixture, the branch (main) pushed
  git init -q --bare "$WORK/remotes/$2.git" && (cd "$1" && git remote add origin "git://127.0.0.1:$PORT/$2.git" && git push -q origin "${3:-main}") || die 'remote failed'
}

# ---------------------------------------------------------------- the flow record (outside the project)
rec() { # the newest non-empty record version of the fixture at $FX, as JSON (empty when none)
  for f in $(ls -t "$HOME"/.snagon/flow/*.v*.json 2>/dev/null); do
    [ -s "$f" ] || continue
    if jq -e --arg r "$FX" '.root == $r' "$f" > /dev/null 2>&1; then cat "$f"; return 0; fi
  done
  return 1
}
field() { rec | jq -r "$1 // empty" 2>/dev/null; }
flow_id() { field '.flowId'; }
ended() { id=$(cat "$RUN/flowid" 2>/dev/null); [ -n "$id" ] && [ -f "$HOME/.snagon/flow/$id.end" ]; }
# AC-SAFE-8 (GAP-R2-0.6-112): the run's flow id, kept from the first record seen; an ended flow has no record left to read
# it from, so it is never overwritten (run 19 left the file empty). A run that never had a flow keeps it empty.
keep_flowid() {
  [ -s "$RUN/flowid" ] && return 0
  fid=$(flow_id); if [ -n "$fid" ]; then printf '%s\n' "$fid" > "$RUN/flowid"; else : > "$RUN/flowid"; fi
}

# ---------------------------------------------------------------- snapshots (plan §4.7, GAP-R2-0.6-107/108)
# A quiescent state of a dry run (main idle, nothing running: S4 awaiting the baseline acceptance, P3 awaiting the plan
# approval), taken with SNAP=1: one tar of the fixture (with .git, its settings and dependency folder), its bare remote
# and the flow's record files at their absolute paths, and a manifest with the plugin hash the record froze.
plugin_hash() { # <plugin folder>: the mod's own pluginIntegrity of it, or empty (and non-zero) when it cannot be read
  _ph=$(node "$HERE/plugin-hash.mjs" "$1" 2>> "${RUN_LOG:-/dev/null}") || return 1
  printf '%s' "$_ph" | grep -qE '^[0-9a-z]{6,}$' || return 1
  printf '%s\n' "$_ph"
}
snap_take() { # <label>: this run's state now into $SNAPS/<stack>-<label>
  _fid=$(cat "$RUN/flowid" 2>/dev/null); printf '%s' "$_fid" | grep -qE '^[0-9a-f]{8}$' || { log "snapshot $1: no flow id"; return 1; }
  # the plugin hash the record froze: a restore compares it, so an empty one would make that check meaningless
  _plug=$(field '.frozen.plugin'); printf '%s' "$_plug" | grep -qE '^[0-9a-z]{6,}$' || { log "snapshot $1: the record holds no plugin hash"; return 1; }
  [ "$_plug" = "$(plugin_hash "$MOD_COPY")" ] || { log "snapshot $1: the loaded copy is not the plugin the record froze"; return 1; }
  _d="$SNAPS/$STACK-$1"; rm -rf "$_d.part" && mkdir -p "$_d.part" || return 1
  { printf '%s\n' "${FX#/}" "${WORK#/}/remotes/$NAME.git"; for _f in "$HOME/.snagon/flow/$_fid".*; do [ -e "$_f" ] && printf '%s\n' "${_f#/}"; done; } > "$_d.part/paths"
  /usr/bin/tar -cf "$_d.part/state.tar" -C / -T "$_d.part/paths" || { log "snapshot $1: tar failed"; return 1; }
  jq -n --arg label "$1" --arg stack "$STACK" --arg fixture "$FX" --arg remote "$WORK/remotes/$NAME.git" --arg name "$NAME" --arg work "$WORK" --arg flowId "$_fid" --arg plugin "$_plug" --arg sha "$(shasum -a 256 "$_d.part/state.tar" | cut -d' ' -f1)" --argjson at "$(date +%s)" \
    '{label: $label, stack: $stack, fixture: $fixture, remote: $remote, name: $name, work: $work, flowId: $flowId, plugin: $plugin, sha256: $sha, at: $at}' > "$_d.part/manifest.json" || return 1
  rm -rf "$_d" && mv "$_d.part" "$_d" && log "snapshot $STACK-$1 taken ($(du -sh "$_d" | cut -f1))"
}
snap_has() { [ -f "$SNAPS/$STACK-$1/manifest.json" ] && [ -f "$SNAPS/$STACK-$1/state.tar" ]; } # <label>
snap_due() { # <label>: the dry run's snapshot at this owner-wait point, once a run, with SNAP=1 and main idle
  [ "${SNAP:-0}" = 1 ] && [ ! -f "$RUN/snap-$1" ] || return 0
  drive idle "$SES" 120 || { log "snapshot $1 not taken: main busy"; return 0; }
  snap_take "$1" && : > "$RUN/snap-$1"
}
snaps_taken() { # <label…>: every one of them has a manifest and was marked taken in this run (code review r1)
  for _l in "$@"; do snap_has "$_l" && [ -f "$RUN/snap-$_l" ] || { log "the $_l snapshot was not taken"; return 1; }; done
}
# snap_restore <label>: the snapshot's state back at its own paths for this run (the fixture and remote under this work
# folder, the records of its flow), or exit 1 with the reason logged. Refused: a tar whose hash is not the manifest's, a
# loaded plugin other than the one the record froze, a path outside the fixture, its remote and its records.
snap_restore() {
  _d="$SNAPS/$STACK-$1"; _m="$_d/manifest.json"
  snap_has "$1" || { log "no snapshot $STACK-$1 (take it: run.sh snapshot --stack $STACK)"; return 1; }
  [ "$(shasum -a 256 "$_d/state.tar" | cut -d' ' -f1)" = "$(jq -r .sha256 "$_m")" ] || { log "snapshot $STACK-$1: the tar's hash is not the manifest's"; return 1; }
  # the plugin the snapshot was taken with, both sides read for real: an empty hash on either side refuses
  _mp=$(jq -r '.plugin // empty' "$_m"); _cp=$(plugin_hash "$MOD_COPY") || { log 'the loaded copy could not be hashed'; return 1; }
  [ -n "$_mp" ] && [ "$_mp" = "$_cp" ] || { log "snapshot $STACK-$1 was taken with another plugin: take new snapshots"; return 1; }
  _sfx=$(jq -r '.fixture // empty' "$_m"); _sid=$(jq -r '.flowId // empty' "$_m"); _sname=$(jq -r '.name // empty' "$_m")
  [ "$(jq -r '.work // empty' "$_m")" = "$WORK" ] || { log "snapshot $STACK-$1 belongs to the work folder $(jq -r '.work // empty' "$_m")"; return 1; }
  case "$_sname" in */*|*.*|*..*|'') log "snapshot run name '$_sname'"; return 1 ;; esac
  # the fixture path is not trusted from the manifest: it must be exactly the folder a run of that name would build
  [ "$_sfx" = "$WORK/$_sname" ] || { log "snapshot fixture '$_sfx' is not $WORK/$_sname"; return 1; }
  printf '%s' "$_sid" | grep -qE '^[0-9a-f]{8}$' || { log "snapshot flow id '$_sid'"; return 1; }
  # every entry must sit under the fixture, its remote or that flow's records, with no `..` and no absolute path; a
  # listing that fails is fatal, so an unreadable tar can never read as "nothing wrong" (security review r1)
  /usr/bin/tar -tf "$_d/state.tar" > "$RUN/snap-paths.txt" 2>> "$RUN_LOG" || { log 'the snapshot tar could not be listed'; return 1; }
  [ -s "$RUN/snap-paths.txt" ] || { log 'the snapshot tar is empty'; return 1; }
  awk -v f="${_sfx#/}/" -v r="${WORK#/}/remotes/$_sname.git/" -v h="${HOME#/}/.snagon/flow/$_sid." \
    '/^\// || /(^|\/)\.\.(\/|$)/ { bad = 1 }
     index($0 "/", f) != 1 && index($0 "/", r) != 1 && index($0, h) != 1 { bad = 1 }
     END { exit bad }' "$RUN/snap-paths.txt" || { log 'the snapshot holds a path outside its fixture, remote and records'; return 1; }
  wipe_records "$_sfx" "$_sid" || return 1
  rm -rf "$_sfx" "$WORK/remotes/$_sname.git"
  # no -P: bsdtar then refuses an absolute or `..` member and will not extract through a symbolic link
  /usr/bin/tar -xpf "$_d/state.tar" -C / || { log 'snapshot extract failed'; return 1; }
  FX=$_sfx; NAME=$_sname; printf '%s\n' "$_sid" > "$RUN/flowid"; log "restored $STACK-$1 ($_sfx)"
}
# wipe_records <fixture> <id8>: the harness's own records only — those whose `.root` is that fixture, and the
# snapshot's own id, which must name a record of that fixture or none at all (a manifest cannot point the wipe at
# another project's flow; security review r1).
wipe_records() {
  _ids=''
  for _f in "$HOME"/.snagon/flow/*.v*.json; do [ -s "$_f" ] && jq -e --arg r "$1" '.root == $r' "$_f" > /dev/null 2>&1 && _ids="$_ids $(basename "$_f" | cut -c1-8)"; done
  if ls "$HOME/.snagon/flow/$2".v*.json > /dev/null 2>&1; then
    case " $_ids " in *" $2 "*) ;; *) log "the snapshot's flow $2 holds a record of another project"; return 1 ;; esac
  else _ids="$_ids $2"; fi
  for _i in $_ids; do printf '%s' "$_i" | grep -qE '^[0-9a-f]{8}$' && rm -f "$HOME/.snagon/flow/$_i".*; done
}

# ---------------------------------------------------------------- the owner robot
approve() { # <kind>: reads "/flow-approve <kind> <hash8> [<code>]" from the pane and types it
  # The pane is the right column of the screen; the left column holds the owner's earlier typed approvals (`❯ …`),
  # which must never be read back (dry run 13: a second waiver read the first's hash8; dry run 14: a baseline approval
  # already taken was read again). An approval the flow no longer waits for (the record moved on) is done.
  i=0
  while [ "$i" -lt 90 ]; do
    cmd=$(drive screen "$SES" 150 | grep -v '❯ /flow-approve' | grep -oE "/flow-approve $1 [0-9a-f]{8}( [A-Z2-9]{6})?" | tail -1)
    [ -n "$cmd" ] && { owner "$cmd"; return 0; }
    case "$1" in
      baseline) [ "$(field '.awaiting')" = '/flow-status' ] || return 0 ;;
      plan) [ "$(field '.awaiting')" = '/flow-plan' ] || return 0 ;;
    esac
    sleep 3; i=$((i + 3))
  done
  log "no $1 approval line in the pane"; return 1
}
# An owner command, then the wait for its effect: the record's version moves (the command ran, queued or not: a command
# typed while main's turn runs is queued and runs when the turn ends), or main goes idle with the record unchanged (a
# refusal, or nothing to do). Nothing is typed twice within that wait.
owner() {
  v0=$(field '.version'); log "owner: $1"; drive type "$SES" "$1"; i=0
  while [ "$i" -lt 150 ]; do
    [ "$(field '.version')" != "$v0" ] && return 0
    [ "$i" -ge 10 ] && ! drive busy "$SES" && return 0
    sleep 5; i=$((i + 5))
  done
  log "no effect seen 150 s after: $1"
}
# Claude Code's own dialogs, answered as the owner would: the write into .claude/ (acceptEdits leaves it to the person;
# its content was approved in the pane) is confirmed; anything else (a host outside the allowed domains, an unsandboxed
# retry) is declined with Escape. Both are counted; the mod's guard has already judged the call by then.
# A shell function's variables are the shell's own, so every name a helper here assigns is global: the helpers use
# `_`-prefixed names and the scenarios use plain ones, which is what keeps a scenario's `ticket` or `sfile` from being
# overwritten mid-run (code review r1: `ask_in`'s `t` had replaced S3's ticket id).
confirm_in() { # <session>
  _scr=$(drive screen "$1" 5); printf '%s' "$_scr" | grep -q 'Do you want to' || return 0
  if printf '%s' "$_scr" | grep -q 'settings.local.json'; then drive keys "$1" Enter; PROMPTS=$((${PROMPTS:-0} + 1)); log 'confirmed the settings write dialog'
  # S5's .npmrc row asks for one Write of that file: Claude Code asks first, and the row means nothing unless the write
  # lands (S5 run 2 of 2026-10-21). Exactly this dialog and no other; delete this branch to decline it again.
  elif printf '%s' "$_scr" | grep -q 'Do you want to create \.npmrc?'; then drive keys "$1" Enter; PROMPTS=$((${PROMPTS:-0} + 1)); log 'confirmed the .npmrc write dialog (S5 config row)'
  else drive keys "$1" Escape; DECLINED=$((${DECLINED:-0} + 1)); log "declined a dialog: $(printf '%s' "$_scr" | grep -E 'outside of sandbox|unsandboxed|Host:|Do you want' | head -2 | tr '\n' ' ')"; fi
  sleep 3
}
confirm() { confirm_in "$SES"; }
timeline() { # one line per change of task/awaiting/blocked
  now=$(rec | jq -c '{v: .version, phase, task, feature, awaiting, blocked: .blocked.reason, spent}' 2>/dev/null)
  [ -n "$now" ] && [ "$now" != "${LAST_STATE:-}" ] && { LAST_STATE=$now; printf '%s\t%s\n' "$(date +%s)" "$now" >> "$RUN/timeline.tsv"; log "state: $now"; rec > "$RUN/record-v$(field '.version').json"; keep_flowid
    # the baseline and RED files go when the flow ends: kept as soon as they exist
    for x in baseline red; do f="$HOME/.snagon/flow/$(cat "$RUN/flowid").$x.json"; [ -f "$f" ] && [ ! -f "$RUN/$(basename "$f")" ] && cp -p "$f" "$RUN/"; done; }
}
# robot <timeout-seconds>: plays the owner until the flow ends, blocks or the time is up (there is no cost cap since
# 2026-10-20, the owner's decision). $INTENT is what /flow-plan asks for; $UNTIL, when set, is the record task to stop
# at (a scenario drives on from there). Exit 0 ended, 1 blocked, 2 reached $UNTIL, 3 timeout, 4 stalled.
robot() {
  deadline=$(( $(date +%s) + $1 )); ships=0; idle_s=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    confirm; timeline
    if ended; then log 'flow ended'; return 0; fi
    if [ -n "${UNTIL:-}" ] && [ "$(field '.task')" = "$UNTIL" ]; then log "reached $UNTIL"; return 2; fi
    aw=$(field '.awaiting'); bl=$(field '.blocked.reason'); task=$(field '.task')
    if [ -n "$bl" ]; then
      # a floor block on fix-scope findings (FL-n, HIGH, waivable): the dry run plays the owner who read the hunk and
      # waives, at most six times a run; each waiver is an echo the owner approves
      # Only the scope rules' findings (fix-scope, out-of-scope: a fix round's stray hunk leaves both, the block naming the
      # out-of-scope one): a RED test changed, an injection or a trivial assertion is what a scenario checks, and S6 run 2
      # of 2026-10-20 waived its own red-test-changed finding here and ran to the end (code review of finding 4)
      fixes=$(rec | jq -r '.findings[] | select(.status == "open" and (.id | startswith("FL-")) and (.rubricId == "fix-scope" or .rubricId == "out-of-scope")) | .id')
      if [ "$bl" = floor ] && [ -n "$fixes" ] && [ "${waived:-0}" -lt 6 ]; then
        for id in $fixes; do
          waived=$((${waived:-0} + 1)); WAIVED=$waived; owner "/flow-waive $id dry run: the hunk outside the FIX range was read by the harness owner"
          approve waive || log "no waive echo for $id"
        done
        continue
      fi
      log "blocked: $bl"; return 1
    fi
    case "$aw" in
      '/flow-status') [ "$task" = S4 ] && snap_due S4; owner '/flow-status'; approve baseline || return 1 ;;
      '/flow-plan') if [ "$task" = P3 ]; then snap_due P3; owner '/flow-plan'; approve plan || return 1; else owner "/flow-plan $INTENT"; fi ;;
      '/flow-build'|'/flow-verify') owner "$aw" ;;
      '/flow-ship') ships=$((ships + 1)); [ "$ships" -le 4 ] || { log 'ship asked 4 times'; return 1; }
        owner '/flow-ship'; approve release || { drive idle "$SES" 600 || true; } ;;
      '/flow-approve release') approve release || return 1 ;;
      '') # main works (tickets, checks) or a ticket's agent runs in the background (D4: main is idle until the engine's
        # completion notice); a long idle while nothing waits and nothing runs is a stall: nudge once per 3 minutes
        live=$(field '[.tickets[]? | select(.used and .agentId != null and .attested != true)] | length')
        if drive busy "$SES" || [ "${live:-0}" != 0 ]; then idle_s=0; else idle_s=$((idle_s + 5)); fi
        if [ "$idle_s" -ge 180 ]; then NUDGES=$((${NUDGES:-0} + 1)); idle_s=0; log "nudge $NUDGES"; owner 'Call flow_status and do what it says.'; fi ;;
      *) log "unknown awaiting $aw"; return 1 ;;
    esac
    sleep 5
  done
  log 'robot timeout'; return 3
}

# ---------------------------------------------------------------- scripted main (plan §4.7, GAP-R2-0.6-110)
# Where a check needs a guarded call, the owner types the one prompt that asks main for exactly that call; what main did
# is read from the transcript. A check whose call main never made is "not attempted" (NA), never a pass.
transcript_of() { find "$HOME/.claude/projects" -maxdepth 2 -name "$1.jsonl" 2>/dev/null | head -1; }
transcript() { transcript_of "$SID"; }
now_ms() { node -e 'console.log(Date.now())'; }
ask_in() { # <session> <session id> <prompt>: typed there; when main is idle again, its calls since then in $ASKED
  ASKS=$((${ASKS:-0} + 1)); ASKED="$RUN/ask-$ASKS.jsonl"; _t0=$(now_ms); log "ask $ASKS ($1): $3"
  drive type "$1" "$3"; sleep 6; _i=0; _quiet=0
  while [ "$_i" -lt 300 ] && [ "$_quiet" -lt 3 ]; do
    if drive screen "$1" 8 | grep -q 'Do you want to'; then confirm_in "$1"; _quiet=0
    elif drive busy "$1"; then _quiet=0
    else _quiet=$((_quiet + 1)); fi
    sleep 2; _i=$((_i + 2))
  done
  node "$HERE/calls.mjs" "$(transcript_of "$2")" "$_t0" > "$ASKED" 2>> "$RUN_LOG"
}
ask() { ask_in "$SES" "$SID" "$1"; }
# outcome <tool> <text its input holds>: what main's matching calls since the last ask came to —
#   none         no such call (the check is "not attempted")
#   ran          one of them went through (the guard did not stop it)
#   refused      every one errored with the mod's own refusal (a `flow:` text): the only evidence a guard held
#   other-error  one errored for another reason (Claude Code's own error, a declined dialog): proves nothing
#   pending      a call whose result had not arrived when the transcript was read
# Both reviews r1: `refused` must not mean "any error result", or a check passes on an error the mod never sent.
# A third argument names the file the call's file_path must end with: text alone also matches a call that only mentions
# the file, such as main's journal entry about it (S11, 2026-10-20).
# A call whose result is a Fact-Forcing Gate denial is left out here and in `said`: the gate asks for facts and a retry,
# so it is not an answer to the call, and main's retry is what the rule under test answers (S4 run 1 of 2026-10-21).
outcome() {
  jq -rs --arg n "$1" --arg s "$2" --arg f "${3:-}" '[.[] | select(.kind == "call" and .name == $n and ((.input | tostring) | contains($s)) and (((.text // "") | contains("[Fact-Forcing Gate]")) | not) and ($f == "" or ((.input.file_path // "") | endswith($f))))]
    | if length == 0 then "none"
      elif any(.[]; .error == false) then "ran"
      elif all(.[]; .error == true) then (if all(.[]; .text | test("(^|\n|denied by plugin snagon-dev-mods: |<tool_use_error>)flow: ")) then "refused" else "other-error" end)
      else "pending" end' "$ASKED"
}
said() { # <tool> <text its input holds> [<file>]: the refusal text of that call (the mod's refusals hold "flow:")
  jq -rs --arg n "$1" --arg s "$2" --arg f "${3:-}" '[.[] | select(.kind == "call" and .name == $n and ((.input | tostring) | contains($s)) and (((.text // "") | contains("[Fact-Forcing Gate]")) | not) and ($f == "" or ((.input.file_path // "") | endswith($f))) and .error == true) | .text] | first // ""' "$ASKED"
}
ck() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RUN/checks.tsv"; log "check $1: $2 $3"; } # <id> <PASS|FAIL|NA> <why>
checks_verdict() { # <scenario>: FAIL when a check failed, NOT-ATTEMPTED when main skipped one, else PASS (rc 1, 5, 0)
  [ -s "$RUN/checks.tsv" ] || { verdict "FAIL $1: no check ran"; return 1; }
  bad=$(awk -F'\t' '$2 == "FAIL" { printf "%s%s (%s)", s, $1, $3; s = "; " }' "$RUN/checks.tsv")
  skipped=$(awk -F'\t' '$2 == "NA" { printf "%s%s", s, $1; s = " " }' "$RUN/checks.tsv")
  if [ -n "$bad" ]; then verdict "FAIL $1: $bad"; return 1; fi
  if [ -n "$skipped" ]; then verdict "NOT-ATTEMPTED $1: no call for $skipped"; return 5; fi
  verdict "PASS $1: $(wc -l < "$RUN/checks.tsv" | tr -d ' ') checks"
}
# ---------------------------------------------------------------- one run
# start_in <session> <cwd> [extra claude arguments…]: a session there, its id fixed so the transcript path is known; the
# id is printed, and every id of the run is kept in session-id (collect copies each transcript).
start_in() {
  ses=$1; cwd=$2; shift 2
  sid=$(uuidgen | tr 'A-Z' 'a-z'); printf '%s\n' "$sid" >> "$RUN/session-id"
  # EXTRA_ARGS is split on spaces on purpose: a scenario passes "--mcp-config <file>" as two words
  drive start "$ses" "$cwd" "$RUN/claude.err" -- --plugin-dir "$MOD_COPY" --strict-mcp-config --permission-mode acceptEdits --session-id "$sid" --settings "$OFF" ${MODEL:+--model "$MODEL"} "$@" ${EXTRA_ARGS-} || die "session $ses did not start"
  log "session $sid ($ses) on $cwd"; printf '%s\n' "$sid"
}
start_session() { SID=$(start_in "$SES" "$FX" "$@") || die 'session did not start'; } # the run's own session on the fixture
collect() { # the evidence: screen, record, transcript and its subagents, cost rows, timings
  drive screen "$SES" 400 > "$RUN/screen.txt" 2>/dev/null
  # a flow that ended `done` has no record any more: no empty file, metrics.mjs reads the last record-v*.json (535 trial 2, M-11)
  rec > "$RUN/record-final.json" 2>/dev/null; [ -s "$RUN/record-final.json" ] || rm -f "$RUN/record-final.json"; keep_flowid
  # the last session's transcript and subagents for metrics.mjs; every session's transcript when a scenario started
  # several. With no session started (a scenario that failed at its restore) there is nothing to copy (security review r1)
  _tr=''; [ -n "${SID:-}" ] && _tr=$(transcript)
  [ -n "$_tr" ] && cp "$_tr" "$RUN/transcript.jsonl" && [ -d "${_tr%.jsonl}/subagents" ] && cp -R "${_tr%.jsonl}/subagents" "$RUN/subagents"
  for _s in $(cat "$RUN/session-id" 2>/dev/null); do _t=$(transcript_of "$_s"); [ -n "$_t" ] && cp "$_t" "$RUN/transcript-$_s.jsonl"; done
  cp "$FX/.snagon/cost.jsonl" "$RUN/cost.jsonl" 2>/dev/null
  id=$(cat "$RUN/flowid" 2>/dev/null); [ -n "$id" ] && cp -p "$HOME/.snagon/flow/$id."* "$RUN/" 2>/dev/null
  cp -R "$FX/.snagon/flow" "$RUN/views" 2>/dev/null; cp -R "$FX/docs" "$RUN/docs" 2>/dev/null
  (cd "$FX" && git log --oneline -20 > "$RUN/git-log.txt" 2>/dev/null; git status --short > "$RUN/git-status.txt" 2>/dev/null)
  git ls-remote "git://127.0.0.1:$PORT/$NAME.git" > "$RUN/remote.txt" 2>/dev/null
  # a flow the run left active is ended as /flow-off would (the end marker, then its files), so it never counts later
  if [ -n "$id" ] && [ ! -f "$HOME/.snagon/flow/$id.end" ]; then
    printf '{"end":"off","at":%s000}\n' "$(date +%s)" > "$HOME/.snagon/flow/$id.end" && rm -f "$HOME/.snagon/flow/$id".v*.json "$HOME/.snagon/flow/$id".tmp-* "$HOME/.snagon/flow/$id".baseline.json "$HOME/.snagon/flow/$id".red.json
  fi
}
one_run() { # <scenario> <n>
  NAME="$1-$2-$(date +%H%M%S)"; SES="ev-$NAME"; RUN="$RESULTS/$1/$NAME"; FX="$WORK/$NAME"; NUDGES=0; PROMPTS=0; LAST_STATE=''; ASKS=0; SID=''
  mkdir -p "$RUN" "$WORK" || die 'cannot create folders'; RUN_LOG="$RUN/run.log"; : > "$RUN/flowid"
  log "run $NAME ($STACK)"; sync_mod; daemon_start
  # a scenario that needs a state deeper than setup restores a snapshot and starts its own session (plan §4.7)
  if ! from_snapshot "$1"; then
    fixture "$FX"; remote_add "$FX" "$NAME"
    FX=$(cd "$FX" && pwd -P)
    direct_ms=$( (cd "$FX" && s=$(now_ms); if [ "$STACK" = python ]; then .venv/bin/pytest -q > /dev/null 2>&1; else npm test > /dev/null 2>&1; fi; e=$(now_ms); echo $((e - s))) )
    printf '{"directTestMs": %s}\n' "$direct_ms" > "$RUN/direct.json"
    start_session
  fi
  "scenario_$1"; rc=$?
  log "scenario rc=$rc (nudges $NUDGES, dialogs confirmed $PROMPTS, declined ${DECLINED:-0})"; printf '%s\n' "$rc" > "$RUN/rc"
  collect; drive stop "$SES"
  # only a fixture this run built under the work folder: the 535 trial's clone is never removed
  [ "$KEEP" = 1 ] || case "$FX" in "$WORK"/?*) rm -rf "$FX" ;; esac
  node "$HERE/metrics.mjs" "$RUN" > "$RUN/summary.json" 2>> "$RUN/run.log" && log "summary: $(jq -c '{verdict, usd, turns, minutes}' "$RUN/summary.json" 2>/dev/null)"
  return "$rc"
}

# ---------------------------------------------------------------- main
# which scenarios start from a snapshot (then one_run builds no fixture and starts no session): scenarios-main.sh
# redefines this
from_snapshot() { return 1; }
. "$HERE/scenarios.sh"
# the scenarios that need main to make the guarded calls on request (scripted main, plan §4.7)
. "$HERE/scenarios-main.sh"
sc=${1:-}; [ -n "$sc" ] || die 'usage: run.sh <scenario> [-n runs] [-w workdir] [-k]'
shift
# the fixture alone (tests/judge-strict.check.mjs, AC-F28-1): no session, no remote, no results
if [ "$sc" = fixture ]; then { [ $# -eq 1 ] || [ $# -eq 2 ]; } || die 'usage: run.sh fixture <dir> [typescript|python]'; fixture "$1" "${2:-$STACK}"; exit 0; fi
while [ $# -gt 0 ]; do case "$1" in -n) RUNS=$2; shift 2 ;; -w) WORK=$2; shift 2 ;; -k) KEEP=1; shift ;; --model) MODEL=$2; shift 2 ;; --stack) STACK=$2; shift 2 ;; *) die "unknown option $1" ;; esac; done
case "$STACK" in typescript|python) ;; *) die "unknown stack $STACK" ;; esac
# the work folder by its real path, as the fixtures and the records name it (a snapshot is restored only into its own)
mkdir -p "$WORK" && WORK=$(cd "$WORK" && pwd -P) || die "cannot use the work folder $WORK"
# the fixtures the session can write must not lie in or over the snapshot folder (security review r1)
case "$WORK/" in "$SNAPS"/*|"$SNAPS/") die "the work folder $WORK is inside the snapshot folder $SNAPS" ;; esac
case "$SNAPS/" in "$WORK"/*) die "the snapshot folder $SNAPS is inside the work folder $WORK" ;; esac
RESULTS=${FLOW_EVAL_RESULTS:-$WORK/results}
case "$sc" in
  list) scenario_list ;;
  selftest) selftest ;;
  daemon-stop) daemon_stop; echo stopped ;;
  *) command -v "scenario_$sc" > /dev/null 2>&1 || die "no scenario $sc"
     fails=0; n=1 # not `i`: the wait loops inside a run use it (S1 once ran one time and reported 3/3)
     while [ "$n" -le "$RUNS" ]; do one_run "$sc" "$n" || fails=$((fails + 1)); n=$((n + 1)); done
     log "$sc: $((RUNS - fails))/$RUNS runs ended as expected"; [ "$fails" = 0 ] ;;
esac
