import { expect, test } from 'claude-code/testing'

import { done, ledgerOf, MAIN, ran, refused, session, task, turnEnd, world, worktreeOf } from './fake-ledger.test-helper'

// D43: the session name is always the state icon and slug of the task the session works on, and changes at each task change and each state change.

const A = worktreeOf('alpha')
const B = worktreeOf('beta')
const sessionAt = (folder: string) => `session ${folder} --json`
const autoPrune = (slug: string) => ({ [`worktrees auto-prune ${ledgerOf(slug)} --json`]: done({ ledger: ledgerOf(slug), worktree: worktreeOf(slug), marker: '', finished: false, outcome: 'unchanged' }) })
const claimed = (slug: string, id: string) => done({ slug, ledger: ledgerOf(slug), claim: { session: id, since: '2026-11-20T10:00:00Z', active: '2026-11-20T10:00:00Z' } })
const started = (slug: string) => done({ slug, main: MAIN, ledger: ledgerOf(slug), worktree: worktreeOf(slug), branch: `me/${slug}`, promoted: false, chain: [], warnings: [] })
const renames = (events: string[]) => events.filter(event => event.startsWith('rename: '))

const ownTasks = {
  [sessionAt(A)]: session(A, task('alpha')),
  [sessionAt(B)]: session(B, task('beta')),
  ...autoPrune('alpha'),
  ...autoPrune('beta'),
}

test('D43: after /ledger:go clears and sends go <slug>, the turn that entered the new worktree names the session after it', async ($, on) => {
  const w = world(on, { ...ownTasks, 'go beta --session session-1 --json': started('beta'), 'task claim beta --session session-2 --from session-1 --json': claimed('beta', 'session-2') }, { cwd: A })
  w.clearsTo('session-2')

  await $.turn.complete(turnEnd)
  expect(renames(w.events)).toEqual(['rename: 🔨 alpha'])

  await $.command.run({ command: 'ledger:go', args: 'beta' })
  await $.turn.complete(turnEnd)
  expect(w.events.slice(-2)).toEqual(['clear', 'submit: go beta'])

  w.enterWorktree(B)
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 alpha', 'rename: 🔨 beta'])
})

test('D43: a session that enters another task\'s worktree without a clear is renamed to that task at the turn end', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A })

  await $.turn.complete(turnEnd)
  w.enterWorktree(B)
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 alpha', 'rename: 🔨 beta'])
})

test('D43: a session in the main checkout that claimed a task with go <slug> is named after it at the turn end', async ($, on) => {
  const w = world(on, { [sessionAt(MAIN)]: session(MAIN, undefined, [task('beta')]), 'task claim beta --session session-1 --json': claimed('beta', 'session-1') }, { cwd: MAIN })

  await $.prompt.submit({ text: 'go beta' })
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 beta'])
})

test('D43: a session that claimed a task, then worked in another task\'s worktree, is not renamed back to the claim in the main checkout', async ($, on) => {
  const w = world(on, { ...ownTasks, [sessionAt(MAIN)]: session(MAIN, undefined, [task('beta')]), 'task claim beta --session session-1 --json': claimed('beta', 'session-1') }, { cwd: MAIN })

  await $.prompt.submit({ text: 'go beta' })
  await $.turn.complete(turnEnd)
  w.enterWorktree(A)
  await $.turn.complete(turnEnd)
  w.enterWorktree(MAIN)
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 beta', 'rename: 🔨 alpha'])
})

test('D43: a new session in a task\'s worktree is named after it even when an earlier session last took that name', async ($, on) => {
  const w = world(on, ownTasks, { cwd: B })

  await $.turn.complete(turnEnd)
  w.newSession('session-2')
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 beta', 'rename: 🔨 beta'])
})

test('D43: a new session that claims a task with go <slug> is named after it at the turn end, though its claim leaves the prompt hook no title to give', async ($, on) => {
  const w = world(on, { [sessionAt(MAIN)]: session(MAIN, undefined, [task('beta')]), 'task claim beta --session session-1 --json': claimed('beta', 'session-1'), 'task claim beta --session session-2 --json': claimed('beta', 'session-2') }, { cwd: MAIN })

  await $.prompt.submit({ text: 'go beta' })
  await $.turn.complete(turnEnd)
  w.newSession('session-2')
  await $.prompt.submit({ text: 'go beta' })
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 beta', 'rename: 🔨 beta'])
})

test('D43: a session is renamed when its own task\'s state changes, and only then', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A })

  await $.turn.complete(turnEnd)
  w.reply(sessionAt(A), session(A, task('alpha', { title: '🔍 alpha' })))
  await $.turn.complete(turnEnd)
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🔨 alpha', 'rename: 🔍 alpha'])
})

test('D43: a session that claimed a task is named with that task\'s title, and renamed when its state changes', async ($, on) => {
  const w = world(on, { [sessionAt(MAIN)]: session(MAIN, undefined, [task('alpha'), task('beta', { title: '🟡 beta' })]), 'task claim beta --session session-1 --json': claimed('beta', 'session-1') }, { cwd: MAIN })

  await $.prompt.submit({ text: 'go beta' })
  await $.turn.complete(turnEnd)
  w.reply(sessionAt(MAIN), session(MAIN, undefined, [task('beta', { title: '⏳ beta' })]))
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: 🟡 beta', 'rename: ⏳ beta'])
})

test('D43: a session that claimed a task the session reply does not list is named with its bare slug', async ($, on) => {
  const w = world(on, { [sessionAt(MAIN)]: session(MAIN, undefined, [task('alpha')]), 'task claim beta --session session-1 --json': claimed('beta', 'session-1') }, { cwd: MAIN })

  await $.prompt.submit({ text: 'go beta' })
  await $.turn.complete(turnEnd)

  expect(renames(w.events)).toEqual(['rename: beta'])
})

const t3Renames = (events: string[]) => events.filter(event => event.startsWith('t3: '))

test('D43: in T3 Code the turn that names the session also renames its thread, once per task', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A, t3: 'renames' })

  await $.turn.complete(turnEnd)
  await $.turn.complete(turnEnd)
  w.enterWorktree(B)
  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['rename: 🔍 alpha', 't3: 🔍 alpha', 'rename: 🔨 beta', 't3: 🔨 beta'])
})

test('D43: outside T3 Code the session is named as before, and nothing is logged', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A })

  await $.turn.complete(turnEnd)
  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['rename: 🔍 alpha'])
})

test('D43: a T3 thread rename that fails is not tried again, nor is /rename', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A, t3: 'fails' })

  await $.turn.complete(turnEnd)
  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['rename: 🔍 alpha', 't3: 🔍 alpha'])
})

const inMain = { [sessionAt(MAIN)]: session(MAIN, undefined, [task('beta')]) }
const claimBeta = 'task claim beta --session session-1 --json'
const heldBeta = ran(3, JSON.stringify({ ok: false, error: 'held: session session-2', held: { session: 'session-2', since: '2026-11-20T08:00:00Z', active: '2026-11-20T09:30:00Z' } }))

test('D43: in T3 Code a go <slug> prompt that claims a task renames the thread at once, and the turn end only runs /rename', async ($, on) => {
  const w = world(on, { ...inMain, [claimBeta]: claimed('beta', 'session-1') }, { cwd: MAIN, t3: 'renames' })

  await $.prompt.submit({ text: 'go beta' })
  expect(w.events).toEqual(['t3: 🔨 beta', 'submit: go beta'])

  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['t3: 🔨 beta', 'submit: go beta', 'rename: 🔨 beta'])
})

test('D43: in T3 Code a go <slug> prompt names the thread with the bare slug when the session cannot be read', async ($, on) => {
  const w = world(on, { [claimBeta]: claimed('beta', 'session-1') }, { cwd: MAIN, t3: 'renames' })

  await $.prompt.submit({ text: 'go beta' })

  expect(w.events).toEqual(['t3: beta', 'submit: go beta'])
})

for (const [name, reply] of [['held', heldBeta], ['failed', refused('no task beta')]] as const) {
  test(`D43: in T3 Code a go <slug> prompt whose claim ${name} leaves the thread to the turn end`, async ($, on) => {
    const w = world(on, { ...inMain, [claimBeta]: reply }, { cwd: MAIN, t3: 'renames' })

    await $.prompt.submit({ text: 'go beta' })

    expect(t3Renames(w.events)).toEqual([])
  })
}

test('D43: in T3 Code the main agent\'s EnterWorktree renames the thread at the tool call, and the turn end only runs /rename', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A, t3: 'renames' })

  await $.tool.call({ tool: 'EnterWorktree', path: B })
  expect(w.events).toEqual(['t3: 🔨 beta'])

  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['t3: 🔨 beta', 'rename: 🔨 beta'])
})

for (const [name, answer] of [['errors', { isError: true }], ['is denied', { deny: 'no worktree' }]] as const) {
  test(`D43: in T3 Code an EnterWorktree that ${name} leaves the thread as it was`, async ($, on) => {
    const w = world(on, ownTasks, { cwd: A, t3: 'renames' })
    w.answerEnterWorktree(answer)

    await $.tool.call({ tool: 'EnterWorktree', path: B })

    expect(w.events).toEqual([])
  })
}

test('D43: in T3 Code an agent\'s EnterWorktree leaves the thread as it was', async ($, on) => {
  const w = world(on, ownTasks, { cwd: A, t3: 'renames' })

  await $.tool.call({ tool: 'EnterWorktree', path: B, agentId: 'a1' })

  expect(w.events).toEqual([])
})

test('D43: outside T3 Code an EnterWorktree and a go <slug> prompt rename nothing until the turn end', async ($, on) => {
  const w = world(on, { ...ownTasks, ...inMain, [claimBeta]: claimed('beta', 'session-1') }, { cwd: MAIN })

  await $.prompt.submit({ text: 'go beta' })
  await $.tool.call({ tool: 'EnterWorktree', path: B })
  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['submit: go beta', 'rename: 🔨 beta'])
})

test('D43: in T3 Code a go <slug> prompt in another task\'s worktree takes the claimed task\'s title from the main checkout', async ($, on) => {
  const w = world(on, { [sessionAt(A)]: session(A, task('alpha')), ...inMain, [claimBeta]: claimed('beta', 'session-1') }, { cwd: A, t3: 'renames' })

  await $.prompt.submit({ text: 'go beta' })

  expect(w.events).toEqual(['t3: 🔨 beta', 'submit: go beta'])
})

test('D43: in T3 Code a go <slug> prompt in another task\'s worktree names the thread with the bare slug when the main checkout does not list it', async ($, on) => {
  const w = world(on, { [sessionAt(A)]: session(A, task('alpha')), [sessionAt(MAIN)]: session(MAIN, undefined, [task('alpha')]), [claimBeta]: claimed('beta', 'session-1') }, { cwd: A, t3: 'renames' })

  await $.prompt.submit({ text: 'go beta' })

  expect(w.events).toEqual(['t3: beta', 'submit: go beta'])
})
