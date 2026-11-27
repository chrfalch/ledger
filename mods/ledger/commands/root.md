---
description: Switch the operator override on for N minutes, 30 by default. While it is on, the hooks that refuse tool calls let them through and log each one; the next session start lists them. `off` ends it, `status` says how long is left.
argument-hint: "[<minutes>|off|status]"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. Only the operator can switch the override on; do not
run `ledger root on` yourself. If you ran this command with the Skill tool, ask
the operator to type it. Otherwise, say in one line that the hook did not
answer, and suggest `/reload-plugins`. Do nothing else.
