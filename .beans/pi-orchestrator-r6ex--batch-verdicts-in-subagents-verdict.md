---
# pi-orchestrator-r6ex
title: Batch verdicts in subagents_verdict
status: completed
type: feature
priority: normal
created_at: 2026-10-09T16:00:31Z
updated_at: 2026-10-09T16:16:44Z
---

Let subagents_verdict accept several delegation ids, each with its own verdict and reason, to avoid one orchestrator turn per verdict (~7 s each).

## Todo

- [x] Schema: `verdicts` list beside the single-delegation fields; a call takes exactly one form
- [x] Each entry judged and recorded on its own, with its own reason, reviewer and gate checks; a refused entry does not block the others
- [x] Reply: one numbered line per entry, with the next effort-ladder rung for each request_changes
- [x] Tool description and orchestrator protocol mention batching
- [x] `docs/reference.md` parameter paragraph; CONTEXT.md and README only name the tool, so they are unchanged
- [x] Tests in extension, review, retry and protocol test files
- [x] `npm run typecheck` and `npm test`

## Summary of changes

- `src/subagents/verdict.ts`: `verdictForm` takes the single form or `verdicts`, and refuses both at once or an empty list; `recordVerdict` judges one entry; the list branch numbers each outcome and fails only when nothing is recorded. The single form's reply is unchanged.
- `src/subagents/orchestrator-protocol.ts`: one sentence on batching in the verdict paragraph.
- `docs/reference.md`: one sentence on batching in the verdict paragraph.
- Tests: `extension.test.ts` (nine tests), `review.test.ts` (per-entry reviewer at max), `retry.test.ts` (next rung per entry), `orchestrator-protocol.test.ts` (protocol sentence).
- Verified: `npm run typecheck` exits 0; `npm test` gives 1115 pass, 0 fail, 13 skipped (live tests, as before). Five injected faults in a scratch copy each made the new tests fail.
- Not committed.
