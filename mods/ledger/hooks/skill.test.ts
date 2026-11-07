import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { HELP } from './ledger'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

const SHOW_EPIC = 'bin/cc-ledger-parent show epic --json'
const EPIC = exit(0, JSON.stringify({ parent: 'epic', goal: 'Goal of epic.', children: [{ slug: 'child-a', status: 'active', next: 'Run the tests.' }] }))

/**
 * `skills` are the calls that reached the Skill tool, which expands the command's markdown, the fallback text.
 * `cwd` of `null` is a session folder that cannot be read.
 */
function world(on: On, replies: Record<string, Reply> = {}, cwd: string | null = '/repo') {
  const commands: string[] = []
  const skills: string[] = []
  const armed: unknown[] = []
  on('session.cwd', async () => (cwd === null ? { deny: 'no session' } : { value: cwd }))
  on('process.run', async (_, e: { argv: string[] }) => {
    const key = scriptKey(e.argv)
    commands.push(key)
    if (e.argv[0] === 'bash') return exit(0, '')
    return replies[key] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('fs.list', async (_, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('env.get', async () => ({ value: '/home' }))
  on('state.set', async (_, e, next) => {
    if (e.plugin === 'ledger' && e.key === 'armed' && e.value !== null) armed.push(e.value)
    return next(e)
  })
  on('tool.call', { tool: 'Skill' }, async (_, e) => {
    skills.push(e.skill)
    return { result: {} }
  })
  return { commands, skills, armed }
}

test('/ledger:parent through the Skill tool answers with the text the typed command shows', async ($, on) => {
  const w = world(on, { [SHOW_EPIC]: EPIC })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic' })
  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:parent', args: 'epic' })

  expect(text).toContain('**Parent task epic** · 1 child, 1 active')
  expect(ran.deny).toBe(text)
  expect(w.skills).toEqual([])
})

test('/ledger:help through the Skill tool answers with the list of commands', async ($, on) => {
  const w = world(on)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:help' })

  expect(ran.deny).toBe(HELP)
  expect(w.skills).toEqual([])
})

for (const command of ['ledger:all', 'ledger:archive', 'ledger:worktrees']) {
  test(`/${command} through the Skill tool answers with the text the typed command shows`, async ($, on) => {
    const w = world(on)

    const { text } = await $.command.run({ command, args: '' })
    const ran = await $.tool.call({ tool: 'Skill', skill: command, args: '' })

    expect(ran.deny).toBe(text)
    expect(w.skills).toEqual([])
  })
}

test('a lookup command through the Skill tool that fails says the lookup failed', async ($, on) => {
  world(on, {}, null)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:parent', args: '' })

  expect(ran.deny?.startsWith('/ledger:parent failed: ')).toBe(true)
  expect(ran.deny).toContain('no session')
  expect(ran.deny?.endsWith(' Ask the operator to type it.')).toBe(true)
  expect(ran.deny).not.toContain('session was not cleared')
})

for (const [command, args] of [
  ['ledger:worktrees', 'prune fix-login'],
  ['ledger:worktrees', 'prune fix-login --yes'],
  ['ledger:worktrees', 'prune-orphans'],
  ['ledger:parent', 'epic add child-b'],
  ['ledger:parent', 'epic remove child-b'],
] as const) {
  test(`/${command} ${args} through the Skill tool is refused and runs nothing, because it deletes or writes`, async ($, on) => {
    const w = world(on)

    const ran = await $.tool.call({ tool: 'Skill', skill: command, args })

    expect(ran.deny).toBe(`/${command} runs only when the operator types it. Ask the operator to type \`/${command} ${args}\`.`)
    expect(w.commands).toEqual([])
    expect(w.skills).toEqual([])
  })
}

// It rewrites ~/.claude/ledgers.json, but only from the ledgers on disk, so the model may run it.
test('/ledger:all --scan through the Skill tool rebuilds the registry and answers with the text the typed command shows', async ($, on) => {
  const SCAN = 'bin/cc-ledgers scan --json'
  const w = world(on, { [SCAN]: exit(0, '[]', 'rebuilt /home/.claude/ledgers.json: 0 active, 0 archived\n') })

  const { text } = await $.command.run({ command: 'ledger:all', args: '--scan' })
  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:all', args: '--scan' })

  expect(text).toContain('rebuilt /home/.claude/ledgers.json')
  expect(ran.deny).toBe(text)
  expect(w.commands.filter(command => command === SCAN)).toHaveLength(2)
  expect(w.skills).toEqual([])
})

for (const command of ['ledger:retire', 'ledger:dashboard', 'ledger:close', 'ledger:next', 'ledger:park']) {
  test(`/${command} through the Skill tool is refused, runs nothing, and asks for the operator to type it`, async ($, on) => {
    const w = world(on)

    const ran = await $.tool.call({ tool: 'Skill', skill: command, args: 'fast-steps --force' })

    expect(ran.deny).toContain(`Ask the operator to type \`/${command} fast-steps --force\`.`)
    expect(ran.deny?.split('\n')).toHaveLength(1)
    expect(w.commands).toEqual([])
    expect(w.skills).toEqual([])
    expect(w.armed).toEqual([])
  })
}

test('/ledger:retire through the Skill tool with a leading slash and no arguments names the bare command', async ($, on) => {
  world(on)

  const ran = await $.tool.call({ tool: 'Skill', skill: '/ledger:retire' })

  expect(ran.deny).toContain('Ask the operator to type `/ledger:retire`.')
})

for (const skill of ['ledger:update', 'ledger:task', 'other:parent']) {
  test(`${skill} through the Skill tool reaches the Skill tool`, async ($, on) => {
    const w = world(on)

    const ran = await $.tool.call({ tool: 'Skill', skill, args: 'epic' })

    expect(ran.deny).toBe(undefined)
    expect(w.skills).toEqual([skill])
  })
}
