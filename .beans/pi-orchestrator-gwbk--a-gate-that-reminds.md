---
# pi-orchestrator-gwbk
title: A gate that reminds
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T21:39:42Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 10 to 13, and the gate part of 20). ADR 0013, amending ADR 0010.

## What to build

The quality gate never denies commit or push. A commit or push result gets a reminder naming the delegations still waiting for a verdict. The verdict-reminder messages and the routing report's missing-verdict count stay. Gate levels and gate actions (ADR 0011) are unchanged. The protocol text describes the reminding gate instead of a refusal.

## Acceptance criteria

- [x] A commit or push with a delegation waiting for a verdict succeeds
- [x] Its result names the waiting delegations
- [x] The routing report still counts missing verdicts
- [x] Gate levels and gate actions unchanged
- [x] Protocol text describes the reminding gate
- [x] Tests use the real-session seam

## Blocked by

None, can start immediately.

## Summary of changes

- `src/subagents/commit-gate.ts`: the gate no longer denies commit or push in `tool_call`. A `tool_result` hook appends a reminder to the orchestrator's `git commit` or `git push` result that names each editing delegation still waiting for a verdict (`commitReminder`, replacing `commitDenial`). An unreadable record folder no longer denies either: the result says the gate cannot tell what waits. The turn-end notice stays; only its trailing "git commit and git push are denied until then" clause is dropped, since it is no longer true. Gate levels, gate actions (`quality-gate.ts`, `gate-level.ts`) and the routing report are untouched.
- `src/subagents/orchestrator-protocol.ts`: the gate paragraph's last sentence now says a commit or push always goes through, its result names the delegations still waiting, and the orchestrator records those verdicts or tells the user which are missing. The nudge paragraph and delivery are left to tickets 2uc7 and 6yxt.
- Tests at the real-session seam (`orchestratorSession` with the scripted provider) in `src/subagents/extension.test.ts`: commit and push run and reach a bare origin while delegations wait, each result names them, the report counts them missing until judged, and the notice is kept; at gate level low an ungated delegation is named in no commit result and counted ungated, and at medium it is named; an unreadable record folder lets a commit through with a reminder. The running-delegation case and the `/pi-orchestrator gate` harness test use a new `toolResult` harness hook. `commit-gate.test.ts` checks the reminder text.
- README: the Verdicts section, the protocol summary and other mentions of the commit block describe the reminding gate. CONTEXT.md already described it.
