| researcher        | opus-5.5    | medium          | *why* — root cause, relevant code surface  | fix, plan, edit                                       |
| runner            | sonnet-5.5  | —               | *what happened* — build/test verdicts      | fix (beyond trivial retry), dump raw logs             |
| ui-runner         | opus-5.5    | medium/high     | *what the UI did* — device flows, assertions | fix code, paste hierarchies or screenshots          |
| opus-implementer  | opus-5.5    | medium/high/max | implement judged and taste work            | architecture, review                                  |
| fable-implementer | fable-5.2   | xhigh/max       | implement the hardest judged and taste work | routine work, untrusted input, security- or biology-adjacent work, architecture, review |
| sol-implementer   | gpt-6.2-sol | routine only    | implement free volume work                 | hard tier, untrusted input, taste work, fill spec gaps |
| astra-implementer | gpt-6.2-astra | high/xhigh/max  | implement the hardest well-specified work  | routine work, taste work, untrusted input, fill spec gaps, `--full-auto` |
| reviewer          | opus-5.5    | medium          | is it actually done, red/green provenance  | fix code                                              |
| astra-reviewer    | gpt-6.2-astra | high/xhigh      | independent cross-lab verdict on critical work | fix code, see the Claude verdict before reviewing |
| codex-runner      | gpt-6.2-sol / gpt-6-luna | routine | read-only Codex investigation and batch work | code, edits, review, verdicts, untrusted input |
