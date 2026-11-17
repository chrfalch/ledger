import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

const WORKTREE = '/repo/.claude/worktrees/fix-login'
const LEDGER = `${WORKTREE}/.claude/ledger.md`
const NEXT_EPIC = 'bin/cc-ledger-parent next epic'

const ledger = (nextStep: string, location = '') => `# Task ledger — fix-login

## Goal
Fix the login form.

## Location
- worktree: ${WORKTREE}
${location}
## Next step
${nextStep}
`

const DONE = ledger('Done. Ask the operator to retire the task.')
const CHILD_OF_EPIC = ledger('Done. Ask the operator to retire the task.', '- parent: epic\n')

const exit = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

const HEAD = 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe'
const inWorktree = (...args: string[]) => scriptKey(['git', '-C', WORKTREE, ...args])

/** What git and gh print for a clean worktree on a merged branch, so /ledger:retire goes ahead. */
const RETIRABLE = new Map([
  [inWorktree('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'), '/repo/.git/worktrees/fix-login\n/repo/.git\n'],
  [inWorktree('status', '--porcelain'), ''],
  [inWorktree('branch', '--show-current'), 'me/fix-login\n'],
  [inWorktree('rev-parse', '--verify', '--quiet', 'HEAD'), `${HEAD}\n`],
  [inWorktree('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/main\n'],
  [inWorktree('rev-list', '--count', `origin/main..${HEAD}`), '0\n'],
  [scriptKey(['gh', 'pr', 'list', '--head', 'me/fix-login', '--state', 'merged', '--json', 'number,headRefOid']), '[]'],
])

type Options = { isFillRefused?: boolean; next?: string; isRetirable?: boolean }

/**
 * `next` is what `cc-ledger-parent next epic` prints; the script fails when it is absent. With `isRetirable`, /ledger:retire
 * finds what it needs, and its script removes the ledger as cc-worktree-retire removes the worktree.
 */
function world(on: On, text: string, { isFillRefused = false, next, isRetirable = false }: Options = {}) {
  const files = new Map([[LEDGER, text]])
  const fills: { text: string; mode?: string }[] = []
  const submits: string[] = []
  const logs: string[] = []
  const runs: string[] = []
  on('session.cwd', async () => ({ value: WORKTREE }))
  on('process.run', async (_, e) => {
    runs.push(scriptKey(e.argv))
    if (e.argv[0] === 'bash' && e.argv[1]?.endsWith('/cc-worktree-retire')) {
      files.delete(LEDGER)
      return exit(0, `removed  ${WORKTREE}\n`)
    }
    if (e.argv[0] === 'bash') return exit(0, [...files.keys()].join('\n'))
    const retirable = isRetirable ? RETIRABLE.get(scriptKey(e.argv)) : undefined
    if (retirable !== undefined) return exit(0, retirable)
    if (scriptKey(e.argv) === NEXT_EPIC && next !== undefined) return exit(0, next)
    return { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => {
    const found = files.get(e.path)
    return found === undefined ? { deny: `ENOENT: ${e.path}` } : { value: found }
  })
  on('prompt.fill', async (_, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return isFillRefused ? { isFilled: false, refusal: 'dialog' } : { isFilled: true }
  })
  on('prompt.submit', async (_, e) => {
    submits.push(e.text)
    return { text: '' }
  })
  on('ui.log', async (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: '' }))
  return { files, fills, submits, logs, runs }
}

const props = (hasSurvey = false) => ({
  hasSurvey,
  isCollapsed: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
})

const mountBand = ($: Engine, hasSurvey = false) =>
  $.ui.mount({ plugin: 'ledger', surface: 'terminal', component: 'AbovePrompt', props: props(hasSurvey) })

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('a finished task shows a button that retires it', async ($, on) => {
  world(on, DONE)
  const ui = await mountBand($)

  expect((await ui.find({ key: 'retire' }))?.props.label).toBe('Retire fix-login')
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  await ui.unmount()
})

for (const nextStep of ['Run the tests.', 'Not Done yet.', '']) {
  test(`a next step of "${nextStep}" shows no row`, async ($, on) => {
    world(on, ledger(nextStep))
    const ui = await mountBand($)

    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })
}

test('the leading spaces and blank lines before Done do not hide the row', async ($, on) => {
  world(on, ledger('\n   Done, merged.'))
  const ui = await mountBand($)

  expect(await ui.find({ key: 'retire' })).toBeDefined()
  await ui.unmount()
})

test('a session outside any task shows no row', async ($, on) => {
  const { files } = world(on, DONE)
  files.clear()
  const ui = await mountBand($)

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a survey above the prompt hides the row', async ($, on) => {
  world(on, DONE)
  const ui = await mountBand($, true)

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('pressing Retire fills the prompt box with the retire command and sends nothing', async ($, on) => {
  const { fills, submits, logs } = world(on, DONE)
  const ui = await mountBand($)

  await ui.press({ key: 'retire' })

  expect(fills).toEqual([{ text: '/ledger:retire fix-login', mode: 'replace' }])
  expect(submits).toEqual([])
  expect(logs).toEqual([])
  await ui.unmount()
})

test('a child task with a next sibling to start shows Next after Retire', async ($, on) => {
  const { fills, submits } = world(on, CHILD_OF_EPIC, { next: 'epic child-b\n' })
  const ui = await mountBand($)

  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(button => button.key)).toEqual(['retire', 'next'])
  expect(buttons[1]?.props.label).toBe('Next: child-b')

  await ui.press({ key: 'next' })

  expect(fills).toEqual([{ text: '/ledger:go epic', mode: 'replace' }])
  expect(submits).toEqual([])
  await ui.unmount()
})

for (const [name, options] of [
  ['no child left to start', { next: 'epic\n' }],
  ['a failed lookup of the next child', {}],
] as const) {
  test(`a child task with ${name} shows only Retire`, async ($, on) => {
    world(on, CHILD_OF_EPIC, options)
    const ui = await mountBand($)

    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['retire'])
    await ui.unmount()
  })
}

test('a refused fill logs the command to type', async ($, on) => {
  const { logs, submits } = world(on, DONE, { isFillRefused: true })
  const ui = await mountBand($)

  await ui.press({ key: 'retire' })

  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('/ledger:retire fix-login')
  expect(submits).toEqual([])
  await ui.unmount()
})

test('the row appears at the end of the turn that finished the task', async ($, on) => {
  const { files } = world(on, ledger('Run the tests.'))
  const ui = await mountBand($)
  expect(await ui.find({ key: 'retire' })).toBeUndefined()

  files.set(LEDGER, DONE)
  await $.turn.complete(turnEnd)

  expect(await ui.find({ key: 'retire' })).toBeDefined()
  await ui.unmount()
})

test('redraws after a turn end read the finished task without running the lookups again', async ($, on) => {
  const { runs } = world(on, CHILD_OF_EPIC, { next: 'epic child-b\n' })
  await $.turn.complete(turnEnd)
  const lookups = runs.length
  expect(lookups).toBeGreaterThan(0)

  const ui = await mountBand($)
  await ui.redraw({ ...props(), isWorking: true })
  await ui.redraw({ ...props(), bodyColumns: 60 })

  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['retire', 'next'])
  expect(runs).toHaveLength(lookups)
  await ui.unmount()
})

test('a subagent turn end does not look the finished task up again', async ($, on) => {
  const { runs } = world(on, DONE)
  await $.turn.complete(turnEnd)
  const ui = await mountBand($)
  const lookups = runs.length

  await $.turn.complete({ ...turnEnd, turnId: 't2', agentId: 'a1' })

  expect(await ui.find({ key: 'retire' })).toBeDefined()
  expect(runs).toHaveLength(lookups)
  await ui.unmount()
})

test('a successful retire of the finished task removes the row', async ($, on) => {
  const { files } = world(on, DONE, { isRetirable: true })
  await $.turn.complete(turnEnd)
  const ui = await mountBand($)
  expect(await ui.find({ key: 'retire' })).toBeDefined()

  const { text } = await $.command.run({ command: 'ledger:retire', args: '' })

  expect(text.split('\n')[0]).toBe('**Retired fix-login**')
  expect(files.has(LEDGER)).toBe(false)
  await ui.redraw(props())
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a retire of the finished task through the Skill tool removes the row', async ($, on) => {
  const { files } = world(on, DONE, { isRetirable: true })
  await $.turn.complete(turnEnd)
  const ui = await mountBand($)
  expect(await ui.find({ key: 'retire' })).toBeDefined()

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:retire', args: '' })

  expect(ran.deny?.split('\n')[0]).toBe('**Retired fix-login**')
  expect(files.has(LEDGER)).toBe(false)
  await ui.redraw(props())
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a retire that fails keeps the row', async ($, on) => {
  world(on, DONE)
  await $.turn.complete(turnEnd)
  const ui = await mountBand($)

  const { text } = await $.command.run({ command: 'ledger:retire', args: '' })

  expect(text).not.toContain('**Retired')
  await ui.redraw(props())
  expect(await ui.find({ key: 'retire' })).toBeDefined()
  await ui.unmount()
})

test('the session start looks the finished task up, so redraws before the first turn end run no lookup', async ($, on) => {
  const { runs } = world(on, CHILD_OF_EPIC, { next: 'epic child-b\n' })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_, e) => e)
  await $.session.start({ source: 'startup', cwd: WORKTREE })
  const lookups = runs.length
  expect(lookups).toBeGreaterThan(0)

  const ui = await mountBand($)
  await ui.redraw({ ...props(), isWorking: true })

  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['retire', 'next'])
  expect(runs).toHaveLength(lookups)
  await ui.unmount()
})
