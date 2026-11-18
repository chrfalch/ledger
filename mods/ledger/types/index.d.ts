/** The session's task before a switch, as `ledger session` gave it when the command ran. */
export type PreviousTask = { slug: string; ledger: string; main?: string; parent?: { slug: string; main?: string } }

/**
 * A /ledger:close, /ledger:next, /ledger:go or /ledger:park that ran in this turn: the session clears when the turn ends.
 * After /ledger:next and /ledger:go, the new session continues with `go <slug>`. When `previous` is finished, a line on how
 * to retire it is shown first. /ledger:park first parks `slug` with `reason`. `isNew` means /ledger:go asked go.md to
 * create the task in the repo at `main`, so the clear waits until a ledger of that repo has its slug.
 */
export type LedgerArmed =
  | { mode: 'close'; slug: string }
  | { mode: 'next'; slug: string; previous: PreviousTask }
  | { mode: 'go'; slug: string; previous?: PreviousTask }
  | { mode: 'go'; slug: string; previous?: PreviousTask; isNew: true; main: string }
  | { mode: 'park'; slug: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    /** `titled`: the slug the mod last named the session after with /rename. A StateRead gives undefined when the value was never written. */
    ledger: { armed: LedgerArmed | null; titled: string | null }
  }
}
