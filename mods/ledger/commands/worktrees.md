---
description: Show each linked git worktree's size, last commit, dirty files, ledger and PR, largest first. `prune <name>` deletes a worktree's build folders, and `prune --all` those of every linked worktree. `prune-orphans` deletes the Xcode build folders of worktrees that no longer exist. With `--dry-run`, each prune only lists the folders.
argument-hint: "[prune <name> [--dry-run] | prune --all [--dry-run] | prune-orphans [--dry-run]]"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. The Skill tool does not run this command. If you ran
it that way, ask the operator to type it. Otherwise, say in one line that the
hook did not answer, and suggest `/reload-plugins`. Do nothing else.
