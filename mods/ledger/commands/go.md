---
description: Write the latest results to this task's ledger, clear the session, and continue in the task named <slug>. When no task has that name, it first makes a new task with a goal from this conversation. A backlog task of this repository first gets its own git worktree and branch, with its packages installed. A parent task continues in its first child task not yet started. A child task in another repository is promoted there, and the session stays here.
argument-hint: <slug>
---

The ledger hook replaces the argument with two or more lines:

```
$ARGUMENTS
```

- `task:` is the slug of the task to switch to. Do not start that
  task in this session: the next session does.
- `ledger:` is the absolute path of this session's task ledger, or `none`.
- `held:`, when present, means another session holds a live claim on that
  task: `session <id> since <time>, active <time>`. Nothing was started, and
  the session does not clear.
- `new:`, when present, means no task has the `task:` slug yet. Make it first,
  as the next section says.
- `parked:`, when present, is the date and reason the task was parked. The
  hook has already removed the marker from that task's ledger.
- `parent:`, when present, is the slug of that task's parent task.
- `children:`, when present, lists that task's child tasks, each with its
  status.
- `promoted:`, when present, is the absolute path of the worktree the hook
  just made for a backlog task. That task's ledger is already in it.
- `picked:`, when present, means the argument named a parent task. The hook
  picked its first child task not yet started; the line runs from that parent
  task down to the `task:` value.
- `marked:`, when present, is the ledger in which the hook just marked the task
  started under `## Children`.
- Each `warning:` line says what the hook could not do.

If there is a `held:` line, change no files and skip the rest of this command.
Ask the operator with AskUserQuestion what to do. Name the task, the session
that holds it, when it claimed the task and when it was last active. Give
three options:

1. "Take over", described as ending the other session's claim. If picked, run
   `/ledger:go <task> --take-over`, where `<task>` is the `task:` value.
2. "Pick another task". If picked, list this repo's tasks, ask which one to
   continue, and run `/ledger:go` with the slug the operator picks.
3. "Stop", described as changing nothing. If picked, say that nothing changed.

Offer "Stop", not "Close": /ledger:close would write a ledger that the other
session owns.

If there is a `new:` line, make the task in this turn with these new-task
steps, before anything else. Its ledger is not this session's ledger, so the
ledger steps below still apply.

1. If this conversation does not show what the task is, make nothing and
   write nothing. Ask the operator in one line what the task is, say that the
   session was not cleared, and stop.
2. Write a one-paragraph goal from this conversation. State the problem first,
   then what done looks like.
3. Check the task repo for `llp/`. If it exists, read its file names and
   `llp/current/` if present; `llp/current/` is background only. Read the
   titles of the likely documents. Pick the LLPs the task touches. Each number
   must name a file directly in `llp/`, as `llp/<number>-*.md`. If none match,
   pick nothing.
4. Run `bin/ledger` from the ledger repo. The repo is two directories above
   the real path of `~/.claude/rules/10-operating-model.md`. `<slug>` is the
   `task:` value. Put the goal in single quotes, and write each `'` inside it
   as `'\''`:

   ```bash
   f=~/.claude/rules/10-operating-model.md
   while [ -L "$f" ]; do
     l=$(readlink "$f")
     case "$l" in /*) f="$l" ;; *) f="$(dirname "$f")/$l" ;; esac
   done
   "$(cd -P "$(dirname "$f")/.." && pwd)/bin/ledger" task new <slug> --kind <kind> --goal '<goal>'
   ```

   If new-task step 3 picked LLPs, add `--design-refs` with their numbers,
   comma-separated, such as `--design-refs 3,12`. The script writes them on
   the `- design refs:` line of the new ledger.

   Pick the kind of task from the goal, and always add `--kind` with it.
   Use `docs` when the work changes only documentation. Use `investigation`
   when the result is a report or an answer, with no code change. Use `code`
   for anything else. The kind sets the stages the task goes through.
5. Run the same `bin/ledger` as `bin/ledger go <slug>`, with nothing else. It
   makes the worktree and branch, installs the packages when the repo has a
   lockfile, and claims the task for this session. Do not move this session
   into the worktree: the next session does.
6. If `ledger task new` fails, nothing was made. Reply with its error and stop:
   the session does not clear. If only `ledger go` fails, the backlog ledger
   exists, so the session still clears, and the next session tries to start
   it again. Then still do the ledger steps, and put the error in your reply.
   If `ledger go` exits 5, only the package install failed: the worktree and
   its ledger exist. Put the error in your reply, and say that running
   `/ledger:go <slug>` again installs the packages.
7. If `ledger:` is not `none` and `ledger task new` printed no `noted` line,
   add one line under that ledger's Decisions that names the new task,
   together with the ledger steps below. A `noted` line means the script already wrote
   that line.

If `ledger:` is `none`, this session has no task ledger. Write nothing, do not
create one, and only do ledger step 4. Otherwise, update the file at that
exact path, even when it is not in the current working directory, with these
ledger steps:

1. Use Edit. Never rewrite the whole file. If `marked:` is the same path as
   `ledger:`, read the file again first: the hook changed it.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step. A later session starts from it, so make it
     something a fresh session can act on without this conversation.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. End your reply with one line saying whether the ledger is updated (or that there is none), that the
   session clears automatically after this turn, and that the new session
   then continues by itself in the task that the `task:` value names, so the
   operator types nothing. Do not show `go <task>` or any other command for
   the operator to type. Do not ask the operator to run `/clear`. If there is a `new:` line, add one line
   before it: the task was made, and its worktree is at the path on the
   `worktree` line that `ledger go` printed. If `ledger go` failed with any
   exit but 5, say instead that the task is in the backlog. If there is a `parked:` line, add
   one line before it: the task was parked on that date, the reason, and that it is no
   longer parked. If there is a `parent:` line, add one line before it that
   names the parent task. If there is a `children:` line, add one line before
   it that lists the child tasks with their status, as given. If there is a
   `promoted:` line, add one line before the final line: the backlog task was
   promoted, and its worktree is at that path. If there is a `picked:` line,
   add one line before the final line that names the picked task and the
   parent task the argument named. Add each `warning:` line before the final
   line, as given.
