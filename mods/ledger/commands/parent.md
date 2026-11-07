---
description: Show a parent task and each child's status and next step. Without a slug, it shows this task when it has children, or this task's parent. `<slug> add <child>` and `<slug> remove <child>` change a parent's children. Write `<slug>@<path>` for a task in the repository that holds `<path>`.
argument-hint: "[<slug> [add <child> | remove <child>]]"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. The Skill tool does not run this command. If you ran
it that way, ask the operator to type it. Otherwise, say in one line that the
hook did not answer, and suggest `/reload-plugins`. Do nothing else.
