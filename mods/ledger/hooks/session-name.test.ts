import { expect, test } from 'claude-code/testing'

import { done, ledgerOf, MAIN, session, task, turnEnd, world, worktreeOf } from './fake-ledger.test-helper'

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
