## Subagent mechanics

- Claude models run via the Agent/Workflow model parameter with `effort` per
  delegation. opus-5.x: thinking on by default; `thinking: disabled` with xhigh/max
  → 400; `max_tokens` caps thinking plus response.
<!-- needs: fable-5.2 -->
- fable-5.2: adaptive thinking is always on; `thinking` set to enabled or
  disabled → 400. Forced tool use (`tool_choice` any or tool) → 400. Only Fable
  5.2 and Mythos 5.2 can read its thinking blocks.
<!-- /needs -->
<!-- needs: codex -->
- OpenAI models run only through the Codex CLI (`codex exec` / `codex review`).
  `~/.codex/config.toml` sets its own default model, which can be any model. Always
  pass `-m` explicitly to `codex exec`: `-m gpt-6.2-sol`, or `-m gpt-6.2-astra`.
  Never rely on the config default. Reasoning effort is a config override, not a
  flag: `-c model_reasoning_effort=high|xhigh|max`. `codex review` accepts
  neither `-m` nor `-s`; set its model with `-c model="gpt-6.2-astra"`.
<!-- /needs -->
<!-- needs: gpt-6.2-sol -->
- On `model_not_found`, upgrade with `brew upgrade codex`.
<!-- /needs -->
<!-- needs: gpt-6.2-astra -->
- ⚠ Astra: `approval_policy = "on-request"`, set globally in `~/.codex/config.toml`.
  Never `--full-auto`, never
  `approval_policy = "never"`. Reviews `-s read-only`. Log tool results with a
  `post_tool_use` hook.
<!-- /needs -->
<!-- needs: codex, codex-runner -->
- Every Codex run goes through a wrapper agent. The orchestrator never runs `codex exec` or `codex review` itself, not even in the background.
<!-- /needs -->
<!-- needs: codex -->
- Inside a wrapper, a Codex run can exceed Bash's 10-minute foreground limit. The
  wrapper starts Codex in the background with no `timeout`, then waits
  on a done-file with Monitor. The wrapper never returns before Codex ends. Each
  wrapper agent file gives the wait steps.
<!-- /needs -->
<!-- needs: codex -->
- Parallel Codex implementers use `isolation: 'worktree'`.
<!-- /needs -->
<!-- needs: codex -->
- Workflow budgets count Claude tokens only. Sol and Luna are plan-covered; track Astra spend via
  Codex thread metadata (`model` / `reasoningEffort`) until the plan allowance is
  confirmed.
<!-- /needs -->
