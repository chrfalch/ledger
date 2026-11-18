## Model routing

Rankings, higher = better. Cost is what the operator actually pays. Intelligence is how hard a
problem the model takes unsupervised. Taste covers UI/UX, code quality, API
design, copy. Rationale and benchmarks: `~/.claude/notes/model-routing-rationale.md`.

| model       | cost | intelligence | taste | note                                   |
|-------------|------|--------------|-------|----------------------------------------|
<!-- needs: gpt-6-luna -->
| gpt-6-luna  | 8    | 4            | —     | Codex plan; trivial batch only         |
<!-- /needs -->
<!-- needs: haiku-5.5 -->
| haiku-5.5   | 8    | 5            | —     | trusted text only; >100k prompt = 5x   |
<!-- /needs -->
<!-- needs: gpt-6.2-sol -->
| gpt-6.2-sol | 7    | 8            | 6     | Codex plan; injection resisted 99.76% benchmark, 91.65% generated; external agent messages engaged 0% |
<!-- /needs -->
<!-- needs: sonnet-5.5 -->
| sonnet-5.5  | 7    | 7            | 7     |                                        |
<!-- /needs -->
<!-- needs: opus-5.5 -->
| opus-5.5    | 5    | 9            | 9     | you; default for everything judged     |
<!-- /needs -->
<!-- needs: gpt-6.2-astra -->
| gpt-6.2-astra | 4  | 9            | 6     | Codex only; cost score assumes plan    |
<!-- /needs -->
<!-- needs: fable-5.2 -->
| fable-5.2   | 4    | 10           | 9     | hardest judged work; xhigh/max only    |
<!-- /needs -->

| agent             | engine      | effort          | answers                                    | never does                                            |
|-------------------|-------------|-----------------|--------------------------------------------|-------------------------------------------------------|
<!-- needs: researcher -->
| researcher        | opus-5.5    | medium          | *why* — root cause, relevant code surface  | fix, plan, edit                                       |
<!-- /needs -->
<!-- needs: runner -->
| runner            | sonnet-5.5  | —               | *what happened* — build/test verdicts      | fix (beyond trivial retry), dump raw logs             |
<!-- /needs -->
<!-- needs: argent, ui-runner -->
| ui-runner         | opus-5.5    | medium/high     | *what the UI did* — device flows, assertions | fix code, paste hierarchies or screenshots          |
<!-- /needs -->
<!-- needs: opus-implementer -->
| opus-implementer  | opus-5.5    | medium/high/max | implement judged and taste work            | architecture, review                                  |
<!-- /needs -->
<!-- needs: fable-implementer, fable-5.2 -->
| fable-implementer | fable-5.2   | xhigh/max       | implement the hardest judged and taste work | routine work, untrusted input, security- or biology-adjacent work, architecture, review |
<!-- /needs -->
<!-- needs: sol-implementer, gpt-6.2-sol -->
| sol-implementer   | gpt-6.2-sol | routine only    | implement free volume work                 | hard tier, untrusted input, taste work, fill spec gaps |
<!-- /needs -->
<!-- needs: astra-implementer, gpt-6.2-astra -->
| astra-implementer | gpt-6.2-astra | high/xhigh/max  | implement the hardest well-specified work  | routine work, taste work, untrusted input, fill spec gaps, `--full-auto` |
<!-- /needs -->
<!-- needs: reviewer -->
| reviewer          | opus-5.5    | medium          | is it actually done, red/green provenance  | fix code                                              |
<!-- /needs -->
<!-- needs: astra-reviewer, gpt-6.2-astra -->
| astra-reviewer    | gpt-6.2-astra | high/xhigh      | independent cross-lab verdict on critical work | fix code, see the Claude verdict before reviewing |
<!-- /needs -->
<!-- needs: codex-runner -->
| codex-runner      | gpt-6.2-sol / gpt-6-luna | routine | read-only Codex investigation and batch work | code, edits, review, verdicts, untrusted input |
<!-- /needs -->

<!-- needs: runner, reviewer -->
Pipeline: investigate → resolve ambiguity → plan → ledger → red tests → implement
(effort stated) → verify (runner) → review (reviewer) → clear point if more remains
→ you accept.
<!-- /needs -->

Rules:
- Defaults, not limits. If cheaper output misses the bar, redo it smarter or at
  higher effort without asking. Judge the output, not the price.
- For anything that ships: intelligence > taste > cost. Cost is a tie-breaker.
- Effort: medium routine, high hard, xhigh/max difficult or taste-critical.
- **Implementation — two questions: volume or judged? if judged, taste?** The
  agent table gives each agent's effort range and its never-does list.
<!-- needs: gpt-6.2-sol, sol-implementer -->
  - Volume (mechanical, clear-spec, free is the point: migrations, codemods, test
    scaffolding, bulk renames) → `sol-implementer`. Needs high reasoning → not
    volume.
<!-- /needs -->
<!-- needs: opus-implementer -->
  - Judged with taste (features, user-facing, API design, judgment in approach) →
    `opus-implementer`, effort stated.
<!-- /needs -->
<!-- needs: fable-5.2, fable-implementer -->
  - Judged or taste work at the hardest tier, where Opus at max is expected to
    fall short (long-horizon, taste-critical) → `fable-implementer`.
    Choose it when you plan, never as a retry after an Opus failure. At high effort
    it scored level with Opus at twice the price: use Opus.
    Never untrusted input, never security- or biology-adjacent work.
<!-- /needs -->
<!-- needs: gpt-6.2-astra, astra-implementer -->
  - Hard, crisply specified, non-taste (multi-file refactors, concurrency, tricky
    migrations, algorithmic, long many-file sessions) → `astra-implementer`. Spec
    complete, criteria mechanical. In doubt → Opus: cheaper on our plan,
    injection-hardened.
<!-- /needs -->
  - Untrusted or externally-sourced input → opus-5.5 only.
  - Ambiguous spec → nobody. Resolve it first.
<!-- needs: runner, researcher -->
- Errors → `runner` first; `researcher` when the cause is not obvious from them.
<!-- /needs -->
<!-- needs: gpt-6.2-sol, codex-runner -->
- Deep investigation with a self-contained brief → `codex-runner` on gpt-6.2-sol
  (plan-covered).
<!-- /needs -->
<!-- needs: gpt-6-luna, codex-runner -->
- Trivial batch work on trusted text (classify, extract, short summaries) →
  `codex-runner` on gpt-6-luna.
<!-- /needs -->
<!-- needs: haiku-5.5 -->
- Same trivial batch work when gpt-6-luna is not available → a subagent with
  `model: 'claude-haiku-5-5'`, effort low or medium. Never for code, review or
  verdicts. Keep each prompt under 100k tokens: past that, every rate is 5x.
<!-- /needs -->
<!-- needs: researcher -->
- Deep investigation that needs session state or iteration → `researcher`.
<!-- /needs -->
<!-- needs: argent, ui-runner -->
- Computer use → `ui-runner` (opus-5.5, injection robustness). Never in-thread — a view
  hierarchy in your context is re-read by every later turn.
<!-- /needs -->
- ⚠ Every model here **expands scope and fills gaps** if allowed. Complete specs;
  scope review is mandatory. Never add "verify your work".
- Never use Haiku 4.5. Never use Haiku 5.5 for code, review, verdicts or
  untrusted input.

### Usage pace

The usage-pace hook adds a line when Claude usage runs ahead of an even pace.
When the line says to route work to OpenAI:
<!-- needs: gpt-6.2-sol, sol-implementer -->
- Send volume work to `sol-implementer`.
<!-- /needs -->
<!-- needs: gpt-6.2-astra, astra-implementer -->
- Send hard, clearly specified work to `astra-implementer`.
<!-- /needs -->
<!-- needs: opus-implementer -->
- Keep taste work and untrusted input on `opus-implementer`.
<!-- /needs -->
<!-- needs: fable-5.2, fable-implementer, opus-implementer -->
- Move Fable work to `opus-implementer` at max.
<!-- /needs -->
<!-- needs: reviewer -->
- Keep reviews on Claude (`reviewer`).
<!-- /needs -->
<!-- needs: gpt-6.2-sol, codex-runner -->
- Large investigation may go to `codex-runner`.
<!-- /needs -->
- Tell the operator once per task that work moved to OpenAI and why.
  Include the usage and pace numbers.

When the line says both plans are high, do not switch models.
Ask the operator what to do.
