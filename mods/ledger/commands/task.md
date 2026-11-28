---
description: Write a backlog ledger for a separate task, with no worktree or branch yet; `/ledger:go <slug>` starts it. With no current ledger, it starts the task at once and continues in this session. `--stack` makes its worktree and branch at once, on top of the current branch. `--here [<slug>]` adds a ledger to the current linked worktree instead. Labels the operator names, such as sdk-59, go on the task.
argument-hint: "<what the task is> [labels: <label>, …] | --here [<slug>]"
---

The operator asks for a separate task: $ARGUMENTS

If that request starts with `--here`, the operator wants a ledger for the
linked worktree this session is in, not a new worktree:

1. Take the slug from the word after `--here`, if there is one. Without it,
   the script names the task after the branch, without its owner prefix.
2. Write a one-paragraph goal from this conversation. State the problem first,
   then what done looks like. If the conversation does not show the goal,
   leave out `--goal`.
3. Run the script as in step 5 below, with `--here [<slug>]` in place of
   `<slug>`. Never add `--stack` or `--repo`: the script refuses them with
   `--here`. It also refuses the main checkout and a worktree that already
   has a ledger; then reply with its error and stop.
4. Reply with the `ledger` line the script printed. This session already works
   in that worktree, so do not offer `/ledger:go`.

Otherwise, if that request is empty, ask what the task is and stop.

If the request clearly holds two or more parts that ship separately, as
separate PRs or separate merges, it needs a parent task. Write the parent
task's backlog ledger first, then the ledger of each child task, each with
steps 1 to 5 and without `--stack`. The parent task's goal from step 2 also
states the split and the order: each part, in the order they ship. Then
attach each child task in that order: run
`bin/ledger tree add <parent> <child>` from the ledger repo, as in step 5.
Each child task you add goes after the ones before it. To change the order
later, run `bin/ledger tree order <parent> <child>...` and name every child
task, first to last. When a child task cannot start until another task is
retired, run `bin/ledger tree depends <child> <task>...`. A task in another
repository is `<slug>@<path>`, or `<slug>@<address>` such as
`api@github.com/acme/api`. Never promote the parent task.
Steps 6 to 8 do not apply, except that a current ledger gets one decision that
names the parent task, written with `ledger notes decide`.
Reply with `/ledger:go <parent>` as the start line: it starts the first child
task. If the split shows up while you plan the current ledger's task, the Plan
gate applies instead: the current task becomes the first child task of a new
parent task.

1. Pick a short kebab-case slug for the task, such as `fix-login`.
2. Write a one-paragraph goal. State the problem first, then what done looks
   like.
3. Add `--stack` only if the work builds on the current branch. Without it,
   the script writes only a backlog ledger, with no worktree or branch;
   step 8 or `/ledger:go <slug>` makes them later. With it, the script makes the
   worktree and branch at once.
4. Before running the script, check the task repo for `llp/`. If it exists,
   read its file names and `llp/current/` if present; `llp/current/` is
   background only. Read the titles of the likely documents. Pick the LLPs the
   task touches. Each number must name a file directly in `llp/`, as
   `llp/<number>-*.md`. If none match, pick nothing. This also applies to
   `--here`.
5. Run the script from the ledger repo. The repo is two directories
   above the real path of `~/.claude/rules/10-operating-model.md`. Put the goal
   in single quotes, and write each `'` inside it as `'\''`:

   ```bash
   f=~/.claude/rules/10-operating-model.md
   while [ -L "$f" ]; do
     l=$(readlink "$f")
     case "$l" in /*) f="$l" ;; *) f="$(dirname "$f")/$l" ;; esac
   done
   "$(cd -P "$(dirname "$f")/.." && pwd)/bin/ledger" task new <slug> --kind <kind> --goal '<goal>'
   ```

   If step 4 picked LLPs, add `--design-refs` with their numbers,
   comma-separated, such as `--design-refs 3,12`. The script writes them on
   the `- design refs:` line of the new ledger.

   If the operator named labels for the task, add `--label <label>` for
   each, such as `--label sdk-59`. Add no label the operator did not name.

   Pick the kind of task from the goal, and always add `--kind` with it.
   Use `docs` when the work changes only documentation. Use `investigation`
   when the result is a report or an answer, with no code change. Use `code`
   for anything else. The kind sets the stages the task goes through.
6. Check for a current ledger: `ledger show` succeeds in the working directory
   of this session. In the main checkout, treat it as none.
7. If there is a current ledger, the script already added one line under its
   Decisions that names the new task, and printed that ledger on its `noted`
   line. Reply with the `start:` line the script printed, and nothing else of
   substance. Do not plan the task and do not start it in this session.
8. If there is no current ledger, there is no old task to clear. Without
   `--stack`, start the task now: run `bin/ledger go <slug>` as in step 5,
   with nothing else. It makes the worktree and branch, and makes the ledger
   the active ledger of that worktree. If it fails, reply with its error and
   stop. Then move this session into the new worktree with the EnterWorktree tool. Set `path`
   to the path on the `worktree` line that `ledger go` printed, or that the
   script printed for `--stack`. Read its ledger with `ledger show` in
   the new worktree: no session start report covers a worktree entered in
   the middle of a session. Then continue with the operator's request in this session, through
   the normal pipeline. When the task changes more than one file or involves
   a design choice, write the plan into the ledger with
   `ledger notes plan add`, one step per command, and its summary with
   `ledger notes plan summary`. Send the full plan with send_to_user, or
   show it in full, then
   get it approved with the widget question that `ledger task gate plan`
   prints. Then run `ledger notes plan approve`.
