---
# pi-orchestrator-53x3
title: Measure the delegation rate again
status: in-progress
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-29T19:58:16Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-2uc7
    - pi-orchestrator-gwbk
    - pi-orchestrator-6yxt
---

## Parent

pi-orchestrator-cml8 (user story 19). ADR 0013.

## What to build

Once the nudge, the reminding gate and the protocol on every run are in, measure the orchestrator's delegation rate again in live sessions, so ADR 0013 is judged on evidence. The agent prepares the measurement script and instructions; the owner runs it and the result is recorded against ADR 0013.

## Acceptance criteria

- [x] Measurement script and instructions prepared
- [ ] Owner has run the measurement
- [ ] Result recorded in this bean and referenced from ADR 0013

## Blocked by

- 01 Exploration nudge instead of refusal
- 02 A gate that reminds
- 03 Protocol on every run

## Preparation (agent)

Prepared, not yet run by the owner. No live result exists yet: the sessions that count start after commit 318435c (protocol on every run, 2026-09-29 00:08 +02:00).

- src/live-check/delegation-rate.ts: a script, not an extension. `extract` reads the main session files under ~/.pi/agent/sessions (workers' subagents/ folders are skipped), keeps sessions whose recorded system prompt held the orchestrator protocol (system messages replayed as pi replays them: later ones are section patches), splits them into prompts, counts a forked session's copied entries once across files by entry id and timestamp, and writes labels.jsonl (prompt text, route empty, sorted by hashed id) and outcomes.jsonl (counts only) outside the repository, mode 600. `summarize` joins the owner's labels with the outcomes and prints counts, hashed ids and a decision line.
- src/live-check/delegation-rate.md: the owner's steps, definitions, labelling criteria (the baseline's route question), sample, anonymization, what to capture and how to record the result.
- src/live-check/delegation-rate.test.ts: extraction from synthetic session files (including section patches and forks), the summary and decision, and the extract command's file boundary.
- docs/adr/0013: its consequence now says where "near 6 of 29" is made concrete and where the result is recorded.

Definitions: the denominator is plain prompts the owner labels delegate (skill prompts are reported apart, as the baseline routed slash commands apart); the numerator is those in which the orchestrator started at least one worker. Decision: fewer than 29 needed prompts is insufficient; otherwise IMPROVED when a one-sided Fisher exact test against 6 of 29 gives p < 0.05, else NEAR BASELINE: the rate is not statistically shown above the baseline, and ADR 0013 is revisited. The summary counts subagents-* messages as notices, not as wake-ups. A parsing smoke run over the owner's existing sessions (counts only, output deleted, before the window) read 46 session files and found 21 orchestrator sessions (106 prompts, no fork copies, on the rerun after the review fixes); that is not a measurement.

Remaining for the owner: run the window, label, summarize and record per delegation-rate.md, then tick the last two criteria.


## Deferral note (owner, 2026-09-29)

The window was predeclared as 2026-09-29T08:35:57Z to 2026-10-06T08:35:57Z. The owner has waived this measurement for the cml8 goal: no extraction, labels, summary or ADR 0013 result is required for the goal to close. The bean stays in progress for later. The script and instructions (src/live-check/delegation-rate.ts, src/live-check/delegation-rate.md) are preserved as they are. No result exists and none is claimed. The two unmeasured criteria stay unchecked until the owner runs the measurement.
