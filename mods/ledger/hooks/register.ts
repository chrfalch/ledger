import type { EngineInterface, PluginState, Register } from 'claude-code'

import { ledgerJson, ledgerText, LONG_TIMEOUT_MS, message, ownTask, readSession, type AutoPruned, type NextChild, type Parked, type RetirePlan, type Started } from './cli'
import {
  descriptionMessage,
  formatLedgers,
  GO_FROM_SUBAGENT,
  GO_USAGE,
  goArgs,
  goCommand,
  goDeniedMessage,
  HELP,
  isDescription,
  isGoArgs,
  isNewSlug,
  lookupFailedMessage,
  nextChildHint,
  noLedgerMessage,
  notCheckedMessage,
  notCreatedMessage,
  oneSwitchPerTurnMessage,
  PARENT_USAGE,
  PARK_USAGE,
  parkArgs,
  parkFailedMessage,
  removedFolderMessage,
  retireHint,
  SCAN_DROPPED,
  skillFailedMessage,
  slugExpectedMessage,
  startedElsewhereMessage,
  startFailedMessage,
  taskName,
  typedOnlyMessage,
  type BranchFacts,
  type GoFields,
  type ListedTask,
} from './ledger'

type Armed = NonNullable<PluginState['ledger']['armed']>
type GoArm = Extract<Armed, { mode: 'go' }>
type PreviousTask = NonNullable<GoArm['previous']>

const armed = { plugin: 'ledger', key: 'armed' } as const
const titled = { plugin: 'ledger', key: 'titled' } as const

/** `ledger go` exits 2 when no task has the slug. */
const NO_SUCH_TASK = 2

/**
 * The task a /ledger:go call is starting, from its armed check until it armed the switch or gave up. It is set before the
 * first await, so a second call that overlaps the first cannot also pass the check.
 * It assumes the hooks module is loaded once per session; a second instance would hold its own reservation.
 */
let goStarting: string | undefined

const words = (args: string | undefined): string[] => (args ?? '').split(/\s+/).filter(word => word !== '')

const basename = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1)

const previousOf = ({ slug, path, main, parent }: ListedTask): PreviousTask => ({
  slug,
  ledger: path,
  ...(main === undefined ? {} : { main }),
  ...(parent === undefined ? {} : { parent }),
})

/** The fields go.md reads from what `ledger go` did, each task named as the operator types it in the repo at `here`. */
function goFields({ worktree, promoted, chain, parent, children = [], unparked, marked, warnings }: Started, here: string): GoFields {
  return {
    ...(unparked === undefined ? {} : { unparked }),
    ...(parent === undefined ? {} : { parent: taskName(parent, here) }),
    ...(children.length === 0 ? {} : { children: children.map(child => `${taskName(child, here)} (${child.status})`) }),
    ...(promoted ? { promoted: worktree } : {}),
    ...(chain.length === 0 ? {} : { picked: chain.map(ref => taskName(ref, here)) }),
    ...(marked === undefined ? {} : { marked: marked.ledger }),
    warnings,
  }
}

/**
 * Everything /ledger:go does before go.md runs: read this session's ledger, let `ledger go` start the task, and arm the
 * clear. A text says why the task was not started, or where a task of another repo was started; then the clear is not
 * armed, and a clear this turn already armed stays.
 */
async function startGo($: EngineInterface, input: string): Promise<{ target: string; fields: GoFields; args: string; arm: GoArm } | { text: string }> {
  const target = input.trim()
  if (target === '') return { text: GO_USAGE }
  if (isDescription(target)) return { text: descriptionMessage(target) }
  if (goStarting !== undefined) return { text: oneSwitchPerTurnMessage({ mode: 'go', slug: goStarting }, target) }
  goStarting = target
  try {
    const { value: alreadyArmed } = await $.state.get(armed)
    if (alreadyArmed) return { text: oneSwitchPerTurnMessage(alreadyArmed, target) }
    const session = await readSession($)
    if (!session.ok) return { text: lookupFailedMessage(session.error) }
    const own = ownTask(session)
    const here = session.main
    const started = await ledgerJson<Started>($, goCommand(target))
    let arm: GoArm
    let fields: GoFields
    if (started.ok) {
      if (started.main !== here) return { text: startedElsewhereMessage(started) }
      arm = { mode: 'go', slug: started.slug, ...(own === undefined || own.path === started.ledger ? {} : { previous: previousOf(own) }) }
      fields = goFields(started, here)
    } else if (started.exitCode === NO_SUCH_TASK && isNewSlug(target) && here !== undefined) {
      arm = { mode: 'go', slug: target, isNew: true, main: here, ...(own === undefined ? {} : { previous: previousOf(own) }) }
      fields = { isNew: true }
    } else {
      return { text: startFailedMessage(target, started.error) }
    }
    await $.state.set(armed, arm)
    return { target: arm.slug, fields, args: goArgs(arm.slug, own?.path, fields), arm }
  } finally {
    goStarting = undefined
  }
}

/**
 * Clears the switch a /ledger:go call armed, unless something armed another since. State hands back copies, not `arm`.
 * Known limit: in the test harness $.state.get returns this hook's own last write, so an arm made meanwhile may be
 * cleared too. The cost is one missed clear.
 */
async function disarm($: EngineInterface, arm: GoArm): Promise<void> {
  const { value } = await $.state.get(armed)
  if (value?.mode === 'go' && value.slug === arm.slug) await $.state.set(armed, null)
}

/** The answer of the hooks after /ledger:go; when they fail, the switch it armed is undone first. */
async function disarmedOnFailure<T>($: EngineInterface, arm: GoArm, answer: Promise<T>): Promise<T> {
  try {
    return await answer
  } catch (error) {
    await disarm($, arm)
    throw error
  }
}

async function parkOther($: EngineInterface, slug: string, reason: string): Promise<string> {
  const parked = await ledgerJson<Parked>($, ['park', slug, '--reason', reason])
  return parked.ok ? `Parked ${slug}. Parked: ${parked.parked.date} — ${parked.parked.reason}` : `Could not park ${slug}. ${parked.error}`
}

type Listed = { tasks: { slug: string; main?: string }[] }

/** Whether the repo at `main` has a live task `slug`; an error when `ledger list` failed. */
async function hasTask($: EngineInterface, slug: string, main: string): Promise<boolean | { error: string }> {
  const listed = await ledgerJson<Listed>($, ['list'])
  return listed.ok ? listed.tasks.some(task => task.slug === slug && task.main === main) : { error: listed.error }
}

/** What `ledger retire --dry-run` tells of the branch of a finished task; a failed dry run only makes the hint plainer. */
async function branchFacts($: EngineInterface, slug: string): Promise<BranchFacts> {
  const plan = await ledgerJson<RetirePlan>($, ['retire', slug, '--dry-run'], LONG_TIMEOUT_MS)
  if (!plan.ok || plan.worktree === undefined) return undefined
  return { ...plan.worktree, blockedBy: plan.blocked ? plan.blockers.map(({ reason }) => reason) : [] }
}

/**
 * Shown after the clear, because the model may have just finished the last step. The lines are only advice, so a failed
 * lookup skips them. `namesNextChild` is false after /ledger:go: it has already marked its target started, so the
 * parent's next child would be the one after it. The build folders of a finished task are pruned first. The retire dry
 * run asks git and gh whether the branch is merged, which can take seconds.
 */
async function showRetireHint($: EngineInterface, previous: PreviousTask, namesNextChild: boolean): Promise<void> {
  const pruned = await ledgerJson<AutoPruned>($, ['auto-prune', previous.ledger])
  if (!pruned.ok) return
  if (pruned.message) await $.ui.log(pruned.message)
  if (!pruned.finished) return
  await $.ui.log(retireHint(previous.slug, await branchFacts($, previous.slug)))
  const { parent, main: here } = previous
  if (!namesNextChild || parent === undefined) return
  const ref = { slug: parent.slug, main: parent.main ?? here ?? '' }
  const next = await ledgerJson<NextChild>($, ['parent', `${ref.slug}@${ref.main}`, 'next'])
  const child = next.ok ? next.chain.at(-1) : undefined
  if (next.ok) await $.ui.log(nextChildHint(taskName(ref, here), child && taskName(child, here)))
}

/**
 * Names the session after its task with /rename, because a hook's sessionTitle does not reach Remote Control in VS Code.
 * Only a new task renames, so a title the operator gave stays while the task does. A failure is tried again next turn;
 * the title is not worth a line in the transcript.
 */
async function titleSession($: EngineInterface, slug: string): Promise<void> {
  try {
    const { value: last } = await $.state.get(titled)
    if (slug === last) return
    await $.command.run({ command: 'rename', args: slug })
    await $.state.set(titled, slug)
  } catch {}
}

/** At a turn end that does not clear: the model may have just finished or reopened the task, which auto-prune acts on once. */
async function finishTurn($: EngineInterface): Promise<void> {
  const session = await readSession($)
  if (!session.ok) return
  if (session.title !== undefined) await titleSession($, session.title)
  const own = ownTask(session)
  if (own === undefined) return
  const pruned = await ledgerJson<AutoPruned>($, ['auto-prune', own.path])
  if (pruned.ok && pruned.message) await $.ui.log(pruned.message)
}

function archiveArgs(given: string[]): string[] {
  const term = given.filter(word => word !== '--all').join(' ')
  return ['archive', ...(term === '' ? [] : [term]), ...(given.includes('--all') ? ['--all'] : [])]
}

// The hook sees the model's raw input: the name may be missing, or carry a leading slash the Skill tool strips later.
const skillName = (skill: string | undefined): string => (skill ?? '').trim().replace(/^\//, '')

/**
 * The text of a command answered by text alone, with no markdown turn after it; `undefined` for every other command.
 * Not async, so that the Skill hook passes a /ledger:go call on without a wait, and /ledger:go reserves its turn's switch
 * before an overlapping call can.
 */
function answerOf($: EngineInterface, command: string, args: string | undefined): Promise<string> | undefined {
  const given = words(args)
  switch (command) {
    case 'ledger:all': {
      const list = ledgerText($, ['list', '--archived'])
      return given.includes('--scan') ? list.then(text => `${SCAN_DROPPED}\n\n${text}`) : list
    }
    case 'ledger:archive':
      return ledgerText($, archiveArgs(given))
    case 'ledger:parent':
      return given.length === 0 ? Promise.resolve(PARENT_USAGE) : ledgerText($, ['parent', ...given])
    case 'ledger:worktrees':
      return ledgerText($, ['worktrees', ...given], LONG_TIMEOUT_MS)
    case 'ledger:retire':
      return ledgerText($, ['retire', ...given], LONG_TIMEOUT_MS)
    case 'ledger:help':
      return Promise.resolve(HELP)
  }
  return undefined
}

const TYPED_ONLY = new Set(['ledger:close', 'ledger:next', 'ledger:park'])

/** Whether only the operator may run `command` with `args`: it deletes, writes or clears the session. */
function isTypedOnly(command: string, args: string | undefined): boolean {
  const given = words(args)
  switch (command) {
    case 'ledger:parent':
      return given[1] !== undefined && given[1] !== 'next'
    // --force discards uncommitted changes and unmerged work.
    case 'ledger:retire':
      return given.includes('--force')
    case 'ledger:worktrees':
      return (given[0] === 'prune' || given[0] === 'prune-orphans') && !given.includes('--dry-run')
  }
  return TYPED_ONLY.has(command)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ledger',
      description: 'Show the goal, current step and next step of each task ledger this session works on. /ledger <name> shows those whose slug holds it.',
    })
    return next(e)
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const session = await readSession($)
    if (!session.ok) return { text: `Could not list the task ledgers of this session. ${session.error}` }
    const filter = (e.args ?? '').trim()
    const shown = session.ledgers.filter(({ slug }) => slug.toLowerCase().includes(filter.toLowerCase()))
    if (shown.length > 0) return { text: formatLedgers(shown) }
    return { text: filter ? `No ledger matches "${filter}".` : 'No task ledgers found for this session. /ledger:all lists every task on this machine.' }
  })

  // The markdown command writes to the ledger, so it runs only for the session's own ledger. The exception is
  // /ledger:close after the session folder was removed: told there is no ledger, it writes nothing, and its turn's end clears.
  on('command.run', { command: ['ledger:close', 'ledger:next'] }, async ($, e, next) => {
    const session = await readSession($)
    if (!session.ok) return { text: lookupFailedMessage(session.error) }
    if (session.removed) {
      if (e.command === 'ledger:next') return { text: removedFolderMessage(session.folder) }
      await $.state.set(armed, { mode: 'close', slug: basename(session.folder) })
      return next({ ...e, args: 'ledger: none' })
    }
    const own = ownTask(session)
    if (own === undefined) return { text: noLedgerMessage(session.folder) }
    if (e.command === 'ledger:next') {
      await $.state.set(armed, { mode: 'next', slug: own.slug, previous: previousOf(own) })
      return next(e)
    }
    await $.state.set(armed, { mode: 'close', slug: own.slug })
    // Set here, so only this hook can tell close.md that there is no ledger.
    return next({ ...e, args: `ledger: ${own.path}` })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // A command.run hook cannot clear the session, and an answer of { text } ends no turn, so go.md runs a
  // model turn even when there is no ledger to write: its turn.complete is what clears.
  on('command.run', { command: 'ledger:go' }, async ($, e, next) => {
    // Should an engine raise both command.run and tool.call for one command, the second one sees this hook's own args.
    if (isGoArgs(e.args ?? '')) return next(e)
    const started = await startGo($, e.args ?? '')
    return 'text' in started ? started : disarmedOnFailure($, started.arm, next({ ...e, args: started.args }))
  }).catch(async ($, e, next) => (next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }))

  // The other commands raise no command.run through the Skill tool either. A deny answers without running the tool, so the
  // model gets this text instead of the command's markdown, which is only the fallback for a hook that did not answer.
  // Registered before the /ledger:go hook, so that an error thrown in this hook reaches this .catch, not the /ledger:go hook's.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const command = skillName(e.skill)
    if (isTypedOnly(command, e.args)) return { deny: typedOnlyMessage(command, e.args ?? '') }
    const answer = answerOf($, command, e.args)
    return answer === undefined ? next(e) : { deny: await answer }
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: skillFailedMessage(skillName(e.skill), next.error.message ?? next.error.kind) }))

  // The model starts /ledger:go through the Skill tool, which raises no command.run: the Skill tool expands go.md itself.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (skillName(e.skill) !== 'ledger:go') return next(e)
    // A subagent's turn end does not clear, so the main session would clear at its own turn's end, mid-task.
    if (e.agentId !== undefined) return { deny: GO_FROM_SUBAGENT }
    // No slug has a colon, so even one of the lines this hook writes means the model passed them instead of a slug.
    if (/^(task|ledger):/.test(e.args ?? '')) return { deny: slugExpectedMessage(e.args ?? '') }
    const started = await startGo($, e.args ?? '')
    if ('text' in started) return { deny: started.text }
    // The permission prompt runs inside next(), after `ledger go`. A started worktree stays: the next /ledger:go finds it.
    const ran = await disarmedOnFailure($, started.arm, next({ ...e, args: started.args }))
    // A person's No at the permission prompt comes back as an error result, not as a deny.
    if (ran.isError === true) {
      await disarm($, started.arm)
      const reason = ran.text ?? ''
      const text = goDeniedMessage(started.target, started.fields, reason)
      // The engine shows the model its own rejection text instead, so only the person can learn what was done.
      if (text !== reason) await $.ui.log(text)
      return { ...ran, text }
    }
    if (ran.deny === undefined) return ran
    await disarm($, started.arm)
    return { ...ran, deny: goDeniedMessage(started.target, started.fields, ran.deny) }
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: lookupFailedMessage(next.error.message ?? next.error.kind) }))

  // The first word names another task only when a live task of this repo has that slug; otherwise it is part of the reason. A slug of
  // another task with no reason is a mistake, not this task's reason.
  on('command.run', { command: 'ledger:park' }, async ($, e, next) => {
    const [first, ...rest] = words(e.args)
    if (first === undefined) return { text: PARK_USAGE }
    const session = await readSession($)
    if (!session.ok) return { text: lookupFailedMessage(session.error) }
    const own = ownTask(session)
    let reason = [first, ...rest].join(' ')
    if (own !== undefined && first === own.slug) reason = rest.join(' ')
    else if (session.main !== undefined) {
      const found = await hasTask($, first, session.main)
      if (typeof found === 'object') return { text: lookupFailedMessage(found.error) }
      if (found) return { text: rest.length === 0 ? PARK_USAGE : await parkOther($, first, rest.join(' ')) }
    }
    if (reason === '') return { text: PARK_USAGE }
    if (session.removed) return { text: removedFolderMessage(session.folder) }
    if (own === undefined) return { text: noLedgerMessage(session.folder) }
    await $.state.set(armed, { mode: 'park', slug: own.slug, reason })
    return next({ ...e, args: parkArgs(own.slug, own.path, reason) })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  for (const command of ['ledger:all', 'ledger:archive', 'ledger:parent', 'ledger:worktrees', 'ledger:retire', 'ledger:help']) {
    // Typed as always a string, but `claude plugin test` leaves it undefined when the caller omits it.
    on('command.run', { command }, async ($, e) => ({ text: (await answerOf($, command, e.args)) ?? '' }))
  }

  // $.command.run and $.prompt.submit must not be awaited inside a command.run hook, so the clear waits for the turn's end.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { value } = await $.state.get(armed)
    // A turn that clears does not rename: the session is still in the old task, and the turn of `go <slug>` renames.
    // It prunes through showRetireHint instead, so each turn prunes at most once.
    if (!value) {
      if (e.reason === 'answer') await finishTurn($)
      return next(e)
    }
    await $.state.set(armed, null)
    if (e.reason !== 'answer') return next(e)
    // go.md creates the task only when the conversation shows what it is; without a ledger, `go <slug>` would find nothing.
    if (value.mode === 'go' && 'isNew' in value) {
      const made = await hasTask($, value.slug, value.main)
      if (made !== true) {
        await $.ui.log(made === false ? notCreatedMessage(value.slug) : notCheckedMessage(value.slug, made.error))
        return next(e)
      }
    }
    // After the model's turn, so its own edits to the ledger cannot move or drop the marker.
    if (value.mode === 'park') {
      const parked = await ledgerJson<Parked>($, ['park', value.slug, '--reason', value.reason])
      if (!parked.ok) {
        await $.ui.log(parkFailedMessage(value.slug, parked.error))
        return next(e)
      }
    }
    const go = `go ${value.slug}`
    const continues = value.mode === 'next' || value.mode === 'go'
    try {
      await $.command.run({ command: 'clear' })
    } catch (error) {
      await $.ui.log(`/ledger:${value.mode} could not clear the session: ${message(error)}. Run /clear${continues ? `, then say: ${go}` : ''}.`)
      return next(e)
    }
    if (value.mode === 'next' || value.mode === 'go') {
      if (value.previous) await showRetireHint($, value.previous, value.mode === 'next')
      try {
        await $.prompt.submit({ text: go })
      } catch (error) {
        await $.ui.log(`/ledger:${value.mode} cleared the session but could not send "${go}": ${message(error)}. Say: ${go}.`)
      }
    }
    return next(e)
  })
}
