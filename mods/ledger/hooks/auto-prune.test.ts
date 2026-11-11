import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const REPO = '/repo'
const TREE = '/repo/.claude/worktrees/fix-login'
const LEDGER_PATH = `${TREE}/.claude/ledger.md`
const MARKER = `${TREE}/.claude/build-folders-pruned`

const OPEN = `# Task ledger — fast-steps

## Plan (approved 2026-10-08)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | baseline runs | done | me | |
| 2 | runner: tsc | todo | runner | |
`
const DONE = OPEN.replace('| todo |', '| done |')

const RETIRE_LINE = 'Task fast-steps is finished. Run `/ledger:retire fast-steps --dry-run` to see what blocks retiring it.'
const PRUNED_LINE = 'Pruned the build folders of fix-login, because its task is finished: 3.0 GB freed in 2 folders.'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }
const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const ok = (stdout: string): Reply => exit(0, stdout)

const WORKTREE_LIST = ['git', 'worktree', 'list', '--porcelain', '-z']
const IGNORED_STATUS = ['git', '-C', TREE, 'status', '--ignored', '--porcelain']
const porcelainZ = (...blocks: string[][]): string => blocks.map(fields => `${fields.join('\0')}\0\0`).join('')
const LISTED = porcelainZ([`worktree ${REPO}`, 'HEAD 1111', 'branch refs/heads/main'], [`worktree ${TREE}`, 'HEAD 2222', 'branch refs/heads/me/fix-login'])

const BUILD = `${TREE}/build`
const IOS_BUILD = `${TREE}/ios/build`
const GIT_DIR = '/repo/.git/worktrees/fix-login'
const GIT_DIR_LOOKUP = ['git', '-C', TREE, 'rev-parse', '--absolute-git-dir']

function baseReplies(): Record<string, Reply> {
  const entries: [string[], Reply][] = [
    [WORKTREE_LIST, ok(LISTED)],
    [GIT_DIR_LOOKUP, ok(`${GIT_DIR}\n`)],
    [IGNORED_STATUS, ok('!! build/\n!! ios/build/\n!! node_modules/\n!! .claude/build/\n')],
    [['du', '-sk', BUILD], ok(`1953125\t${BUILD}\n`)],
    [['du', '-sk', IOS_BUILD], ok(`976563\t${IOS_BUILD}\n`)],
    [['rm', '-f', '--', MARKER], ok('')],
  ]
  return Object.fromEntries(entries.map(([argv, reply]) => [JSON.stringify(argv), reply]))
}

/** `isUnderPrivate` resolves every path to the same path under /private, as macOS does for /var and /tmp. */
type Options = {
  ledger?: string
  marker?: boolean
  replies?: Record<string, Reply>
  links?: string[]
  isMarkerWriteBroken?: boolean
  isExistsBroken?: boolean
  isUnderPrivate?: boolean
  failedMoves?: string[]
}

/**
 * A session in the fix-login worktree whose ledger is `ledger`. `moved` lists each folder handed to the background delete, in
 * order, and `trashParents` the folder each of them named for its trash.
 */
function world(on: On, options: Options = {}) {
  const calls: string[] = []
  const commands: string[][] = []
  const moved: string[] = []
  const trashParents: string[] = []
  const written: string[] = []
  const state = { ledger: options.ledger ?? DONE, marker: options.marker ?? false, note: '' }
  const realPathOf = (path: string): string => (options.isUnderPrivate && !path.startsWith('/private/') ? `/private${path}` : path)
  const replies = options.replies ?? baseReplies()
  mock.env(on, {})
  on('session.cwd', async () => ({ value: TREE }))
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'bash') return ok(LEDGER_PATH)
    commands.push([...e.argv])
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') {
      const [folder = '', trashParent = ''] = e.argv.slice(4)
      if (options.failedMoves?.includes(folder)) return exit(1, '', 'mv: rename failed')
      moved.push(folder)
      trashParents.push(trashParent)
      return ok('')
    }
    if (JSON.stringify(e.argv) === JSON.stringify(['rm', '-f', '--', MARKER])) state.marker = false
    return replies[JSON.stringify(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async (_, e) => {
    if (e.path === MARKER) return state.marker ? { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } } : { deny: `ENOENT: ${e.path}` }
    const realPath = e.resolve ? { realPath: realPathOf(e.path) } : {}
    return { value: { kind: e.path === LEDGER_PATH ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: options.links?.includes(e.path) ?? false, ...realPath } }
  })
  on('fs.exists', async (_, e) => (options.isExistsBroken ? { deny: 'EIO: exists broke' } : { value: realPathOf(e.path) === realPathOf(TREE) }))
  on('fs.read', async (_, e) => (e.path === LEDGER_PATH ? { value: state.ledger } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', async (_, e) => {
    if (e.path === MARKER && options.isMarkerWriteBroken) return { deny: 'EACCES: read-only' }
    written.push(e.path)
    if (e.path === MARKER) {
      state.marker = true
      state.note = e.text
    }
    return { value: undefined }
  })
  on('command.run', { command: 'ledger:next' }, async () => ({ text: '' }))
  on('command.run', { command: 'rename' }, async () => ({ text: '' }))
  on('command.run', { command: 'clear' }, async () => {
    calls.push('clear')
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => {
    calls.push(`submit: ${e.text}`)
    return { text: '' }
  })
  on('ui.log', async (_, e) => {
    calls.push(`log: ${e.text}`)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: '' }))
  return { calls, commands, moved, trashParents, written, state }
}

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

/** Runs /ledger:next and ends its turn, which clears the session and reads the ledger again. */
async function next($: EngineInterface): Promise<void> {
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)
}

const isPruneWork = (argv: string[]): boolean => argv[0] === 'sh' || argv[0] === 'du' || argv.includes('--ignored')

test('a finished task has its build folders moved out for a background delete, one line logged, and the marker written', async ($, on) => {
  const { calls, commands, moved, written } = world(on)
  await next($)
  expect(calls).toEqual(['clear', `log: ${PRUNED_LINE}`, `log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved.sort()).toEqual([BUILD, IOS_BUILD])
  expect(commands.filter(argv => argv[0] === 'rm')).toEqual([])
  expect(written).toEqual([MARKER])
})

test('the background delete takes each folder by absolute path through sh, and starts rm detached from the hook', async ($, on) => {
  const { commands } = world(on)
  await next($)
  const moves = commands.filter(argv => argv[0] === 'sh')
  expect(moves.length).toBe(2)
  for (const argv of moves) {
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(argv[2]).toContain('mv -- "$1"')
    expect(argv[2]).toContain('nohup rm -rf')
  }
})

test('the background delete names the worktree git dir for its trash, so git status never shows it', async ($, on) => {
  const { trashParents } = world(on)
  await next($)
  expect(trashParents).toEqual([GIT_DIR, GIT_DIR])
})

test('when the git dir cannot be found, the background delete names no trash folder and the script falls back to one beside the folder', async ($, on) => {
  const replies = { ...baseReplies(), [JSON.stringify(GIT_DIR_LOOKUP)]: exit(128, '', 'fatal: not a git repository') }
  const { moved, trashParents } = world(on, { replies })
  await next($)
  expect(moved.length).toBe(2)
  expect(trashParents).toEqual(['', ''])
})

test('a clear turn prunes once, not once for the clear and once for the turn end', async ($, on) => {
  const { commands, moved } = world(on)
  await next($)
  expect(commands.filter(argv => argv.includes('--ignored')).length).toBe(1)
  expect(moved.length).toBe(2)
})

test('an ordinary turn end prunes a finished task once, logs one line and no retire line, and writes the marker', async ($, on) => {
  const { calls, moved, written } = world(on)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`log: ${PRUNED_LINE}`])
  expect(moved.sort()).toEqual([BUILD, IOS_BUILD])
  expect(written).toEqual([MARKER])

  calls.length = 0
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
  expect(moved.length).toBe(2)
})

test('an ordinary turn end with a finished task and its marker runs nothing', async ($, on) => {
  const { calls, commands, written } = world(on, { marker: true })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
  expect(commands).toEqual([])
  expect(written).toEqual([])
})

test('an ordinary turn end with an open task and no marker runs nothing', async ($, on) => {
  const { calls, commands } = world(on, { ledger: OPEN })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
  expect(commands).toEqual([])
})

test('an ordinary turn end removes the marker of a reopened task', async ($, on) => {
  const { calls, commands, state } = world(on, { ledger: OPEN, marker: true })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
  expect(commands).toEqual([['rm', '-f', '--', MARKER]])
  expect(state.marker).toBe(false)
})

test('a subagent turn end prunes nothing', async ($, on) => {
  const { commands, moved } = world(on)
  await $.turn.complete({ ...turnEnd, agentId: 'a1' })
  expect(commands).toEqual([])
  expect(moved).toEqual([])
})

test('a finished task that was pruned already is not pruned again; the retire line still shows', async ($, on) => {
  const { calls, commands, moved } = world(on, { marker: true })
  await next($)
  expect(calls).toEqual(['clear', `log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved).toEqual([])
  expect(commands.filter(isPruneWork)).toEqual([])
})

test('a second clear after the auto-prune prunes nothing', async ($, on) => {
  const { calls, moved } = world(on)
  await next($)
  calls.length = 0
  await next($)
  expect(calls).toEqual(['clear', `log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved.length).toBe(2)
})

test('a reopened task loses its marker, so its next finish prunes again', async ($, on) => {
  const { calls, commands, moved, state } = world(on, { ledger: OPEN, marker: true })
  await next($)
  expect(calls).toEqual(['clear', 'submit: go fast-steps'])
  expect(commands).toContainEqual(['rm', '-f', '--', MARKER])
  expect(state.marker).toBe(false)
  expect(moved).toEqual([])

  state.ledger = DONE
  calls.length = 0
  await next($)
  expect(calls).toEqual(['clear', `log: ${PRUNED_LINE}`, `log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved.length).toBe(2)
  expect(state.marker).toBe(true)
})

test('a task that is not finished, without a marker, runs nothing and logs nothing', async ($, on) => {
  const { calls, commands } = world(on, { ledger: OPEN })
  await next($)
  expect(calls).toEqual(['clear', 'submit: go fast-steps'])
  expect(commands).toEqual([])
})

test('a finished task with no build folders logs that, and writes the marker', async ($, on) => {
  const replies = { ...baseReplies(), [JSON.stringify(IGNORED_STATUS)]: ok('!! node_modules/\n') }
  const { calls, moved, written } = world(on, { replies })
  await next($)
  expect(calls).toEqual(['clear', 'log: The task is finished, and fix-login has no build folders to prune.', `log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved).toEqual([])
  expect(written).toEqual([MARKER])
})

const RETRY = 'Run `/ledger:worktrees prune fix-login` to prune by hand.'

test('a failed prune logs one line, writes a marker that names the retry by hand, and keeps the retire line and the submit', async ($, on) => {
  const replies = { ...baseReplies(), [JSON.stringify(IGNORED_STATUS)]: exit(128, '', 'fatal: bad object') }
  const { calls, moved, written, state } = world(on, { replies })
  await next($)
  expect(calls).toEqual([
    'clear',
    'log: Did not prune fix-login. Could not read the ignored files of fix-login. git status failed (exit 128): fatal: bad object',
    `log: ${RETIRE_LINE}`,
    'submit: go fast-steps',
  ])
  expect(moved).toEqual([])
  expect(written).toEqual([MARKER])
  expect(state.note).toContain('could not prune')
  expect(state.note).toContain('git status failed (exit 128): fatal: bad object')
  expect(state.note).toContain(RETRY)
})

test('a failed prune logs once per finish, not at every later turn end', async ($, on) => {
  const replies = { ...baseReplies(), [JSON.stringify(IGNORED_STATUS)]: exit(128, '', 'fatal: bad object') }
  const { calls, commands } = world(on, { replies })
  await $.turn.complete(turnEnd)
  expect(calls.length).toBe(1)
  calls.length = 0
  commands.length = 0
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
  expect(commands).toEqual([])
})

test('a git that cannot list the worktrees does not break the hook, and is logged once per finish', async ($, on) => {
  const { [JSON.stringify(WORKTREE_LIST)]: _, ...replies } = baseReplies()
  const { calls, written, state } = world(on, { replies })
  await next($)
  expect(calls[0]).toBe('clear')
  expect(calls[1]).toMatch(/^log: Did not prune fix-login\. Could not list worktrees\./)
  expect(calls.slice(2)).toEqual([`log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(written).toEqual([MARKER])
  expect(state.note).toContain(RETRY)
  calls.length = 0
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('an error thrown while pruning is logged once per finish, with a marker that names the retry', async ($, on) => {
  const { calls, written, state } = world(on, { isExistsBroken: true })
  await $.turn.complete(turnEnd)
  expect(calls.length).toBe(1)
  expect(calls[0]).toMatch(/^log: Did not prune fix-login\. .*EIO: exists broke$/)
  expect(written).toEqual([MARKER])
  expect(state.note).toContain(RETRY)
  calls.length = 0
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('a worktree that git lists by another spelling of the same real path is still pruned', async ($, on) => {
  const listed = porcelainZ([`worktree /private${REPO}`, 'HEAD 1111', 'branch refs/heads/main'], [`worktree /private${TREE}`, 'HEAD 2222', 'branch refs/heads/me/fix-login'])
  const replies = { ...baseReplies(), [JSON.stringify(WORKTREE_LIST)]: ok(listed) }
  const { calls, moved } = world(on, { replies, isUnderPrivate: true })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`log: ${PRUNED_LINE}`])
  expect(moved.sort()).toEqual([BUILD, IOS_BUILD])
})

test('the main checkout is never pruned, also when its ledger path resolves like a listed path', async ($, on) => {
  const listed = porcelainZ([`worktree /private${TREE}`, 'HEAD 1111', 'branch refs/heads/main'])
  const replies = { ...baseReplies(), [JSON.stringify(WORKTREE_LIST)]: ok(listed) }
  const { calls, moved } = world(on, { replies, isUnderPrivate: true })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
  expect(moved).toEqual([])
})

test('a marker that cannot be written is reported, and the hook still finishes', async ($, on) => {
  const { calls, moved } = world(on, { isMarkerWriteBroken: true })
  await next($)
  expect(calls[1]).toBe(`log: ${PRUNED_LINE}`)
  expect(calls[2]).toMatch(/^log: Could not write .*build-folders-pruned: .*EACCES.* The next turn end tries fix-login again\.$/)
  expect(calls.slice(3)).toEqual([`log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved.length).toBe(2)
})

test('a folder that could not be moved is counted in the line, and the others are still pruned', async ($, on) => {
  const { calls, moved } = world(on, { failedMoves: [IOS_BUILD] })
  await next($)
  expect(calls[1]).toBe(
    'log: Pruned the build folders of fix-login, because its task is finished: 2.0 GB freed in 1 folder. 1 folder was not deleted; run `/ledger:worktrees prune fix-login` to see why.',
  )
  expect(moved).toEqual([BUILD])
})

test('the auto-prune keeps the safety checks of /ledger:worktrees prune: a symbolic link is never moved', async ($, on) => {
  const { moved } = world(on, { links: [BUILD] })
  await next($)
  expect(moved).toEqual([IOS_BUILD])
})

test('a ledger whose folder is not a linked worktree is not pruned, and nothing is logged for it', async ($, on) => {
  const replies = { ...baseReplies(), [JSON.stringify(WORKTREE_LIST)]: ok(porcelainZ([`worktree ${REPO}`, 'HEAD 1111', 'branch refs/heads/main'])) }
  const { calls, moved, written } = world(on, { replies })
  await next($)
  expect(calls).toEqual(['clear', `log: ${RETIRE_LINE}`, 'submit: go fast-steps'])
  expect(moved).toEqual([])
  expect(written).toEqual([])
})
