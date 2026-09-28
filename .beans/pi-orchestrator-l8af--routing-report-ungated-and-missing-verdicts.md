---
# pi-orchestrator-l8af
title: Ungated and missing verdicts in the routing report
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T14:23:32Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-mxmz
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010, 0011 and 0013. Since ADR 0013 turns the gate's refusals into guidance, this report is where a skipped gate stays visible. An editing delegation whose gate action was none is recorded as ungated. When an editing delegation ends, its gate requirement is recorded (ungated, spot check or reviewer). The routing report derives missing: a required verdict with no verdict record. This avoids pi's session_shutdown, which also fires for reload, resume, new and fork, and a verdict recorded later (after a resume) simply removes it from missing. The routing report counts ungated and missing apart; neither is a learning observation. The old meaning of missing (a reviewer result without structured output) is retired, together with the pi-subagents verdict-reviewer agent and reading verdicts from structured output.

## Acceptance criteria

- [x] Ungated delegations appear in the decision record and the report's ungated count
- [x] A required verdict with no verdict record counts as missing; recording the verdict later removes it
- [x] Neither creates a learning observation
- [x] Verdicts backed by a same-rung review are counted apart (owner decision 2026-09-28)
- [x] The verdict-reviewer agent and structured-output verdict reading are removed, with their tests
- [x] Tests

## Blocked by

- pi-orchestrator-mxmz


## Summary of Changes

- `src/routing/decision-record.ts`: new `gate-requirement` record type (`delegationId`, `timestamp`, `gateLevel`, `gateAction`), validated on write and read like the others (/3 only, no unknown fields), with `buildGateRequirementRecord`. `GATE_ACTIONS`/`GateAction` move here from `quality-gate.ts` so the reader validates them. `VERDICTS` is now `accept` and `request_changes`: the old `missing` (a reviewer result without structured output) is retired, so a `missing` verdict record fails validation. No real record folder held one (checked `~/.pi/agent/pi-orchestrator/routing`).
- `src/subagents/quality-gate.ts`: `recordGateRequirement(recordDir, delegationId, level)` writes the delegation's gate action at `level` from its tier (`delegationRouting`, untiered counts as elevated). Re-exports `GATE_ACTIONS`.
- `src/subagents/extension.ts`: after each `runWorker` in the orchestrator's own call (new, retry, review and resume paths, foreground and background), a run that edited records its gate requirement at `gateLevels.inForce(ctx)`. A worker's own call leaves it to the delegation its edits count for. No `session_shutdown`. A failure is logged once and never fails the item.
- `src/routing/routing-report.ts`: each row, the totals and the unrouted line count `accept`, `request_changes`, `same-rung accept`, `same-rung request_changes`, `ungated` and `missing` (`GateCounts`). A same-rung verdict counts apart from the others. Ungated: latest gate requirement is `none`. Missing: latest gate requirement needs a verdict and no verdict follows the latest edit record in file order, so a later verdict removes it and a resume that edits again is missing again. `unroutedVerdicts` becomes `unrouted`, and its line `unrouted delegations: ...`.
- `src/routing/verdicts.ts`: removes `verdictFromReviewResult`, `installVerdictReviewer`, `VERDICT_OUTPUT_SCHEMA`, `VERDICT_REVIEWER_AGENT` and `REVIEW_VERDICTS`; `observationFor` no longer special-cases `missing`. `src/routing/verdict-reviewer.md` deleted. `src/subagents/verdict.ts` uses `VERDICTS`.
- Tests: gate requirement record validation and `missing` refused (`decision-record.test.ts`); known-folder report with ungated, missing, same-rung and unrouted counts, plus missing removed by a later verdict and back after a resume that edits (`routing-report.test.ts`); structured-output, reviewer-install and live Haiku review tests removed, `missing` attach refused (`verdicts.test.ts`); extension tests for a requirement at the level in force (low: ungated, no ledger written), nested workers, resumes that read or edit again (`extension.test.ts`); report shape updates in `retry.test.ts` and `routing-acceptance.test.ts`.
- README: Verdicts section describes the gate requirement record and the report's columns, Reviewers says same-rung reviews are counted apart, State table lists gate requirements.

Notes: an editing run that never ends in this process (pi killed mid-run) leaves an edit record but no gate requirement, so the report shows it as neither ungated nor missing. `docs/split-plan.md` still lists `verdict-reviewer.md` as a historical move list; left as it is.


Orchestrator verdict: accepted. countGate in routing-report.ts derives ungated and missing as specified; typecheck clean; npm test 774 pass 0 fail.
