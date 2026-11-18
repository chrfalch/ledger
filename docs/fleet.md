# The fleet

Ten subagents. Each has one question it answers, one lane it stays in, and a
list of things it never does. The orchestrator routes work to them; you rarely
name one yourself. The agent table, with each agent's engine, effort and limits,
is in [the model routing rule](../rules/40-model-routing.md).

The four Codex agents are thin Claude wrappers. Their own model is cheap
because the real work happens in Codex; what matters is the Codex model behind
them.

## Models

Each agent pins a model in its frontmatter. Change that one line if your plan
does not include the model named, or if you want a lane to run cheaper.

| Agent | Model | Effort | Needs |
|---|---|---|---|
| `runner` | `claude-sonnet-5-5` | — | — |
| `researcher` | `claude-opus-5-5` | medium | — |
| `reviewer` | `claude-opus-5-5` | medium | — |
| `opus-implementer` | `claude-opus-5-5` | high | — |
| `fable-implementer` | `claude-fable-5-2` | xhigh | — |
| `ui-runner` | `claude-opus-5-5` | — | argent |
| `sol-implementer` | `claude-haiku-5-5` | low | Codex, `gpt-6.2-sol` |
| `astra-implementer` | `claude-haiku-5-5` | low | Codex, `gpt-6.2-astra` |
| `astra-reviewer` | `claude-haiku-5-5` | low | Codex, `gpt-6.2-astra` |
| `codex-runner` | `claude-haiku-5-5` | low | Codex, `gpt-6.2-sol` or `gpt-6-luna` |

To drop the models you do not have from the routing rule:

```sh
bin/deploy --models opus-5.5,sonnet-5.5
```

## Routing

[The model routing rule](../rules/40-model-routing.md) ranks the models by
cost, intelligence and taste. It also says which agent gets which work.

The rankings come from one operator's own eight-week corpus. Treat the order
as a starting point, and the numbers as that operator's, not yours. The
reasoning is in [the routing rationale](../notes/model-routing-rationale.md).

## Gates

[The operating model rule](../rules/10-operating-model.md) gives the gates:
plan, test-first, review, investigation, execution and checkpoint. Each gate
says when it applies; the test-first gate, for example, exempts docs and
config. Review is mandatory, and the reviewer is never the author.

## Codex mechanics

[The subagent mechanics rule](../rules/60-subagent-mechanics.md) says how the
Codex CLI is called. The agent files in `agents/` give each wrapper's prompt,
wait steps and label prefix. The `--reasoning-effort` flag is gone as of Codex
CLI 0.153.4; effort is a config override now.

## UI automation

[The UI automation rule](../rules/80-ui-automation.md) sends all device work to
`ui-runner`. It also gives the measured cost of an in-thread run.
