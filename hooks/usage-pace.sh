#!/usr/bin/env bash

exec 2>/dev/null

even_pace() {
  printf '%s\n' 'def even_pace($reset; $duration): ([100 * (1 - (($reset - $now) / $duration)), 0] | max | [., 100] | min | (. * 1000000 | round) / 1000000);'
}

now=${USAGE_PACE_NOW:-$(date +%s)}
json_mode=false
[ "${1:-}" = "--json" ] && json_mode=true

if [ "$json_mode" = false ] && [ ! -f "$HOME/.claude/agents/sol-implementer.md" ] && [ ! -f "$HOME/.claude/agents/astra-implementer.md" ]; then
  exit 0
fi

snapshot="$HOME/.claude/state/usage-snapshot.json"
claude='{"week":null,"five_hour":null,"ahead":false}'
if [ -f "$snapshot" ]; then
  calculated=$(jq -c --argjson now "$now" "$(even_pace)"'
    def window($value):
      if ($value | type) == "object"
        and ($value.used_percentage | type) == "number"
        and ($value.resets_at | type) == "number"
        and $value.resets_at > $now
      then {
        used: $value.used_percentage,
        even: even_pace($value.resets_at; $value.duration)
      } else null end;
    if (.captured_at | type) == "number" and ($now - .captured_at) >= 0 and ($now - .captured_at) <= 43200 then
      (window({used_percentage: .seven_day.used_percentage, resets_at: .seven_day.resets_at, duration: 604800}) // null) as $week |
      (if ($now - .captured_at) <= 3600 then window({used_percentage: .five_hour.used_percentage, resets_at: .five_hour.resets_at, duration: 18000}) else null end) as $five |
      {week: $week, five_hour: $five, ahead: (($week != null and $week.used > ($week.even + 10)) or ($five != null and $five.used > 80))}
    else {week:null, five_hour:null, ahead:false} end
  ' "$snapshot")
  [ -n "$calculated" ] && claude=$calculated
fi

claude_ahead=$(printf '%s' "$claude" | jq -r '.ahead')
if [ "$json_mode" = false ] && [ "$claude_ahead" != true ]; then
  exit 0
fi

newest=""
sessions="$HOME/.codex/sessions"
if [ -d "$sessions" ]; then
  if stat --version >/dev/null 2>&1; then
    stat_format=(-c '%Y %n')
  else
    stat_format=(-f '%m %N')
  fi
  newest=$(find "$sessions" -type f -name '*.jsonl' -mtime -8 -exec stat "${stat_format[@]}" {} + | LC_ALL=C sort -nr | head -n 1 | cut -d ' ' -f 2-)
fi

rate_limits=""
if [ -n "$newest" ]; then
  rate_limits=$(grep -F '"rate_limits":{' "$newest" | tail -n 1 | jq -c '.payload.rate_limits // empty')
fi

codex='{"windows":[],"high":false,"unknown":true}'
if [ -n "$rate_limits" ]; then
  calculated=$(printf '%s' "$rate_limits" | jq -c --argjson now "$now" "$(even_pace)"'
    [.primary, .secondary]
    | map(select(
        (type == "object")
        and (.used_percent | type) == "number"
        and (.window_minutes | type) == "number"
        and .window_minutes > 0
        and (.resets_at | type) == "number"
        and .resets_at > $now
      ) | {
        name: (if .window_minutes == 10080 then "week" elif .window_minutes == 300 then "5-hour" else ((.window_minutes | tostring) + "-minute") end),
        used: .used_percent,
        even: even_pace(.resets_at; (.window_minutes * 60)),
        window_minutes: .window_minutes,
        high: (if .window_minutes <= 300 then .used_percent > 80 else .used_percent > even_pace(.resets_at; (.window_minutes * 60)) end)
      })
    | {windows: ., high: any(.[]; .high), unknown: (length == 0)}
  ')
  [ -n "$calculated" ] && codex=$calculated
fi

result=$(jq -cn --argjson claude "$claude" --argjson codex "$codex" '{claude:$claude,codex:$codex}')

if $json_mode; then
  printf '%s\n' "$result"
  exit 0
fi

[ "$claude_ahead" = true ] || exit 0

context=$(printf '%s' "$result" | jq -r '
  def rounded: round | tostring;
  def parts($windows): $windows | map(.name + " " + (.used | rounded) + "% used, even pace " + (.even | rounded) + "%") | join("; ");
  ([if .claude.week != null then "week " + (.claude.week.used | rounded) + "% used, even pace " + (.claude.week.even | rounded) + "%" else empty end,
    if .claude.five_hour != null then "5-hour " + (.claude.five_hour.used | rounded) + "% used" else empty end] | join("; ")) as $claude_parts |
  if .codex.high then
    "Usage pace: Claude is ahead of pace (" + $claude_parts + ") and Codex is ahead of its pace too (" + (parts(.codex.windows)) + "). Do not switch models. Tell the operator that both plans are high and ask what to do."
  elif .codex.unknown then
    "Usage pace: Claude is ahead of pace (" + $claude_parts + "). Codex usage unknown. Route implementation to sol-implementer or astra-implementer, as rules/40-model-routing.md says, and tell the operator."
  else
    "Usage pace: Claude is ahead of pace (" + $claude_parts + "). Codex: " + (parts(.codex.windows)) + ". Route implementation to sol-implementer or astra-implementer, as rules/40-model-routing.md says, and tell the operator."
  end
')

jq -cn --arg context "$context" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$context}}'
exit 0
