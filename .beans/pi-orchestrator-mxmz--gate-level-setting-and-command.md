---
# pi-orchestrator-mxmz
title: Gate level
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T14:11:01Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-vu2o
    - pi-orchestrator-mw81
    - pi-orchestrator-247s
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0011, as amended by ADR 0013. The gate level (low, medium, high, max) sets the gate action for each editing delegation from its tier, using the table in ADR 0011: none, spot check or reviewer. Critical always needs a reviewer, and a delegation without a tier counts as elevated. The gate action replaces today's fixed medium rule in one place, and everything that asks "does this delegation need a verdict, and does it need a reviewer" reads it:
- the commit gate and the turn-end notice name only delegations whose gate action is not none (today the gate blocks; epic pi-orchestrator-atod turns it into a notice, and this ticket must not depend on which);
- subagents_verdict refuses a self-judged verdict where the gate action is reviewer.

At max, reviewers are told to rerun the Result's Verified by commands. The personal default is medium, a project may override it, and /pi-orchestrator gate <level> sets it for the session. The orchestrator may raise the level for one delegation with a reason in subagents_verdict, never lower it. The protocol names the current level.

## Acceptance criteria

- [x] Every cell of the ADR 0011 table gives the right gate action, and a delegation without a tier counts as elevated
- [x] Gate action none: no verdict needed; the delegation is never named by the commit gate or the turn-end notice
- [x] Gate action reviewer: subagents_verdict refuses a self-judged verdict; spot check: a self-judged verdict is accepted
- [x] Personal setting, project override and the session command work; an invalid level is refused with usage
- [x] Raising for one delegation works and is recorded; lowering is refused
- [x] At max, reviewer instructions include rerunning Verified by
- [x] The protocol names the current gate level
- [x] Tests

## Blocked by

- pi-orchestrator-vu2o
- pi-orchestrator-mw81
- pi-orchestrator-247s


## Summary of Changes

- `src/subagents/quality-gate.ts`: `gateAction(tier, level)` reads ADR 0011's table (adds `none`); a delegation without a tier counts as elevated. Adds `isGateLevel`, `isHigherGateLevel`, `tiersByGateAction`. `GATE_LEVELS`/`GateLevel` live in `src/routing/decision-record.ts` so the record reader validates them without loading the subagents side.
- `src/subagents/gate-level.ts` (new): `GateLevels` gives the level in force per orchestrator session (settings, or a session level), and adds `/pi-orchestrator gate [level]`: with a level it sets it for the session (dropped at the next session_start), without one it shows the level and its source, anything else prints the usage.
- `src/subagents/settings.ts`: `orchestrator.subagents.gateLevel`, default `medium`, project override only under personal `allowProjectOverrides`.
- `src/subagents/commit-gate.ts`: `waitingForVerdict` leaves out delegations whose gate action is none, for both the commit/push check and the turn-end notice. It does not depend on whether the gate blocks or notes (epic atod).
- `src/subagents/verdict.ts`: `subagents_verdict` checks the reviewer requirement at the level in force, or at a raise given with `gateLevel` and `gateLevelReason`. A raise that is not above the level in force is refused. The raise is recorded on the verdict record as `gateLevelRaise: { from, to, reason }` (validated and redacted in `decision-record.ts`, passed on by `attachVerdict`).
- `src/subagents/review.ts`: `reviewRules(level)`; at max the reviewer reruns every Verified by command. `reviewerPrompt` takes the level in force when the review starts.
- `src/subagents/orchestrator-protocol.ts`: a gate level paragraph names the level in force, what each tier needs and how to raise it. The verdict and reviewer paragraphs now follow the level.
- `src/subagents/extension.ts`: wires the gate levels into the tool result's edited line (none, spot check or reviewer), the reviewer prompt, the verdict tool, the commit gate and the protocol.
- README: new Gate level section, plus updates to Verdicts, Reviewers, Orchestrator protocol, settings table and subcommands.
- Tests: table cells, levels, settings, session command, commit-gate filter, verdict refusals and raises, the record field, reviewer rules at max, protocol text.

Notes for l8af: `GateLevels.inForce(ctx)` and `gateAction(tier, level)` give the gate requirement when a delegation ends; a verdict's `gateLevelRaise` records a raise. A raise exists only on a verdict, so it never changes whether a delegation waits.


Orchestrator verdict: accepted. GATE_TABLE in quality-gate.ts matches ADR 0011 cell for cell; typecheck clean; npm test 775 pass 0 fail.
