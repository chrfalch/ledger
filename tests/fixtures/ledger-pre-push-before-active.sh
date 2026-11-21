#!/usr/bin/env bash
# Written by ledger, which writes it again when it differs. It blocks a push whose new commits change anything but
# ledgers, as plain files, or add secret-like text, and prints only where. ledger store sync checks the same before it
# pushes. Any error blocks the push too.
set -euo pipefail
export LC_ALL=C GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null/none

blocked=0
trap 'status=$?; [ "$status" -eq 0 ] || [ "$blocked" -eq 1 ] || echo "ledger pre-push: the secret scan failed (exit $status), so the push is blocked." >&2' EXIT

patterns=(-e 'gh[pousr]_[A-Za-z0-9]{36}' -e 'github_pat_[A-Za-z0-9_]{82}' -e 'AKIA[0-9A-Z]{16}' -e 'xox[abprs]-[A-Za-z0-9-]{10,}' -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -e '(^|[^A-Za-z0-9_-])sk-(ant|proj|svcacct|admin)-[A-Za-z0-9_-]{32,}' -e '(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9]{32,}')

# The lines that match, with their numbers after -n; no match is no error, but a failing grep is.
matching() {
  local status=0
  grep -aE "$@" "${patterns[@]}" || status=$?
  [ "$status" -le 1 ]
}

# file:line<TAB>text for each line the commits add.
added_lines() {
  git -c core.quotePath=false log -p -U0 --inter-hunk-context=0 -a --format= --no-color --no-ext-diff --no-textconv --no-renames --root --diff-merges=first-parent --src-prefix=a/ --dst-prefix=b/ "$@" | tr '\000' ' ' | awk '
    /^diff --git / { inhunk = 0; file = ""; next }
    !inhunk && /^\+\+\+ / { file = ($0 == "+++ /dev/null") ? "" : substr($0, 7); next }
    /^@@ / { split($3, start, ","); line = substr(start[1], 2) + 0; inhunk = 1; next }
    inhunk && /^\+/ { if (file != "") print file ":" line "\t" substr($0, 2); line++ }
  '
}

# The allowlist of ledger store sync: a repo folder and a ledger name are never . or .., and hold no / or \ or line break.
ledger_path='^(backlog|archive)/([^/\]+)/([^/\]+)\.md$'
is_ledger() {
  case $1 in .ledger-data | .gitignore) return 0 ;; *$'\n'*) return 1 ;; esac
  [[ $1 =~ $ledger_path ]] || return 1
  case ${BASH_REMATCH[2]} in . | ..) return 1 ;; esac
  case ${BASH_REMATCH[3]} in . | ..) return 1 ;; esac
}

# A path as one line: as it is, or, when it holds a control character or a double quote, in double quotes with C
# escapes, as git quotes it; so no two paths look the same, and none is empty.
shown_path() {
  case $1 in
    *[[:cntrl:]\"]*) ;;
    *) printf '%s\n' "$1"; return 0 ;;
  esac
  local text=$1 out='' char i
  for ((i = 0; i < ${#text}; i++)); do
    char=${text:i:1}
    case $char in
      [\\\"]) out+="\\$char" ;;
      $'\n') out+='\n' ;;
      $'\t') out+='\t' ;;
      [[:cntrl:]]) out+=$(printf '\\%03o' "'$char") ;;
      *) out+=$char ;;
    esac
  done
  printf '"%s"\n' "$out"
}

# Each path the commits change that is no ledger, or that they make anything but a plain file that is not executable,
# as shown_path shows it.
not_ledgers() {
  git log --format= --raw -z --no-renames --no-abbrev --root --diff-merges=first-parent "$@" | while IFS= read -r -d '' header; do
    while [[ $header == $'\n'* ]]; do header=${header#$'\n'}; done
    [[ $header == :* ]] || continue
    IFS= read -r -d '' file || break
    read -r _ mode _ _ status <<<"${header#:}"
    if ! is_ledger "$file" || { [ "$status" != D ] && [ "$mode" != 100644 ]; }; then
      # The path as it is: an escape that shown_path writes, such as \n, would hide a secret after a line break.
      secret_name=$(printf '%s\n' "$file" | matching) || exit 1
      if [ -n "$secret_name" ]; then printf '%s\n' '<file name withheld>'; else shown_path "$file"; fi
    fi
  done
}

strays=""
found=""
while read -r _ local_sha remote_ref remote_sha; do
  case $local_sha in *[!0]*) ;; *) continue ;; esac
  # A tag, or any ref but a branch, carries text this scan does not read, such as a tag message.
  case $remote_ref in
    refs/heads/*) ;;
    *) blocked=1; echo "ledger pre-push: the push is blocked. Only branches are pushed from this clone, no tag or other ref." >&2; exit 1 ;;
  esac
  # The commits the remote branch does not have yet; for a new branch, every commit.
  case $remote_sha in
    *[!0]*) revs=("$local_sha" --not "$remote_sha") ;;
    *) revs=("$local_sha") ;;
  esac
  outside=$(not_ledgers "${revs[@]}")
  while IFS= read -r stray; do
    [ -n "$stray" ] || continue
    strays="$strays  $stray"$'\n'
  done <<<"$outside"
  names=$(git log --format= --name-only -z --no-renames --root --diff-merges=first-parent "${revs[@]}" | tr '\000' '\n' | matching)
  [ -z "$names" ] || found="$found  <file name withheld>"$'\n'
  hits=$(added_lines "${revs[@]}" | matching | cut -f1)
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    # git writes a name with a line break or another control character with C escapes, which %b undoes.
    secret_name=$(printf '%b\n' "${hit%:*}" | matching)
    [ -z "$secret_name" ] || hit="<file name withheld>:${hit##*:}"
    found="$found  $hit"$'\n'
  done <<<"$hits"
  commits=$(git rev-list "${revs[@]}")
  for commit in $commits; do
    lines=$(git log -1 --format=%B "$commit" | matching -n | cut -d: -f1)
    for line in $lines; do
      found="$found  message of commit ${commit:0:12}, line $line"$'\n'
    done
  done
done

if [ -n "$strays" ]; then
  blocked=1
  echo "ledger pre-push: the push is blocked. Only ledgers are pushed, as plain files that are not executable, and these paths are not:" >&2
  printf '%s' "$strays" | sort -u >&2
fi
if [ -n "$found" ]; then
  blocked=1
  echo "ledger pre-push: the push is blocked. These lines add secret-like text:" >&2
  printf '%s' "$found" | sort -u >&2
fi
if [ "$blocked" -eq 1 ]; then
  echo "ledger pre-push: take them out of the commits that are not pushed yet, then push again." >&2
  exit 1
fi
