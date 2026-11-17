import type { EngineInterface, On, PluginState } from 'claude-code'

import { folderSlug, summarize, taskArgument } from './ledger'
import { sessionTaskLedger } from './lookup'
import { childToStart } from './parent-command'
import { worktreeOf } from './retire'

const finished = { plugin: 'ledger', key: 'finished' } as const

/** The task at `ledger` when its next step says it is done, with the parent's next child to start, if any. */
export async function finishedTask($: EngineInterface, ledger: string | undefined): Promise<PluginState['ledger']['finished']> {
  if (ledger === undefined) return null
  const { slug, next, parent } = summarize(await $.fs.read(ledger), folderSlug(ledger), 0)
  if (!next.startsWith('Done')) return null
  if (!parent) return { slug }
  const parentArgument = taskArgument(parent)
  const chain = await childToStart($, parentArgument, worktreeOf(ledger))
  const child = 'error' in chain ? undefined : chain.at(-1)
  return child === undefined ? { slug } : { slug, start: { parent: parentArgument, child } }
}

// Filled, never submitted: a retire deletes a worktree, so the operator presses Enter.
async function fill($: EngineInterface, command: string): Promise<void> {
  const { isFilled } = await $.prompt.fill({ text: command, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!isFilled) $.ui.log(`Could not put the command in the prompt box. Type \`${command}\`.`)
}

/**
 * Buttons above the prompt box that fill in the commands for a finished task, as register.ts stores it at the session's start,
 * each main turn's end and each retire. Until the first store, the task is looked up here, as a draw cannot write state.
 */
export function band(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { value: stored } = await $.state.get(finished)
    const task = stored !== undefined ? stored : await finishedTask($, await sessionTaskLedger($)).catch(() => null)
    if (!task) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const { slug, start } = task
    return (
      <Box>
        <Button key="retire" label={`Retire ${slug}`} onPress={() => fill($, `/ledger:retire ${slug}`)} />
        {start && <Button key="next" label={`Next: ${start.child}`} onPress={() => fill($, `/ledger:go ${start.parent}`)} />}
      </Box>
    )
  })
}
