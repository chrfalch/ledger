#!/usr/bin/env bash

input=$(cat)
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null)
# Bash 5.2 expands a ~ in a ${var/pattern/~} replacement back to $HOME.
case "$dir" in "$HOME"*) dir="~${dir#"$HOME"}" ;; esac
model=$(printf '%s' "$input" | jq -r '.model.display_name // ""' 2>/dev/null)
sess=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
week=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
sess_seg=""
[ -n "$sess" ] && sess_seg=" | session:$(printf '%.0f' "$sess")%"
week_seg=""
[ -n "$week" ] && week_seg=" week:$(printf '%.0f' "$week")%"
branch=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git branch --show-current 2>/dev/null)
fi
branch_seg=""
[ -n "$branch" ] && branch_seg=" \033[0;32m${branch}\033[0m"
printf '%b' "\033[0;34m${dir}\033[0m${branch_seg} [\033[0;36m${model}\033[0m${sess_seg}${week_seg}]"

if printf '%s' "$input" | jq -e '(.rate_limits.five_hour? != null) or (.rate_limits.seven_day? != null)' >/dev/null 2>&1; then
  state_dir="$HOME/.claude/state"
  if mkdir -p "$state_dir" 2>/dev/null; then
    tmp=$(mktemp "$state_dir/.usage-snapshot.XXXXXX" 2>/dev/null) || tmp=""
    if [ -n "$tmp" ]; then
      if printf '%s' "$input" | jq --argjson captured_at "$(date +%s)" '{captured_at: $captured_at, five_hour: (.rate_limits.five_hour // null), seven_day: (.rate_limits.seven_day // null)}' >"$tmp" 2>/dev/null; then
        mv -f "$tmp" "$state_dir/usage-snapshot.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
      else
        rm -f "$tmp" 2>/dev/null
      fi
    fi
  fi
fi

exit 0
