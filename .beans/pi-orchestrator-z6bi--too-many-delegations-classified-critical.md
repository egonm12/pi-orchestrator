---
# pi-orchestrator-z6bi
title: Only the classifier model chooses the tier
status: completed
type: bug
priority: normal
tags:
    - ready-for-agent
created_at: 2026-10-01T14:38:45Z
updated_at: 2026-10-02T07:20:52Z
---

## Problem Statement

Too many delegations are classified critical. A read-only investigation of why messages reached a dead-letter queue ran as critical on the strongest rung, and so do very simple code changes. Critical is the most expensive tier: it runs on the strongest rung and gets an independent reviewer at every gate level, so each false critical costs time, money and a review the work never needed.

The routing log from 2026-09-25 to 2026-10-01 shows two causes:

- The keyword floor scans the whole task text for words, ignoring context. Two security or destructive words make a task critical. 39 of the 46 critical decisions came from it, matched on words such as "commit hash", "escalation", "token count", "truncate the text", "delete the /tmp files" and on the orchestrator's own prohibitions ("do NOT purge, delete", "do not force-push"). Of the 66 decisions the floor raised, none caught a task the model had genuinely under-rated.
- The classifier model itself rates a task by its subject, not by its action. 5 of its own 7 critical calls were read-only security reviews.

Retries make it worse: a retry is classified again on its original task plus the reviewer's feedback, whose vocabulary adds risk words.

## Solution

Only the classifier model chooses the tier (ADR 0015). The keyword floor and the keywords-only tier are removed. The rubric judges the action a task asks for, not the subject it touches: a review, audit or investigation that changes nothing is never critical, and a prohibition is a constraint, not a risk. A task no classifier model could classify runs as elevated and is recorded as unclassified. A retry keeps the tier of the delegation it retries; the effort ladder already gives it more care. The routing log explains each tier with the model's own reason instead of matched keywords.

## User Stories

1. As an owner, I want a read-only investigation (such as why messages reached a DLQ) to run as standard or elevated, so that I don't pay for the strongest rung on research.
2. As an owner, I want a trivial code change to keep the tier the model gave it, so that a rename does not run on the strongest rung.
3. As an orchestrator, I want to write guardrails such as "do not delete, purge or force-push" in a task without raising its tier, so that being careful does not make work more expensive.
4. As an orchestrator, I want to ask a worker to report a commit hash without that word counting as cryptography, so that ordinary instructions don't change routing.
5. As an orchestrator, I want project glossary words such as "escalation" or "injected" to carry no routing weight, so that the domain vocabulary doesn't distort tiers.
6. As an owner, I want a security review of a PR that changes OAuth to be elevated, not critical, so that the depth of reasoning is paid for without the critical premium.
7. As an owner, I want a task that actually changes a security boundary to stay critical, so that real risk still gets the strongest care.
8. As an owner, I want a task that actually destroys unrecoverable data to stay critical, so that irreversible actions get the strongest care.
9. As an owner, I want the classifier rubric to state that the tier follows the action a task asks for, not its subject, so that the model applies one consistent rule.
10. As an owner, I want the rubric to show examples of read-only work on risky subjects and of prohibitions, so that the model learns the boundary from concrete cases.
11. As an owner, I want a task no classifier model could classify to run as elevated, so that failure costs some care without jumping to critical.
12. As an owner, I want unclassified tasks recorded with their own cause, so that the routing report shows how often classification fails.
13. As an owner, I want each routing record to carry the model's reason and risk reasons, so that I can see why a task got its tier.
14. As an owner, I want routing records written before this change, which still carry a floor field, to keep parsing and showing in the report, so that history is not lost.
15. As an orchestrator, I want a retry to keep the tier of the delegation it retries, so that the reviewer's feedback cannot push it up a tier.
16. As an orchestrator, I want a retry's extra care to come only from the effort ladder's next rung, so that there is one escalation path for retries, not two.
17. As an orchestrator, I want a retry of a retry to keep the original delegation's tier as well, so that the tier stays stable across the chain.
18. As a maintainer, I want no keyword list to maintain for routing, so that new false positives don't require new exceptions.
19. As a maintainer, I want the older routing-policy path that falls back to the keyword classifier either rewired or confirmed dead before removal, so that nothing live breaks silently.
20. As a maintainer, I want regression tests built from the real log cases, so that the false criticals cannot come back.
21. As a reviewer of routing decisions, I want to argue with the model's stated reason rather than with a matched word, so that disagreements point at the rubric, which is the one place to fix them.

## Implementation Decisions

- The tier classifier no longer computes or applies a keyword floor. The classifier model's answer is the final tier.
- The keywords-only path is removed. When every classifier model hop fails or is refused, the classification is elevated with cause `unclassified`.
- The keyword classifier module is removed once nothing live depends on it. The implementing agent first checks the older routing-policy path that falls back to it when a request brings no assessment of its own, and reports whether anything live reaches it. If something does, it is rewired to the tier classifier or to the unclassified rule; it is not deleted blindly.
- The routing decision record drops the floor description and floor signals for new records. It records the model's `why` and `risk.reasons` (already required by the answer schema). Readers treat `floor` as optional so older records still parse; the routing report shows the model reason where present.
- The rubric gains an explicit rule: judge the action the task asks the worker to perform, not the subject it touches. A review, audit or investigation that changes nothing is never critical; its tier follows how hard the reasoning is. A prohibition in the task is a constraint and does not count as the action.
- The rubric gains examples: "Review a PR that changes OAuth" is elevated, not critical. "Do not delete anything" does not destroy data. "Investigate why messages reached the DLQ" is standard.
- The rubric's existing critical rule (changes a security boundary, or destroys unrecoverable data) stays, as do its existing examples. The "judge the riskiest part" instruction is reworded so it refers to the riskiest part of the requested action.
- The rubric version is bumped so records show which rubric decided them.
- A retry is routed on the tier of the delegation it retries, carried through from that delegation's record; it is not classified again. The effort ladder's next rung is unchanged.
- Domain language follows CONTEXT.md: Classifier, Unclassified task, Retry tier. "Keyword floor" is now an avoided term.

## Testing Decisions

- Test external behaviour at existing seams only; no new seams. Assert on the classification and the routing record a task produces, not on internal helpers.
- Tier classifier, with a fake classifier model (prior art: the existing tier classifier tests):
  - A mechanical model answer for "rename foo to bar; do not push or force-push; report the commit hash" stays mechanical.
  - The DLQ investigation prompt with "do NOT redrive, purge, delete … if aws sso login is needed, stop" keeps the model's tier.
  - The model's critical answer stays critical (the model may still choose critical).
  - With every model hop failing, the tier is elevated with cause `unclassified`, whatever words the task contains.
  - The record carries `why` and `risk.reasons` and no floor.
  - Existing tests that expect a floor or a keywords-only tier are rewritten to these expectations or deleted.
- Rubric: the rubric text sent to the model contains the action-not-subject rule and the three examples, and the rubric version changed. The live model's judgement is not tested offline.
- Retry path (prior art: the retry tests): a retry whose feedback is full of "delete", "auth" and "credential" is routed on its original delegation's tier and triggers no classifier call; a retry of a retry keeps the same tier.
- Routing records and report (prior art: the decision record and routing report tests): an old record with a floor field parses and appears in the report; a new record has no floor.
- The older routing-policy tests that exercise the keyword classifier are updated to whatever the rewiring decision is.

## Out of Scope

- Why the classifier model fails often enough to reach the keywords-only path (32 of 380 decisions). That gets its own bean.
- The edit-detection false positive: a research delegation was marked as editing because the orchestrator edited a file while it ran. Separate bean.
- Changing tiers, the tier map, gate levels or the effort ladder.
- Rewriting historical routing records.

## Further Notes

- Decision record: ADR 0015 (only the classifier model chooses the tier). CONTEXT.md entries Classifier, Unclassified task and Retry tier.
- Evidence came from the routing log 2026-09-25 to 2026-10-01: 377 to 380 classified decisions, 46 critical (39 floor-driven, 7 model), 66 floor raises with 0 clean catches and 1 borderline (the model had flagged that case in its own reason).
- Manual check after implementation: replay the logged critical tasks (the DLQ prompt, the five read-only security reviews, the two deserved criticals) through the live classifier model and confirm the read-only ones land below critical and the two changes stay critical.
- The trade-off accepted in ADR 0015: if the model under-rates a risky change, only the quality gate catches it. Correct that through rubric examples, not keywords.

## Work

- [x] Tier classifier: remove the keyword floor and the keywords-only tier; all hops failing gives elevated, cause unclassified
- [x] Rubric: action-not-subject rule, read-only-never-critical, prohibition-is-a-constraint, the three examples, version bump
- [x] Keyword classifier: check the routing-policy fallback for live callers, then remove the module
- [x] Decision record: no floor on new records, floor optional on read; routing report shows reasons and unclassified count
- [x] Retry: route on the retried delegation's tier without a classifier call, also for a retry of a retry
- [x] Tests from the real log cases, at the existing seams
- [x] README and docs no longer describe the keyword floor

## Summary of Changes

- `src/routing/tier-classifier.ts`: the keyword floor and the keywords-only tier are gone. The first model hop that decides gives the tier with its own `why` and `risk.reasons`; when no hop decides, the task is unclassified: tier elevated, cause `unclassified`, risk, ambiguity, complexity and kind of work `unassessed`. The cause type also names `retry:<delegation id>`.
- `src/routing/tier-rubric.ts`: rubric `tier-rubric-3` judges the action, not the subject. Read-only work is never critical, a prohibition is a constraint, the "riskiest part" sentence refers to the requested action, and the OAuth review, "do not delete anything" and DLQ investigation examples are added. The standard question's description also covers investigations.
- `src/routing/classifier.ts` (the keyword classifier) is removed; the tier vocabulary moved to `src/routing/tiers.ts`. The legacy routing-policy path that fell back to it is dead (only `delegateWithSwitch`, which only tests call, reaches `route`), so its request now brings a required assessment.
- `src/routing/decision-record.ts`: new records carry no `floor`, `floorTier`, `floorSignals` or `modelTier`; old records with them still validate. `src/routing/routing-report.ts` adds `unclassified decisions: N` and one `classification <id>: <tier>, <cause>: <why>` line per decision, naming the floor of an old record that had one.
- Retries (`src/subagents/retry.ts`, `worker.ts`, `extension.ts`, `src/router/auto-model.ts`): a retry carries the retried delegation's recorded classification (cause `retry:<id>`, no hops) and the router routes on it without calling the classifier, so a retry of a retry keeps the same tier. An attempt without a decision record is classified as before.
- Tests from the routing log's false criticals (the rename with "do not push or force-push, report the commit hash", the DLQ investigation, all hops failing, a retry with delete, auth and credential feedback) and updated floor or keywords tests. README's routing, retry and report sections describe the new behaviour.
- Not done: the manual replay of the logged critical tasks through the live classifier model (needs live credentials and spend).
