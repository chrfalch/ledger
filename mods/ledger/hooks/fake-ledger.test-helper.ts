import type { On } from 'claude-code'

/** Test kit: a fake `bin/ledger` and the engine calls the mod makes around it. */

type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }
export type Reply = { value: Ran } | { deny: string }

export const ran = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

export const done = (fields: object): Reply => ran(0, JSON.stringify({ ok: true, ...fields }, null, 2))

export const refused = (error: string, exitCode = 1): Reply => ran(exitCode, JSON.stringify({ ok: false, error }, null, 2))

export const MAIN = '/repo'
export const worktreeOf = (slug: string, main = MAIN): string => `${main}/.claude/worktrees/${slug}`
export const ledgerOf = (slug: string, main = MAIN): string => `${worktreeOf(slug, main)}/.claude/ledger.md`

type Ref = { slug: string; main: string }

/** A task as `ledger session --json` and `ledger list --json` list it. */
export function task(slug: string, extra: { main?: string; parent?: Ref; finished?: boolean; status?: string; parked?: { date: string; reason: string } } = {}) {
  const { main = MAIN, finished = false, status = 'active', ...rest } = extra
  return {
    slug,
    repo: 'repo',
    main,
    status,
    path: ledgerOf(slug, main),
    branch: `me/${slug}`,
    updated: '2026-11-18T10:00:00.000Z',
    goal: `Goal of ${slug}.`,
    next: `Next of ${slug}.`,
    current: finished ? null : { number: '2', step: 'implement', status: 'todo' },
    finished,
    children: [],
    ...rest,
  }
}

/** `ledger session <folder> --json` for a session in the worktree of `own`, or in `folder` with no own ledger; both in the repo at MAIN. */
export function session(folder: string, own?: ReturnType<typeof task>, others: ReturnType<typeof task>[] = []): Reply {
  return done({ folder, removed: false, main: MAIN, own: own !== undefined, ...(own === undefined ? {} : { title: own.slug }), ledgers: own === undefined ? others : [own] })
}

export const removedSession = (folder: string): Reply => done({ folder, removed: true, own: false, ledgers: [] })

export type Call = { args: string[]; cwd?: string; timeoutMs?: number }

/** An engine call `world` can make throw: a command's markdown, the Skill tool, /clear, /rename or a prompt submit. */
export type Breakable = 'markdown' | 'skill' | 'clear' | 'rename' | 'submit'

/**
 * `replies` are keyed by the arguments after bin/ledger, joined by spaces. Any other program, and any arguments with no
 * reply, are refused, so a test fails on a call it did not expect. `missing` are folders fs.stat does not find.
 * `events` records, in order, each /clear, /rename, prompt submit and ui.log line that went through.
 */
export function world(on: On, replies: Record<string, Reply>, { cwd, missing = [] }: { cwd: string; missing?: string[] }) {
  const calls: Call[] = []
  const others: string[][] = []
  const events: string[] = []
  const armed: unknown[] = []
  const skills: { skill: string; args?: string }[] = []
  const broken = new Map<Breakable, number>()
  let markdown: { command: string; args?: string } | undefined
  let skillAnswer: { deny?: string; isError?: true; text?: string } = {}

  const breakIfBroken = (call: Breakable): void => {
    const left = broken.get(call) ?? 0
    if (left === 0) return
    broken.set(call, left - 1)
    throw new Error(`${call} broke`)
  }

  on('session.cwd', async () => ({ value: cwd }))
  on('fs.stat', async (_, e) => (missing.includes(e.path) ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` } : { value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false } }))
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string; timeoutMs?: number } }) => {
    const [program = '', ...args] = e.argv
    if (!program.endsWith('/bin/ledger')) {
      others.push(e.argv)
      return { deny: `not bin/ledger: ${JSON.stringify(e.argv)}` }
    }
    calls.push({ args, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    return replies[args.join(' ')] ?? { deny: `no reply for: ledger ${args.join(' ')}` }
  })
  on('state.set', async (_, e, next) => {
    if (e.plugin === 'ledger' && e.key === 'armed' && e.value !== null) armed.push(e.value)
    return next(e)
  })
  for (const command of ['ledger:go', 'ledger:next', 'ledger:close', 'ledger:park']) {
    on('command.run', { command }, async (_, e) => {
      breakIfBroken('markdown')
      markdown = { command, args: e.args }
      return { text: '' }
    })
  }
  // Stands for the Skill tool, which expands the command's markdown, and for its permission check.
  on('tool.call', { tool: 'Skill' }, async (_, e) => {
    breakIfBroken('skill')
    skills.push({ skill: e.skill, args: e.args })
    if (skillAnswer.isError) return { isError: true, result: {}, text: skillAnswer.text }
    return skillAnswer.deny === undefined ? { result: {} } : { deny: skillAnswer.deny }
  })
  on('command.run', { command: 'clear' }, async () => {
    breakIfBroken('clear')
    events.push('clear')
    return { text: '' }
  })
  on('command.run', { command: 'rename' }, async (_, e) => {
    breakIfBroken('rename')
    events.push(`rename: ${e.args}`)
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => {
    breakIfBroken('submit')
    events.push(`submit: ${e.text}`)
    return { text: '' }
  })
  on('ui.log', async (_, e) => {
    events.push(`log: ${e.text}`)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: '' }))

  return {
    calls,
    /** Each call as the argument list after bin/ledger. */
    argvs: () => calls.map(({ args }) => args),
    others,
    events,
    armed,
    skills,
    markdown: () => markdown,
    answerSkill: (answer: typeof skillAnswer) => {
      skillAnswer = answer
    },
    /** Makes the next `times` calls of `call` throw. */
    breakCall: (call: Breakable, times = Number.POSITIVE_INFINITY) => {
      broken.set(call, times)
    },
    reply: (args: string, reply: Reply) => {
      replies[args] = reply
    },
  }
}

export const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
