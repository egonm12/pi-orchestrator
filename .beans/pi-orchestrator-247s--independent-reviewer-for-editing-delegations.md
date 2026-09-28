---
# pi-orchestrator-247s
title: Independent reviewer for editing delegations
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-28T09:17:18Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-kokv
    - pi-orchestrator-uezs
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. A subagents item review: <delegation id> starts an independent reviewer for an editing delegation: routed through the auto model at the implementer's tier or higher, never on the implementer's rung, with review instructions (check the change against the task, rerun nothing unless told, answer accept or request changes with reasons). A delegation without a tier (a forked worker, or one whose agent definition names a model) counts as elevated. subagents_verdict refuses a self-judged verdict on an elevated or critical delegation unless it names the reviewer delegation. The protocol gains a paragraph on reviewers.

## Acceptance criteria

- [x] A review item is routed at or above the implementer's tier and never on its rung
- [x] The reviewer's decision record links to the reviewed delegation
- [x] subagents_verdict on an elevated or critical delegation without a reviewer delegation is refused; with one it is accepted
- [x] Forked and agent-model delegations are gated as elevated
- [x] The protocol describes reviewers
- [x] Tests

## Blocked by

- pi-orchestrator-kokv
- pi-orchestrator-uezs


## Notes from uezs
- Routing constraints exist: setRoutingConstraints(id, { minimumTier, excludedRung }) in the auto provider, read at the worker's first request; nothing calls it yet, so WorkerSetup needs a field to pass them.
- When routing refuses, runs in shadow mode or is off, a worker falls back to the orchestrator's session model without checking the excluded rung. ADR 0010 says a reviewer never runs on the implementer's rung, so a review item whose fallback model is the implementer's rung must fail with a reason instead of running.
- A compaction summary gets a new session id and is routed without the worker's constraints; decide whether that matters for a reviewer.

## Summary of Changes

A subagents item `review: <delegation id>` starts an independent reviewer for a finished editing delegation of the orchestrator session. It is routed under routing constraints: minimum tier the delegation's tier (elevated when it has none), excluded rung the rung it ran on (from its latest decision, fork or agent-model record, else the worker board's served rung). A worker whose fallback to the session model would be its excluded rung fails with the reason instead of running (auto provider). The reviewer gets review rules and the reviewed delegation's task, Result and edit/write paths, read from its saved worker session (or the board's unsaved messages), in its system prompt. Its decision record carries `reviewedDelegationId`. `review` excludes fork and resume, is refused in a worker's own call, and ignores an agent definition's model. subagents_verdict takes an optional `reviewer` and refuses a self-judged verdict where the gate action is a reviewer (elevated, critical, tierless at the medium level; one function, `gateAction`); a named reviewer must be a completed review of the same delegation, started after its latest edit. The protocol gained a reviewer paragraph; an editing Result's note says when a reviewer is needed. A compaction summary of a reviewer is routed without its constraints; accepted, as it only condenses the reviewer's own context.

Files:
- src/router/auto-provider.ts
- src/router/extension.test.ts
- src/routing/decision-record.ts
- src/routing/decision-record.test.ts
- src/subagents/quality-gate.ts (new)
- src/subagents/quality-gate.test.ts (new)
- src/subagents/review.ts (new)
- src/subagents/review.test.ts (new)
- src/subagents/extension.ts
- src/subagents/extension.test.ts (one test adapted; the file also holds another session's worker widget hunk)
- src/subagents/verdict.ts
- src/subagents/worker.ts
- src/subagents/worker-sessions.ts
- src/subagents/worker-board.ts
- src/subagents/resume.ts
- src/subagents/orchestrator-protocol.ts
- README.md (Subagents tool, Verdicts, new Reviewers section, Orchestrator protocol, How routing decides; the file also holds another session's worker widget hunk)

Open for the owner:
- In shadow mode (the default) or with routing off every worker runs on the session model, so an elevated, critical or tierless delegation made there can only be reviewed after the session model changes; until then its verdict, and so git commit, is blocked.
- A reviewer that runs an editing call (for example an unrecognised bash command) becomes an editing delegation itself, at elevated or higher, so it needs its own reviewer. Should a reviewer's edits count, or should reviewers get read-only tools?


Orchestrator verdict: accepted. Verified in isolation (detached worktree with only this ticket's files and hunks; another session's widget work is uncommitted in the main tree): typecheck clean, npm test 743 pass 0 fail. quality-gate.ts and the auto provider's fallbackPin read. Nit: fallbackPin compares model names case-sensitively while isExcluded ignores case; harmless while both come from the same pin.
