---
description: Show each linked git worktree's size, last commit, dirty files, ledger and PR, largest first. `prune <name>` deletes a worktree's build folders, and `prune --all` those of every linked worktree. `derived-data` groups Xcode's DerivedData folders by the project they were built from. `prune-orphans` deletes the folders whose project is gone. With `--dry-run`, each prune only lists the folders.
argument-hint: "[prune <name> [--dry-run] | prune --all [--dry-run] | derived-data | prune-orphans [--dry-run]]"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. The Skill tool does not run this command. If you ran
it that way, ask the operator to type it. Otherwise, say in one line that the
hook did not answer, and suggest `/reload-plugins`. Do nothing else.
