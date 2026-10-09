---
# pi-orchestrator-3esy
title: Shorten classifier why answer
status: in-progress
type: task
priority: normal
created_at: 2026-10-09T16:00:31Z
updated_at: 2026-10-09T16:09:20Z
---

Cap the classifier's why field (346 chars p50) in src/routing/tier-answer-schema.ts and prompt, keeping it useful for the routing report.

## Todo

- [x] Read the schema, the prompt and the routing report's use of `why`
- [x] Ask for one short sentence of at most 120 characters in the rubric's `why` line, and bump `RUBRIC_VERSION` to `tier-rubric-4`
- [x] Leave the schema unchanged, with no `maxLength` (see the summary)
- [x] Update the version pin, and add a regression test that an over-long `why` is still a decision
- [x] Run `npm run typecheck` and `npm test`
- [ ] Measure the `why` length on live `tier-rubric-4` records, since no live model call was made

## Summary of changes

- `src/routing/tier-rubric.ts`: the `why` line now asks for one short sentence of at most 120 characters (was one or two sentences). `RUBRIC_VERSION` is `tier-rubric-4`, because the rubric text changed.
- `src/routing/tier-classifier.test.ts`: the version pin reads `tier-rubric-4`. A new test checks the rubric line, and that a `why` of about 320 characters is still a decided tier, not a schema failure.
- `src/routing/tier-answer-schema.ts`: unchanged. The harness accepts any non-empty `why` and cannot truncate, so a `maxLength` would either fail over-long answers (more fallbacks) or need new truncation code and a `SCHEMA_VERSION` bump. It would also not cut generation time: the model writes the whole string before any cut. The bean's "and prompt" scope is met by the prompt alone.
- Baseline, from the 15 day files in `~/.pi/agent/pi-orchestrator/routing/`: the 346 p50 reproduces over the 706 non-unclassified decisions, which include 32 pre-ADR 0015 keyword records and 17 retries. Over the 657 `model:` decisions alone, the p50 is 351, 1 (0.2%) is 120 characters or fewer, and 67 sit at the 500-character write cap. Under `tier-rubric-3` the model p50 is 340, and none of 302 is 120 characters or fewer. Most of these decisions ran on `anthropic/claude-haiku-4-5:off` (494 of 657), not the code default `openai-codex/gpt-6-luna:low`, so measure that rung.
- Not verified: whether the live model follows the 120-character instruction. The live classifier test skipped (no credentials), so no model call was made. Measure the `tier-rubric-4` records to confirm the drop, and check the failure rate with the same records.
- Checks: `npm run typecheck` passes. `npm test` passes: 1116 tests, 0 failing, 13 skipped. All 13 are live tests: 11 need `PI_ORCHESTRATOR_LIVE=1`, and 2 report that credentials or the auth extension are unavailable, one of them the classifier case.
