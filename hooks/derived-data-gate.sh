#!/bin/bash
# PreToolUse gate on Bash: one build folder per worktree and configuration.
# Denies any -derivedDataPath that points outside that one folder.
# Exits 0 and stays silent for every other command.

self="$0"
if [ -L "$self" ]; then self=$(readlink "$self"); fi
repo=$(cd "$(dirname "$self")/.." 2>/dev/null; pwd)

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

case "$command" in
  *-derivedDataPath*) ;;
  *) exit 0 ;;
esac

# Strips quotes, expands ~, and makes $1 absolute against directory $2.
absolute() {
  local p
  p=$(printf '%s' "$1" | tr -d '"'"'"'')
  case "$p" in
    "~" | "~/"*) p="$HOME${p#\~}" ;;
  esac
  case "$p" in
    /*) printf '%s' "$p" ;;
    *) printf '%s' "$2/$p" ;;
  esac
}

value='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^ ;|&]+)'

repository_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null
}

# The app being built decides the build folder, not the session cwd. Use the
# first of these folders that is inside a git repository: the folder of
# -workspace/-project, a leading `cd <dir> &&`, the cwd. A path the hook cannot
# resolve, such as one in a shell variable, then falls back to the cwd.
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')
base="$cwd"
cd_dir=$(printf '%s' "$command" | head -1 \
  | sed -nE "s/^[[:space:]]*cd[[:space:]]+$value[[:space:]]*&&.*/\\1/p")
if [ -n "$cd_dir" ]; then
  base=$(absolute "$cd_dir" "$cwd")
fi
app=$(printf '%s' "$command" \
  | grep -oE -- "(^|[[:space:]])-(workspace|project)[= ]+$value" \
  | head -1 \
  | sed -E 's/^[[:space:]]*-(workspace|project)[= ]+//')

root=""
if [ -n "$app" ]; then
  root=$(repository_root "$(dirname "$(absolute "$app" "$base")")")
fi
if [ -z "$root" ] && [ -n "$cd_dir" ]; then
  root=$(repository_root "$base")
fi
if [ -z "$root" ]; then
  root=$(repository_root "$cwd")
fi
if [ -z "$root" ]; then
  exit 0
fi

# The folder bin/cc-dd-path names for the checkout at $root; keep the two in step.
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
main=$(cd "$(dirname "$common")" && pwd -P)
if [ "$(git -C "$root" rev-parse --path-format=absolute --git-dir)" = "$common" ]; then
  name=.main
else
  name=$(basename "$root")
fi
folder="$main/.claude/worktrees/.build/$name"

# Each -derivedDataPath is followed by = or blanks and one single-quoted, double-quoted or bare word that
# ends where the shell word ends. A flag in any other spelling is not read, so it is denied.
word='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:];|&()<>"'"'"'`]+)'
end='[[:space:];|&)]'
flags=$(( $(printf '%s\n' "$command" | grep -o -- '-derivedDataPath' | wc -l) ))
paths=$(printf '%s\n' "$command" \
  | grep -oE -- "-derivedDataPath(=|[[:space:]]+)$word($end|\$)" \
  | sed -E "s/^-derivedDataPath(=|[[:space:]]+)//; s/$end\$//" \
  | sed -E "s#^~(/|\$)#$HOME\\1#; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/")

# A configuration is one folder name right after "$folder/", as bin/cc-dd-path accepts it. That also
# rules out $, backticks, //, a trailing slash and .. anywhere in the path. An empty value is not read.
bad=""
read_paths=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  read_paths=$((read_paths + 1))
  config=${p#"$folder/"}
  if [ "$config" = "$p" ] || ! [[ "$config" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]]; then
    bad="$bad$p "
  fi
done <<< "$paths"
if [ "$read_paths" -ne "$flags" ]; then
  bad="${bad}(a -derivedDataPath this hook cannot read) "
fi
if [ -z "$bad" ]; then
  exit 0
fi

reason=$(printf '%s\n' \
  "Build folder is not reusable: $bad" \
  "" \
  "Use one folder per worktree and configuration:" \
  "  $folder/<configuration>" \
  "for example $folder/Debug-sim." \
  "" \
  "Write the path in full in the command, not as a shell variable such as \$D." \
  "This hook reads the command text and cannot see what a variable holds." \
  "" \
  "Get the exact path: run $repo/bin/cc-dd-path <configuration>" \
  "in the folder of the app you build." \
  "Never put a build folder in the session scratchpad or in /tmp.")

# While the operator's `ledger root on` lasts, allow the call and log it, as tools/ledger/root.ts does for its gates.
# A missing or garbled marker, or one spanning more than the 240 minutes `ledger root on` allows, fails jq -e, so the
# deny stands.
if jq -e --argjson now "$(date +%s)" \
  '(.sinceEpoch | numbers) as $since | (.untilEpoch | numbers) as $until | $since <= $now and $now < $until and $until - $since <= 14400' \
  "$HOME/.claude/ledger-root.json" >/dev/null 2>&1; then
  jq -nc --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cwd "$cwd" --arg reason "$reason" --arg command "$command" \
    '{at: $at, tool: "Bash", cwd: $cwd, reason: $reason, command: $command}' >>"$HOME/.claude/ledger-root.log" 2>/dev/null
  exit 0
fi

printf '%s' "$reason" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: .
  }
}'
