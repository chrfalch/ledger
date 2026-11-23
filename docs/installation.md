# Installation

## Prerequisites

Required: Claude Code, Node.js 20.12 or later, and `bash`. Deploy runs on Node.
`bash` runs the git hook dispatcher that deploy installs. Python is no longer
needed. SQLite storage for the ledgers needs Node.js 22.13 or later, and 23.4
or later on Node.js 23; see [Ledger storage](#ledger-storage).

The first run of `bin/deploy` runs `npm ci`. It installs dependencies into
`node_modules` and writes the npm cache in `~/.npm`. That first run needs
network access.

Optional. Deploy works without any of them, and each has a flag that removes the
parts that depend on it:

| Optional | Used by | Skip with |
|---|---|---|
| Codex CLI | `sol-implementer`, `astra-implementer`, `astra-reviewer`, `codex-runner`, and the second-opinion path in `reviewer` | `--no-codex` |
| argent MCP server | `ui-runner`, and the UI automation rule | `--no-argent` |
| `gh stack` extension | the stacked-PR rule | `--no-stacks` |

## Deploy

```sh
git clone <this repo>
cd ledger
bin/deploy --dry-run   # print every change, write nothing
bin/deploy
```

A clone made before the project was called ledger can still be in a folder
named `agent-config`. Deploy works from any folder name. To rename the folder,
run `bin/deploy` again from the new path. Ledgers are filed under the address of
the repo's remote, such as `github.com/chrfalch/ledger`, so they stay with the
repo. A repo with no `origin` and not exactly one other remote files them under
the path of its main checkout instead, and a new path starts a new set.

Ledgers written before this were filed under the folder name of the checkout.
`ledger store migrate --repo-ids` moves them to the repo's address, once. Deploy
offers this move when it finds such ledgers (see
[Moving stored task data](#moving-stored-task-data)). Run it before you rename
or move the folder. It finds the repo of each ledger through
the checkout's folder, so it leaves the ledgers of a checkout that has moved
where they are. Run it while no other ledger command runs, in this or any other session.

The command only renames files on the same disk. It leaves a ledger where it is
when it cannot tell the repo for sure, when the address already has a ledger of
that name, or when the address's folder is on another disk. It lists each one
and exits 1. Move those by hand, then run the command again to check that
nothing is left.

Active ledgers used to be files inside each task's worktree. They now live in
the ledger store, like the backlog. Each deploy runs
`ledger store migrate --active` without asking: it moves each active ledger that
is still a file in a worktree into the store, and deletes the file. The
`.claude/evidence/` folder stays in the worktree. Until every ledger
is moved, each session start in a repo with such a worktree says how many are
left.

Run the dry run first. It tells you which files would be linked, which policy
keys would change, and whether any file of your own would be replaced.

Run `bin/deploy` with no flags in a terminal to start an interactive wizard.
You choose Deploy, Migrate, or Revert the last deploy. For Deploy you then pick
the components, agents and models. The wizard shows a dry-run preview and asks
you to confirm before it writes anything. Migrate lists the pending moves and
offers to run them, or to switch the store type between files, SQLite and git.
Before a switch it shows the dry run of `ledger store migrate --to`, and the old
copy stays where it is. That dry run moves no ledger, but a switch to or from
git storage opens the clone in `~/.claude/ledger-data` and puts back its
pre-push hook if it was changed. Flags work as before and skip the wizard.

Deploy also links the `ledger` command into `~/.local/bin`. If that folder is
not on your `PATH`, deploy prints the line to add to your shell profile. After
that, `ledger deploy` runs `bin/deploy` from any folder, and passes its options
through. `ledger --help` lists its commands: `deploy`, and the read-only
`/ledger` commands that `ledger` runs without a Claude Code session.

| Flag | Effect |
|---|---|
| *(none)* | Apply everything. Codex policy too, if `~/.codex/config.toml` exists. |
| `--dry-run` | Print every change and write nothing. Run this first. |
| `--no-codex` | Skip Codex, and the four agents that drive it. |
| `--codex` | Require Codex; fail if its config is missing. |
| `--no-argent` | Skip `ui-runner` and the UI automation rule. |
| `--no-stacks` | Skip the stacked-PR rule. |
| `--no-mods` | Skip the ledger mod (`/ledger` and its `/ledger:` commands). |
| `--agents a,b,c` | Deploy only the agents named. |
| `--models a,b` | Keep only these models in the routing rules. |
| `--force` | Replace a file of your own without asking. |
| `--revert` | Remove this repo's symlinks and restore the newest backup. |
| `--migrate` | Run the pending moves of stored task data, and deploy no files. With `--dry-run`, only list them. |
| `--help` | Print the flag list. |

Examples:

```sh
bin/deploy --no-codex                    # Claude-only fleet
bin/deploy --models opus-5.5,sonnet-5.5  # drop models your plan lacks
bin/deploy --agents runner,reviewer      # a minimal two-agent setup
```

### Moving stored task data

Older versions kept task data in older formats. Three one-time moves bring it
up to date: `--repo-ids`, `--active` and `--records` of `ledger store migrate`.
They run in that order. `ledger store migrate --pending` lists what each one
would move, from where to where, and changes nothing. It prints
`Nothing to move.` when everything is up to date.

After it installs the files, every deploy runs the `--active` move without
asking, as the installed ledger reads active ledgers only from the store. Then
it checks for the other moves:

- In the wizard, deploy lists the moves still pending and asks
  "Run these moves now?". If you say no, it names the command to run later. It
  also lists each task that needs a person, with the reason. When nothing is
  pending, or only such tasks are left, it asks nothing.
- Without the wizard, deploy lists the moves still pending and tells you to run
  `bin/deploy --migrate`.
- `bin/deploy --dry-run` lists every pending move under `moves still to do:`.

```sh
bin/deploy --migrate --dry-run   # list the pending moves, move nothing
bin/deploy --migrate             # run them; deploy no files
```

A move never takes a task it cannot move safely, such as one whose name is
already taken. The list marks each such task with the reason, and the task stays
as it is for you to fix by hand. A failed move does not undo the deploy; fix
what it names, then run the move again.

`bin/deploy --migrate` runs the pending moves without asking. It does not check
for new upstream commits first, so it never asks to pull and never changes the
checkout. The list is a preview: before each kind of move, it checks again and
runs the move only when that check still lists a task it can take. A task a move
leaves, for the reason it names, is printed with that reason and is not a
failure. The command exits 1 only in these cases:

- the check for pending moves fails;
- a move cannot start, is stopped by a signal, or exits with a status above 1;
- the last check still lists a move it could have made.

## Ledger storage

The backlog ledgers and the archive are files under `~/.claude` by default:
`ledger-backlog/` and `ledger-archive/`. To keep them in one SQLite database instead,
`~/.claude/ledgers.db`, write `~/.claude/ledger-settings.json`:

```json
{ "storage": "sqlite" }
```

- SQLite storage needs Node.js 22.13 or later, and 23.4 or later on
  Node.js 23.
- `"storage": "file"`, no `storage` key, or no settings file keeps the files.
- Any other value, or a file that is not valid JSON, makes every `ledger`
  command that uses the storage exit 1 with a message that names the
  settings file. `ledger --help` still works. A hook prints the message to
  stderr and exits 0, so Claude Code goes on.
- The database also holds the evidence of each archive copy. Read a ledger
  or its evidence with `ledger show <slug>` and `ledger show <slug> --evidence`.
- Changing the setting does not copy the ledgers to the other storage.
- The active ledgers move with the storage, as the backlog does. The
  `.claude/evidence/` folder of a task stays in its worktree.
- `"storage": "git"` keeps the backlog and the archive in a clone of a private
  GitHub repository, `~/.claude/ledger-data`, so several machines share them.
  It needs `git` and `gh`, logged in. Set it up with `ledger store sync init <url>`,
  then `ledger store migrate --to git`. Without the clone, every `ledger` command
  that uses the storage exits 1 and says to run `ledger store sync init`. The clone
  sets its own `core.hooksPath`, so hooks from a global `core.hooksPath` do not
  run in it. See [usage.md](usage.md) for what is pushed and what stays.
- `"host"` names this machine, such as
  `{"storage": "git", "host": "work-laptop"}`: lowercase letters, digits and
  hyphens. Each task this machine starts names it, so with git storage your
  other machines show the task as on this host. Without it, the host name up
  to its first dot names the machine.

## Environment variables

These are not part of any file deploy writes. Add them to your shell profile:

```sh
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30   # let a session fill further before compacting
export BASH_MAX_OUTPUT_LENGTH=10000         # cap a Bash result before it enters context
export MAX_MCP_OUTPUT_TOKENS=10000          # cap an MCP result before it enters context
```

The first matters most on a model with a 1M-token window. It trades a longer
usable session for a higher context bill, which makes clearing between tasks the
main brake. The other two stop one verbose command from being re-read on every
later turn.

## What deploy owns

Owned outright, and symlinked into `~/.claude/`. Editing the repo deploys them:

| Path | Live location |
|---|---|
| `rules/*.md` | `~/.claude/rules/` |
| `ledger.template.md` | `~/.claude/ledger.template.md` |
| `notes/model-routing-rationale.md` | `~/.claude/notes/` |
| `agents/*.md` | `~/.claude/agents/` |

**Your own `~/.claude/CLAUDE.md` is never touched.** The contract ships as rule
files in `~/.claude/rules/` instead, which Claude Code loads for every project.
If deploy finds a `~/.claude/CLAUDE.md` left as a symlink by an older version of
this repo, it retires that link and says so.

For the few files deploy does own, if one is already a file of your own it asks
before replacing it. With no terminal attached it refuses and tells you to use
`--force`, so an unattended run cannot overwrite anything.

### The ledger mod

The ledger mod is a Claude Code plugin in `mods/ledger`. It adds fourteen
commands:

- `/ledger` prints each task ledger's goal, current step and next step.
  The parent of a listed task, and the parent of that parent, is shown too
  when it is in the backlog, marked `(backlog)`, or active in another
  worktree.
- `/ledger:task` writes a backlog ledger for a separate task, with no git
  worktree or branch yet. `/ledger:go <slug>` makes them and starts the task.
  When no task is open, `/ledger:task` makes them at once and continues in
  the same session. `/ledger:task --stack` makes them at once, on top of the current branch.
  `/ledger:task --here [<slug>]` adds a ledger to the linked worktree
  the session is in, without a new branch or worktree.
- `/ledger:update` writes the latest results to the current task's ledger. When
  there is no ledger, it creates nothing and points you to `/ledger:task`.
- `/ledger:close` writes the latest results to the current task's ledger, then
  clears the session. When there is no ledger, it prints why and does nothing.
- `/ledger:next` does the same as `/ledger:close`, then sends `go <name>`, so
  the fresh session continues the task.
- `/ledger:go <name>` does the same as `/ledger:next`, but sends
  `go <name>` for the task you name. The name must be the name of a task
  ledger. Without a ledger in the session, it writes nothing and still
  switches. When that task is parked, it removes the parked mark. When that
  task is in the backlog, it first makes its branch and worktree. The branch
  starts at the `--base` ref given when the task was written. Without one, it
  starts at the commit that `origin/HEAD` points to, as of the last fetch.
  Without `origin/HEAD`, it starts at the branch the main checkout is on. It
  refuses a backlog task of another repo.
- `/ledger:park [<slug>] <reason>` marks a task parked, with the date and the
  reason, as the first line under `## Next step`. `/ledger` then shows it as
  parked. Without a slug it does the same as `/ledger:close` for the current
  task, and adds the mark. With the slug of another task it only adds the mark.
- `/ledger:worktrees` prints each linked git worktree's size, last commit,
  dirty files, ledger and PR.
- `/ledger:retire [<slug>]` runs `ledger task retire`: it archives the
  task's ledger, removes its worktree and deletes the worktree's build folders.
  It also deletes the local branch when every commit on it is in the default
  branch or in a merged PR. A branch with commits after its PR merged stays.
  Uncommitted changes need `--force`, and so does a branch that has commits
  not in the default branch and no merged PR. `--dry-run` only shows what
  retiring would archive and remove.
  A backlog task has no worktree or branch: retiring it archives its ledger
  and removes it from the backlog. A parent task with active child tasks
  needs `--force`.
- `/ledger:archive [<term>]` lists this repo's archived ledgers in
  `~/.claude/ledger-archive/`, newest first. A term keeps the ledgers that
  contain it. `--all` lists the archive of every repo.
- `/ledger:all` lists every task ledger on this machine, from every repo,
  active, parked, backlog and archived, with its next step.
- `/ledger:parent [<slug>]` shows a parent task and each child task's status
  and next step. `<slug> add <child>` and `<slug> remove <child>` change its
  child tasks.
- `/ledger:help` prints one line for each of these commands.

`/ledger:worktrees prune <name>` deletes the build folders of one worktree.
These are ignored folders such as `build` and `.expo-prebuild`, and the
worktree's Xcode build folder from `bin/cc-dd-path`. Empty folders are left
out. Add `--dry-run` to only list them and their sizes. The command never
deletes the worktree itself or anything in its `.claude`. It also keeps `node_modules` and
`Pods`, so the worktree still builds without a new install.

Deploy installs the mod through the `claude` CLI, at user scope:

- It adds this repo as a folder marketplace named `ledger`.
- It installs the plugin `ledger@ledger`. The part before `@` is the plugin
  name. The part after `@` is the name of the plugin source, the marketplace.

Deploy skips each step that is already done. The plugin loads from this repo,
so an edit to the repo reaches a running session after `/reload-plugins`. It
does not need a reinstall.

Deploy skips the mod with `--no-mods`. It also skips the mod when `claude` is
not on `PATH`, and says so.

## What deploy does not own

These two files hold state the apps write for themselves. Deploy merges a few
keys into them and leaves the rest alone:

| Policy file | Merged into | Keys asserted |
|---|---|---|
| `settings.policy.json` | `~/.claude/settings.json` | `statusLine`, `hooks`, `tui`, `skipWorkflowUsageWarning`, `permissions.allow` |
| `codex/policy.toml` | `~/.codex/config.toml` | `approval_policy`, `sandbox_mode` |

Everything else in those files stays yours and stays local: Codex project trust
levels, plugins, marketplaces, MCP servers, your own permissions, your model choice.
None of it is stored here. Running `bin/deploy` never removes it, and deploy
prints what it left alone so you can check.

Policy keys are merged one level down, and hooks follow their own rule. Deploy
replaces the `PreCompact` and `SessionStart` hook events whole. For every other
event, it replaces the repo's own entries and keeps yours as they are. An entry
you edited counts as yours.

Deploy adds allow rules for the everyday `ledger` commands, so they run
without a permission prompt. These commands read tasks, write notes, and make,
start, claim, park and archive tasks. Deploy keeps every allow rule you already
have and adds its own after them. Commands that delete or restructure still
ask: `ledger task retire`, `ledger worktrees`, `ledger store`, the `ledger tree`
commands that change children, and `ledger deploy`.

Re-running deploy is safe. It changes only keys that differ, and backs up any
file it rewrites into `~/.claude/backups/deploy-<timestamp>/`, under that file's
own path relative to your home directory.

## How the contract ships

The orchestrator contract lives in `rules/`, one file per topic, and deploys
into `~/.claude/rules/`. Rules there apply to every project on your machine, and
load at the start of every session.

Two of those files, and parts of others, are gated on tools and models you may
not have. See [customizing.md](customizing.md) for how gating works.

With no selection flags, the rule files are symlinked, so an edit in the repo is
live at once. With `--models`, `--agents`, `--no-codex`, `--no-argent` or
`--no-stacks`, deploy writes filtered copies instead, and says so; after that,
repo edits need another deploy.

> **Cowork.** A Cowork session on the desktop skips a symlinked
> `~/.claude/rules/` file whose target is outside the session's working
> directory, so these rules do not load there. Claude Code in the terminal is
> unaffected.

## The hooks

Deploy asserts five hook events in `~/.claude/settings.json`. They run four
hook scripts from `hooks/`, excluding the status line, and `ledger hook
<event>`. Deploy links `bin/ledger` to `~/.claude/bin/ledger` for these hooks.
When its dependencies are not installed, `ledger hook` writes one line to
stderr and lets the call through. Each hook script runs through
`hooks/logged.sh`. A hook that fails lets the call through and adds one line to
`~/.claude/ledger-hook-failures.log`; the next session start reports the
failures not yet reported.

- **SessionStart, `ledger hook session-start`** — reads the task ledger into the new
  session. It reads ledgers from linked worktrees, never from the main
  checkout. With several ledgers it prints a summary of each instead. This is
  what makes `/clear` then `go` work. With git storage it first pulls the
  ledgers of your other machines, for at most four of its five seconds, and
  adds one line when the last sync stopped.
- **SessionStart, `deploy-drift.sh`** — warns when `~/.claude` is behind this
  repo.
- **UserPromptSubmit, `ledger hook prompt-submit`** — names the session
  after the task when you type `go <slug>`. It replaces an empty title or the
  name of another task. A name you gave with `/rename` stays.
- **UserPromptSubmit, `usage-pace.sh`** — adds routing guidance when Claude
  usage runs ahead of pace. If Codex is high too, asks the operator what to do.
- **PreCompact, `ledger hook pre-compact`** — tells the compaction pass that
  the ledger is authoritative, and that its path and Next step must survive
  verbatim.
- **PreToolUse, `derived-data-gate.sh`** — keeps one Xcode build folder per
  worktree and configuration.
- **PreToolUse, `ledger hook pre-tool-use`** — denies removing a worktree
  whose ledger is not archived, and denies writing a ledger in a main
  checkout.
- **PermissionDenied, `denied-read-retry.sh`** — lets the model retry a denied
  call that only reads.

The status line runs `hooks/statusline.sh`. It keeps the directory, branch,
model, session usage and weekly usage display. When usage is available, it
atomically saves `~/.claude/state/usage-snapshot.json` for the prompt hook.
Weekly snapshots expire after 12 hours; five-hour data expires after one hour.
Expired usage windows are ignored. Codex usage comes from the newest session
JSONL file modified in the last eight days. No network request is needed.
Run `~/.claude/hooks/usage-pace.sh --json` to inspect the computed pace.

## Undoing a deploy

```sh
bin/deploy --revert --dry-run
bin/deploy --revert
```

Revert removes only symlinks that point into this repo, then restores the newest
backup directory. It restores each file as it was at that deploy, so local edits
made since are lost. Older backups stay in `~/.claude/backups/`.

Revert does not remove the ledger mod. The mod lives in Claude Code's own
plugin state, not in a file deploy links. To remove it, run:

```sh
claude plugin uninstall ledger
claude plugin marketplace remove ledger
```

## Tests

The tests write only to a temporary directory. They never touch your own config.

```sh
npm test            # policy merge, dry run, confirm, force, revert, agent selection, wizard
npm run typecheck
```

Run them after any change to `bin/deploy`, `tools/deploy.ts` or
`tools/apply-policy.ts`.
