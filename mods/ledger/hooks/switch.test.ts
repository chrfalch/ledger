import { expect, test } from 'claude-code/testing'

import { done, ledgerOf, MAIN, refused, removedSession, session, task, turnEnd, world, worktreeOf } from './fake-ledger.test-helper'
import { GO_FROM_SUBAGENT, NEXT_FROM_SUBAGENT, nextAfterSwitchMessage, noLedgerMessage, oneSwitchPerTurnMessage, removedFolderMessage, typedOnlyMessage } from './ledger'

const CWD = worktreeOf('epic')
const SESSION = `session ${CWD} --json`
const EPIC = ledgerOf('epic')
const UNCHANGED = 'Nothing was written, and the session was not cleared.'

const autoPrune = (worktree: string) => `worktrees auto-prune ${worktree} --json`
const unchanged = (worktree: string, finished = false) => done({ ledger: EPIC, worktree, marker: '', finished, outcome: 'unchanged' })

/** `ledger go --json` of a task that already has a worktree, unless `fields` say otherwise. */
const started = (slug: string, fields: object = {}) =>
  done({ slug, main: MAIN, ledger: ledgerOf(slug), worktree: worktreeOf(slug), branch: `me/${slug}`, promoted: false, chain: [], warnings: [], ...fields })

const ownEpic = (extra: Parameters<typeof task>[1] = {}) => session(CWD, task('epic', extra))

// close and next

test('/ledger:close passes the task to close.md, and the turn end clears without a go', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })

  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()).toEqual({ command: 'ledger:close', args: 'ledger: epic' })
  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['task', 'release', '--all', '--session', 'session-1']])
  expect(w.events).toEqual(['clear'])
})

test('/ledger:close names a task whose repo is not the session repo as <slug>@<main>, as ledger notes --task takes it', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic({ main: '/lib' }) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:close', args: '' })

  expect(w.markdown()).toEqual({ command: 'ledger:close', args: 'ledger: epic@/lib' })
})

test('/ledger:close in a removed session folder tells close.md there is no ledger, and still clears', async ($, on) => {
  const gone = worktreeOf('gone')
  const w = world(on, { [`session ${gone} --json`]: removedSession(gone) }, { cwd: gone, missing: [gone] })

  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()).toEqual({ command: 'ledger:close', args: 'ledger: none' })
  expect(w.calls[0]?.cwd).toBe(`${MAIN}/.claude/worktrees`)
  expect(w.events).toEqual(['clear'])
})

test('/ledger:next in a removed session folder says so and arms nothing', async ($, on) => {
  const gone = worktreeOf('gone')
  const w = world(on, { [`session ${gone} --json`]: removedSession(gone) }, { cwd: gone, missing: [gone] })

  const { text } = await $.command.run({ command: 'ledger:next', args: '' })

  expect(text).toBe(removedFolderMessage(gone))
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
})

for (const command of ['ledger:close', 'ledger:next']) {
  test(`/${command} in a folder with no ledger of its own says so and arms nothing`, async ($, on) => {
    const w = world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic')]) }, { cwd: MAIN })

    const { text } = await $.command.run({ command, args: '' })

    expect(text).toBe(noLedgerMessage(MAIN))
    expect(w.armed).toEqual([])
    expect(w.markdown()).toBeUndefined()
  })
}

test('/ledger:next clears at the turn end, then continues the same task with go <slug>', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()?.command).toBe('ledger:next')
  expect(w.events).toEqual(['clear', 'submit: go epic'])
  expect(w.argvs()).toEqual([
    ['session', CWD, '--json'],
    ['task', 'release', '--all', '--session', 'session-1'],
    ['worktrees', 'auto-prune', CWD, '--json'],
    ['task', 'claim', 'epic', '--session', 'session-1', '--json'],
  ])
})

test('/ledger:next of a finished child task shows the prune, how to retire it, and the next child of its parent', async ($, on) => {
  const parent = { slug: 'umbrella', main: MAIN }
  const w = world(
    on,
    {
      [SESSION]: ownEpic({ parent }),
      [autoPrune(CWD)]: done({ ledger: EPIC, worktree: CWD, marker: '', finished: true, outcome: 'pruned', message: 'Pruned the build folders of epic, because its task is finished: 1.2 GB freed in 1 folder.' }),
      [`tree next umbrella@${MAIN} --json`]: done({ action: 'next', parent, chain: [parent, { slug: 'part', main: MAIN }] }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  const [clear, pruned, retire, child, submit] = w.events
  expect([clear, pruned, submit]).toEqual(['clear', 'log: Pruned the build folders of epic, because its task is finished: 1.2 GB freed in 1 folder.', 'submit: go epic'])
  expect(retire).toContain('Task epic is finished')
  expect(retire).toContain('/ledger:retire epic')
  expect(child).toContain('part')
  expect(child).toContain('/ledger:go umbrella')
  expect(w.events.length).toBe(5)
})

test('a turn that ends without an answer clears nothing, and the arm is gone after it', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete({ ...turnEnd, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...turnEnd, turnId: 't2' })

  expect(w.events).not.toContain('clear')
})

test('a subagent turn end neither clears nor runs bin/ledger', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })

  await $.command.run({ command: 'ledger:close', args: '' })
  const before = w.calls.length
  await $.turn.complete({ ...turnEnd, agentId: 'a1' })

  expect(w.events).toEqual([])
  expect(w.calls.length).toBe(before)
})

// go

test('/ledger:go <slug> reads the session ledger, starts the task with one ledger go call, then clears and sends go <slug>', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['go', 'kid', '--session', 'session-1', '--json']])
  expect(w.calls[1]?.cwd).toBe(CWD)
  expect(w.markdown()).toEqual({ command: 'ledger:go', args: 'task: kid\nledger: epic' })
  expect(w.armed.length).toBe(1)
  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['clear', 'submit: go kid'])
})

test('/ledger:go gives ledger go the longest timeout, as its package install can take minutes', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(EPIC)]: unchanged(EPIC) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(w.calls[1]?.timeoutMs).toBe(600_000)
})

test('a ledger go whose package install failed (exit 5) says the worktree and ledger are kept and how to retry, and does not clear', async ($, on) => {
  const failed = refused('Could not install the packages of /repo/.claude/worktrees/kid: `npm ci` failed, as it exited 1.', 5)
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': failed }, { cwd: CWD })

  const { text = '' } = await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(text).toContain('packages did not install')
  expect(text).toContain('worktree and ledger are kept')
  expect(text).toContain('/ledger:go kid')
  expect(text).toContain('`npm ci` failed, as it exited 1.')
  expect(text).not.toContain(UNCHANGED)
  expect(w.markdown()).toBeUndefined()
  expect(w.armed).toEqual([])
  expect(w.events.filter(event => event === 'clear')).toEqual([])
})

test('/ledger:go of the own task of the session arms no previous task: the same slug and repo is the same task', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go epic --session session-1 --json': started('epic', { ledger: 'the store copy of epic' }) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(w.armed).toEqual([{ mode: 'go', slug: 'epic', sessionId: 'session-1' }])
  expect(w.markdown()?.args).toBe('task: epic\nledger: epic')
})

test('/ledger:go <parent> passes on the child it picked, the promotion, the unpark, the mark and each warning', async ($, on) => {
  const w = world(
    on,
    {
      [`session ${MAIN} --json`]: session(MAIN, undefined, [task('busy')]),
      'go epic --session session-1 --json': started('kid', {
        promoted: true,
        base: 'origin/main @ abc1234',
        chain: [{ slug: 'epic', main: MAIN }, { slug: 'kid', main: MAIN }],
        unparked: { date: '2026-11-10', reason: 'not yet' },
        marked: { parent: { slug: 'epic', main: MAIN }, ledger: '/home/.claude/ledger-backlog/repo/epic.md' },
        warnings: ['kid is not marked started in umbrella: gone'],
      }),
    },
    { cwd: MAIN },
  )

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(w.markdown()?.args).toBe(
    [
      'task: kid',
      'ledger: none',
      'parked: 2026-11-10 — not yet',
      `promoted: ${worktreeOf('kid')}`,
      'picked: epic > kid',
      'marked: /home/.claude/ledger-backlog/repo/epic.md',
      'warning: kid is not marked started in umbrella: gone',
    ].join('\n'),
  )
  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['clear', 'submit: go kid'])
})

test('/ledger:go <parent> whose child is in another repo says where it was started, and stays in this session', async ($, on) => {
  const lib = '/lib'
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'go umbrella --session session-1 --json': started('lib-part', {
        main: lib,
        ledger: ledgerOf('lib-part', lib),
        worktree: worktreeOf('lib-part', lib),
        promoted: true,
        chain: [{ slug: 'umbrella', main: MAIN }, { slug: 'lib-part', main: lib }],
        marked: { parent: { slug: 'umbrella', main: MAIN }, ledger: ledgerOf('umbrella') },
      }),
    },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:go', args: 'umbrella' })

  expect(text).toContain('lib-part')
  expect(text).toContain(worktreeOf('lib-part', lib))
  expect(text).toContain(`Marked lib-part started in ${ledgerOf('umbrella')}.`)
  expect(text).toContain('The session was not cleared')
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
})

test('/ledger:go <new slug> asks go.md to make the task, and clears once a ledger has that slug', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'go new-api --session session-1 --json': refused('No backlog task new-api for the repo at /repo.', 2),
      'list --json': done({ tasks: [task('new-api', { status: 'active' })] }),
      [autoPrune(CWD)]: unchanged(CWD),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  expect(w.markdown()?.args).toBe('task: new-api\nledger: epic\nnew: yes')
  await $.turn.complete(turnEnd)

  expect(w.argvs().slice(0, w.callsBeforeClear[0]).slice(-2)).toEqual([['list', '--json'], ['task', 'release', '--all', '--session', 'session-1']])
  expect(w.events).toEqual(['clear', 'submit: go new-api'])
})

test('/ledger:go <new slug> does not clear when go.md made no task', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic(), 'go new-api --session session-1 --json': refused('No backlog task new-api for the repo at /repo.', 2), 'list --json': done({ tasks: [task('epic')] }) },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)

  expect(w.events.length).toBe(1)
  expect(w.events[0]).toContain('did not create task new-api')
})

test('/ledger:go answers a refusal of ledger go with its error, and arms nothing', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go epic-two --session session-1 --json': refused('The branch epic-two already exists in /repo.') }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'epic-two' })

  expect(text).toContain('The branch epic-two already exists in /repo.')
  expect(text).toContain(UNCHANGED)
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
})

test('/ledger:go of a missing task whose name cannot be a new slug is refused, not created', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go Fix_Login --session session-1 --json': refused('No backlog task Fix_Login for the repo at /repo.', 2) }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'Fix_Login' })

  expect(text).toContain('No backlog task Fix_Login')
  expect(w.armed).toEqual([])
})

test('/ledger:go with no slug or with a description answers usage and runs nothing', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const empty = await $.command.run({ command: 'ledger:go', args: ' ' })
  const description = await $.command.run({ command: 'ledger:go', args: 'fix the login page' })

  expect(empty.text).toContain('Usage: /ledger:go <slug>')
  expect(description.text).toContain('/ledger:task fix the login page.')
  expect(w.calls).toEqual([])
})

test('a turn switches once: /ledger:go after /ledger:next is refused before ledger go runs', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:next', args: '' })
  const { text } = await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(text).toBe(oneSwitchPerTurnMessage({ mode: 'next', slug: 'epic' }, 'kid'))
  expect(w.argvs()).toEqual([['session', CWD, '--json']])
  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['clear', 'submit: go epic'])
})

test('a second /ledger:go in the same turn is refused', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  const { text } = await $.command.run({ command: 'ledger:go', args: 'other' })

  expect(text).toBe(oneSwitchPerTurnMessage({ mode: 'go', slug: 'kid' }, 'other'))
  expect(w.argvs().filter(([command]) => command === 'go')).toEqual([['go', 'kid', '--session', 'session-1', '--json']])
})

// go through the Skill tool

test('/ledger:go through the Skill tool starts the task and hands go.md the same lines', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })

  expect(answer.deny).toBeUndefined()
  expect(w.skills).toEqual([{ skill: 'ledger:go', args: 'task: kid\nledger: epic' }])
  await $.turn.complete(turnEnd)
  expect(w.events).toEqual(['clear', 'submit: go kid'])
})

test('/ledger:go through the Skill tool from a subagent is refused before anything runs', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid', agentId: 'a1' })

  expect(answer.deny).toBe(GO_FROM_SUBAGENT)
  expect(w.calls).toEqual([])
  expect(w.armed).toEqual([])
})

test('/ledger:go through the Skill tool with the task: and ledger: lines as its argument is refused', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'task: kid\nledger: epic' })

  expect(answer.deny).toContain('takes a task slug, such as kid')
  expect(w.calls).toEqual([])
})

test('a No at the permission prompt disarms /ledger:go and says what was already done', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid', { promoted: true, base: 'origin/main @ abc1234' }), [autoPrune(CWD)]: unchanged(CWD) },
    { cwd: CWD },
  )
  w.answerSkill({ isError: true, text: 'The user said no.' })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(answer.text).toContain(`Promoted backlog task kid: its branch, worktree and ledger are at ${worktreeOf('kid')}.`)
  expect(w.events).not.toContain('clear')
})

// next through the Skill tool, after the operator's pick in the clear-point question box

const CLEAR_POINT = 'Clear point. Ledger updated. Clear the session and continue?'
const clearPointQuestions = [
  {
    question: CLEAR_POINT,
    header: 'Clear point',
    options: [
      { label: 'Save, clear and continue (Recommended)', description: 'Writes the ledger, clears the session and continues the task.' },
      { label: 'Not yet', description: 'Stops here and waits.' },
    ],
    multiSelect: false,
  },
]
const askClearPoint = { tool: 'AskUserQuestion', questions: clearPointQuestions } as const
const NEXT_ARM = { mode: 'next', slug: 'epic', previous: { slug: 'epic', worktree: CWD, main: MAIN } }

for (const pick of ['Save, clear and continue (Recommended)', 'Save, clear and continue', 'Retire this task, Save, clear and continue']) {
  test(`/ledger:next through the Skill tool runs after the operator picks "${pick}", and the turn end clears and sends go <slug>`, async ($, on) => {
    const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
    w.answerQuestion({ answers: { [CLEAR_POINT]: pick } })

    await $.tool.call(askClearPoint)
    const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
    await $.turn.complete(turnEnd)

    expect(answer.deny).toBeUndefined()
    expect(w.skills.map(({ skill }) => skill)).toEqual(['ledger:next'])
    expect(w.armed).toEqual([NEXT_ARM])
    expect(w.events).toEqual(['clear', 'submit: go epic'])
  })
}

test('the pick approves one /ledger:next: a second Skill call is refused', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  const second = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(second.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.skills.length).toBe(1)
})

test('"Not yet" approves no /ledger:next, and takes back an earlier pick', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })

  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Not yet' } })
  await $.tool.call(askClearPoint)
  const unpicked = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })
  await $.tool.call(askClearPoint)
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Not yet' } })
  await $.tool.call(askClearPoint)
  const takenBack = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(unpicked.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(takenBack.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.calls).toEqual([])
  expect(w.armed).toEqual([])
})

test('a question box that answered itself while the operator was away approves no /ledger:next', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' }, afkTimeoutMs: 60_000 })

  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.armed).toEqual([])
})

test('a pick in a subagent question box approves no /ledger:next of the main session', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call({ ...askClearPoint, agentId: 'a1' })
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.armed).toEqual([])
})

test('answers the model wrote into the question box call approve no /ledger:next', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue' } })

  await $.tool.call({ ...askClearPoint, answers: { [CLEAR_POINT]: 'Save, clear and continue' } })
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.armed).toEqual([])
})

test('answers the model wrote into the question box call take back an earlier pick', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  await $.tool.call({ ...askClearPoint, answers: { [CLEAR_POINT]: 'Save, clear and continue' } })
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.armed).toEqual([])
})

for (const [failure, times] of [
  ['once', 1],
  ['every time', Number.POSITIVE_INFINITY],
] as const) {
  test(`a write of the pick that fails ${failure} still hands back the answer, asks once, and leaves no earlier pick`, async ($, on) => {
    const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
    w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })
    await $.tool.call(askClearPoint)

    w.answerQuestion({ answers: { [CLEAR_POINT]: 'Not yet' } })
    w.breakCall('approval', times)
    const notYet = await $.tool.call(askClearPoint)
    const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

    expect(notYet).toMatchObject({ result: { answers: { [CLEAR_POINT]: 'Not yet' } } })
    expect(w.asked.length).toBe(2)
    expect(answer.deny).toBeDefined()
    expect(w.skills).toEqual([])
    expect(w.armed).toEqual([])
  })
}

test('/ledger:next through the Skill tool from a subagent is refused even after the pick', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next', agentId: 'a1' })

  expect(answer.deny).toBe(NEXT_FROM_SUBAGENT)
  expect(w.calls).toEqual([])
  expect(w.armed).toEqual([])
})

test('a subagent ledger:next leaves the pick to the main session, whose ledger:next then runs', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  const fromSubagent = await $.tool.call({ tool: 'Skill', skill: 'ledger:next', agentId: 'a1' })
  const fromMain = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(fromSubagent.deny).toBe(NEXT_FROM_SUBAGENT)
  expect(fromMain.deny).toBeUndefined()
  expect(w.armed).toEqual([NEXT_ARM])
})

test('the pick ends with the main turn: /ledger:next in the next turn is refused', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  await $.turn.complete(turnEnd)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(typedOnlyMessage('ledger:next', ''))
  expect(w.armed).toEqual([])
})

test('a subagent turn end keeps the pick: /ledger:next of the main session still runs', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  await $.turn.complete({ ...turnEnd, agentId: 'a1' })
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBeUndefined()
  expect(w.armed).toEqual([NEXT_ARM])
})

test('a /ledger:go that overlaps a /ledger:next still checking the pick is refused before ledger go runs', async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const held = new Promise<void>(resolve => (reached = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  on('state.get', async (_, e, next) => {
    if (e.key === 'clearApproved') {
      reached()
      await gate
    }
    return next(e)
  })
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  const nextCall = $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  await held
  const goAnswer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })
  release()
  const nextAnswer = await nextCall

  expect(goAnswer.deny).toBe(oneSwitchPerTurnMessage({ mode: 'next' }, 'kid'))
  expect(nextAnswer.deny).toBeUndefined()
  expect(w.argvs().filter(([command]) => command === 'go')).toEqual([])
  expect(w.armed).toEqual([NEXT_ARM])
})

test('two /ledger:next calls through the Skill tool that overlap start only the first', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  const [first, second] = await Promise.all([$.tool.call({ tool: 'Skill', skill: 'ledger:next' }), $.tool.call({ tool: 'Skill', skill: 'ledger:next' })])

  expect(first.deny).toBeUndefined()
  expect(second.deny).toBe(nextAfterSwitchMessage({ mode: 'next' }))
  expect(w.skills.length).toBe(1)
  expect(w.armed).toEqual([NEXT_ARM])
})

for (const [command, args] of [
  ['ledger:close', ''],
  ['ledger:park', 'waits for review'],
] as const) {
  test(`/${command} through the Skill tool stays refused after the pick`, async ($, on) => {
    const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })
    w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

    await $.tool.call(askClearPoint)
    const answer = await $.tool.call({ tool: 'Skill', skill: command, args })

    expect(answer.deny).toBe(typedOnlyMessage(command, args))
    expect(w.armed).toEqual([])
  })
}

test('/ledger:next through the Skill tool after /ledger:go in the same turn is refused, and the go stays armed', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  await $.turn.complete(turnEnd)

  expect(answer.deny).toBe(nextAfterSwitchMessage({ mode: 'go', slug: 'kid' }))
  expect(w.skills).toEqual([])
  expect(w.events).toEqual(['clear', 'submit: go kid'])
})

test('/ledger:next through the Skill tool in a folder with no ledger of its own says so and arms nothing', async ($, on) => {
  const w = world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic')]) }, { cwd: MAIN })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(noLedgerMessage(MAIN))
  expect(w.armed).toEqual([])
  expect(w.skills).toEqual([])
})

test('/ledger:next through the Skill tool in a removed session folder says so and arms nothing', async ($, on) => {
  const gone = worktreeOf('gone')
  const w = world(on, { [`session ${gone} --json`]: removedSession(gone) }, { cwd: gone, missing: [gone] })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })

  expect(answer.deny).toBe(removedFolderMessage(gone))
  expect(w.armed).toEqual([])
})

test('a No at the permission prompt disarms /ledger:next: the turn end does not clear', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })
  w.answerSkill({ isError: true, text: 'The user said no.' })

  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  await $.turn.complete(turnEnd)

  expect(answer.text).toBe('The user said no.')
  expect(w.events).not.toContain('clear')
})

test('a deny of the /ledger:next Skill call disarms it: the turn end does not clear', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })
  w.answerSkill({ deny: 'Blocked.' })

  await $.tool.call(askClearPoint)
  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  await $.turn.complete(turnEnd)

  expect(answer.deny).toBe('Blocked.')
  expect(w.events).not.toContain('clear')
})

// park

test('/ledger:park <reason> parks this task after the model turn, then clears without a go', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'list --json': done({ tasks: [task('epic')] }),
      'task park epic --reason waits for review --json': done({ slug: 'epic', main: MAIN, ledger: EPIC, parked: { date: '2026-11-18', reason: 'waits for review' } }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:park', args: 'waits for review' })
  expect(w.markdown()).toEqual({ command: 'ledger:park', args: 'task: epic\nledger: epic\nreason: waits for review' })
  expect(w.argvs().some(([group, command]) => group === 'task' && command === 'park')).toBe(false)
  await $.turn.complete(turnEnd)

  expect(w.argvs().slice(-2)).toEqual([
    ['task', 'park', 'epic', '--reason', 'waits for review', '--json'],
    ['task', 'release', '--all', '--session', 'session-1'],
  ])
  expect(w.events).toEqual(['clear'])
})

const ON_HOST_A = 'fix-login is active in the worktree /other/repo/.claude/worktrees/fix-login on host-a, which is not on this machine, and this machine has only a read-only copy of its ledger. Continue the task on host-a.'

test('/ledger:park <slug of a task on another machine> <reason> answers that it is read-only here, and parks nothing here', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'list --json': done({ tasks: [task('epic'), { ...task('fix-login'), main: undefined, place: 'active', elsewhere: true, host: 'host-a' }] }),
      'task park fix-login --reason waits for review --json': refused(ON_HOST_A),
    },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })
  await $.turn.complete(turnEnd)

  expect(text).toBe(`Could not park fix-login. ${ON_HOST_A}`)
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
  expect(w.events).not.toContain('clear')
})

const APP_KEY = 'github.com/me/app'
const keyedSession = done({ folder: CWD, removed: false, main: MAIN, repo: APP_KEY, own: true, title: 'epic', ledgers: [{ ...task('epic'), repo: APP_KEY }] })

test('/ledger:park <slug> <reason> finds a task on another machine by the repo key of the session, not by the folder name of its main checkout', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: keyedSession,
      'list --json': done({ tasks: [{ ...task('epic'), repo: APP_KEY }, { ...task('fix-login'), repo: APP_KEY, main: undefined, place: 'active', elsewhere: true, host: 'host-a' }] }),
      'task park fix-login --reason waits for review --json': refused(ON_HOST_A),
    },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(text).toBe(`Could not park fix-login. ${ON_HOST_A}`)
  expect(w.armed).toEqual([])
})

test('/ledger:park <slug> <reason> finds a task on another machine filed under an old repo key by the key it is an alias of', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: keyedSession,
      'list --json': done({
        tasks: [{ ...task('epic'), repo: APP_KEY }, { ...task('fix-login'), repo: 'app', currentRepo: APP_KEY, main: undefined, place: 'active', elsewhere: true, host: 'host-a' }],
      }),
      'task park fix-login --reason waits for review --json': refused(ON_HOST_A),
    },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(text).toBe(`Could not park fix-login. ${ON_HOST_A}`)
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
})

test('/ledger:park <slug> <reason> takes a task on another machine in a repo whose key is only the folder name of this main checkout as part of the reason', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: keyedSession,
      'list --json': done({ tasks: [{ ...task('epic'), repo: APP_KEY }, { ...task('fix-login'), repo: 'repo', main: undefined, place: 'active', elsewhere: true, host: 'host-a' }] }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(w.markdown()?.args).toBe('task: epic\nledger: epic\nreason: fix-login waits for review')
  expect(w.argvs().some(([group, command]) => group === 'task' && command === 'park')).toBe(false)
})

test('/ledger:park <slug> <reason> finds a task of this machine in another clone of the repo by the repo key, though its main differs', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'list --json': done({ tasks: [task('epic'), task('fix-login', { main: '/second-clone' })] }),
      'task park fix-login --reason waits for review --json': done({ slug: 'fix-login', main: '/second-clone', ledger: ledgerOf('fix-login', '/second-clone'), parked: { date: '2026-11-18', reason: 'waits for review' } }),
    },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(text).toBe('Parked fix-login. Parked: 2026-11-18 — waits for review')
  expect(w.armed).toEqual([])
})

test('/ledger:park <slug> <reason> takes a task whose main is this main checkout but whose repo key is another as part of the reason', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'list --json': done({ tasks: [task('epic'), { ...task('fix-login'), repo: 'github.com/someone/else' }] }) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(w.markdown()?.args).toBe('task: epic\nledger: epic\nreason: fix-login waits for review')
  expect(w.argvs().some(([group, command]) => group === 'task' && command === 'park')).toBe(false)
})

test('/ledger:park <own slug> <reason> parks this task, with the reason after the slug', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic() }, { cwd: CWD })

  await $.command.run({ command: 'ledger:park', args: 'epic waits for review' })

  expect(w.markdown()?.args).toBe('task: epic\nledger: epic\nreason: waits for review')
  expect(w.argvs()).toEqual([['session', CWD, '--json']])
})

test('/ledger:park <other slug> <reason> parks that task at once and arms no clear', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'list --json': done({ tasks: [task('epic'), task('fix-login', { status: 'backlog' })] }),
      'task park fix-login --reason waits for review --json': done({ slug: 'fix-login', main: MAIN, ledger: '/b/fix-login.md', parked: { date: '2026-11-18', reason: 'waits for review' } }),
    },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(text).toBe('Parked fix-login. Parked: 2026-11-18 — waits for review')
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
})

test('a park that fails at the turn end says so and does not clear', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'task park epic --reason later --json': refused('epic is retired: only its archive copy is left.') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:park', args: 'epic later' })
  await $.turn.complete(turnEnd)

  expect(w.events.length).toBe(1)
  expect(w.events[0]).toContain('could not mark epic parked')
  expect(w.events[0]).toContain('epic is retired')
})

test('/ledger:park with no reason answers its usage and runs nothing', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:park', args: '  ' })

  expect(text).toContain('Usage: /ledger:park')
  expect(w.calls).toEqual([])
})

// turn end without a switch

test('an answered turn names the session after its task once per slug, and runs auto-prune once per turn', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.turn.complete(turnEnd)
  await $.turn.complete({ ...turnEnd, turnId: 't2' })

  expect(w.events).toEqual(['rename: epic'])
  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['worktrees', 'auto-prune', CWD, '--json'], ['session', CWD, '--json'], ['worktrees', 'auto-prune', CWD, '--json']])
})

test('an answered turn shows the line auto-prune gives when it pruned a finished task', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic({ finished: true }), [autoPrune(CWD)]: done({ ledger: EPIC, worktree: CWD, marker: '', finished: true, outcome: 'pruned', message: 'Pruned the build folders of epic.' }) },
    { cwd: CWD },
  )

  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['rename: epic', 'log: Pruned the build folders of epic.'])
})

test('a turn that clears neither renames nor runs auto-prune a second time', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.events).toEqual(['clear', 'submit: go kid'])
  expect(w.argvs().filter(([, command]) => command === 'auto-prune').length).toBe(1)
})

test('an answered turn in a folder with no ledger of its own renames nothing and prunes nothing', async ($, on) => {
  const w = world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic')]) }, { cwd: MAIN })

  await $.turn.complete(turnEnd)

  expect(w.events).toEqual([])
  expect(w.argvs()).toEqual([['session', MAIN, '--json']])
})

test('no switch runs a program other than bin/ledger', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid', { promoted: true }), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.others).toEqual([])
})

// park: a slug alone

test('/ledger:park <other slug> with no reason answers its usage: it parks neither task and clears nothing', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'list --json': done({ tasks: [task('epic'), task('fix-login', { status: 'backlog' })] }) }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:park', args: 'fix-login' })
  await $.turn.complete(turnEnd)

  expect(text).toContain('Usage: /ledger:park')
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
  expect(w.argvs().some(([group, command]) => group === 'task' && command === 'park')).toBe(false)
  expect(w.events).not.toContain('clear')
})

test('/ledger:park <one word> that is no task slug parks this task with that word as the reason', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'list --json': done({ tasks: [task('epic')] }) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:park', args: 'later' })

  expect(w.markdown()?.args).toBe('task: epic\nledger: epic\nreason: later')
})

test('/ledger:park <slug of a task in another repo> <reason> parks this task, with the whole text as the reason', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'list --json': done({ tasks: [task('epic'), { ...task('fix-login', { main: '/other', status: 'backlog' }), repo: 'github.com/me/other' }] }) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:park', args: 'fix-login waits for review' })

  expect(w.markdown()?.args).toBe('task: epic\nledger: epic\nreason: fix-login waits for review')
  expect(w.argvs().some(([group, command]) => group === 'task' && command === 'park')).toBe(false)
})

// clear and submit failures

test('a /clear that fails at the turn end says so in the log, and sends no go', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })
  w.breakCall('clear')

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.events.length).toBe(1)
  expect(w.events[0]).toContain('/ledger:go could not clear the session: ')
  expect(w.events[0]).toContain('Run /clear, then say: go kid.')
})

test('a prompt submit that fails after the clear says what to type', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.breakCall('submit')

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events[0]).toBe('clear')
  expect(w.events[1]).toContain('/ledger:next cleared the session but could not send "go epic": ')
  expect(w.events.length).toBe(2)
})

// go: races, denials and throws

test('two /ledger:go calls that overlap start only the first: the second is refused before ledger go runs', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), 'go other --session session-1 --json': started('other') }, { cwd: CWD })

  const [first, second] = await Promise.all([$.command.run({ command: 'ledger:go', args: 'kid' }), $.command.run({ command: 'ledger:go', args: 'other' })])

  expect(first.text).toBe('')
  expect(second.text).toBe(oneSwitchPerTurnMessage({ mode: 'go', slug: 'kid' }, 'other'))
  expect(w.argvs().filter(([command]) => command === 'go')).toEqual([['go', 'kid', '--session', 'session-1', '--json']])
})

test('a deny of the Skill call after ledger go disarms /ledger:go and answers with the deny', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.answerSkill({ deny: 'Skill calls are blocked here.' })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(answer.deny).toBe('Skill calls are blocked here.')
  expect(w.events).not.toContain('clear')
})

test('a deny of the Skill call after a promotion says what was already done', async ($, on) => {
  world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid', { promoted: true }) }, { cwd: CWD }).answerSkill({ deny: 'Blocked.' })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })

  expect(answer.deny).toContain(`Promoted backlog task kid: its branch, worktree and ledger are at ${worktreeOf('kid')}.`)
  expect(answer.deny).toContain('Then the Skill call was denied: Blocked.')
})

test('a typed /ledger:go whose markdown throws after the arm disarms it: the turn end does not clear', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.breakCall('markdown')

  await $.command.run({ command: 'ledger:go', args: 'kid' }).catch(() => undefined)
  await $.turn.complete(turnEnd)

  expect(w.armed.length).toBe(1)
  expect(w.events).not.toContain('clear')
})

test('a /ledger:go Skill call that throws after the arm disarms it: the turn end does not clear', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.breakCall('skill')

  await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' }).catch(() => undefined)
  await $.turn.complete(turnEnd)

  expect(w.armed.length).toBe(1)
  expect(w.events).not.toContain('clear')
})

test('/ledger:go with the task: and ledger: lines it wrote itself passes them to go.md untouched', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })
  const lines = 'task: kid\nledger: epic'

  await $.command.run({ command: 'ledger:go', args: lines })

  expect(w.markdown()).toEqual({ command: 'ledger:go', args: lines })
  expect(w.calls).toEqual([])
  expect(w.armed).toEqual([])
})

test('/ledger:go through the Skill tool with a leading slash on its name starts the task', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid') }, { cwd: CWD })

  await $.tool.call({ tool: 'Skill', skill: '/ledger:go', args: 'kid' })

  expect(w.skills).toEqual([{ skill: '/ledger:go', args: 'task: kid\nledger: epic' }])
  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['go', 'kid', '--session', 'session-1', '--json']])
})

// go: tasks in other repos, and slugs that name no new task

test('/ledger:go <slug>@<path> starts the task in that repo with --repo, and the session stays here', async ($, on) => {
  const lib = '/lib'
  const w = world(
    on,
    { [SESSION]: ownEpic(), 'go part --repo /lib --session session-1 --json': started('part', { main: lib, ledger: ledgerOf('part', lib), worktree: worktreeOf('part', lib), promoted: true }) },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:go', args: 'part@/lib' })

  expect(w.argvs()).toEqual([['session', CWD, '--json'], ['go', 'part', '--repo', '/lib', '--session', 'session-1', '--json']])
  expect(text).toContain(`Task part belongs to the repo at ${lib}`)
  expect(text).toContain(worktreeOf('part', lib))
  expect(text).toContain('The session was not cleared')
  expect(w.armed).toEqual([])
  expect(w.markdown()).toBeUndefined()
})

test('/ledger:go of a task that ledger go refuses as one of another repo makes no new task', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic(), 'go part --session session-1 --json': refused('No task part in the repo at /repo: it is a task of the repo at /lib. Run: ledger go part --repo /lib', 3) },
    { cwd: CWD },
  )

  const { text } = await $.command.run({ command: 'ledger:go', args: 'part' })

  expect(text).toContain('it is a task of the repo at /lib')
  expect(w.armed).toEqual([])
})

test('/ledger:go <new slug> does not clear when only another repo has a task with that slug', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'go new-api --session session-1 --json': refused('No backlog task new-api for the repo at /repo.', 2),
      'list --json': done({ tasks: [task('new-api', { main: '/other' })] }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)

  expect(w.events.length).toBe(1)
  expect(w.events[0]).toContain('did not create task new-api')
})

test('/ledger:go <new slug> does not clear when only another machine has a task with that slug in this repo', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'go new-api --session session-1 --json': refused('No backlog task new-api for the repo at /repo.', 2),
      'list --json': done({ tasks: [task('epic'), { ...task('new-api'), main: undefined, place: 'active', elsewhere: true, host: 'host-a' }] }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)

  expect(w.events.length).toBe(1)
  expect(w.events[0]).toContain('did not create task new-api')
})

test('/ledger:go <new slug> does not clear when ledger list fails at the turn end, and says why', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic(), 'go new-api --session session-1 --json': refused('No backlog task new-api for the repo at /repo.', 2), 'list --json': refused('git is broken') },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)

  expect(w.events.length).toBe(1)
  expect(w.events[0]).toContain('git is broken')
  expect(w.events[0]).toContain('was not cleared')
  expect(w.events[0]).not.toContain('did not create')
})

test('/ledger:go passes on the parent of the task it starts and the status of each of its children', async ($, on) => {
  const w = world(
    on,
    {
      [SESSION]: ownEpic(),
      'go kid --session session-1 --json': started('kid', {
        parent: { slug: 'epic', main: MAIN },
        children: [
          { slug: 'a', main: MAIN, status: 'active' },
          { slug: 'b', main: '/lib', status: 'backlog' },
        ],
      }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(w.markdown()?.args).toBe('task: kid\nledger: epic\nparent: epic\nchildren: a (active), b@/lib (backlog)')
})

// the lines after a finished task's clear

const finishedPrune = done({ ledger: EPIC, worktree: CWD, marker: '', finished: true, outcome: 'pruned', message: 'Pruned the build folders of epic.' })
const RETIRE_PLAN = 'task retire epic --dry-run --json'
const retirePlan = (worktree: object, fields: object = {}) =>
  done({
    slug: 'epic',
    main: MAIN,
    place: 'active',
    ledger: EPIC,
    dryRun: true,
    blocked: false,
    needsForce: false,
    blockers: [],
    steps: [],
    warnings: [],
    done: [],
    worktree: { folder: CWD, branch: 'me/epic', defaultBranch: 'main', dirty: 0, ...worktree },
    ...fields,
  })

test('/ledger:go from a finished task shows how to retire it, and looks up no next child: go already picked it', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic({ finished: true, parent: { slug: 'umbrella', main: MAIN } }), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: finishedPrune },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.events[0]).toBe('clear')
  expect(w.events.some(event => event.includes('Task epic is finished'))).toBe(true)
  expect(w.events.at(-1)).toBe('submit: go kid')
  expect(w.argvs().some(([command]) => command === 'tree')).toBe(false)
})

test('a finished task whose branch is merged gets the line to retire it', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic({ finished: true }), [autoPrune(CWD)]: finishedPrune, [RETIRE_PLAN]: retirePlan({ ahead: 0, mergedPr: 'at-head', merged: true }) }, { cwd: CWD })

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events).toContain('log: Task epic is finished and merged. Retire it with `/ledger:retire epic`.')
})

test('a finished, merged task whose retire is blocked says what blocks it, not that retire will work', async ($, on) => {
  const blockers = [
    { kind: 'dirty', reason: 'it has 2 uncommitted changes', forceable: true },
    { kind: 'children', reason: 'it has active children: part', forceable: true },
  ]
  const plan = retirePlan({ ahead: 0, mergedPr: 'at-head', merged: true, dirty: 2 }, { blocked: true, needsForce: true, blockers })
  const w = world(on, { [SESSION]: ownEpic({ finished: true }), [autoPrune(CWD)]: finishedPrune, [RETIRE_PLAN]: plan }, { cwd: CWD })

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events).toContain(
    'log: Task epic is finished and merged, but it cannot be retired yet: it has 2 uncommitted changes; it has active children: part. Run `/ledger:retire epic --dry-run` to see the details.',
  )
  expect(w.events.some(event => event.includes('Retire it with'))).toBe(false)
})

test('a finished task whose PR is still open says so, and to retire it once the PR merges', async ($, on) => {
  const w = world(
    on,
    { [SESSION]: ownEpic({ finished: true }), [autoPrune(CWD)]: finishedPrune, [RETIRE_PLAN]: retirePlan({ ahead: 3, mergedPr: 'none', merged: false, openPr: 12 }) },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events).toContain('log: Task epic is finished, and its PR #12 is still open. After it merges, run `/ledger:retire epic`.')
})

test('a finished child task whose parent has no child left says so', async ($, on) => {
  const parent = { slug: 'umbrella', main: MAIN }
  const w = world(
    on,
    { [SESSION]: ownEpic({ finished: true, parent }), [autoPrune(CWD)]: finishedPrune, [`tree next umbrella@${MAIN} --json`]: done({ action: 'next', parent, chain: [] }) },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events).toContain('log: Parent umbrella has no child task left to start.')
  expect(w.events.at(-1)).toBe('submit: go epic')
})

test('a finished child task whose next-child lookup fails shows no child line, and still continues', async ($, on) => {
  const parent = { slug: 'umbrella', main: MAIN }
  const w = world(
    on,
    { [SESSION]: ownEpic({ finished: true, parent }), [autoPrune(CWD)]: finishedPrune, [`tree next umbrella@${MAIN} --json`]: refused('umbrella is retired') },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events.some(event => event.includes('Parent umbrella'))).toBe(false)
  expect(w.events.at(-1)).toBe('submit: go epic')
})

test('a finished child task of a parent in another repo names the parent as /ledger:go takes it', async ($, on) => {
  const parent = { slug: 'umbrella', main: '/lib' }
  const w = world(
    on,
    {
      [SESSION]: ownEpic({ finished: true, parent }),
      [autoPrune(CWD)]: finishedPrune,
      'tree next umbrella@/lib --json': done({ action: 'next', parent, chain: [parent, { slug: 'part', main: '/lib' }] }),
    },
    { cwd: CWD },
  )

  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.events).toContain('log: Parent umbrella@/lib has a child task that has not started: part@/lib. Start it with `/ledger:go umbrella@/lib`.')
})

// rename

test('a /rename that fails is tried again at the next turn end', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.breakCall('rename', 1)

  await $.turn.complete(turnEnd)
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  await $.turn.complete({ ...turnEnd, turnId: 't3' })

  expect(w.events).toEqual(['rename: epic'])
})

// a host with no person at the prompt, where a submitted prompt gets no turn

const sdkStart = { cwd: CWD, surface: null, isInteractive: false } as const

test('/ledger:go in a session with no person at the prompt tells go.md the operator types go <slug>, and the turn end clears without sending it', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.session.start(sdkStart)
  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()).toEqual({ command: 'ledger:go', args: 'task: kid\nledger: epic\ncontinue: typed' })
  expect(w.armed).toEqual([{ mode: 'go', slug: 'kid', sessionId: 'session-1', previous: { slug: 'epic', worktree: CWD, main: MAIN }, typed: true }])
  expect(w.events).toEqual(['clear'])
})

test('/ledger:go through the Skill tool with no person at the prompt hands go.md the same continue line', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.session.start(sdkStart)
  await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)

  expect(w.skills).toEqual([{ skill: 'ledger:go', args: 'task: kid\nledger: epic\ncontinue: typed' }])
  expect(w.events).toEqual(['clear'])
})

test('/ledger:next with no person at the prompt tells next.md the operator types go <slug>, and the turn end clears without sending it', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.session.start(sdkStart)
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()).toEqual({ command: 'ledger:next', args: 'continue: typed' })
  expect(w.armed).toEqual([{ ...NEXT_ARM, typed: true }])
  expect(w.events).toEqual(['clear'])
})

test('/ledger:next through the Skill tool with no person at the prompt hands next.md the continue line', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })
  w.answerQuestion({ answers: { [CLEAR_POINT]: 'Save, clear and continue (Recommended)' } })

  await $.session.start(sdkStart)
  await $.tool.call(askClearPoint)
  await $.tool.call({ tool: 'Skill', skill: 'ledger:next' })
  await $.turn.complete(turnEnd)

  expect(w.skills).toEqual([{ skill: 'ledger:next', args: 'continue: typed' }])
  expect(w.events).toEqual(['clear'])
})

test('/ledger:go and /ledger:next in an interactive session still send go <slug> after the clear', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), 'go kid --session session-1 --json': started('kid'), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.session.start({ ...sdkStart, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ledger:go', args: 'kid' })
  await $.turn.complete(turnEnd)
  expect(w.markdown()).toEqual({ command: 'ledger:go', args: 'task: kid\nledger: epic' })
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete({ ...turnEnd, turnId: 't2' })

  expect(w.markdown()).toEqual({ command: 'ledger:next', args: '' })
  expect(w.events).toEqual(['clear', 'submit: go kid', 'clear', 'submit: go epic'])
})

test('a start with no person at the prompt counts only for its own session: a later session sends go <slug> again', async ($, on) => {
  const w = world(on, { [SESSION]: ownEpic(), [autoPrune(CWD)]: unchanged(CWD) }, { cwd: CWD })

  await $.session.start(sdkStart)
  w.newSession('session-2')
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)

  expect(w.markdown()).toEqual({ command: 'ledger:next', args: '' })
  expect(w.events).toEqual(['clear', 'submit: go epic'])
})
