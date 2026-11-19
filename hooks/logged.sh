#!/bin/bash
# Usage: logged.sh <script-name> [args...]
# Runs a hook script from this folder. Exit 0 and 2 pass through with stdout and
# stderr. Any other exit lets the action through: it appends one line to
# ~/.claude/ledger-hook-failures.log, which the next session start reports.
# Pure shell, so a hook still runs and logs when `ledger` cannot.

name=${1:-}
shift
script="$(dirname "$0")/$name"

err=$(mktemp "${TMPDIR:-/tmp}/logged-hook.XXXXXX" 2>/dev/null) || exec "$script" "$@"
trap 'rm -f "$err"' EXIT

# The shell's own stderr goes to the capture too, so its report of a script
# killed by a signal does not reach Claude Code. Fd 3 keeps the real stderr.
exec 3>&2 2>"$err"
"$script" "$@" 3>&-
code=$?

if [ "$code" -eq 0 ] || [ "$code" -eq 2 ]; then
  cat "$err" >&3
  exit "$code"
fi

message=$(grep -v '^[[:space:]]*$' "$err" | tail -n 1 | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//' | cut -c 1-500)
[ -n "$message" ] || message="exit $code"
mkdir -p "$HOME/.claude" &&
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" "$message" >>"$HOME/.claude/ledger-hook-failures.log"
exit 0
