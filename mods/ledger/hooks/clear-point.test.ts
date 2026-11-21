import { expect, test } from 'claude-code/testing'

import { done, ledgerOf, MAIN, session, task, turnEnd, world, worktreeOf } from './fake-ledger.test-helper'
import { CLEAR_POINT_OPTION, clearPointReminder } from './ledger'

const CWD = worktreeOf('epic')
const EPIC = ledgerOf('epic')
const OWN_EPIC = {
  [`session ${CWD} --json`]: session(CWD, task('epic')),
  [`worktrees auto-prune ${CWD} --json`]: done({ ledger: EPIC, worktree: CWD, marker: '', finished: false, outcome: 'unchanged' }),
}
const EVERY_100 = { options: { clearPointTokens: 100 } }

test('the reminder asks for the clear-point question, its first option recommended', () => {
  const reminder = clearPointReminder(150_000)

  expect(reminder).toContain('150,000 tokens')
  expect(reminder).toContain(`"${CLEAR_POINT_OPTION} (Recommended)", "Not now" and "Close"`)
})

test('by default, the next prompt after a turn that reaches 150,000 tokens carries the reminder once', async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(149_999)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })
  w.useContext(150_000)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'two' })
  await $.prompt.submit({ text: 'three' })

  expect(w.reminders).toEqual([clearPointReminder(150_000)])
})

test('a turn end that finds the task finished marks no offer: after the last verdict there is no clear point', EVERY_100, async ($, on) => {
  const finished = { [`worktrees auto-prune ${CWD} --json`]: done({ ledger: EPIC, worktree: CWD, marker: '', finished: true, outcome: 'unchanged' }) }
  const w = world(on, { ...OWN_EPIC, ...finished }, { cwd: CWD })

  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })

  expect(w.reminders).toEqual([])
})

test('the clearPointTokens option sets the size of the first offer', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(99)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })
  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'two' })

  expect(w.reminders).toEqual([clearPointReminder(120)])
})

test('a turn end that marked no new offer adds nothing to the prompt after it', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'two' })

  expect(w.reminders).toEqual([clearPointReminder(120)])
})

test('a slash command prompt does not carry the offer; the plain prompt after it does', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })
  // `command` is the engine's to set, so the submit args do not type it.
  const commandPrompt = { text: '/ledger:update', command: { name: 'ledger:update', args: '' } }

  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit(commandPrompt)
  const afterCommand = [...w.reminders]
  await $.prompt.submit({ text: 'one' })

  expect(afterCommand).toEqual([])
  expect(w.reminders).toEqual([clearPointReminder(120)])
})

test('the next offer waits for another clearPointTokens of growth past the last one', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  for (const tokens of [120, 219, 220]) {
    w.useContext(tokens)
    await $.turn.complete(turnEnd)
    await $.prompt.submit({ text: `at ${tokens}` })
  }

  expect(w.reminders).toEqual([clearPointReminder(120), clearPointReminder(220)])
})

test('no offer while an agent runs; the first turn end with none running marks it', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(120)
  w.listAgents('running', 'completed')
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })
  w.listAgents('completed', 'idle')
  w.useContext(130)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'two' })

  expect(w.reminders).toEqual([clearPointReminder(130)])
})

test('a subagent turn end marks no offer', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(120)
  await $.turn.complete({ ...turnEnd, agentId: 'agent-0' })
  await $.prompt.submit({ text: 'one' })

  expect(w.reminders).toEqual([])
})

test('a session with no ledger of its own gets no offer', EVERY_100, async ($, on) => {
  const w = world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic')]) }, { cwd: MAIN })

  w.useContext(120)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })

  expect(w.reminders).toEqual([])
})

test('no offer before the first response gives a context size', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(undefined)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })

  expect(w.reminders).toEqual([])
})

for (const clearPointTokens of [0, -1]) {
  test(`clearPointTokens ${clearPointTokens} turns the offer off`, { options: { clearPointTokens } }, async ($, on) => {
    const w = world(on, OWN_EPIC, { cwd: CWD })

    w.useContext(900_000)
    await $.turn.complete(turnEnd)
    await $.prompt.submit({ text: 'one' })

    expect(w.reminders).toEqual([])
  })
}

test('a new session starts again at clearPointTokens, and drops an offer the old one had not delivered', EVERY_100, async ($, on) => {
  const claimed = done({ slug: 'epic', ledger: EPIC, claim: { session: 'session-2', since: '2026-11-20T10:00:00Z', active: '2026-11-20T10:00:00Z' } })
  const w = world(on, { ...OWN_EPIC, 'task claim epic --session session-2 --json': claimed }, { cwd: CWD })

  w.useContext(150)
  await $.turn.complete(turnEnd)
  w.newSession('session-2')
  await $.prompt.submit({ text: 'go epic' })
  w.useContext(110)
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })

  expect(w.reminders).toEqual([clearPointReminder(110)])
})

test('a failed usage read leaves the turn end and the next prompt as they were', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(120)
  w.breakCall('usage')
  await $.turn.complete(turnEnd)
  await $.prompt.submit({ text: 'one' })

  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['worktrees', 'auto-prune', CWD, '--json']])
  expect(w.events).toEqual(['rename: epic', 'submit: one'])
  expect(w.reminders).toEqual([])
})

test('a failed offer write at the prompt passes the prompt on without the reminder', EVERY_100, async ($, on) => {
  const w = world(on, OWN_EPIC, { cwd: CWD })

  w.useContext(120)
  await $.turn.complete(turnEnd)
  w.breakCall('offer')
  await $.prompt.submit({ text: 'one' })

  expect(w.events).toEqual(['rename: epic', 'submit: one'])
  expect(w.reminders).toEqual([])
})
