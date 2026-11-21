/** The session's task before a switch, as `ledger session` gave it when the command ran. */
export type PreviousTask = { slug: string; worktree: string; main?: string; parent?: { slug: string; main?: string } }

/**
 * A /ledger:close, /ledger:next, /ledger:go or /ledger:park that ran in this turn: the session clears when the turn ends.
 * After /ledger:next and /ledger:go, the new session continues with `go <slug>`. When `previous` is finished, a line on how
 * to retire it is shown first. /ledger:park first parks `slug` with `reason`. `isNew` means /ledger:go asked go.md to
 * create the task in the repo at `main`, so the clear waits until a ledger of that repo has its slug. `sessionId` is the
 * session that ran `ledger go`, whose claim the new session takes over.
 */
export type LedgerArmed =
  | { mode: 'close'; slug: string }
  | { mode: 'next'; slug: string; previous: PreviousTask }
  | { mode: 'go'; slug: string; sessionId: string; previous?: PreviousTask }
  | { mode: 'go'; slug: string; sessionId: string; previous?: PreviousTask; isNew: true; main: string }
  | { mode: 'park'; slug: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    /**
     * `titled`: the slug the mod last named the session after with /rename. `clearApproved`: the operator's last answer in a
     * question box picked "Save, clear and continue", so the model may start /ledger:next once. `clearPoint`: for session
     * `sessionId`, the context size in tokens that marks the next clear-point offer, and `pending`, the size at a marked
     * offer no prompt has carried yet. `touched`: when, in ms of the engine clock, the turn end of session `sessionId` last
     * marked its claims active. `heldTask`: the task another session held when a `go <slug>` prompt or /ledger:go of
     * session `sessionId` last found one held. `takeOverApproved`: that task's slug, when the operator's last answer in a
     * question box picked "Take over", so the model may start /ledger:go <slug> --take-over for it once. `handover`: the
     * task an armed /ledger:go cleared the session for, and the session `from` that claimed it, for the next `go <slug>`
     * prompt. A StateRead gives undefined when the value was never written.
     */
    ledger: {
      armed: LedgerArmed | null
      titled: string | null
      clearApproved: boolean
      heldTask: { sessionId: string; slug: string } | null
      takeOverApproved: string | null
      handover: { slug: string; from: string } | null
      clearPoint: { sessionId: string; threshold: number; pending: number | null }
      touched: { sessionId: string; at: number }
    }
  }
}
