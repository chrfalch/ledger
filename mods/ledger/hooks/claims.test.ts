import { expect, mock, test } from 'claude-code/testing'

import { done, ledgerOf, MAIN, ran, refused, session, task, turnEnd, world, worktreeOf } from './fake-ledger.test-helper'
import { CLEAR_POINT_OPTION, clearPointReminder, heldMessage, TAKE_OVER_UNPICKED, typedOnlyMessage } from './ledger'

const CWD = worktreeOf('epic')
const SESSION = `session ${CWD} --json`
const EPIC = ledgerOf('epic')
const MINUTE = 60_000

const OTHER = { session: 'session-2', since: '2026-11-20T08:00:00Z', active: '2026-11-20T09:30:00Z' }
const HELD_TEXT = 'held: session session-2 since 2026-11-20T08:00:00Z, active 2026-11-20T09:30:00Z'
const held = ran(3, JSON.stringify({ ok: false, error: HELD_TEXT, held: OTHER }))
const claimed = (slug: string) => done({ slug, ledger: ledgerOf(slug), claim: { session: 'session-1', since: '2026-11-20T10:00:00Z', active: '2026-11-20T10:00:00Z' } })

const claim = (slug: string) => `task claim ${slug} --session session-1 --json`
const claimArgv = (slug: string) => ['task', 'claim', slug, '--session', 'session-1', '--json']
const touchAllArgv = (id = 'session-1') => ['task', 'touch', '--all', '--session', id]
const releaseAllArgv = (id = 'session-1') => ['task', 'release', '--all', '--session', id]
const TOUCH_ALL = touchAllArgv().join(' ')
const RELEASE_ALL = releaseAllArgv().join(' ')
const touchedSome = ran(0, 'touched epic\ntouched kid')
const touches = (w: ReturnType<typeof world>) => w.argvs().filter(argv => argv[1] === 'touch')
const autoPrune = { [`worktrees auto-prune ${EPIC} --json`]: done({ ledger: EPIC, worktree: CWD, marker: '', finished: false, outcome: 'unchanged' }) }
const started = (slug: string) => done({ slug, main: MAIN, ledger: ledgerOf(slug), worktree: worktreeOf(slug), branch: `me/${slug}`, promoted: false, chain: [], warnings: [] })

// the go <slug> prompt

test('a go <slug> prompt claims the task for this session and passes the prompt on unchanged', async ($, on) => {
  const w = world(on, { [claim('epic')]: claimed('epic') }, { cwd: CWD })

  await $.prompt.submit({ text: '  go epic\n' })

  expect(w.argvs()).toEqual([claimArgv('epic')])
  expect(w.events).toEqual(['submit:   go epic\n'])
  expect(w.reminders).toEqual([])
})

test('a go <slug> prompt for a task another session holds asks, with three options, before any work', async ($, on) => {
  const w = world(on, { [claim('epic')]: held }, { cwd: CWD })

  await $.prompt.submit({ text: 'go epic' })

  expect(w.events).toEqual(['submit: go epic'])
  expect(w.reminders.length).toBe(1)
  const [reminder = ''] = w.reminders
  expect(reminder).toContain('Task epic is held by session session-2 since 2026-11-20T08:00:00Z, last active 2026-11-20T09:30:00Z.')
  expect(reminder).toContain('Do not start work')
  expect(reminder).toContain('AskUserQuestion')
  expect(reminder).toContain('"Take over"')
  expect(reminder).toContain("ends the other session's claim")
  expect(reminder).toContain("/bin/ledger' task claim 'epic' --take-over --session session-1")
  expect(reminder).toContain('"Pick another task"')
  expect(reminder).toContain("/bin/ledger' list")
  expect(reminder).toContain('"Stop"')
  expect(reminder).not.toContain('"Close"')
})

test('the held line quotes the bin/ledger path, so a path with spaces or quotes runs as one word', () => {
  const line = heldMessage('epic', OTHER, "/Users/me/my repo/it's/bin/ledger", 'session-1')

  expect(line).toContain(`\`'/Users/me/my repo/it'\\''s/bin/ledger' task claim 'epic' --take-over --session session-1\``)
  expect(line).toContain(`\`'/Users/me/my repo/it'\\''s/bin/ledger' list\``)
})

test('the held line quotes the task too, so a slug@path with a quote runs as one word', () => {
  const line = heldMessage("epic@/Users/me/it's", OTHER, '/bin/ledger', 'session-1')

  expect(line).toContain(`task claim 'epic@/Users/me/it'\\''s' --take-over`)
})

test('a go <slug> prompt with more than one space before the slug claims the task', async ($, on) => {
  const w = world(on, { [claim('epic')]: claimed('epic') }, { cwd: CWD })

  await $.prompt.submit({ text: 'go   epic' })
  await $.prompt.submit({ text: 'go\tepic' })

  expect(w.argvs()).toEqual([claimArgv('epic'), claimArgv('epic')])
})

test('a held answer whose claim is malformed is a plain claim failure', async ($, on) => {
  const malformed = ran(3, JSON.stringify({ ok: false, error: 'held by someone', held: { session: 'session-2', since: 7 } }))
  const w = world(on, { [claim('epic')]: malformed }, { cwd: CWD })

  await $.prompt.submit({ text: 'go epic' })

  expect(w.reminders.length).toBe(1)
  expect(w.reminders[0]).toContain('Could not claim task epic')
  expect(w.reminders[0]).toContain('held by someone')
  expect(w.reminders[0]).not.toContain('AskUserQuestion')
})

const EVERY_100 = { options: { clearPointTokens: 100 } }

test('a held go <slug> prompt leaves the clear-point offer for the next plain prompt', EVERY_100, async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune, [claim('kid')]: held }, { cwd: CWD })

  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'go kid' })
  expect(w.reminders.length).toBe(1)
  expect(w.reminders[0]).toContain('Task kid is held by session session-2')

  await $.prompt.submit({ text: 'later' })
  expect(w.reminders.slice(1)).toEqual([clearPointReminder(120)])
})

test('a go <slug> prompt that claims the task still carries the clear-point offer', EVERY_100, async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune, [claim('kid')]: claimed('kid') }, { cwd: CWD })

  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'go kid' })

  expect(w.reminders).toEqual([clearPointReminder(120)])
})

test('a claim that fails for another reason passes the prompt on with a line that says why', async ($, on) => {
  const w = world(on, { [claim('epic')]: refused('epic is not active: it is in the backlog. ledger go epic starts it.', 2) }, { cwd: CWD })

  await $.prompt.submit({ text: 'go epic' })

  expect(w.events).toEqual(['submit: go epic'])
  expect(w.reminders.length).toBe(1)
  expect(w.reminders[0]).toContain('Could not claim task epic')
  expect(w.reminders[0]).toContain('epic is not active: it is in the backlog.')
})

for (const text of ['go', 'go epic now', 'let us go epic', 'Go epic', 'goepic', 'go --take-over', 'go -x']) {
  test(`the prompt "${text}" makes no claim`, async ($, on) => {
    const w = world(on, {}, { cwd: CWD })

    await $.prompt.submit({ text })

    expect(w.calls).toEqual([])
    expect(w.reminders).toEqual([])
  })
}

test('a slash command whose text reads go <slug> makes no claim', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  await $.prompt.submit({ text: 'go epic', command: { name: 'ledger:go', args: 'epic' } })

  expect(w.calls).toEqual([])
})

// /ledger:go

test('/ledger:go passes the session id to ledger go', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['go', 'kid', '--session', 'session-1', '--json']])
})

test('/ledger:go of a task another session holds hands go.md a held: line and arms no clear', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': held }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()).toEqual({ command: 'ledger:go', args: `task: kid\nledger: ${EPIC}\n${HELD_TEXT}` })
  expect(w.armed).toEqual([])
  expect(w.events.filter(event => event === 'clear')).toEqual([])
})

test('/ledger:go through the Skill tool of a held task hands go.md the held: line and arms no clear', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': held }, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(answer.deny).toBeUndefined()
  expect(w.skills).toEqual([{ skill: 'ledger:go', args: `task: kid\nledger: ${EPIC}\n${HELD_TEXT}` }])
  expect(w.armed).toEqual([])
  expect(w.events.filter(event => event === 'clear')).toEqual([])
})

test('a ledger go refusal with exit 3 but no held claim is a failed start, not a held task', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': refused('No task kid in the repo at /repo.', 3) }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(text).toContain('Could not start task kid.')
  expect(w.markdown()).toBeUndefined()
})

test('/ledger:go <slug> --take-over forwards --take-over to ledger go and switches as usual', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --take-over --json': started('kid'), ...autoPrune }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid --take-over' })
  await $.turn.complete(turnEnd)

  expect(w.argvs()[1]).toEqual(['go', 'kid', '--session', 'session-1', '--take-over', '--json'])
  expect(w.markdown()).toEqual({ command: 'ledger:go', args: `task: kid\nledger: ${EPIC}` })
  expect(w.events.filter(event => event !== 'rename: epic')).toEqual(['clear', 'submit: go kid'])
})

const HELD_QUESTION = 'Task kid is held by session session-2. What now?'
const heldQuestions = [
  {
    question: HELD_QUESTION,
    header: 'Held',
    options: [
      { label: 'Take over', description: "Ends the other session's claim." },
      { label: 'Pick another task', description: 'Lists the tasks.' },
      { label: 'Stop', description: 'Changes nothing.' },
    ],
    multiSelect: false,
  },
]
const askHeld = { tool: 'AskUserQuestion', questions: heldQuestions } as const
const takeOverKid = { tool: 'Skill', skill: 'ledger:go', args: 'kid --take-over' } as const
const goKidTakingOver = { [SESSION]: session(CWD, task('epic')), [claim('kid')]: held, 'go kid --session session-1 --take-over --json': started('kid') }
const goCalls = (w: ReturnType<typeof world>) => w.argvs().filter(([command]) => command === 'go')
const CLEAR_POINT = 'Clear point. Ledger updated. Clear the session and continue?'
const clearPointQuestions = [
  {
    question: CLEAR_POINT,
    header: 'Clear point',
    options: [
      { label: `${CLEAR_POINT_OPTION} (Recommended)`, description: 'Writes the ledger, clears the session and continues the task.' },
      { label: 'Not yet', description: 'Keeps working in this session.' },
    ],
    multiSelect: false,
  },
]
const askClearPoint = { tool: 'AskUserQuestion', questions: clearPointQuestions } as const

for (const pick of ['Take over', 'Take over (Recommended)']) {
  test(`/ledger:go <slug> --take-over through the Skill tool forwards --take-over after the operator picks "${pick}" for that held task`, async ($, on) => {
    const w = world(on, goKidTakingOver, { cwd: CWD })
    w.answerQuestion({ answers: { [HELD_QUESTION]: pick } })

    await $.prompt.submit({ text: 'go kid' })
    await $.tool.call(askHeld)
    const answer = await $.tool.call(takeOverKid)

    expect(answer.deny).toBeUndefined()
    expect(goCalls(w)).toEqual([['go', 'kid', '--session', 'session-1', '--take-over', '--json']])
    expect(w.skills).toEqual([{ skill: 'ledger:go', args: `task: kid\nledger: ${EPIC}` }])
  })
}

test('a held /ledger:go names the task a "Take over" pick approves, as a held go <slug> prompt does', async ($, on) => {
  const w = world(on, { ...goKidTakingOver, 'go kid --session session-1 --json': held }, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })
  await $.tool.call(askHeld)
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBeUndefined()
  expect(goCalls(w).at(-1)).toEqual(['go', 'kid', '--session', 'session-1', '--take-over', '--json'])
})

test('/ledger:go <slug> --take-over through the Skill tool is refused until the operator picks "Take over"', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })

  await $.prompt.submit({ text: 'go kid' })
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
  expect(w.skills).toEqual([])
})

test('a "Take over" pick with no held task approves nothing', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.tool.call(askHeld)
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
})

test('a "Take over" pick for the held task approves no take-over of another task', async ($, on) => {
  const w = world(on, { ...goKidTakingOver, 'go other --session session-1 --take-over --json': started('other') }, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'other --take-over' })

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
})

for (const answer of ['Pick another task, Take over', 'Take over, Stop', 'Take over now', 'Not Take over']) {
  test(`the answer "${answer}" is no "Take over" pick`, async ($, on) => {
    const w = world(on, goKidTakingOver, { cwd: CWD })
    w.answerQuestion({ answers: { [HELD_QUESTION]: answer } })

    await $.prompt.submit({ text: 'go kid' })
    await $.tool.call(askHeld)
    const ran = await $.tool.call(takeOverKid)

    expect(ran.deny).toBe(TAKE_OVER_UNPICKED)
    expect(goCalls(w)).toEqual([])
  })
}

test('"Take over" in a box with more than one question is no pick, as it may answer another question', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Stop', 'Which branch should the PR target?': 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  const ran = await $.tool.call(takeOverKid)

  expect(ran.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
})

test('a take-over forgets the held task, so a later "Take over" pick approves nothing', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  await $.tool.call(takeOverKid)
  await $.turn.complete({ ...turnEnd, reason: 'aborted', isAborted: true })
  await $.tool.call(askHeld)
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w).length).toBe(1)
})

test('a go <slug> prompt that claims its task forgets an earlier held task, so a later "Take over" pick approves nothing', async ($, on) => {
  const w = world(on, { ...goKidTakingOver, [claim('epic')]: claimed('epic') }, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.prompt.submit({ text: 'go epic' })
  await $.tool.call(askHeld)
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
})

test('a "Take over" pick lets the model take over once', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  await $.tool.call(takeOverKid)
  const second = await $.tool.call(takeOverKid)

  expect(second.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w).length).toBe(1)
})

test('"Stop" lets the model take over nothing, and takes back an earlier "Take over"', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })

  await $.prompt.submit({ text: 'go kid' })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })
  await $.tool.call(askHeld)
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Stop' } })
  await $.tool.call(askHeld)
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
})

test('a "Take over" the model wrote into the question box call approves no take-over, and takes back an earlier pick', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  await $.tool.call({ ...askHeld, answers: { [HELD_QUESTION]: 'Take over' } })
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
  expect(goCalls(w)).toEqual([])
})

test('a "Take over" pick in a subagent question box approves nothing, and takes back an earlier pick', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  await $.tool.call({ ...askHeld, agentId: 'a1' })
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
})

test('a "Take over" pick answers the question of its own turn only', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  await $.turn.complete({ ...turnEnd, reason: 'aborted', isAborted: true })
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
})

test('a "Take over" pick ends with the turn even when the clear-point pick cannot be reset', async ($, on) => {
  const w = world(on, goKidTakingOver, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Take over' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  w.breakCall('approval')
  await $.turn.complete({ ...turnEnd, reason: 'aborted', isAborted: true })
  const answer = await $.tool.call(takeOverKid)

  expect(answer.deny).toBe(TAKE_OVER_UNPICKED)
})

test('a take-over reset that fails at the turn end still resets the clear-point pick, and the armed clear still runs', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')) }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: `${CLEAR_POINT_OPTION} (Recommended)` } })

  await $.tool.call(askClearPoint)
  await $.command.run({ command: 'ledger:close', args: '' })
  w.breakCall('takeOver', 1)
  await $.turn.complete(turnEnd)
  const next = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(w.events).toEqual(['clear'])
  expect(next.deny).toBe(typedOnlyMessage('ledger:next', ''))
})

test('/ledger:go through the Skill tool without --take-over needs no pick', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })

  expect(answer.deny).toBeUndefined()
  expect(w.skills.length).toBe(1)
})

test('a finished turn marks every claim of this session active, at most once per 15 minutes', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune, [TOUCH_ALL]: touchedSome }, { cwd: CWD })

  await $.turn.complete(turnEnd)
  await clock.advance(14 * MINUTE)
  await $.turn.complete(turnEnd)
  expect(touches(w)).toEqual([touchAllArgv()])

  await clock.advance(MINUTE)
  await $.turn.complete(turnEnd)
  expect(touches(w)).toEqual([touchAllArgv(), touchAllArgv()])
})

test('a touch that exits nonzero is tried again at the next turn end, and says nothing', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune, [TOUCH_ALL]: ran(1, '', 'broken') }, { cwd: CWD })

  await $.turn.complete(turnEnd)
  await clock.advance(MINUTE)
  await $.turn.complete(turnEnd)

  expect(touches(w)).toEqual([touchAllArgv(), touchAllArgv()])
  expect(w.events).toEqual(['rename: epic'])
})

test('a touch that bin/ledger could not run is tried again at the next turn end', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune }, { cwd: CWD })

  await $.turn.complete(turnEnd)
  await clock.advance(MINUTE)
  await $.turn.complete(turnEnd)

  expect(touches(w)).toEqual([touchAllArgv(), touchAllArgv()])
})

test('a new session marks its own claims active at its first turn end', async ($, on) => {
  mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune, [TOUCH_ALL]: touchedSome, 'task touch --all --session session-2': touchedSome }, { cwd: CWD })

  await $.turn.complete(turnEnd)
  w.newSession('session-2')
  await $.turn.complete(turnEnd)

  expect(touches(w)).toEqual([touchAllArgv(), touchAllArgv('session-2')])
})

test('a session in the main checkout marks its claims active too: it may have claimed a task from there', async ($, on) => {
  mock.clock(on)
  const w = world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic')]), [TOUCH_ALL]: touchedSome }, { cwd: MAIN })

  await $.turn.complete(turnEnd)

  expect(touches(w)).toEqual([touchAllArgv()])
})

test('a subagent turn end marks no claim active', async ($, on) => {
  mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')) }, { cwd: CWD })

  await $.turn.complete({ ...turnEnd, agentId: 'agent-0' })

  expect(w.calls).toEqual([])
})

test('the touch runs before an armed clear, which then releases every claim of the session and clears', async ($, on) => {
  mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')), [TOUCH_ALL]: touchedSome }, { cwd: CWD })

  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.argvs()).toEqual([['session', CWD, '--json'], touchAllArgv(), ['store', 'mirror', '--quiet'], releaseAllArgv()])
  expect(w.events).toEqual(['clear'])
})

test('a session in task epic that finds kid held and stops touches and releases only through the session-wide calls', async ($, on) => {
  mock.clock(on)
  const w = world(on, { [SESSION]: session(CWD, task('epic')), ...autoPrune, [claim('kid')]: held, [TOUCH_ALL]: touchedSome }, { cwd: CWD })
  w.answerQuestion({ answers: { [HELD_QUESTION]: 'Stop' } })

  await $.prompt.submit({ text: 'go kid' })
  await $.tool.call(askHeld)
  await $.turn.complete(turnEnd)
  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.argvs().filter(argv => argv[0] === 'task' && argv[1] !== 'claim')).toEqual([touchAllArgv(), releaseAllArgv()])
  expect(w.events.at(-1)).toBe('clear')
})

test('a take-over the model ran through Bash is released at the end of the session with no state the plugin kept', async ($, on) => {
  const w = world(on, {}, { cwd: MAIN })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

  expect(w.argvs()).toEqual([releaseAllArgv()])
})

test('an armed /ledger:close releases every claim of the session before it clears', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['store', 'mirror', '--quiet'], releaseAllArgv()])
  expect(w.callsBeforeClear).toEqual([3])
  expect(w.events).toEqual(['clear'])
})

for (const [from, cwd, sessionReply] of [
  ['its task', CWD, session(CWD, task('epic'))],
  ['the main checkout', MAIN, session(MAIN, undefined, [task('epic')])],
] as const) {
  test(`an armed /ledger:go from ${from} releases every claim of the session before it clears`, async ($, on) => {
    const w = world(on, { [`session ${cwd} --json`]: sessionReply, 'go kid --session session-1 --json': started('kid'), ...autoPrune }, { cwd })

    await $.command.run({ command: 'ledger:go', args: 'kid' })
    await $.turn.complete(turnEnd)

    expect(w.argvs().slice(0, w.callsBeforeClear[0]).at(-1)).toEqual(releaseAllArgv())
    expect(w.argvs().filter(argv => argv[1] === 'release')).toEqual([releaseAllArgv()])
  })
}

const handOver = (slug: string) => `task claim ${slug} --session session-2 --from session-1 --json`

test('after an armed /ledger:go clears with its release failed, the new session takes the live claim over from the old one with no held question, once', async ($, on) => {
  const heldByOld = ran(3, JSON.stringify({ ok: false, error: 'held: session session-1', held: { ...OTHER, session: 'session-1' } }))
  const plainClaim = 'task claim kid --session session-2 --json'
  const w = world(
    on,
    { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': started('kid'), ...autoPrune, [RELEASE_ALL]: ran(1, '', 'release broke'), [handOver('kid')]: claimed('kid'), [plainClaim]: heldByOld },
    { cwd: CWD },
  )
  w.clearsTo('session-2')

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['clear', 'submit: go kid'])
  expect(w.reminders).toEqual([])

  w.reply(plainClaim, claimed('kid'))
  await $.prompt.submit({ text: 'go kid' })
  expect(w.argvs().filter(argv => argv[1] === 'claim')).toEqual([
    ['task', 'claim', 'kid', '--session', 'session-2', '--from', 'session-1', '--json'],
    ['task', 'claim', 'kid', '--session', 'session-2', '--json'],
  ])
})

test('a go <slug> prompt for another task than the armed one claims without --from, and ends the hand-over', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), 'go kid --session session-1 --json': started('kid'), ...autoPrune }, { cwd: CWD })
  w.breakCall('clear', 1)

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)
  w.newSession('session-2')
  w.reply('task claim other --session session-2 --json', claimed('other'))
  w.reply('task claim kid --session session-2 --json', claimed('kid'))
  await $.prompt.submit({ text: 'go other' })
  await $.prompt.submit({ text: 'go kid' })

  expect(w.argvs().filter(argv => argv[1] === 'claim')).toEqual([
    ['task', 'claim', 'other', '--session', 'session-2', '--json'],
    ['task', 'claim', 'kid', '--session', 'session-2', '--json'],
  ])
})

test('an armed /ledger:park releases every claim of the session after the park and before the clear', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: session(CWD, task('epic')), 'list --json': done({ tasks: [task('epic')] }), 'task park epic --reason waiting --json': done({ parked: { date: '2026-11-20', reason: 'waiting' } }) },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:park', args: 'waiting' })
  await $.turn.complete(turnEnd)

  expect(w.argvs().slice(-3)).toEqual([['task', 'park', 'epic', '--reason', 'waiting', '--json'], ['store', 'mirror', '--quiet'], releaseAllArgv()])
  expect(w.callsBeforeClear).toEqual([w.calls.length])
})

test('a failed release says nothing and still clears', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')), [RELEASE_ALL]: ran(1, '', 'broken') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['clear'])
})

test('the end of a session releases every claim of that session, by the id the event gives', async ($, on) => {
  const w = world(on, { [SESSION]: session(CWD, task('epic')) }, { cwd: CWD })
  w.newSession('session-3')

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

  expect(w.argvs()).toEqual([releaseAllArgv()])
  expect(w.events).toEqual([])
})
