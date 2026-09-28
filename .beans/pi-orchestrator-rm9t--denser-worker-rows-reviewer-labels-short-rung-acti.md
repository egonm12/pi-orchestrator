---
# pi-orchestrator-rm9t
title: 'Denser worker rows: reviewer labels, short rung, activity only while running'
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T19:58:39Z
updated_at: 2026-09-28T20:37:52Z
parent: pi-orchestrator-cml8
---

Follow-up to k2xj (labels on worker rows), agreed with the owner on 2026-09-28 after seeing the live widget.

Problems seen: only a labelled worker says what it is for; reviewers and retries show plain `reviewer` or `worker`; the label is cut to about 18 characters while the full rung (`anthropic/claude-opus-5-5:xhigh`) takes about 35; the row ends with the tool name or, for a finished worker, the start of its task text.

- [x] A reviewer row shows `reviewer: <label>`, from the reviewer's own label or the reviewed delegation's label. This amends user story 24.
- [x] A retry inherits the original delegation's label
- [x] The label takes the remaining width and is shortened only when the row does not fit
- [x] The rung is shown short, as model without provider plus effort (`opus-5-5:xhigh`). The full rung stays in the transcript view and the status output
- [x] Activity is shown only while a worker runs, as one word (thinking, bash, writing). A finished row ends with its state, never with task text
- [x] The turn count is dropped from the row; the transcript view keeps it
- [x] The same row in the widget, picker, transcript view and status
- [x] Tests at the real-board widget, picker and transcript seams, with a plain theme
- [x] The row format in the cml8 PRD and CONTEXT.md (Worker widget, Label) is updated

## Summary of changes

One row format for every worker, built once in `src/subagents/worker-widget.ts` (`rowParts`) and used by the widget, the /subagents picker and its text listing, the transcript view's nested workers, the tool result and the status output: label · tier · rung · elapsed · state, then the activity only while the worker runs.

- Rows: the rung is short (`shortModel`: no provider, no `claude-` prefix, so `anthropic/claude-opus-5-5:xhigh` reads `opus-5-5:xhigh`). The turn count, tokens and task text are gone from rows. A row that is not running ends with its state; a failure's reason stays in the transcript view. Elapsed time comes before the state so that a finished row ends with its state.
- Width: the label takes the room the rest of the row leaves and is cut only when that row does not fit (at least 6 columns, then the details are cut from the end). In an agent list the names share one column, as wide as the widest name its row has room for.
- Reviewers read `reviewer: <label>`: their own label, else the reviewed delegation's (board, else saved outcome), else plain `reviewer` (`agentLabel`; `delegationLabel` in `src/subagents/extension.ts`).
- Retries keep the failed attempt's label (`RetrySetup.label` in `src/subagents/retry.ts`) and save it with their outcome, so a retry of a retry keeps it too.
- The transcript view keeps the full rung history and the turn count. The `subagents_status` snapshot adds a `Rung:` line with the full rung.
- CONTEXT.md (Label, Worker widget, Activity) and the cml8 PRD (labels paragraph, user story 24, row format) are updated.

Tests: widget, picker, transcript-view and render tests with a real board and a plain theme; end-to-end tests for reviewer labels (review.test.ts), retry label inheritance (retry.test.ts) and the status listing and snapshot (extension.test.ts). tsc and `npm test` pass.
