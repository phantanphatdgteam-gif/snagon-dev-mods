#!/bin/sh
# The state of a repository that the 535 trial must leave as it was (plan §4.9, AC-06-5): HEAD, every ref with its
# object, packed-refs, refs/stash, `git status`, and the content of the uncommitted part (tracked changes, untracked
# files). Run before and after the trial; the two outputs must be identical. Read-only: no optional git locks, so
# `git status` does not refresh the index.
#
# Usage: repo-state.sh <repo>
set -eu
cd "${1:?usage: repo-state.sh <repo>}"
export GIT_OPTIONAL_LOCKS=0
echo "HEAD $(git symbolic-ref -q HEAD || echo detached) $(git rev-parse HEAD)"
git for-each-ref --format='%(objectname) %(refname)'
pr=$(git rev-parse --git-path packed-refs)
if [ -f "$pr" ]; then echo "packed-refs $(shasum -a 256 < "$pr" | cut -d' ' -f1)"; else echo 'packed-refs none'; fi
echo "stash $(git rev-parse -q --verify refs/stash || echo none)"
echo '--- status'
git status --porcelain=v1 -uall
echo "--- diff $(git diff HEAD --binary | shasum -a 256 | cut -d' ' -f1)"
git ls-files -o --exclude-standard -z | xargs -0 shasum -a 256
