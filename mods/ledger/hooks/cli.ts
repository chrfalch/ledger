import type { EngineInterface } from 'claude-code'

import type { Claim, ListedTask } from './ledger'

/** The longest `$.process.run` allows. A retire or prune of a big worktree outlasts the default, and a kill midway skips steps. */
export const LONG_TIMEOUT_MS = 600_000

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const parentFolder = (folder: string): string => folder.slice(0, folder.lastIndexOf('/')) || '/'

/**
 * The session folder, or the nearest folder above it when it is gone, as after a retire from inside the worktree: a
 * process cannot start in a folder that does not exist.
 */
async function runFolder($: EngineInterface, cwd: string): Promise<string> {
  for (let folder = cwd; ; folder = parentFolder(folder)) {
    if (await $.fs.stat(folder).then(() => true, () => false)) return folder
    if (folder === '/') return cwd
  }
}

type Ran = { exitCode: number; stdout: string; stderr: string }

export function ledgerBin($: EngineInterface): string {
  return `${$.plugin.root}/../../bin/ledger`
}

async function run($: EngineInterface, args: string[], timeoutMs?: number): Promise<Ran | { error: string }> {
  try {
    const cwd = await runFolder($, await $.session.cwd())
    return await $.process.run([ledgerBin($), ...args], { cwd, timeoutMs })
  } catch (error) {
    return { error: `bin/ledger did not run: ${message(error)}` }
  }
}

/** `ledger <args>` as the operator would see it in a terminal: stdout, then stderr, which holds errors and warnings. */
export async function ledgerText($: EngineInterface, args: string[], timeoutMs?: number): Promise<string> {
  const ran = await run($, args, timeoutMs)
  if ('error' in ran) return ran.error
  const shown = [ran.stdout, ran.stderr].map(text => text.trimEnd()).filter(text => text !== '')
  if (shown.length > 0) return shown.join('\n\n')
  return ran.exitCode === 0 ? 'Done.' : `bin/ledger failed (exit ${ran.exitCode}) and printed nothing.`
}

export async function ledgerSucceeded($: EngineInterface, args: string[]): Promise<boolean> {
  const ran = await run($, args)
  return !('error' in ran) && ran.exitCode === 0
}

const isClaim = (value: unknown): value is Claim =>
  typeof value === 'object' &&
  value !== null &&
  'session' in value &&
  typeof value.session === 'string' &&
  'since' in value &&
  typeof value.since === 'string' &&
  'active' in value &&
  typeof value.active === 'string'

/**
 * A `--json` answer: the fields of `{"ok":true,...}`, or the error of `{"ok":false,...}` with the exit code. `held` is the
 * live claim of another session that made the command refuse.
 */
export type Answer<T> = ({ ok: true } & T) | { ok: false; error: string; exitCode?: number; held?: Claim }

/** Runs `ledger <args> --json`. Its fields are pinned by tests/ledger-core-json.test.ts, so they are read as `T` without a check. */
export async function ledgerJson<T>($: EngineInterface, args: string[], timeoutMs?: number): Promise<Answer<T>> {
  const ran = await run($, [...args, '--json'], timeoutMs)
  if ('error' in ran) return { ok: false, error: ran.error }
  let answer: unknown
  try {
    answer = JSON.parse(ran.stdout)
  } catch {
    return { ok: false, error: `bin/ledger ${args[0]} printed no JSON (exit ${ran.exitCode}). ${ran.stderr.trim()}`.trim(), exitCode: ran.exitCode }
  }
  if (typeof answer !== 'object' || answer === null || !('ok' in answer)) return { ok: false, error: `bin/ledger ${args[0]} printed no JSON object.`, exitCode: ran.exitCode }
  if (answer.ok === true) return answer as Answer<T>
  const error = 'error' in answer ? String(answer.error) : 'unknown error'
  return { ok: false, error, exitCode: ran.exitCode, ...('held' in answer && isClaim(answer.held) ? { held: answer.held } : {}) }
}

type Ref = { slug: string; main: string }

/** `main` is the main checkout of the repo that holds the folder. */
export type Session = { folder: string; removed: boolean; main?: string; own: boolean; title?: string; ledgers: ListedTask[] }

/** The ledgers this session works on. The folder is an argument, so a removed one is reported rather than a failed start. */
export async function readSession($: EngineInterface): Promise<Answer<Session>> {
  return ledgerJson<Session>($, ['session', await $.session.cwd()])
}

/** The session's own task: the ledger of the linked worktree it is in, which `ledger session` lists first. */
export const ownTask = (session: Session): ListedTask | undefined => (session.own ? session.ledgers[0] : undefined)

export type Started = {
  slug: string
  main: string
  ledger: string
  worktree: string
  promoted: boolean
  chain: Ref[]
  parent?: Ref
  children: (Ref & { status: string })[]
  unparked?: { date: string; reason: string }
  marked?: { parent: Ref; ledger: string }
  warnings: string[]
}

export type AutoPruned = { finished: boolean; message?: string }

export type RetirePlan = { worktree?: { merged: boolean; openPr?: number }; blocked: boolean; blockers: { reason: string }[] }

export type NextChild = { chain: Ref[] }

export type Parked = { parked: { date: string; reason: string } }

export type Claimed = { slug: string; claim: Claim }
