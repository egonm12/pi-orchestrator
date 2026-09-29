---
# pi-orchestrator-k2xj
title: Labels on worker rows
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-29T20:05:10Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 21 to 27).

## What to build

Each item of the subagents tool gains an optional short `label`, such as `research: budget code`. The worker board keeps the label and the worker's tier. Worker rows in the widget, the /subagents picker, the transcript view's nested workers and the status output read label · tier · rung · state · elapsed · turns · activity. The name falls back from label to agent definition to `worker`; reviewers are always `reviewer`. Long labels are shortened to fit one line.

## Acceptance criteria

- [x] Optional `label` in the subagents tool schema
- [x] Rows show label · tier · rung · state · elapsed · turns · activity in widget, picker, transcript view and status
- [x] Fallback to agent definition, then `worker`; reviewers always `reviewer`
- [x] Long labels shortened to keep one line per worker
- [x] Widget, render, picker and transcript-view tests with a real worker board and a plain theme, plus end-to-end board and widget tests

## Blocked by

None, can start immediately.

## Summary of changes

Added an optional subagents label, kept labels and routed tiers on the worker board, and showed consistent compact rows in the widget, picker, nested transcript workers, tool rendering and status output. Added real-board and end-to-end tests for labels, tiers, fallbacks and one-line truncation. Typecheck and full test suite pass.

Review follow-up fixes:

- Resumed named workers and resumed reviewers keep their display identity: the worker outcome now saves the label, and a resume reads the saved label, agent definition and review before the run enters the worker board (`savedWorkerIdentity` in `src/subagents/resume.ts`). End-to-end tests cover a resumed named worker and a resumed reviewer.
- Compact rows keep tier, rung and state visible at narrow widths: the width for the mandatory fields is reserved first and only the label is shortened, so each worker stays on one line. Widget tests cover narrow widths.
- The status snapshot no longer prints a separate `Agent:` line when a board row is present, so the board row is the one identity shown for that worker. The status test checks this with an agent-definition worker.

The status test's orchestrator active tools now include `hold`, because the new agent-definition worker in that test lists `hold` as a tool and `resolveAgent` only keeps definition tools the orchestrator has active (`src/subagents/agent-definitions.ts`). Without it the worker never reaches its hold tool and the test times out.
