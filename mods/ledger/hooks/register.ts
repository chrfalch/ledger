import type { EngineInterface, PluginState, Register, ToolCallResult } from 'claude-code'

import { ledgerBin, ledgerJson, ledgerSucceeded, ledgerText, LONG_TIMEOUT_MS, message, ownTask, readSession, type AutoPruned, type Claimed, type NextChild, type OwnTask, type Parked, type RetirePlan, type Started } from './cli'
import {
  claimFailedMessage,
  CLEAR_POINT_OPTION,
  clearPointReminder,
  continueTypedArgs,
  descriptionMessage,
  formatLedgers,
  GO_FROM_SUBAGENT,
  GO_USAGE,
  goArgs,
  goCommand,
  goDeniedMessage,
  heldMessage,
  HELP,
  installFailedMessage,
  isDescription,
  isGoArgs,
  isNewSlug,
  lookupFailedMessage,
  NEXT_FROM_SUBAGENT,
  nextAfterSwitchMessage,
  nextChildHint,
  noLedgerMessage,
  notCheckedMessage,
  notCreatedMessage,
  notQueuedMessage,
  oneSwitchPerTurnMessage,
  PARENT_USAGE,
  PARK_USAGE,
  parkArgs,
  parkFailedMessage,
  removedFolderMessage,
  retireHint,
  ROOT_USAGE,
  SCAN_DROPPED,
  skillFailedMessage,
  slugExpectedMessage,
  startedElsewhereMessage,
  startFailedMessage,
  TAKE_OVER_OPTION,
  TAKE_OVER_UNPICKED,
  taskName,
  typedOnlyMessage,
  type BranchFacts,
  type Switch,
  type GoFields,
} from './ledger'

type Armed = NonNullable<PluginState['ledger']['armed']>
type GoArm = Extract<Armed, { mode: 'go' }>
type NextArm = Extract<Armed, { mode: 'next' }>
type PreviousTask = NonNullable<GoArm['previous']>

const armed = { plugin: 'ledger', key: 'armed' } as const
const titled = { plugin: 'ledger', key: 'titled' } as const
const claimedTask = { plugin: 'ledger', key: 'claimedTask' } as const
const clearApproved = { plugin: 'ledger', key: 'clearApproved' } as const
const takeOverApproved = { plugin: 'ledger', key: 'takeOverApproved' } as const
const clearPoint = { plugin: 'ledger', key: 'clearPoint' } as const
const touched = { plugin: 'ledger', key: 'touched' } as const
const heldTask = { plugin: 'ledger', key: 'heldTask' } as const
const handover = { plugin: 'ledger', key: 'handover' } as const
const sessionStart = { plugin: 'ledger', key: 'sessionStart' } as const

/** `ledger go` exits 2 when no task has the slug. */
const NO_SUCH_TASK = 2

/** `ledger go` exits 5 when the task started but its package install failed; the worktree and ledger stay. */
const INSTALL_FAILED = 5

const TAKE_OVER = '--take-over'

/** bin/ledger writes a claim's activity at most this often, so a touch sooner would change nothing. */
const TOUCH_EVERY_MS = 15 * 60_000

/**
 * The switch a /ledger:go or model-started /ledger:next call is starting, from its armed check until it armed the switch or
 * gave up. It is set before the first await, so a second call that overlaps the first cannot also pass the check.
 * It assumes the hooks module is loaded once per session; a second instance would hold its own reservation.
 */
let switchStarting: Switch | undefined

const words = (args: string | undefined): string[] => (args ?? '').split(/\s+/).filter(word => word !== '')

const basename = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1)

const previousOf = ({ slug, worktree, main, parent }: OwnTask): PreviousTask => ({
  slug,
  worktree,
  ...(main === undefined ? {} : { main }),
  ...(parent === undefined ? {} : { parent }),
})

/** The session's own task as `ledger notes --task` takes it, for the `ledger:` line of a command's markdown. */
const ownName = ({ slug, main }: OwnTask, here: string | undefined): string => (main === undefined ? slug : taskName({ slug, main }, here))

/**
 * `{ typed: true }` when no person was at the prompt as this session started: an Agent SDK host cuts the turn of a
 * prompt the mod submits, so the operator types `go <slug>`. A start not recorded for this session counts as a person's.
 */
async function typing($: EngineInterface): Promise<{ typed?: true }> {
  try {
    const { value } = await $.state.get(sessionStart)
    return value?.interactive === false && value.sessionId === (await $.session.id()) ? { typed: true } : {}
  } catch {
    return {}
  }
}

/** next.md takes no argument of its own, so the continue line replaces whatever was passed. */
const withNextArgs = <E extends { args?: string }>(e: E, { typed, slug }: NextArm): E => (typed ? { ...e, args: continueTypedArgs(slug) } : e)

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
 * clear. A text says why the task was not started, or where a task of another repo was started; `heldArgs` hand go.md the
 * claim of the session that holds the task. Then the clear is not armed, and a clear this turn already armed stays.
 * The model may take over only the held task the operator picked "Take over" for, once per pick.
 */
async function startGo(
  $: EngineInterface,
  input: string,
  by: 'operator' | 'model',
): Promise<{ target: string; fields: GoFields; args: string; arm: GoArm } | { heldArgs: string } | { text: string }> {
  const given = input.trim()
  const takeOver = given === TAKE_OVER || given.endsWith(` ${TAKE_OVER}`)
  const target = takeOver ? given.slice(0, -TAKE_OVER.length).trim() : given
  if (target === '') return { text: GO_USAGE }
  if (isDescription(target)) return { text: descriptionMessage(target) }
  if (switchStarting !== undefined) return { text: oneSwitchPerTurnMessage(switchStarting, target) }
  switchStarting = { mode: 'go', slug: target }
  try {
    if (takeOver && by === 'model') {
      const { value: approved } = await $.state.get(takeOverApproved)
      if (approved !== target) return { text: TAKE_OVER_UNPICKED }
      await $.state.set(takeOverApproved, null)
      await $.state.set(heldTask, null)
    }
    const { value: alreadyArmed } = await $.state.get(armed)
    if (alreadyArmed) return { text: oneSwitchPerTurnMessage(alreadyArmed, target) }
    const session = await readSession($)
    if (!session.ok) return { text: lookupFailedMessage(session.error) }
    const own = ownTask(session)
    const here = session.main
    const sessionId = await $.session.id()
    const typed = await typing($)
    const started = await ledgerJson<Started>($, [...goCommand(target), '--session', sessionId, ...(takeOver ? [TAKE_OVER] : [])], LONG_TIMEOUT_MS)
    let arm: GoArm
    let fields: GoFields
    if (started.ok) {
      if (started.main !== here) return { text: startedElsewhereMessage(started) }
      arm = { mode: 'go', slug: started.slug, sessionId, ...typed, ...(own === undefined || (own.slug === started.slug && own.main === started.main) ? {} : { previous: previousOf(own) }) }
      fields = { ...goFields(started, here), ...typed }
    } else if (started.held !== undefined) {
      await recordHeld($, sessionId, target)
      return { heldArgs: goArgs(target, own && ownName(own, here), { held: started.held }) }
    } else if (started.exitCode === NO_SUCH_TASK && isNewSlug(target) && here !== undefined) {
      arm = { mode: 'go', slug: target, sessionId, ...typed, isNew: true, main: here, ...(own === undefined ? {} : { previous: previousOf(own) }) }
      fields = { isNew: true, ...typed }
    } else if (started.exitCode === INSTALL_FAILED) {
      return { text: installFailedMessage(target, started.error) }
    } else {
      return { text: startFailedMessage(target, started.error) }
    }
    await $.state.set(armed, arm)
    return { target: arm.slug, fields, args: goArgs(arm.slug, own && ownName(own, here), fields), arm }
  } finally {
    switchStarting = undefined
  }
}

/**
 * Everything /ledger:next does before next.md runs: read this session's ledger and arm the clear. A text says why it
 * cannot; then nothing is armed.
 */
async function armNext($: EngineInterface): Promise<{ arm: NextArm } | { text: string }> {
  const session = await readSession($)
  if (!session.ok) return { text: lookupFailedMessage(session.error) }
  if (session.removed) return { text: removedFolderMessage(session.folder) }
  const own = ownTask(session)
  if (own === undefined) return { text: noLedgerMessage(session.folder) }
  const arm: NextArm = { mode: 'next', slug: own.slug, previous: previousOf(own), ...(await typing($)) }
  await $.state.set(armed, arm)
  return { arm }
}

/**
 * Everything a model-started /ledger:next does before next.md runs: use up the operator's pick, then arm the clear as the
 * typed command does. A text says why it did not; then nothing is armed.
 */
async function startNext($: EngineInterface, args: string): Promise<{ arm: NextArm } | { text: string }> {
  if (switchStarting !== undefined) return { text: nextAfterSwitchMessage(switchStarting) }
  switchStarting = { mode: 'next' }
  try {
    const { value: approved } = await $.state.get(clearApproved)
    if (approved !== true) return { text: typedOnlyMessage('ledger:next', args) }
    await $.state.set(clearApproved, false)
    const { value: alreadyArmed } = await $.state.get(armed)
    if (alreadyArmed) return { text: nextAfterSwitchMessage(alreadyArmed) }
    return await armNext($)
  } finally {
    switchStarting = undefined
  }
}

/**
 * Clears the switch a /ledger:go or /ledger:next call armed, unless something armed another since. State hands back
 * copies, not `arm`. Known limit: in the test harness $.state.get returns this hook's own last write, so an arm made
 * meanwhile may be cleared too. The cost is one missed clear.
 */
async function disarm($: EngineInterface, arm: GoArm | NextArm): Promise<void> {
  const { value } = await $.state.get(armed)
  if (value?.mode === arm.mode && value.slug === arm.slug) await $.state.set(armed, null)
}

/** The answer of the hooks after /ledger:go or /ledger:next; when they fail, the switch it armed is undone first. */
async function disarmedOnFailure<T>($: EngineInterface, arm: GoArm | NextArm, answer: Promise<T>): Promise<T> {
  try {
    return await answer
  } catch (error) {
    await disarm($, arm)
    throw error
  }
}

async function parkOther($: EngineInterface, slug: string, reason: string): Promise<string> {
  const parked = await ledgerJson<Parked>($, ['task', 'park', slug, '--reason', reason])
  return parked.ok ? `Parked ${slug}. Parked: ${parked.parked.date} — ${parked.parked.reason}` : `Could not park ${slug}. ${parked.error}`
}

/** `currentRepo` is the key `repo` is an alias of, for a ledger still filed under an old key. */
type Listed = { tasks: { slug: string; repo: string; currentRepo?: string; main?: string; host?: string }[] }

/**
 * Whether the repo at `main` has a live task `slug`. With `remoteRepo`, the repo key of that repo, the key alone decides:
 * one key is one repo in every clone, so the task's main may be another clone's, here or on another machine. An error
 * when `ledger list` failed.
 */
async function hasTask($: EngineInterface, slug: string, main: string, { remoteRepo }: { remoteRepo?: string } = {}): Promise<boolean | { error: string }> {
  const listed = await ledgerJson<Listed>($, ['list'])
  const inRepo = (task: Listed['tasks'][number]): boolean => (remoteRepo === undefined ? task.main === main : (task.currentRepo ?? task.repo) === remoteRepo)
  return listed.ok ? listed.tasks.some(task => task.slug === slug && inRepo(task)) : { error: listed.error }
}

/** What `ledger task retire --dry-run` tells of the branch of a finished task; a failed dry run only makes the hint plainer. */
async function branchFacts($: EngineInterface, slug: string): Promise<BranchFacts> {
  const plan = await ledgerJson<RetirePlan>($, ['task', 'retire', slug, '--dry-run'], LONG_TIMEOUT_MS)
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
  const pruned = await ledgerJson<AutoPruned>($, ['worktrees', 'auto-prune', previous.worktree])
  if (!pruned.ok) return
  if (pruned.message) await $.ui.log(pruned.message)
  if (!pruned.finished) return
  await $.ui.log(retireHint(previous.slug, await branchFacts($, previous.slug)))
  const { parent, main: here } = previous
  if (!namesNextChild || parent === undefined) return
  const ref = { slug: parent.slug, main: parent.main ?? here ?? '' }
  const next = await ledgerJson<NextChild>($, ['tree', 'next', `${ref.slug}@${ref.main}`])
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
    const sessionId = await $.session.id()
    const { value: last } = await $.state.get(titled)
    // A title from before titles were kept per session is a plain string, and so names no session.
    if (last?.sessionId === sessionId && last.slug === slug) return
    await $.command.run({ command: 'rename', args: slug })
    await $.state.set(titled, { sessionId, slug })
  } catch {}
}

/**
 * Marks a clear-point offer once the context reaches this session's threshold, unless an agent runs: a clear would cut it
 * off. The offer is only advice, so a failure skips it, as a failed rename does.
 */
async function markClearPoint($: EngineInterface, every: number): Promise<void> {
  if (every <= 0) return
  try {
    const { tokens } = (await $.session.usage()).context
    if (tokens === undefined) return
    const sessionId = await $.session.id()
    const { value } = await $.state.get(clearPoint)
    if (tokens < (value?.sessionId === sessionId ? value.threshold : every)) return
    if ((await $.agent.list()).some(({ status }) => status === 'running')) return
    await $.state.set(clearPoint, { sessionId, threshold: tokens + every, pending: tokens })
  } catch {}
}

/** The context size of this session's marked offer, which the prompt now carries; `undefined` when there is none. */
async function takeClearPoint($: EngineInterface): Promise<number | undefined> {
  const { value } = await $.state.get(clearPoint)
  if (value === undefined || value.pending === null || value.sessionId !== (await $.session.id())) return undefined
  await $.state.set(clearPoint, { ...value, pending: null })
  return value.pending
}

/** The slug of a prompt that is exactly `go <slug>`, as a /ledger:go or /ledger:next sends it after the clear. */
const goSlug = (text: string): string | undefined => /^go\s+([^\s-]\S*)$/.exec(text.trim())?.[1]

/** A line for the model beside the prompt; `held` when another session holds the task, so the turn asks the operator. */
type ClaimLine = { text: string; held: boolean }

/** Names the task a "Take over" pick may approve. A lost record only makes that pick approve nothing. */
async function recordHeld($: EngineInterface, sessionId: string, slug: string): Promise<void> {
  await $.state.set(heldTask, { sessionId, slug }).catch(() => undefined)
}

/**
 * Claims the task for this session; a line for the model when it could not, which never stops the turn. A claim forgets
 * a task found held before, so a later "Take over" pick cannot approve taking that one over. The first go prompt after an
 * armed /ledger:go cleared ends the hand-over; for that task, it takes the claim over from the session that cleared.
 */
async function claimAtGo($: EngineInterface, slug: string): Promise<ClaimLine | undefined> {
  const sessionId = await $.session.id()
  const { value: handedOver } = await $.state.get(handover).catch(() => ({ value: null }))
  if (handedOver) await $.state.set(handover, null).catch(() => undefined)
  const from = handedOver?.slug === slug ? ['--from', handedOver.from] : []
  const answer = await ledgerJson<Claimed>($, ['task', 'claim', slug, '--session', sessionId, ...from])
  if (answer.ok) {
    await $.state.set(heldTask, null).catch(() => undefined)
    await $.state.set(claimedTask, { sessionId, slug: answer.slug }).catch(() => undefined)
    return undefined
  }
  if (answer.held === undefined) return { text: claimFailedMessage(slug, answer.error), held: false }
  await recordHeld($, sessionId, slug)
  return { text: heldMessage(slug, answer.held, ledgerBin($), sessionId), held: true }
}

/** The task this session last claimed with a `go <slug>` prompt; undefined when it claimed none, or the read failed. */
async function claimedSlug($: EngineInterface): Promise<string | undefined> {
  try {
    const sessionId = await $.session.id()
    const { value } = await $.state.get(claimedTask)
    return value?.sessionId === sessionId ? value.slug : undefined
  } catch {
    return undefined
  }
}

/**
 * Marks every claim of this session active, so that none expires while the session works, whichever way it was taken.
 * Only a touch that succeeded counts, so a failure is tried again at the next turn end.
 */
async function touchClaims($: EngineInterface): Promise<void> {
  try {
    const sessionId = await $.session.id()
    const now = await $.clock.now()
    const { value } = await $.state.get(touched)
    if (value?.sessionId === sessionId && now - value.at < TOUCH_EVERY_MS) return
    if (await ledgerSucceeded($, ['task', 'touch', '--all', '--session', sessionId])) await $.state.set(touched, { sessionId, at: now })
  } catch {}
}

/** Ends every claim of session `sessionId`, by default this one. A failure only leaves the claims to expire. */
async function releaseClaims($: EngineInterface, sessionId?: string): Promise<void> {
  try {
    await ledgerText($, ['task', 'release', '--all', '--session', sessionId ?? (await $.session.id())])
  } catch {}
}

/** At a turn end that does not clear: the model may have just finished or reopened the task, which auto-prune acts on once. */
async function finishTurn($: EngineInterface, clearPointTokens: number): Promise<void> {
  const session = await readSession($)
  if (!session.ok) return
  // A worktree's own task replaces the claim as the task the session works on, so the claim must not name it again later.
  if (session.title !== undefined) await $.state.set(claimedTask, null).catch(() => undefined)
  const title = session.title ?? (await claimedSlug($))
  if (title !== undefined) await titleSession($, title)
  const own = ownTask(session)
  if (own === undefined) return
  const pruned = await ledgerJson<AutoPruned>($, ['worktrees', 'auto-prune', own.worktree])
  if (pruned.ok && pruned.message) await $.ui.log(pruned.message)
  if (!(pruned.ok && pruned.finished)) await markClearPoint($, clearPointTokens)
}

function archiveArgs(given: string[]): string[] {
  const term = given.filter(word => word !== '--all').join(' ')
  return ['task', 'archive', ...(term === '' ? [] : [term]), ...(given.includes('--all') ? ['--all'] : [])]
}

/** /ledger:parent takes `<slug> [<action> <child>]`; `ledger tree` takes the action first, and `show` for none. */
function treeArgs(given: string[]): string[] {
  const options = given.filter(word => word.startsWith('-'))
  const [slug = '', action = 'show', ...rest] = given.filter(word => !word.startsWith('-'))
  return ['tree', action, slug, ...rest, ...options]
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
      return given.every(word => word.startsWith('-')) ? Promise.resolve(PARENT_USAGE) : ledgerText($, treeArgs(given))
    case 'ledger:worktrees':
      return ledgerText($, ['worktrees', ...given], LONG_TIMEOUT_MS)
    case 'ledger:retire':
      return ledgerText($, ['task', 'retire', ...given], LONG_TIMEOUT_MS)
    case 'ledger:help':
      return Promise.resolve(HELP)
    case 'ledger:root': {
      const args = rootArgs(given)
      return args === undefined ? Promise.resolve(ROOT_USAGE) : ledgerText($, args)
    }
  }
  return undefined
}

/** /ledger:root takes `[<minutes>|off|status]`; with no argument it is `ledger root on`. */
function rootArgs(given: string[]): string[] | undefined {
  if (given.length === 0) return ['root', 'on']
  if (given.length > 1) return undefined
  const [word] = given
  if (word === 'off' || word === 'status') return ['root', word]
  return /^\d+$/.test(word) ? ['root', 'on', '--minutes', word] : undefined
}

// /ledger:next is typed-only too, unless the operator just picked the clear-point option: its own Skill hook decides.
const TYPED_ONLY = new Set(['ledger:close', 'ledger:park', 'ledger:fleet', 'ledger:root'])

/** The operator's answers in a question box. An answer the box gave itself after the operator was away is not the operator's. */
function operatorAnswers(asked: ToolCallResult<'AskUserQuestion'>): string[] {
  if (asked.deny !== undefined || asked.isError === true || asked.result.afkTimeoutMs !== undefined) return []
  return Object.values<unknown>(asked.result.answers).filter(answer => typeof answer === 'string')
}

const labelsOf = (option: string): string[] => [option, `${option} (Recommended)`]

/**
 * Whether the operator picked the clear-point option. A multi-select answer joins its labels with ", ", which the
 * option's label holds too, so a pick is matched as a whole label between separators rather than by splitting.
 */
const picksClearPoint = (asked: ToolCallResult<'AskUserQuestion'>): boolean =>
  operatorAnswers(asked).some(answer => labelsOf(CLEAR_POINT_OPTION).some(label => `, ${answer}, `.includes(`, ${label}, `)))

/**
 * Whether the operator's whole answer is "Take over": one that also names another option is no pick, as it ends a claim.
 * In a box with several questions the answer may belong to another one, so only a box with one answer counts.
 */
const picksTakeOver = (asked: ToolCallResult<'AskUserQuestion'>): boolean => {
  const answers = operatorAnswers(asked)
  return answers.length === 1 && labelsOf(TAKE_OVER_OPTION).includes(answers[0])
}

/** The held task a "Take over" pick approves the take-over of; none when this session found none held. */
async function heldSlug($: EngineInterface): Promise<string | null> {
  const { value } = await $.state.get(heldTask)
  return value?.sessionId === (await $.session.id()) ? value.slug : null
}

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

export const register: Register = (on, options) => {
  const clearPointTokens = typeof options.clearPointTokens === 'number' ? options.clearPointTokens : 0

  on('session.start', async ($, e, next) => {
    // A failed write leaves the session counted as a person's, which is today's behaviour.
    try {
      await $.state.set(sessionStart, { sessionId: await $.session.id(), interactive: e.isInteractive })
    } catch {}
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
    if (e.command === 'ledger:next') {
      const nextArmed = await armNext($)
      return 'text' in nextArmed ? nextArmed : next(withNextArgs(e, nextArmed.arm))
    }
    const session = await readSession($)
    if (!session.ok) return { text: lookupFailedMessage(session.error) }
    if (session.removed) {
      await $.state.set(armed, { mode: 'close', slug: basename(session.folder) })
      return next({ ...e, args: 'ledger: none' })
    }
    const own = ownTask(session)
    if (own === undefined) return { text: noLedgerMessage(session.folder) }
    await $.state.set(armed, { mode: 'close', slug: own.slug })
    // Set here, so only this hook can tell close.md that there is no ledger.
    return next({ ...e, args: `ledger: ${ownName(own, session.main)}` })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // A command.run hook cannot clear the session, and an answer of { text } ends no turn, so go.md runs a
  // model turn even when there is no ledger to write: its turn.complete is what clears.
  on('command.run', { command: 'ledger:go' }, async ($, e, next) => {
    // Should an engine raise both command.run and tool.call for one command, the second one sees this hook's own args.
    if (isGoArgs(e.args ?? '')) return next(e)
    const started = await startGo($, e.args ?? '', 'operator')
    if ('text' in started) return started
    if ('heldArgs' in started) return next({ ...e, args: started.heldArgs })
    return disarmedOnFailure($, started.arm, next({ ...e, args: started.args }))
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
    const started = await startGo($, e.args ?? '', 'model')
    if ('text' in started) return { deny: started.text }
    if ('heldArgs' in started) return next({ ...e, args: started.heldArgs })
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

  // The model may start /ledger:next only right after the operator picked the clear-point option, and once per pick.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (skillName(e.skill) !== 'ledger:next') return next(e)
    // Before the pick is checked, so that a subagent cannot use up the main session's pick.
    if (e.agentId !== undefined) return { deny: NEXT_FROM_SUBAGENT }
    const started = await startNext($, e.args ?? '')
    if ('text' in started) return { deny: started.text }
    const ran = await disarmedOnFailure($, started.arm, next(withNextArgs(e, started.arm)))
    // A person's No at the permission prompt comes back as an error result, not as a deny.
    if (ran.isError === true || ran.deny !== undefined) await disarm($, started.arm)
    return ran
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: lookupFailedMessage(next.error.message ?? next.error.kind) }))

  // Every answer replaces the last approval, so a later "Not yet" takes back an earlier pick. A subagent's question box
  // approves nothing: the clear-point and held questions are the main session's. Nor do answers the model wrote into the call itself.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const asked = await next(e)
    const byOperator = e.agentId === undefined && e.answers === undefined
    await $.state.set(clearApproved, byOperator && picksClearPoint(asked))
    await $.state.set(takeOverApproved, byOperator && picksTakeOver(asked) ? await heldSlug($) : null)
    return asked
  }).catch(async ($, e, next) => {
    // The operator's answer is handed back, never asked again; a pick that was not written approves nothing.
    const asked = await next(e)
    await $.state.set(clearApproved, false).catch(() => undefined)
    await $.state.set(takeOverApproved, null).catch(() => undefined)
    return asked
  })

  // T3 starts a message queued with fresh context as a new run of the thread once this turn ends; that run is the cleared
  // session. A send T3 refused queues nothing, so the turn end clears as before and the operator types `go <slug>`.
  on('tool.call', { tool: 'mcp__t3-code__t3_thread_send' }, async ($, e, next) => {
    const sent = await next(e)
    if (e.agentId !== undefined || sent.deny !== undefined || sent.isError === true) return sent
    const { value } = await $.state.get(armed)
    const continues = value?.mode === 'next' || value?.mode === 'go'
    if (continues && value.typed && e.mode === 'queue' && e.freshContext === true && typeof e.message === 'string' && e.message.trim() === `go ${value.slug}`) {
      await $.state.set(armed, { ...value, queued: true })
    }
    return sent
  }).catch(async ($, e, next) => next(e))

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
      const found = await hasTask($, first, session.main, { remoteRepo: session.repo })
      if (typeof found === 'object') return { text: lookupFailedMessage(found.error) }
      if (found) return { text: rest.length === 0 ? PARK_USAGE : await parkOther($, first, rest.join(' ')) }
    }
    if (reason === '') return { text: PARK_USAGE }
    if (session.removed) return { text: removedFolderMessage(session.folder) }
    if (own === undefined) return { text: noLedgerMessage(session.folder) }
    await $.state.set(armed, { mode: 'park', slug: own.slug, reason })
    return next({ ...e, args: parkArgs(own.slug, ownName(own, session.main), reason) })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  for (const command of ['ledger:all', 'ledger:archive', 'ledger:parent', 'ledger:worktrees', 'ledger:retire', 'ledger:help', 'ledger:root']) {
    // Typed as always a string, but `claude plugin test` leaves it undefined when the caller omits it.
    on('command.run', { command }, async ($, e) => ({ text: (await answerOf($, command, e.args)) ?? '' }))
  }

  // The claim line and the offer reach the model as context beside the prompt, which the operator does not see. A slash
  // command's turn has its own instructions, so the offer waits for the next plain prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    const slug = goSlug(e.text)
    const claim = slug === undefined ? undefined : await claimAtGo($, slug).catch((error): ClaimLine => ({ text: claimFailedMessage(slug, message(error)), held: false }))
    // The held question has the turn to itself, so the offer waits for a later prompt.
    const tokens = claim?.held ? undefined : await takeClearPoint($).catch(() => undefined)
    const lines = [claim?.text, tokens === undefined ? undefined : clearPointReminder(tokens)].filter(line => line !== undefined)
    return next(lines.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...lines] })
  }).catch(async ($, e, next) => next(e))

  // $.command.run and $.prompt.submit must not be awaited inside a command.run hook, so the clear waits for the turn's end.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // A pick answers the question of this turn only. Each reset is its own try, so neither failure leaves the other pick
    // standing or skips the turn's end; the take-over pick goes first, as it ends another session's claim.
    await $.state.set(takeOverApproved, null).catch(() => undefined)
    await $.state.set(clearApproved, false).catch(() => undefined)
    await touchClaims($)
    const { value } = await $.state.get(armed)
    // A turn that clears does not rename: the session is still in the old task, and the turn of `go <slug>` renames.
    // It prunes through showRetireHint instead, so each turn prunes at most once.
    if (!value) {
      if (e.reason === 'answer') await finishTurn($, clearPointTokens)
      return next(e)
    }
    await $.state.set(armed, null)
    // T3 starts a queued run even after a turn cut short, and that run needs the claims released.
    const queued = (value.mode === 'next' || value.mode === 'go') && value.queued === true
    if (e.reason !== 'answer' && !queued) return next(e)
    // go.md creates the task only when the conversation shows what it is; without a ledger, `go <slug>` would find nothing.
    if (value.mode === 'go' && 'isNew' in value) {
      const made = await hasTask($, value.slug, value.main)
      if (made !== true) {
        const why = made === false ? notCreatedMessage(value.slug) : notCheckedMessage(value.slug, made.error)
        await $.ui.log(queued ? `${why} The queued "go ${value.slug}" still runs; stop it in T3.` : why)
        return next(e)
      }
    }
    // After the model's turn, so its own edits to the ledger cannot move or drop the marker.
    if (value.mode === 'park') {
      const parked = await ledgerJson<Parked>($, ['task', 'park', value.slug, '--reason', value.reason])
      if (!parked.ok) {
        await $.ui.log(parkFailedMessage(value.slug, parked.error))
        return next(e)
      }
    }
    // The new session has another id, so the claim of this one would hold the task against it.
    await releaseClaims($)
    // A release that failed leaves that claim live; the new session's go prompt takes it over.
    if (value.mode === 'go') await $.state.set(handover, { slug: value.slug, from: value.sessionId }).catch(() => undefined)
    if ((value.mode === 'next' || value.mode === 'go') && value.queued) {
      if (value.previous) await showRetireHint($, value.previous, value.mode === 'next')
      return next(e)
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
      if (value.typed) {
        try {
          await $.ui.log(notQueuedMessage(value.mode, value.slug))
        } catch {}
        return next(e)
      }
      try {
        await $.prompt.submit({ text: go })
      } catch (error) {
        await $.ui.log(`/ledger:${value.mode} cleared the session but could not send "${go}": ${message(error)}. Say: ${go}.`)
      }
    }
    return next(e)
  })

  // A /clear ends the session too, so the claims of an armed clear may already be gone; a second release changes nothing.
  on('session.end', async ($, e, next) => {
    await releaseClaims($, e.sessionId)
    return next(e)
  }).catch(async ($, e, next) => next(e))
}
