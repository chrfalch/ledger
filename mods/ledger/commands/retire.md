---
description: Archive a task's ledger and its evidence, remove its worktree, and delete the worktree's build folders in the background. Before that, it deletes the local branch when every commit on it is in the default branch or in a merged PR. A branch with commits after its PR merged stays. Uncommitted changes need `--force`, and so does a branch that has commits not in the default branch and no merged PR. A parent task with active child tasks needs `--force` too. A backlog task of this repo has no worktree or branch: its ledger is archived, then deleted. `--repo <repo>` retires a backlog task of another repo, named by its key, alias or label, also when no checkout of it is on this machine. `--dry-run` only shows what retiring would do. Without a slug it retires the task this session is in.
argument-hint: "[<slug>] [--repo <repo>] [--dry-run] [--force]"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. Say in one line that the hook did not answer, and
suggest `/reload-plugins`. Do nothing else.
