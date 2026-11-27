import type { EngineInterface } from 'claude-code'

/** Renames the calling T3 Code thread, whose title /rename leaves as it was; false outside T3 or on a failure. */
export async function renameT3Thread($: EngineInterface, title: string): Promise<boolean> {
  try {
    const { isError } = await $.mcp.call('t3-code', 't3_thread_update', { action: 'rename', title })
    return !isError
  } catch {
    return false
  }
}
