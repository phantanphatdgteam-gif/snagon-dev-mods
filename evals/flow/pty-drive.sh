#!/bin/sh
# Drives one interactive `claude` session from outside it, through a tmux server of its own (socket name
# `flowev`), so the owner's commands are typed at the real composer (origin `composer`) and the pane and
# transcript are read from the rendered screen. Plan v7.1 §10 row 13 names an expect script here; tmux
# replaced it (GAP-step13-2): expect sees the raw byte stream, where the TUI draws spaces as cursor moves,
# while `tmux capture-pane` gives the screen as painted.
#
# Usage: pty-drive.sh <command> <session> [args]
#   start <session> <cwd> <log> -- <claude args...>   new 200x60 session; answers the folder-trust dialog
#   type <session> <text>        types the text (literal keys), waits 0.3 s, then Enter
#   keys <session> <key>...      raw tmux key names (Escape, Down, Enter, C-c)
#   screen <session> [lines]     the screen with that many scrollback lines (default 80)
#   wait <session> <sec> <ere>   polls the screen for the extended regex; prints the matching line; exit 1 at timeout
#   busy <session>               exit 0 while a turn runs ("esc to interrupt" on screen), 1 when idle
#   idle <session> <sec>         waits until no turn runs ("esc to interrupt" gone) for 4 s in a row; exit 1 at timeout
#   stop <session>               /exit, then the session is killed
set -u
SOCK=flowev
T() { tmux -L "$SOCK" "$@"; }
die() { echo "pty-drive: $*" >&2; exit 2; }
cmd=${1:-}; name=${2:-}; [ -n "$cmd" ] && [ -n "$name" ] || die 'usage: pty-drive.sh <command> <session> [args]'
shift 2

screen() { T capture-pane -p -t "$name" -S "-${1:-80}" 2>/dev/null; }
busy() { screen 20 | grep -q 'esc to interrupt'; }
wait_re() { # <sec> <ere>: the first screen line matching, or exit 1
  sec=$1; re=$2; i=0
  while [ "$i" -lt "$sec" ]; do
    line=$(screen 200 | grep -E -- "$re" | tail -1)
    [ -n "$line" ] && { printf '%s\n' "$line"; return 0; }
    sleep 1; i=$((i + 1))
  done
  echo "pty-drive: timeout after ${sec}s waiting for /$re/" >&2; return 1
}

case "$cmd" in
  start)
    cwd=$1; log=$2; shift 2; [ "${1:-}" = '--' ] && shift
    [ -d "$cwd" ] || die "no folder $cwd"
    T has-session -t "$name" 2>/dev/null && die "session $name exists"
    # the claude arguments are passed as one shell line to tmux: each quoted for the shell
    line=''; for a in "$@"; do line="$line '$(printf '%s' "$a" | sed "s/'/'\\\\''/g")'"; done
    # 150 rows: the release echo in the pane (with verify.md) runs past 60 rows, and the approval line is read from the screen
    T new-session -d -s "$name" -x 200 -y 150 -c "$cwd" "exec claude $line 2>> '$log'" || die 'tmux failed'
    # the trust dialog (a new folder) highlights "No, exit": move down once, then confirm; else the prompt box
    i=0
    while [ "$i" -lt 60 ]; do
      s=$(screen 40)
      if printf '%s' "$s" | grep -q 'Yes, I trust this folder'; then T send-keys -t "$name" Down; sleep 0.5; T send-keys -t "$name" Enter; sleep 2
      elif printf '%s' "$s" | grep -q 'Try "'; then exit 0
      fi
      sleep 1; i=$((i + 1))
    done
    die 'the prompt box did not appear within 60 s'
    ;;
  type) T send-keys -t "$name" -l -- "$1"; sleep 0.3; T send-keys -t "$name" Enter ;;
  keys) T send-keys -t "$name" "$@" ;;
  screen) screen "${1:-80}" ;;
  wait) wait_re "$1" "$2" ;;
  busy) busy ;;
  idle)
    sec=$1; i=0; quiet=0
    while [ "$i" -lt "$sec" ]; do
      if busy; then quiet=0; else quiet=$((quiet + 1)); fi
      [ "$quiet" -ge 4 ] && exit 0
      sleep 1; i=$((i + 1))
    done
    echo "pty-drive: still busy after ${sec}s" >&2; exit 1
    ;;
  stop)
    if T has-session -t "$name" 2>/dev/null; then
      T send-keys -t "$name" -l -- '/exit'; sleep 0.3; T send-keys -t "$name" Enter; sleep 3
      T kill-session -t "$name" 2>/dev/null
    fi
    ;;
  *) die "unknown command $cmd" ;;
esac
