---
description: Show a parent task and each child's labels, status and next step. `--label <label>`, repeatable, shows only the children that carry every label named. `<slug> add <child>` and `<slug> remove <child>` change a parent's children. Write `<slug>@<path>` for a task in the repository that holds `<path>`.
argument-hint: "<slug> [--label <label>]… | <slug> add <child> | <slug> remove <child>"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. The Skill tool does not run this command. If you ran
it that way, ask the operator to type it. Otherwise, say in one line that the
hook did not answer, and suggest `/reload-plugins`. Do nothing else.
