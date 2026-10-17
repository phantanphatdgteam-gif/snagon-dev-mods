#!/bin/sh
# Live flow evals (plan v7.1 §9, §10 row 13): each run builds a fixture TypeScript repository, starts a fresh
# interactive `claude` session with the mod loaded (pty-drive.sh, tmux), plays the project owner (types the
# /flow-* commands, reads hash8 and the release code from the pane) and keeps the evidence under results/.
# Scenario steps live in scenarios.sh; metrics.mjs reads a run folder afterwards.
#
# Usage: run.sh <scenario> [-n <runs>] [-w <workdir>] [-k]
#   scenario: dryrun | H123 | H4 | H5 | S1 … S11 | list | selftest
#   -n runs (default 1), -w work folder (default ${TMPDIR:-/tmp}/flow-evals), -k keep the fixture folders
#   run.sh daemon-stop   stops the git daemon that serves the local remotes
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
RUNS=1; KEEP=0
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
# The fixture repository: vitest green, eslint red (a known unused helper: S4), tsc green; sum drops negative
# numbers (the seeded bug F-02 fixes), stats.ts holds a console.log (pre-existing junk the scan must not
# flag), src/clamp.ts does not exist yet (F-01, "(new)"), stats.ts gets a new export (F-03, RED missing-export).
fixture() { # <dir>
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
  printf '%s\n' '{ "permissions": { "allow": ["Bash", "Read", "Glob", "Grep", "Agent", "Skill", "TodoWrite", "mcp__snagon-dev-mods__flow_status", "mcp__snagon-dev-mods__flow_check", "mcp__snagon-dev-mods__memory_save", "mcp__snagon-dev-mods__memory_search", "mcp__snagon-dev-mods__memory_get"] } }' > "$d/.claude/settings.json"
  printf '%s\n' '{ "journalDir": ".snagon/journal" }' > "$d/.snagon/config.json"
  printf '# Written by the snagon-dev-mods mod: everything here is per-user, per-machine data.\n*\n' > "$d/.snagon/.gitignore"
  (cd "$d" && npm install --no-audit --no-fund --loglevel=error > /dev/null 2>&1) || die 'npm install failed'
  (cd "$d" && git init -q -b main && git config user.name fx && git config user.email fx@example.invalid && git add -A && git commit -q -m 'fixture: sum, stats, legacy') || die 'git init failed'
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
remote_add() { # <dir> <name>: a bare remote for this run, `origin` of the fixture, main pushed
  git init -q --bare "$WORK/remotes/$2.git" && (cd "$1" && git remote add origin "git://127.0.0.1:$PORT/$2.git" && git push -q origin main) || die 'remote failed'
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
confirm() {
  s=$(drive screen "$SES" 5); printf '%s' "$s" | grep -q 'Do you want to' || return 0
  if printf '%s' "$s" | grep -q 'settings.local.json'; then drive keys "$SES" Enter; PROMPTS=$((${PROMPTS:-0} + 1)); log 'confirmed the settings write dialog'
  else drive keys "$SES" Escape; DECLINED=$((${DECLINED:-0} + 1)); log "declined a dialog: $(printf '%s' "$s" | grep -E 'outside of sandbox|unsandboxed|Host:|Do you want' | head -2 | tr '\n' ' ')"; fi
  sleep 3
}
timeline() { # one line per change of task/awaiting/blocked
  now=$(rec | jq -c '{v: .version, phase, task, feature, awaiting, blocked: .blocked.reason, spent}' 2>/dev/null)
  [ -n "$now" ] && [ "$now" != "${LAST_STATE:-}" ] && { LAST_STATE=$now; printf '%s\t%s\n' "$(date +%s)" "$now" >> "$RUN/timeline.tsv"; log "state: $now"; rec > "$RUN/record-v$(field '.version').json"; [ -s "$RUN/flowid" ] || flow_id > "$RUN/flowid"
    # the baseline and RED files go when the flow ends: kept as soon as they exist
    for x in baseline red; do f="$HOME/.snagon/flow/$(cat "$RUN/flowid").$x.json"; [ -f "$f" ] && [ ! -f "$RUN/$(basename "$f")" ] && cp -p "$f" "$RUN/"; done; }
}
# robot <timeout-seconds>: plays the owner until the flow ends, blocks (other than a cost cap, retried once) or
# the time is up. $INTENT is what /flow-plan asks for. Exit 0 ended, 1 blocked, 3 timeout, 4 stalled.
robot() {
  deadline=$(( $(date +%s) + $1 )); retried=0; ships=0; idle_s=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    confirm; timeline
    if ended; then log 'flow ended'; return 0; fi
    aw=$(field '.awaiting'); bl=$(field '.blocked.reason'); task=$(field '.task')
    if [ -n "$bl" ]; then
      if [ "$bl" = cost ] && [ "$retried" = 0 ]; then retried=1; owner '/flow-retry cost'; continue; fi
      # a floor block on fix-scope findings (FL-n, HIGH, waivable): the dry run plays the owner who read the hunk and
      # waives, at most six times a run; each waiver is an echo the owner approves
      if [ "$bl" = floor ] && [ "${waived:-0}" -lt 6 ]; then
        for id in $(rec | jq -r '.findings[] | select(.status == "open" and (.id | startswith("FL-"))) | .id'); do
          waived=$((${waived:-0} + 1)); WAIVED=$waived; owner "/flow-waive $id dry run: the hunk outside the FIX range was read by the harness owner"
          approve waive || log "no waive echo for $id"
        done
        continue
      fi
      log "blocked: $bl"; return 1
    fi
    case "$aw" in
      '/flow-status') owner '/flow-status'; approve baseline || return 1 ;;
      '/flow-plan') if [ "$task" = P3 ]; then owner '/flow-plan'; approve plan || return 1; else owner "/flow-plan $INTENT"; fi ;;
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

# ---------------------------------------------------------------- one run
start_session() { # the session on the fixture, its id fixed so the transcript path is known
  SID=$(uuidgen | tr 'A-Z' 'a-z'); printf '%s\n' "$SID" > "$RUN/session-id"
  drive start "$SES" "$FX" "$RUN/claude.err" -- --plugin-dir "$MOD_COPY" --strict-mcp-config --permission-mode acceptEdits --session-id "$SID" --settings "$OFF" ${MODEL:+--model "$MODEL"} || die 'session did not start'
  log "session $SID on $FX"
}
collect() { # the evidence: screen, record, transcript and its subagents, cost rows, timings
  drive screen "$SES" 400 > "$RUN/screen.txt" 2>/dev/null
  rec > "$RUN/record-final.json" 2>/dev/null; flow_id > "$RUN/flowid" 2>/dev/null
  slug=$(printf '%s' "$FX" | sed 's/[^A-Za-z0-9]/-/g')
  cp "$HOME/.claude/projects/$slug/$SID.jsonl" "$RUN/transcript.jsonl" 2>/dev/null
  [ -d "$HOME/.claude/projects/$slug/$SID/subagents" ] && cp -R "$HOME/.claude/projects/$slug/$SID/subagents" "$RUN/subagents"
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
  NAME="$1-$2-$(date +%H%M%S)"; SES="ev-$NAME"; RUN="$RESULTS/$1/$NAME"; FX="$WORK/$NAME"; NUDGES=0; PROMPTS=0; LAST_STATE=''
  mkdir -p "$RUN" "$WORK" || die 'cannot create folders'; RUN_LOG="$RUN/run.log"
  log "run $NAME"; sync_mod; fixture "$FX"; daemon_start; remote_add "$FX" "$NAME"
  FX=$(cd "$FX" && pwd -P)
  direct_ms=$( (cd "$FX" && s=$(date +%s%N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1e9))'); npm test > /dev/null 2>&1; e=$(date +%s%N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1e9))'); echo $(( (e - s) / 1000000 ))) )
  printf '{"directTestMs": %s}\n' "$direct_ms" > "$RUN/direct.json"
  start_session
  "scenario_$1"; rc=$?
  log "scenario rc=$rc (nudges $NUDGES, dialogs confirmed $PROMPTS, declined ${DECLINED:-0})"; printf '%s\n' "$rc" > "$RUN/rc"
  collect; drive stop "$SES"
  [ "$KEEP" = 1 ] || rm -rf "$FX"
  node "$HERE/metrics.mjs" "$RUN" > "$RUN/summary.json" 2>> "$RUN/run.log" && log "summary: $(jq -c '{verdict, usd, turns, minutes}' "$RUN/summary.json" 2>/dev/null)"
  return "$rc"
}

# ---------------------------------------------------------------- main
. "$HERE/scenarios.sh"
sc=${1:-}; [ -n "$sc" ] || die 'usage: run.sh <scenario> [-n runs] [-w workdir] [-k]'
shift
while [ $# -gt 0 ]; do case "$1" in -n) RUNS=$2; shift 2 ;; -w) WORK=$2; shift 2 ;; -k) KEEP=1; shift ;; --model) MODEL=$2; shift 2 ;; *) die "unknown option $1" ;; esac; done
case "$sc" in
  list) scenario_list ;;
  selftest) selftest ;;
  daemon-stop) daemon_stop; echo stopped ;;
  *) command -v "scenario_$sc" > /dev/null 2>&1 || die "no scenario $sc"
     fails=0; n=1 # not `i`: the wait loops inside a run use it (S1 once ran one time and reported 3/3)
     while [ "$n" -le "$RUNS" ]; do one_run "$sc" "$n" || fails=$((fails + 1)); n=$((n + 1)); done
     log "$sc: $((RUNS - fails))/$RUNS runs ended as expected"; [ "$fails" = 0 ] ;;
esac
