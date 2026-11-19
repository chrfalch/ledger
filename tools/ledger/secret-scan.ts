/**
 * Secret-like text, as patterns that are both JavaScript regular expressions and POSIX extended ones, so `ledger store sync`
 * and the pre-push hook it writes search for exactly the same text. An `sk-` key must not follow a letter, a digit, `_`
 * or `-`, so a slug such as task-disk-… is no key.
 */
export const SECRET_PATTERNS: readonly string[] = [
  'gh[pousr]_[A-Za-z0-9]{36}',
  'github_pat_[A-Za-z0-9_]{82}',
  'AKIA[0-9A-Z]{16}',
  'xox[abprs]-[A-Za-z0-9-]{10,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  '(^|[^A-Za-z0-9_-])sk-(ant|proj|svcacct|admin)-[A-Za-z0-9_-]{32,}',
  '(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9]{32,}',
];

const PATTERNS = SECRET_PATTERNS.map((pattern) => new RegExp(pattern));

export const isSecretLike = (text: string): boolean => PATTERNS.some((pattern) => pattern.test(text));

/**
 * `git log` arguments that print every line the commits add: binary files as text, renames as a new file, the first
 * commit of a history as all added, and a merge against its first parent, so a line written while resolving a conflict
 * counts as added. Each is explicit, so no git config, such as log.showRoot, diff.noprefix or diff.interHunkContext,
 * changes what is printed: a hunk holds no line of context, which the line count would skip.
 */
export const ADDED_LINES_LOG = ['-c', 'core.quotePath=false', 'log', '-p', '-U0', '--inter-hunk-context=0', '-a', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--root', '--diff-merges=first-parent', '--src-prefix=a/', '--dst-prefix=b/'];

/** `git log` arguments that print each change of the commits as ":<old mode> <new mode> <old> <new> <status>" and its path, NUL-separated. */
export const RAW_CHANGES_LOG = ['log', '--format=', '--raw', '-z', '--no-renames', '--no-abbrev', '--root', '--diff-merges=first-parent'];

/** `git log` arguments that print the paths the commits touch, NUL-separated, diffed as ADDED_LINES_LOG diffs them. */
export const CHANGED_PATHS_LOG = ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '--diff-merges=first-parent'];

/** `git log` arguments that print, for each commit, a NUL, its full object name, a NUL and its message. */
export const MESSAGES_LOG = ['log', '--format=%x00%H%x00%B'];

/** Where a commit message of the output of MESSAGES_LOG holds secret-like text, as `message of commit <12 hex digits>, line <n>`. */
export function messageLocations(log: string): string[] {
  const [, ...parts] = log.split('\0');
  const found: string[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [commit, message] = [parts[index], parts[index + 1]];
    message.split('\n').forEach((text, line) => {
      if (isSecretLike(text)) found.push(`message of commit ${commit.slice(0, 12)}, line ${line + 1}`);
    });
  }
  return found;
}

export const WITHHELD = '<file name withheld>';

/**
 * Where the output of ADDED_LINES_LOG adds secret-like text, as `<file>:<line>`, and each path of `paths` that is
 * secret-like itself, as WITHHELD; a secret-like file name is never printed. Sorted, without repeats. The pre-push hook
 * reads the log the same way, in awk.
 */
export function secretLocations(log: string, paths: string[]): string[] {
  const found = new Set<string>(paths.some(isSecretLike) ? [WITHHELD] : []);
  let file: string | undefined;
  let line = 0;
  let inHunk = false;
  for (const text of log.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false;
      file = undefined;
      continue;
    }
    if (!inHunk && text.startsWith('+++ ')) {
      file = text === '+++ /dev/null' ? undefined : text.slice('+++ b/'.length);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !text.startsWith('+')) continue;
    if (file !== undefined && isSecretLike(text.slice(1))) found.add(`${isSecretLike(file) ? WITHHELD : file}:${line}`);
    line++;
  }
  return [...found].sort();
}

const quoted = (text: string): string => `'${text}'`;

/**
 * The pre-push hook: it blocks a push whose new commits change a path that is no ledger, or a ledger to anything but a
 * plain file, or add secret-like text, in a file, a file name or a commit message, and prints only where. It scans from
 * the object the remote has, as git passes it, so no local ref can hide a commit, and reads objects without replace refs
 * or grafts. It fails closed: an error in any step blocks the push too. Bash, so it runs where `ledger` is not installed.
 */
export function prePushHook(): string {
  if (SECRET_PATTERNS.some((pattern) => pattern.includes("'"))) throw new Error('a secret pattern holds a quote, which the hook cannot hold');
  const added = ADDED_LINES_LOG.join(' ');
  const changed = CHANGED_PATHS_LOG.join(' ');
  return [
    '#!/usr/bin/env bash',
    '# Written by ledger, which writes it again when it differs. It blocks a push whose new commits change anything but',
    '# ledgers, as plain files, or add secret-like text, and prints only where. ledger store sync checks the same before it',
    '# pushes. Any error blocks the push too.',
    'set -euo pipefail',
    'export LC_ALL=C GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null/none',
    '',
    'blocked=0',
    "trap 'status=$?; [ \"$status\" -eq 0 ] || [ \"$blocked\" -eq 1 ] || echo \"ledger pre-push: the secret scan failed (exit $status), so the push is blocked.\" >&2' EXIT",
    '',
    `patterns=(${SECRET_PATTERNS.map((pattern) => `-e ${quoted(pattern)}`).join(' ')})`,
    '',
    '# The lines that match, with their numbers after -n; no match is no error, but a failing grep is.',
    'matching() {',
    '  local status=0',
    '  grep -aE "$@" "${patterns[@]}" || status=$?',
    '  [ "$status" -le 1 ]',
    '}',
    '',
    '# file:line<TAB>text for each line the commits add.',
    'added_lines() {',
    `  git ${added} "$@" | tr '\\000' ' ' | awk '`,
    '    /^diff --git / { inhunk = 0; file = ""; next }',
    '    !inhunk && /^\\+\\+\\+ / { file = ($0 == "+++ /dev/null") ? "" : substr($0, 7); next }',
    '    /^@@ / { split($3, start, ","); line = substr(start[1], 2) + 0; inhunk = 1; next }',
    '    inhunk && /^\\+/ { if (file != "") print file ":" line "\\t" substr($0, 2); line++ }',
    "  '",
    '}',
    '',
    '# The allowlist of ledger store sync: a repo folder and a ledger name are never . or .., and hold no / or \\ or line break.',
    "ledger_path='^(backlog|archive)/([^/\\]+)/([^/\\]+)\\.md$'",
    'is_ledger() {',
    '  case $1 in .ledger-data | .gitignore) return 0 ;; *$\'\\n\'*) return 1 ;; esac',
    '  [[ $1 =~ $ledger_path ]] || return 1',
    '  case ${BASH_REMATCH[2]} in . | ..) return 1 ;; esac',
    '  case ${BASH_REMATCH[3]} in . | ..) return 1 ;; esac',
    '}',
    '',
    '# A path as one line: as it is, or, when it holds a control character or a double quote, in double quotes with C',
    '# escapes, as git quotes it; so no two paths look the same, and none is empty.',
    'shown_path() {',
    '  case $1 in',
    '    *[[:cntrl:]\\"]*) ;;',
    "    *) printf '%s\\n' \"$1\"; return 0 ;;",
    '  esac',
    "  local text=$1 out='' char i",
    '  for ((i = 0; i < ${#text}; i++)); do',
    '    char=${text:i:1}',
    '    case $char in',
    '      [\\\\\\"]) out+="\\\\$char" ;;',
    "      $'\\n') out+='\\n' ;;",
    "      $'\\t') out+='\\t' ;;",
    "      [[:cntrl:]]) out+=$(printf '\\\\%03o' \"'$char\") ;;",
    '      *) out+=$char ;;',
    '    esac',
    '  done',
    "  printf '\"%s\"\\n' \"$out\"",
    '}',
    '',
    '# Each path the commits change that is no ledger, or that they make anything but a plain file that is not executable,',
    '# as shown_path shows it.',
    'not_ledgers() {',
    `  git ${RAW_CHANGES_LOG.join(' ')} "$@" | while IFS= read -r -d '' header; do`,
    "    while [[ $header == $'\\n'* ]]; do header=${header#$'\\n'}; done",
    '    [[ $header == :* ]] || continue',
    "    IFS= read -r -d '' file || break",
    '    read -r _ mode _ _ status <<<"${header#:}"',
    '    if ! is_ledger "$file" || { [ "$status" != D ] && [ "$mode" != 100644 ]; }; then',
    '      # The path as it is: an escape that shown_path writes, such as \\n, would hide a secret after a line break.',
    '      secret_name=$(printf \'%s\\n\' "$file" | matching) || exit 1',
    `      if [ -n "$secret_name" ]; then printf '%s\\n' '${WITHHELD}'; else shown_path "$file"; fi`,
    '    fi',
    '  done',
    '}',
    '',
    'strays=""',
    'found=""',
    'while read -r _ local_sha remote_ref remote_sha; do',
    '  case $local_sha in *[!0]*) ;; *) continue ;; esac',
    '  # A tag, or any ref but a branch, carries text this scan does not read, such as a tag message.',
    '  case $remote_ref in',
    '    refs/heads/*) ;;',
    '    *) blocked=1; echo "ledger pre-push: the push is blocked. Only branches are pushed from this clone, no tag or other ref." >&2; exit 1 ;;',
    '  esac',
    '  # The commits the remote branch does not have yet; for a new branch, every commit.',
    '  case $remote_sha in',
    '    *[!0]*) revs=("$local_sha" --not "$remote_sha") ;;',
    '    *) revs=("$local_sha") ;;',
    '  esac',
    '  outside=$(not_ledgers "${revs[@]}")',
    '  while IFS= read -r stray; do',
    '    [ -n "$stray" ] || continue',
    '    strays="$strays  $stray"$\'\\n\'',
    '  done <<<"$outside"',
    `  names=$(git ${changed} "\${revs[@]}" | tr '\\000' '\\n' | matching)`,
    `  [ -z "$names" ] || found="$found  ${WITHHELD}"$'\\n'`,
    '  hits=$(added_lines "${revs[@]}" | matching | cut -f1)',
    '  while IFS= read -r hit; do',
    '    [ -n "$hit" ] || continue',
    '    # git writes a name with a line break or another control character with C escapes, which %b undoes.',
    '    secret_name=$(printf \'%b\\n\' "${hit%:*}" | matching)',
    `    [ -z "$secret_name" ] || hit="${WITHHELD}:\${hit##*:}"`,
    '    found="$found  $hit"$\'\\n\'',
    '  done <<<"$hits"',
    '  commits=$(git rev-list "${revs[@]}")',
    '  for commit in $commits; do',
    '    lines=$(git log -1 --format=%B "$commit" | matching -n | cut -d: -f1)',
    '    for line in $lines; do',
    '      found="$found  message of commit ${commit:0:12}, line $line"$\'\\n\'',
    '    done',
    '  done',
    'done',
    '',
    'if [ -n "$strays" ]; then',
    '  blocked=1',
    '  echo "ledger pre-push: the push is blocked. Only ledgers are pushed, as plain files that are not executable, and these paths are not:" >&2',
    '  printf \'%s\' "$strays" | sort -u >&2',
    'fi',
    'if [ -n "$found" ]; then',
    '  blocked=1',
    '  echo "ledger pre-push: the push is blocked. These lines add secret-like text:" >&2',
    '  printf \'%s\' "$found" | sort -u >&2',
    'fi',
    'if [ "$blocked" -eq 1 ]; then',
    '  echo "ledger pre-push: take them out of the commits that are not pushed yet, then push again." >&2',
    '  exit 1',
    'fi',
    '',
  ].join('\n');
}
