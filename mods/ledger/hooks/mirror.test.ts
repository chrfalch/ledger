import { expect, test } from 'claude-code/testing'

import { done, ledgerOf, ran, session, task, turnEnd, world, worktreeOf, type Reply } from './fake-ledger.test-helper'

const CWD = worktreeOf('epic')
const EPIC = ledgerOf('epic')

/** The replies of a session in the worktree of epic; without `mirror`, ledger store mirror cannot run. */
const replies = (mirror?: Reply): Record<string, Reply> => ({
  [`session ${CWD} --json`]: session(CWD, task('epic')),
  [`worktrees auto-prune ${EPIC} --json`]: done({ ledger: EPIC, worktree: CWD, marker: '', finished: false, outcome: 'unchanged' }),
  ...(mirror === undefined ? {} : { 'store mirror --quiet': mirror }),
})

const storeCalls = (argvs: string[][]): string[][] => argvs.filter(([group]) => group === 'store')

test('each answered turn copies the worktree ledgers of this machine to git storage with ledger store mirror --quiet', async ($, on) => {
  const w = world(on, replies(ran(0, '')), { cwd: CWD })

  await $.turn.complete(turnEnd)
  await $.turn.complete({ ...turnEnd, turnId: 't2' })

  expect(storeCalls(w.argvs())).toEqual([
    ['store', 'mirror', '--quiet'],
    ['store', 'mirror', '--quiet'],
  ])
})

for (const [why, mirror] of [
  ['exits 1', ran(1, '', 'the remote is unreachable')],
  ['cannot run', undefined],
] as const) {
  test(`a turn whose ledger store mirror ${why} still ends quietly`, async ($, on) => {
    const w = world(on, replies(mirror), { cwd: CWD })

    await $.turn.complete(turnEnd)

    expect(storeCalls(w.argvs())).toEqual([['store', 'mirror', '--quiet']])
    expect(w.events).toEqual(['rename: epic'])
  })
}
