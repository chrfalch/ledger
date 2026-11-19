type Ref = { slug: string; main: string }

/** A task as `ledger list --json` and `ledger session --json` give it; only the fields the mod reads. */
export type ListedTask = {
  slug: string
  main?: string
  status: string
  path: string
  goal: string
  next: string
  current: { number: string; step: string; status: string } | null
  finished: boolean
  parent?: { slug: string; main?: string }
  parked?: { date: string; reason: string }
}

/** `<slug>`, or `<slug>@<main>` for a task in another repo than `here`: the form bin/ledger takes and the operator types. */
export const taskName = ({ slug, main }: Ref, here: string | undefined): string => (main === here ? slug : `${slug}@${main}`)

function stepLine({ current, finished, parked }: ListedTask): string | undefined {
  if (parked) return `**Parked:** ${parked.date} — ${parked.reason}`
  if (finished) return '**Now:** all plan steps done'
  return current ? `**Now:** step ${current.number} · ${current.step} — *${current.status}*` : undefined
}

/** The /ledger view of the ledgers a session works on. */
export function formatLedgers(ledgers: ListedTask[]): string {
  const count = ledgers.length === 1 ? '1 ledger' : `${ledgers.length} ledgers`
  const blocks = ledgers.map(ledger => {
    const fields = [ledger.goal && `**Goal:** ${ledger.goal}`, stepLine(ledger), ledger.next && `**Next:** ${ledger.next}`, ledger.parent && `**Parent:** ${ledger.parent.slug}`]
    return [`#### ${ledger.slug} · ${ledger.status}`, ...fields.filter(field => field).map(field => `- ${field}`)].join('\n')
  })
  return [`**Task ledgers** · ${count}`, ...blocks].join('\n\n')
}

const UNCHANGED = 'Nothing was written, and the session was not cleared.'

// bin/ledger errors may end without a period.
const sentence = (text: string): string => text.replace(/[.\s]*$/, '.')

export const noLedgerMessage = (cwd: string): string =>
  `No task ledger found for ${cwd}. ${UNCHANGED} Run this command from the task's worktree, or start a task with /ledger:task.`

export const removedFolderMessage = (folder: string): string =>
  `The session folder ${folder} no longer exists, so this session has no task ledger. ${UNCHANGED} Continue another task with /ledger:go <slug>, or run /ledger:close.`

export const lookupFailedMessage = (error: string): string => `Could not check this task's ledger. ${sentence(error)} ${UNCHANGED}`

export const startFailedMessage = (target: string, error: string): string => `Could not start task ${target}. ${sentence(error)} ${UNCHANGED}`

export const parkFailedMessage = (slug: string, error: string): string => `/ledger:park could not mark ${slug} parked: ${sentence(error)} The session was not cleared.`

export const GO_USAGE = 'Usage: /ledger:go <slug>. Run /ledger to see the slug of each task.'

export const PARK_USAGE =
  "Usage: /ledger:park [<slug>] <reason>. Without a slug it writes this task's ledger, parks it and clears the session. Run /ledger to see each slug."

export const PARENT_USAGE = 'Usage: /ledger:parent <slug> [add|remove <child>]. Run /ledger:all to see the slug of each task.'

export const GO_FROM_SUBAGENT = `Only the main session can switch tasks with /ledger:go. ${UNCHANGED}`

export function slugExpectedMessage(args: string): string {
  const slug = /^task: (.*)/.exec(args)?.[1] ?? '<slug>'
  return `/ledger:go takes a task slug, such as ${slug}, not the task: and ledger: lines it writes itself. ${UNCHANGED}`
}

/** A slug never holds whitespace, so a target with whitespace before any @ is a task description. */
export const isDescription = (target: string): boolean => /\s/.test(target.split('@')[0] ?? '')

/** A slug `ledger task` accepts for a new task. */
export const isNewSlug = (target: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(target)

export const descriptionMessage = (description: string): string =>
  `/ledger:go takes a task slug, such as fix-login, not a description. To make a new task from a description, use /ledger:task ${sentence(description)} ${UNCHANGED}`

export const notCreatedMessage = (slug: string): string =>
  `/ledger:go did not create task ${slug}, so the session was not cleared. Run /ledger:task, or /ledger:go ${slug} again.`

export const notCheckedMessage = (slug: string, error: string): string =>
  `/ledger:go could not check whether task ${slug} was made: ${sentence(error)} The session was not cleared. Run /ledger:go ${slug} again.`

/** The `ledger go` arguments for a target as /ledger:go takes it: `<slug>`, or `<slug>@<path>` for the repo that holds <path>. */
export function goCommand(target: string): string[] {
  const at = target.indexOf('@')
  return at === -1 ? ['go', target] : ['go', target.slice(0, at), '--repo', target.slice(at + 1)]
}

const armedTurn = {
  go: (slug: string) => `switches to task ${slug}`,
  next: (slug: string) => `ends with /ledger:next, which clears the session and continues task ${slug}`,
  close: () => 'ends with /ledger:close, which clears the session',
  park: (slug: string) => `parks task ${slug} and clears the session`,
}

export const oneSwitchPerTurnMessage = (armed: { mode: keyof typeof armedTurn; slug: string }, target: string): string =>
  `This turn already ${armedTurn[armed.mode](armed.slug)}, so /ledger:go ${target} was not started and nothing was written. A turn switches tasks only once: run /ledger:go ${target} after the session clears.`

/** What `ledger go` did, as go.md reads it. `parent` and `children` name tasks as the operator types them. */
export type GoFields = {
  isNew?: true
  unparked?: { date: string; reason: string }
  parent?: string
  /** Each child task of the started task, with its status: `fix-login (active)`. */
  children?: string[]
  promoted?: string
  /** The tasks from the one the operator named down to the child task that was started. */
  picked?: string[]
  marked?: string
  warnings?: string[]
}

// One field per line, because a path can hold spaces. go.md reads this format.
export function goArgs(target: string, ledger: string | undefined, { isNew, unparked, parent, children = [], promoted, picked, marked, warnings = [] }: GoFields): string {
  return [
    `task: ${target}`,
    `ledger: ${ledger ?? 'none'}`,
    ...(isNew ? ['new: yes'] : []),
    ...(unparked ? [`parked: ${unparked.date} — ${unparked.reason}`] : []),
    ...(parent ? [`parent: ${parent}`] : []),
    ...(children.length > 0 ? [`children: ${children.join(', ')}`] : []),
    ...(promoted ? [`promoted: ${promoted}`] : []),
    ...(picked ? [`picked: ${picked.join(' > ')}`] : []),
    ...(marked ? [`marked: ${marked}`] : []),
    ...warnings.map(warning => `warning: ${warning}`),
  ].join('\n')
}

export const isGoArgs = (args: string): boolean => /^task: [^\n]*\nledger: /.test(args)

export const parkArgs = (slug: string, ledger: string, reason: string): string => [`task: ${slug}`, `ledger: ${ledger}`, `reason: ${reason}`].join('\n')

/** What /ledger:go did before the Skill call was denied, or the denial alone when it did nothing. */
export function goDeniedMessage(target: string, { promoted, unparked, marked }: GoFields, denial: string): string {
  const done = [
    ...(promoted ? [`Promoted backlog task ${target}: its branch, worktree and ledger are at ${promoted}.`] : []),
    ...(unparked ? [`Removed the parked marker from ${target}.`] : []),
    ...(marked ? [`Marked ${target} started in ${marked}.`] : []),
  ]
  if (done.length === 0) return denial
  return `${done.join(' ')} Then the Skill call was denied: ${sentence(denial)} The session was not cleared.`
}

type StartedElsewhere = { slug: string; main: string; worktree: string; promoted: boolean; chain: Ref[]; marked?: { ledger: string }; warnings: string[] }

/** `ledger go` started a task of another repo: one the operator named, or a child task it picked. The session cannot follow it. */
export function startedElsewhereMessage({ slug, main, worktree, promoted, chain, marked, warnings }: StartedElsewhere): string {
  const parent = chain.at(-2)?.slug
  const task = parent === undefined ? `Task ${slug} belongs` : `Picked child task ${slug} of ${parent}. It belongs`
  const where = promoted ? `so it was started there: its branch, worktree and ledger are at ${worktree}.` : `and its worktree is at ${worktree}.`
  return [
    `${task} to the repo at ${main}, ${where}`,
    ...(marked ? [`Marked ${slug} started in ${marked.ledger}.`] : []),
    ...warnings,
    `The session was not cleared and stays here, because a session cannot move to another repo. To continue in ${slug}, this session sends a subagent to work in ${worktree}, by its absolute path. The operator can also open a session there and type go ${slug}.`,
  ].join(' ')
}

/**
 * What `ledger retire --dry-run` tells of a task's branch, and what stops the retire; unknown when the dry run failed or
 * the task has no worktree.
 */
export type BranchFacts = { merged: boolean; openPr?: number; blockedBy: string[] } | undefined

export function retireHint(slug: string, branch: BranchFacts): string {
  if (branch?.merged && branch.blockedBy.length > 0)
    return `Task ${slug} is finished and merged, but it cannot be retired yet: ${branch.blockedBy.join('; ')}. Run \`/ledger:retire ${slug} --dry-run\` to see the details.`
  if (branch?.merged) return `Task ${slug} is finished and merged. Retire it with \`/ledger:retire ${slug}\`.`
  if (branch?.openPr !== undefined) return `Task ${slug} is finished, and its PR #${branch.openPr} is still open. After it merges, run \`/ledger:retire ${slug}\`.`
  return `Task ${slug} is finished. Run \`/ledger:retire ${slug} --dry-run\` to see whether it can be retired, then \`/ledger:retire ${slug}\`.`
}

/** `parent` and `child` as the operator types them; `child` is undefined when none is left to start. */
export const nextChildHint = (parent: string, child: string | undefined): string =>
  child === undefined
    ? `Parent ${parent} has no child task left to start.`
    : `Parent ${parent} has a child task that has not started: ${child}. Start it with \`/ledger:go ${parent}\`.`

export function typedOnlyMessage(command: string, args: string): string {
  const typed = [`/${command}`, args.trim().replace(/\s+/g, ' ')].filter(part => part !== '').join(' ')
  return `/${command} runs only when the operator types it. Ask the operator to type \`${typed}\`.`
}

export const SCAN_DROPPED = 'Ignored --scan: /ledger:all reads the ledgers of every known repo from disk each time, and brings ~/.claude/ledgers.json in line with them.'

export const skillFailedMessage = (command: string, error: string): string => `/${command} failed: ${sentence(error)} Ask the operator to type it.`

export const HELP = [
  "- `/ledger` — Show the goal, current step and next step of each task ledger this session works on: its own, or in a main checkout those of every linked worktree. `/ledger <name>` shows those whose slug holds <name>.",
  '- `/ledger:task` — Add a separate task to the backlog: a ledger only, with no branch or worktree yet. `/ledger:go <slug>` starts it. With no current ledger, it starts the task at once and continues in this session. `--here` adds a ledger to this worktree instead.',
  "- `/ledger:update` — Write the latest results to this task's ledger. Without one, it points to `/ledger:task`.",
  "- `/ledger:next` — Write this task's ledger, clear the session, and continue from the next step. When every step is done, it first says how to retire the task. For a child task, it also names the next child task of its parent that has not started.",
  "- `/ledger:close` — Write this task's ledger, then clear the session.",
  "- `/ledger:go <slug>` — Write this task's ledger, clear the session, and continue in the task named <slug>. When no task has that name, the agent first makes it, with a goal written from the conversation. A backlog task first gets its branch and worktree, which works only from a session in its repository. A child task is marked started in its parent ledger. A parent task starts its first child task not yet started instead; a parent task in the backlog with none left stays there. A child task in another repository gets its worktree there, and the session stays here; so does a task named `<slug>@<path>`, of the repository that holds <path>. When every step of this task is done, it first says how to retire it.",
  "- `/ledger:park [<slug>] <reason>` — Mark a task parked. Without a slug it writes this task's ledger, parks it, then clears the session.",
  "- `/ledger:parent <slug>` — Show a parent task and each child's status and next step. `<slug> add <child>` and `<slug> remove <child>` change its children. `<slug>@<path>` names a task in the repository that holds <path>.",
  "- `/ledger:worktrees` — Show each linked git worktree's size, last commit, dirty files, ledger and PR. `prune <name>` deletes the build folders of one worktree, and `prune --all` those of every linked worktree; `--dry-run` only lists them. `prune-orphans` deletes the Xcode build folders of worktrees that no longer exist. When every step of a task is done, the turn's end deletes the build folders of its worktree, once per finish.",
  "- `/ledger:retire [<slug>]` — Archive a task's ledger, remove its worktree, and delete its branch when all of its commits are merged. A backlog task of this repo has no worktree or branch: its ledger is archived, then deleted. `--dry-run` only shows what it would do. Uncommitted changes, unmerged work and active child tasks need `--force`. A child task is marked retired in its parent ledger, also in another repo.",
  "- `/ledger:archive [<term>]` — List this repo's archived ledgers, newest first; a term keeps those that contain it, and `--all` lists every repo.",
  '- `/ledger:all` — Show every task ledger on this machine, from every repository: active, backlog and archived, each with its parent and next step.',
  '- `/ledger:help` — Show this list.',
].join('\n')
