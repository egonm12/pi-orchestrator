---
# pi-orchestrator-4n1u
title: An off rung passes the agent's thinking level through
status: completed
type: bug
priority: normal
created_at: 2026-09-25T21:09:25Z
updated_at: 2026-09-25T21:09:56Z
---

## Observed
In src/router/auto-provider.ts the inner request is built as `{ ...rest, ...(reasoning === undefined ? {} : { reasoning }) }`. For an `:off` rung (or a rung clamped to off), `streamReasoning` returns undefined, so the caller's `reasoning` (pi-subagents' agent thinking, for example `low` for scout, `high` for reviewer) stays in `rest` and reaches the rung. ADR 0006 says the rung sets the effort and the requested thinking level is ignored.

The existing off-rung and clamp tests pass no caller `reasoning`, so they cannot catch this.

## Todo
- [x] Failing test: off rung with caller reasoning high sends no reasoning
- [x] Failing test: clamped-to-off rung with caller reasoning sends no reasoning
- [x] Drop the caller's reasoning before forwarding

## Summary of changes
- The auto provider drops the caller's `reasoning` before forwarding, so only the rung's effort (or none, for an off or clamped rung) reaches the model.
- The off-rung and clamp tests now pass a caller thinking level (`high`, `low`) as pi-subagents does; both were red before the fix.
