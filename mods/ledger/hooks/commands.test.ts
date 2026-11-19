import { expect, test } from 'claude-code/testing'

import { MAIN, ran, refused, session, task, world, worktreeOf } from './fake-ledger.test-helper'
import { HELP, typedOnlyMessage } from './ledger'

const CWD = worktreeOf('epic')
const LONG = 600_000

const LIST = ran(0, 'Task ledgers · 2 tasks: 1 active, 0 parked, 1 backlog\n\nrepo  task  status\n')

test('/ledger:all shows `ledger list --archived` verbatim, from one call', async ($, on) => {
  const w = world(on, { 'list --archived': LIST }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:all', args: '' })

  expect(w.argvs()).toEqual([['list', '--archived']])
  expect(w.calls[0]?.cwd).toBe(CWD)
  expect(text).toBe('Task ledgers · 2 tasks: 1 active, 0 parked, 1 backlog\n\nrepo  task  status')
})

test('/ledger:all --scan says the flag was dropped, then shows the list', async ($, on) => {
  const w = world(on, { 'list --archived': LIST }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:all', args: '--scan' })

  expect(w.argvs()).toEqual([['list', '--archived']])
  expect(text).toStartWith('Ignored --scan:')
  expect(text).toEndWith('Task ledgers · 2 tasks: 1 active, 0 parked, 1 backlog\n\nrepo  task  status')
})

test('/ledger:archive passes the search term as one argument and --all as a flag', async ($, on) => {
  const w = world(on, { 'task archive login fix --all': ran(0, 'Archived ledgers · every repo\n') }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:archive', args: ' login  fix --all ' })

  expect(w.argvs()).toEqual([['task', 'archive', 'login fix', '--all']])
  expect(text).toBe('Archived ledgers · every repo')
})

test('/ledger:archive with no term lists the archive of this repo', async ($, on) => {
  const w = world(on, { 'task archive': ran(0, 'Archived ledgers · repo\n') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:archive', args: '' })

  expect(w.argvs()).toEqual([['task', 'archive']])
})

test('/ledger:parent <slug> shows `ledger tree show <slug>`, and a change runs `ledger tree <action> <slug> <child>`', async ($, on) => {
  const w = world(on, { 'tree show epic': ran(0, 'Parent task epic · 1 child, 1 active\n'), 'tree add epic part': ran(0, 'part is a child of epic.\n') }, { cwd: CWD })

  const shown = await $.command.run({ command: 'ledger:parent', args: 'epic' })
  const added = await $.command.run({ command: 'ledger:parent', args: 'epic add part' })

  expect(w.argvs()).toEqual([['tree', 'show', 'epic'], ['tree', 'add', 'epic', 'part']])
  expect(shown.text).toBe('Parent task epic · 1 child, 1 active')
  expect(added.text).toBe('part is a child of epic.')
})

test('/ledger:parent passes an action with no child, and options, on to ledger tree', async ($, on) => {
  const w = world(on, { 'tree next epic': ran(0, 'epic part\n'), 'tree show epic --json': ran(0, '{"ok":true}\n') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:parent', args: 'epic next' })
  await $.command.run({ command: 'ledger:parent', args: 'epic --json' })

  expect(w.argvs()).toEqual([['tree', 'next', 'epic'], ['tree', 'show', 'epic', '--json']])
})

test('/ledger:parent with no slug answers its usage and runs nothing', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:parent', args: '' })

  expect(text).toContain('Usage: /ledger:parent <slug>')
  expect(w.calls).toEqual([])
})

test('/ledger:parent with options but no slug answers its usage and runs nothing', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:parent', args: '--json' })

  expect(text).toContain('Usage: /ledger:parent <slug>')
  expect(w.calls).toEqual([])
})

test('/ledger:worktrees shows the table from `ledger worktrees`', async ($, on) => {
  const w = world(on, { worktrees: ran(0, 'Worktrees of repo · 2 linked\n') }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:worktrees', args: '' })

  expect(w.argvs()).toEqual([['worktrees']])
  expect(text).toBe('Worktrees of repo · 2 linked')
})

for (const args of ['prune app', 'prune --all --dry-run', 'prune-orphans --dry-run']) {
  test(`/ledger:worktrees ${args} passes its words to \`ledger worktrees\``, async ($, on) => {
    const w = world(on, { [`worktrees ${args}`]: ran(0, 'done\n') }, { cwd: CWD })

    await $.command.run({ command: 'ledger:worktrees', args })

    expect(w.argvs()).toEqual([['worktrees', ...args.split(' ')]])
  })
}

test('/ledger:worktrees prune waits as long as the engine allows, as a big worktree takes time', async ($, on) => {
  const w = world(on, { 'worktrees prune app': ran(0, 'pruned\n') }, { cwd: CWD })

  await $.command.run({ command: 'ledger:worktrees', args: 'prune app' })

  expect(w.calls[0]?.timeoutMs).toBe(LONG)
})

test('a prune that fails shows its report and the error, not only one of them', async ($, on) => {
  const report = 'app · 0.1 GB freed in 1 folder\n\nCould not delete build: permission denied\n'
  world(on, { 'worktrees prune app': ran(1, report, 'warning: 1 folder was not deleted\n') }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:worktrees', args: 'prune app' })

  expect(text).toContain('app · 0.1 GB freed in 1 folder')
  expect(text).toContain('Could not delete build: permission denied')
  expect(text).toContain('warning: 1 folder was not deleted')
})

test('a command that bin/ledger refuses shows its error', async ($, on) => {
  world(on, { 'worktrees prune nope': ran(1, '', 'No linked worktree named "nope". Worktrees: app\n') }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:worktrees', args: 'prune nope' })

  expect(text).toBe('No linked worktree named "nope". Worktrees: app')
})

test('a bin/ledger that does not run says so', async ($, on) => {
  world(on, {}, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:all', args: '' })

  expect(text).toContain('bin/ledger did not run')
})

test('/ledger:retire passes slug, --dry-run and --force on, and waits as long as the engine allows', async ($, on) => {
  const w = world(on, { 'task retire epic --dry-run': ran(0, 'Retire epic · dry run\n'), 'task retire part --force': ran(0, 'archived /home/x.md\n') }, { cwd: CWD })

  const planned = await $.command.run({ command: 'ledger:retire', args: 'epic --dry-run' })
  const retired = await $.command.run({ command: 'ledger:retire', args: 'part --force' })

  expect(w.argvs()).toEqual([['task', 'retire', 'epic', '--dry-run'], ['task', 'retire', 'part', '--force']])
  expect(w.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([LONG, LONG])
  expect(planned.text).toBe('Retire epic · dry run')
  expect(retired.text).toBe('archived /home/x.md')
})

test('/ledger:retire of a blocked task shows why', async ($, on) => {
  world(on, { 'task retire': ran(1, '', 'Not retired: 2 uncommitted files. Add --force to retire it anyway.\n') }, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:retire', args: '' })

  expect(text).toBe('Not retired: 2 uncommitted files. Add --force to retire it anyway.')
})

test('/ledger:help answers the command list and runs nothing', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const { text } = await $.command.run({ command: 'ledger:help', args: '' })

  expect(text).toBe(HELP)
  expect(w.calls).toEqual([])
})

test('/ledger:help lists no dashboard', () => {
  expect(HELP).not.toContain('dashboard')
})

test('/ledger shows the goal, current step and next step of each ledger the session works on', async ($, on) => {
  const parked = task('fix-login', { status: 'parked', parked: { date: '2026-11-10', reason: 'waits for review' } })
  const w = world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic', { parent: { slug: 'umbrella', main: MAIN } }), parked]) }, { cwd: MAIN })

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(w.argvs()).toEqual([['session', MAIN, '--json']])
  expect(text).toContain('epic')
  expect(text).toContain('Goal of epic.')
  expect(text).toContain('step 2 · implement')
  expect(text).toContain('Next of epic.')
  expect(text).toContain('umbrella')
  expect(text).toContain('2026-11-10 — waits for review')
})

test('/ledger <name> shows only the ledgers whose slug holds the name', async ($, on) => {
  world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic'), task('fix-login')]) }, { cwd: MAIN })

  const { text } = await $.command.run({ command: 'ledger', args: 'LOGIN' })

  expect(text).toContain('fix-login')
  expect(text).not.toContain('Goal of epic.')
})

test('/ledger says so when no ledger matches', async ($, on) => {
  world(on, { [`session ${MAIN} --json`]: session(MAIN, undefined, [task('epic')]) }, { cwd: MAIN })

  const { text } = await $.command.run({ command: 'ledger', args: 'nope' })

  expect(text).toBe('No ledger matches "nope".')
})

test('/ledger says the session ledgers could not be read when bin/ledger refuses', async ($, on) => {
  world(on, { [`session ${MAIN} --json`]: refused('git is broken') }, { cwd: MAIN })

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toContain('git is broken')
})

for (const [command, args, key] of [
  ['ledger:all', '', 'list --archived'],
  ['ledger:archive', 'login', 'task archive login'],
  ['ledger:parent', 'epic', 'tree show epic'],
  ['ledger:worktrees', '', 'worktrees'],
  ['ledger:retire', 'epic --dry-run', 'task retire epic --dry-run'],
] as const) {
  test(`/${command} through the Skill tool answers with the text the typed command shows`, async ($, on) => {
    const w = world(on, { [key]: ran(0, `${key} output\n`) }, { cwd: CWD })

    const typed = await $.command.run({ command, args })
    const answer = await $.tool.call({ tool: 'Skill', skill: command, args })

    expect(answer.deny).toBe(typed.text)
    expect(w.skills).toEqual([])
  })
}

test('/ledger:help through the Skill tool answers with the list of commands', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: '/ledger:help' })

  expect(answer.deny).toBe(HELP)
  expect(w.skills).toEqual([])
})

for (const [command, args] of [
  ['ledger:close', ''],
  ['ledger:next', ''],
  ['ledger:park', 'waits for review'],
  ['ledger:parent', 'epic add part'],
  ['ledger:parent', 'epic remove part'],
  ['ledger:retire', 'epic --force'],
  ['ledger:worktrees', 'prune app'],
  ['ledger:worktrees', 'prune --all'],
  ['ledger:worktrees', 'prune-orphans'],
] as const) {
  test(`/${command} ${args} through the Skill tool is refused: only the operator types it`, async ($, on) => {
    const w = world(on, {}, { cwd: CWD })

    const answer = await $.tool.call({ tool: 'Skill', skill: command, args })

    expect(answer.deny).toBe(typedOnlyMessage(command, args))
    expect(w.calls).toEqual([])
    expect(w.skills).toEqual([])
    expect(w.armed).toEqual([])
  })
}

test('/ledger:worktrees prune --dry-run through the Skill tool runs, as it deletes nothing', async ($, on) => {
  const w = world(on, { 'worktrees prune --all --dry-run': ran(0, 'planned\n') }, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:worktrees', args: 'prune --all --dry-run' })

  expect(answer.deny).toBe('planned')
  expect(w.argvs()).toEqual([['worktrees', 'prune', '--all', '--dry-run']])
})

test('/ledger:dashboard is gone: the mod answers no such command', async ($, on) => {
  const w = world(on, {}, { cwd: CWD })

  const answer = await $.tool.call({ tool: 'Skill', skill: 'ledger:dashboard', args: '' })

  expect(answer.deny).toBeUndefined()
  expect(w.calls).toEqual([])
  expect(w.others).toEqual([])
})

test('no command runs a program other than bin/ledger', async ($, on) => {
  const w = world(
    on,
    {
      'list --archived': LIST,
      'task archive': ran(0, 'a\n'),
      'tree show epic': ran(0, 'p\n'),
      worktrees: ran(0, 'w\n'),
      'task retire --dry-run': ran(0, 'r\n'),
      [`session ${CWD} --json`]: session(CWD, task('epic')),
    },
    { cwd: CWD },
  )

  for (const [command, args] of [['ledger', ''], ['ledger:all', ''], ['ledger:archive', ''], ['ledger:parent', 'epic'], ['ledger:worktrees', ''], ['ledger:retire', '--dry-run']]) {
    await $.command.run({ command, args })
  }

  expect(w.others).toEqual([])
  expect(w.calls.length).toBe(6)
})

test('every call runs in the session folder, or the nearest folder above it when that is gone', async ($, on) => {
  const gone = worktreeOf('gone')
  const w = world(on, { 'list --archived': LIST }, { cwd: gone, missing: [gone] })

  await $.command.run({ command: 'ledger:all', args: '' })

  expect(w.calls[0]?.cwd).toBe(`${MAIN}/.claude/worktrees`)
})
