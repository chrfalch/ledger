import type { AgentInfo, AgentStatus, On } from 'claude-code'

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
/** Where the store keeps the active record of a task; only shown, never read. */
export const ledgerOf = (slug: string, main = MAIN): string => `/home/.claude/ledger-active${main}/${slug}.json`

type Ref = { slug: string; main: string }

/** A task as `ledger session --json` and `ledger list --json` list it; its title carries the icon of a plain active task unless given. */
export function task(slug: string, extra: { main?: string; parent?: Ref; finished?: boolean; status?: string; parked?: { date: string; reason: string }; title?: string } = {}) {
  const { main = MAIN, finished = false, status = 'active', title = `🔨 ${slug}`, ...rest } = extra
  return {
    slug,
    title,
    repo: 'repo',
    main,
    status,
    worktree: worktreeOf(slug, main),
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
  return done({ folder, removed: false, main: MAIN, repo: 'repo', own: own !== undefined, ...(own === undefined ? {} : { title: own.title }), ledgers: own === undefined ? others : [own] })
}

export const removedSession = (folder: string): Reply => done({ folder, removed: true, own: false, ledgers: [] })

export type Call = { args: string[]; cwd?: string; timeoutMs?: number }

/**
 * An engine call `world` can make throw: a command's markdown, the Skill tool, /clear, /rename, a prompt submit, a write of
 * the clear-point pick or of the take-over pick, or a usage read.
 */
export type Breakable = 'markdown' | 'skill' | 'clear' | 'rename' | 'submit' | 'approval' | 'takeOver' | 'usage' | 'offer'

/**
 * `replies` are keyed by the arguments after bin/ledger, joined by spaces. Any other program, and any arguments with no
 * reply, are refused, so a test fails on a call it did not expect. `missing` are folders fs.stat does not find.
 * `events` records, in order, each /clear, /rename, prompt submit and ui.log line that went through, and each T3 thread
 * rename as `t3: <title>`. With no `t3`, the session runs outside T3 Code: there is no t3-code server to call.
 */
export function world(on: On, replies: Record<string, Reply>, { cwd: startCwd, missing = [], t3 }: { cwd: string; missing?: string[]; t3?: 'renames' | 'fails' }) {
  let cwd = startCwd
  const calls: Call[] = []
  const callsBeforeClear: number[] = []
  const others: string[][] = []
  const events: string[] = []
  const armed: unknown[] = []
  const skills: { skill: string; args?: string }[] = []
  const asked: string[] = []
  const broken = new Map<Breakable, number>()
  let markdown: { command: string; args?: string } | undefined
  let skillAnswer: { deny?: string; isError?: true; text?: string } = {}
  let questionAnswer: { answers: Record<string, string>; afkTimeoutMs?: number } = { answers: {} }
  const reminders: string[] = []
  let contextTokens: number | undefined = 0
  let sessionId = 'session-1'
  let sessionAfterClear: string | undefined
  let agentStatuses: AgentStatus[] = []

  const takeBreak = (call: Breakable): boolean => {
    const left = broken.get(call) ?? 0
    if (left === 0) return false
    broken.set(call, left - 1)
    return true
  }
  const breakIfBroken = (call: Breakable): void => {
    if (takeBreak(call)) throw new Error(`${call} broke`)
  }

  on('session.cwd', async () => ({ value: cwd }))
  on('session.id', async () => ({ value: sessionId }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.usage', async () => {
    breakIfBroken('usage')
    return { value: { startedAt: 0, context: { tokens: contextTokens, window: 1_000_000 }, rateLimits: [] } }
  })
  on('agent.list', async () => ({ value: agentStatuses.map(agentWith) }))
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
    // A state.set hook that throws is skipped and the write still lands; a deny is what fails it.
    if (e.plugin === 'ledger' && e.key === 'clearApproved' && takeBreak('approval')) return { deny: 'approval broke' }
    if (e.plugin === 'ledger' && e.key === 'takeOverApproved' && takeBreak('takeOver')) return { deny: 'take-over broke' }
    if (e.plugin === 'ledger' && e.key === 'clearPoint' && takeBreak('offer')) return { deny: 'offer broke' }
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
  on('tool.call', { tool: 'AskUserQuestion' }, async function operatorAnswers(_, e) {
    asked.push(e.questions.map(({ question }) => question).join(' | '))
    return { result: { questions: e.questions, ...questionAnswer } }
  })
  on('command.run', { command: 'clear' }, async () => {
    breakIfBroken('clear')
    events.push('clear')
    callsBeforeClear.push(calls.length)
    if (sessionAfterClear !== undefined) sessionId = sessionAfterClear
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
    reminders.push(...(e.context ?? []))
    return { text: '' }
  })
  on('mcp.call', async (_, e) => {
    if (t3 === undefined || e.server !== 't3-code') return { deny: `no MCP server ${e.server}` }
    if (e.tool !== 't3_thread_update' || e.args.action !== 'rename' || 'threadId' in e.args) return { deny: `unexpected T3 call: ${e.tool} ${JSON.stringify(e.args)}` }
    events.push(`t3: ${e.args.title}`)
    return { value: { content: [], isError: t3 === 'fails' } }
  })
  on('ui.log', async (_, e) => {
    events.push(`log: ${e.text}`)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('session.end', async (_, e) => ({ sessionId: e.sessionId }))

  return {
    calls,
    /** For each /clear, how many bin/ledger calls ran before it. */
    callsBeforeClear,
    /** Each call as the argument list after bin/ledger. */
    argvs: () => calls.map(({ args }) => args),
    others,
    events,
    armed,
    skills,
    /** Each question box the operator saw, as its questions joined by " | ". */
    asked,
    markdown: () => markdown,
    answerSkill: (answer: typeof skillAnswer) => {
      skillAnswer = answer
    },
    answerQuestion: (answer: typeof questionAnswer) => {
      questionAnswer = answer
    },
    /** Each context block a prompt submit carried for the model. */
    reminders,
    /** Sets the context size `$.session.usage()` reports; undefined before the first response. */
    useContext: (tokens: number | undefined) => {
      contextTokens = tokens
    },
    /** Makes `$.session.id()` answer `id`, as a /clear does. */
    newSession: (id: string) => {
      sessionId = id
    },
    /** Makes each later /clear start the session `id`, as a real /clear starts a new one. */
    clearsTo: (id: string) => {
      sessionAfterClear = id
    },
    /** Makes `$.session.cwd()` answer `folder`, as EnterWorktree moves the session. */
    enterWorktree: (folder: string) => {
      cwd = folder
    },
    /** Makes `$.agent.list()` list one agent of each status. */
    listAgents: (...statuses: AgentStatus[]) => {
      agentStatuses = statuses
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

const agentWith = (status: AgentStatus, index: number): AgentInfo => ({
  id: `agent-${index}`,
  description: 'work',
  type: 'general-purpose',
  status,
  kind: 'local_agent',
  taskStatus: status === 'running' ? 'running' : 'completed',
  label: 'work',
  startTime: 0,
  cwd: MAIN,
  tokenCount: 0,
  tokenSamples: [],
  hasRow: true,
})

export const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
