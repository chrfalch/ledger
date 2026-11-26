---
description: Deploy the latest main of the ledger repo on this machine, and say which open sessions need /reload-plugins. With --machine, start the deploy on another machine linked in T3.
argument-hint: "[--machine <name>]"
---

The arguments: `$ARGUMENTS`. With `--machine <name>`, go to step 3.

1. Run `ledger deploy --latest --json` with Bash, with `timeout` 600000.
   On `"ok": true`, say in plain words:
   - the deployed `commit` and its `subject`;
   - whether main moved: from `from` to `to` when the two differ, or
     already up to date when they are the same;
   - each mod in `reinstalled` and `installed`;
   - each line of `warnings`, with the fix it names.

   On `"ok": false`, give the `error` in plain words. It starts with
   "Nothing deployed" when `bin/deploy` did not run. Do not run it
   again, never pass `--force`, and do not change the main checkout.

   An `"ok": false` report with `from` and `to` stopped after the
   fast-forward. When `from` and `to` differ, say that the main checkout
   moved from `from` to `to`; when they are the same, say that it was
   already up to date. Then name each mod in `reinstalled` and `installed`,
   and each line of `warnings`, as for `"ok": true`.
2. When `needsReload` is true, also after `"ok": false`, load `mcp__t3-code__t3_thread_list` with
   ToolSearch and call it. List each open thread by its link, this thread
   too, and say each one needs `/reload-plugins`. If the tool is missing,
   say T3 is not available, so the threads cannot be listed, and every open
   Claude Code session needs `/reload-plugins`.
3. With `--machine <name>`, do not deploy here. The other machine must
   already have a version of the ledger plugin with `/ledger:deploy`. If it
   does not, the operator deploys there once by hand with `bin/deploy`. Load
   `mcp__t3-code__t3_environment_links`, `mcp__t3-code__t3_project_list` and
   `mcp__t3-code__t3_thread_launch` with ToolSearch. If one is missing, say
   in one line that `/ledger:deploy --machine` works only in T3, and stop.
   - Call `t3_environment_links`. When no linked environment has the name
     <name>, list the names it has, and stop. When it does not answer now,
     say so, and stop.
   - Call `t3_project_list` with that `environmentId`. Pick the project of
     the ledger repo. When there is none, say so, and stop.
   - Call `t3_thread_launch` with that `environmentId` and `projectId`,
     `title` `Deploy ledger`, `runtimeMode` `approval-required`, and
     `message` `/ledger:deploy`.
   - Give the link of the new thread. Tell the operator to approve the
     deploy on that machine.
