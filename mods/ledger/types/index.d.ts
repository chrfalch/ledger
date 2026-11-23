/** The session's task before a switch, as `ledger session` gave it when the command ran. */
export type PreviousTask = { slug: string; worktree: string; main?: string; parent?: { slug: string; main?: string } }

/**
 * A /ledger:close, /ledger:next, /ledger:go or /ledger:park that ran in this turn: the session clears when the turn ends.
 * After /ledger:next and /ledger:go, the new session continues with `go <slug>`. When `previous` is finished, a line on how
 * to retire it is shown first. /ledger:park first parks `slug` with `reason`. `isNew` means /ledger:go asked go.md to
 * create the task in the repo at `main`, so the clear waits until a ledger of that repo has its slug. `sessionId` is the
 * session that ran `ledger go`, whose claim the new session takes over. `typed` means no person was at the prompt when the
 * session started, as under the Agent SDK, whose host cuts the turn of a submitted prompt: the operator types `go <slug>`.
 * `queued` means the model asked T3 to run `go <slug>` in a fresh run of its own thread once this turn ends, so the turn
 * end releases the claims and hands the task over, but neither clears nor sends `go <slug>`.
 */
export type LedgerArmed =
  | { mode: 'close'; slug: string }
  | { mode: 'next'; slug: string; previous: PreviousTask; typed?: true; queued?: true }
  | { mode: 'go'; slug: string; sessionId: string; previous?: PreviousTask; typed?: true; queued?: true }
  | { mode: 'go'; slug: string; sessionId: string; previous?: PreviousTask; typed?: true; queued?: true; isNew: true; main: string }
  | { mode: 'park'; slug: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    /**
     * `titled`: the slug the mod last named session `sessionId` after with /rename. `claimedTask`: the task session
     * `sessionId` last claimed with a `go <slug>` prompt, which names the session in a folder with no ledger of its own. `clearApproved`: the operator's last answer in a
     * question box picked "Save, clear and continue", so the model may start /ledger:next once. `clearPoint`: for session
     * `sessionId`, the context size in tokens that marks the next clear-point offer, and `pending`, the size at a marked
     * offer no prompt has carried yet. `touched`: when, in ms of the engine clock, the turn end of session `sessionId` last
     * marked its claims active. `heldTask`: the task another session held when a `go <slug>` prompt or /ledger:go of
     * session `sessionId` last found one held. `takeOverApproved`: that task's slug, when the operator's last answer in a
     * question box picked "Take over", so the model may start /ledger:go <slug> --take-over for it once. `handover`: the
     * task an armed /ledger:go cleared the session for, and the session `from` that claimed it, for the next `go <slug>`
     * prompt. `sessionStart`: whether a person was at the prompt when session `sessionId` started. A StateRead gives
     * undefined when the value was never written.
     */
    ledger: {
      armed: LedgerArmed | null
      titled: { sessionId: string; slug: string } | null
      claimedTask: { sessionId: string; slug: string } | null
      clearApproved: boolean
      heldTask: { sessionId: string; slug: string } | null
      takeOverApproved: string | null
      handover: { slug: string; from: string } | null
      clearPoint: { sessionId: string; threshold: number; pending: number | null }
      touched: { sessionId: string; at: number }
      sessionStart: { sessionId: string; interactive: boolean }
    }
  }
}
