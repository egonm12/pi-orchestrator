---
# pi-orchestrator-kokv
title: Orchestrator records verdicts on editing delegations
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T08:40:24Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-y8cd
    - pi-orchestrator-jeyq
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. The runtime tracks, per delegation, whether it edited: its session ran edit, write, or a bash command the budget's classification does not recognise as a read-only search or a build or test run. Edits by a worker's own workers belong to the top-level delegation. A new subagents_verdict tool (delegation id, accept or request_changes, reason) lets the orchestrator record a verdict on an editing delegation, whether from its own spot check or from a reviewer; it attaches the verdict to the decision record, and the routing report counts it. A verdict on a non-editing delegation is refused with a reason. The protocol gains a paragraph on judging Results and recording verdicts.

## Acceptance criteria

- [x] Editing is recorded per delegation and survives the worker's end; nested workers' edits count for their top-level delegation
- [x] bash that the classification does not recognise as read-only or build/test counts as editing
- [x] ctx_execute and ctx_execute_file in a worker's session count as editing (they run arbitrary code), although the budget counts them as exploratory (owner decision 2026-09-28)
- [x] subagents_verdict records accept and request_changes on editing delegations; the routing report shows them
- [x] A verdict on an unknown or non-editing delegation is refused with a reason
- [x] A later verdict on the same delegation replaces the earlier one in the report
- [x] The protocol describes verdicts
- [x] Tests

## Blocked by

- pi-orchestrator-y8cd
- pi-orchestrator-jeyq

## Summary of Changes

- `src/subagents/editing.ts` (new): `isEditingToolCall` is the one rule: kind `edit`, bash or powershell whose kind is `version-control` or `unrecognised` (so `git commit` and `git checkout` in a worker count), and `ctx_execute` / `ctx_execute_file`. `trackEdits` gives each worker run an inline extension on pi's `tool_result` event, which fires only for a call that ran (a call a `tool_call` hook blocked, or one for a missing tool, edited nothing). The first editing call in a run appends an `edit` record. A worker's own worker writes it under the delegation that started it, with `nestedDelegationId`; the running delegations are kept on the process global, as worker-sessions.ts keeps its marks. `delegationEdits` reads one delegation's edits and latest verdict from the record folder.
- Where the fact lives: an append-only `edit` record in the routing record folder (`src/routing/decision-record.ts`, `decision-record/3` only): delegation id, `orchestratorSession`, `tool`, optional `nestedDelegationId`. It outlives the worker, a pi reload and a resume of the orchestrator's session. One per run: a resume that edits writes another under the same delegation id, so a record newer than the latest verdict means a verdict is due. mw81 can derive "editing delegations of this orchestrator session without a verdict" from that ordering, and l8af can hook the gate requirement onto `WorkerResult.edited` at the worker's end.
- Verdict records gain an optional `reason` (free text, redacted and cut to 500 characters like the other fields).
- `src/routing/verdicts.ts`: `attachVerdict` takes a `reason` and attaches to a routed decision, a fork record, an agent-model record (these used to become orphans), or, for a worker the router did not route (routing off or disabled by a failure), its edit record. A known editing delegation is never orphaned. Only a routed decision still yields a learning observation.
- `src/subagents/verdict.ts` (new): `subagents_verdict` (`delegationId`, `verdict` accept|request_changes, `reason`). It refuses: a call from any session but the orchestrator's; a bad verdict or a blank reason; a queued or running delegation; a worker's own worker (naming the delegation its edits count for); a delegation that did not edit; an unknown id; another orchestrator session's delegation. Its reply names a replaced earlier verdict. `VerdictInput` leaves room for 247s' reviewer id and mxmz's gate-level raise.
- `src/subagents/worker.ts`: `runWorker` opens the session, tracks edits for the whole run, and sets `edited: true` on the result. `src/subagents/extension.ts` adds the line "This delegation edited. Judge its Result, then record a verdict with subagents_verdict." to an editing item's part of the result (and completion notice), only in the orchestrator's own calls, and registers the tool. `agent-definitions.ts` never gives a worker `subagents_verdict`; `tool-call-kind.ts` classes it as a delegation tool.
- `src/routing/routing-report.ts`: verdicts on delegations without a routing decision (forks, agent-model and unrouted workers) had no row; they now count on a line of their own, latest per delegation.
- Protocol: a paragraph on judging an editing delegation's Result and recording the verdict with `subagents_verdict`.
- Docs: README (a Verdicts section, the intro, the protocol, the budget's never-counted list, resume, the state table, switching off); CONTEXT.md defines Editing delegation.
- Tests: `editing.test.ts` (the rule); `decision-record.test.ts` (edit record, reason); `extension.test.ts` with real worker sessions (each editing kind and each non-editing kind, a guard-blocked write, records, the result line, accept then request_changes and the report, every refusal, nested edits, resume, fork, agent-model and unrouted attach, the protocol paragraph); the report and acceptance tests for the new line.

Open for the owner:
- `ctx_batch_execute` runs shell commands but does not count as editing: the owner decision names only `ctx_execute` and `ctx_execute_file`.
- A tool the classification does not know (kind `other`, such as another extension's patch tool) does not count as editing.


Orchestrator verdict: accepted. subagents_verdict refusals and the editing rule read; typecheck clean; npm test 719 pass 0 fail (the earlier 'hang' was macOS lacking the timeout command). CONTEXT.md entry trimmed to glossary language.
Open for the owner: ctx_batch_execute also runs shell commands but does not count as editing (the owner decision named ctx_execute and ctx_execute_file).
