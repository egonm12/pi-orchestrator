---
status: accepted
date: 2026-09-25
---

# Budgeted orchestrator, not a hard tool boundary

The main session is held in the orchestrator role by a per-turn budget on exploratory commands, and going over the budget denies the call with an instruction to delegate. Small known actions, such as a single lookup, a small edit or a commit, stay in the main session. This replaces ticket 03's design, which removed `bash`, `edit`, `write`, `mcp` and `mcpScript` from the main session entirely and allowed "not even a trivial edit".

## Considered options

- **Hard boundary (ticket 03).** Keeps the most context out of the main session, but every commit, one-line fix or test run pays a worker's startup cost, and the session stops working when delegation does. It was built and never wired in.
- **Advice only (the Claude Code orchestrator plugin).** Protocol, per-prompt reminder and a warning counter. Cheap, but measured on 75 real prompts Claude delegated 6 of the 29 that needed it, so advice alone does not hold the role.
- **Budgeted (chosen).** Keeps the advice layer and turns the counter's warning into a deny, so research is enforced to go to workers while actions do not pay for one.

## Consequences

- Ticket 03's `orchestrator-boundary.ts`, `orchestrator-launch.ts` and `registry-probe.ts` do not move to `pi-orchestrator`; they stay in the archived harness.
- What counts as an exploratory command, the budget and the deny message are designed separately and are not fixed by this record.
