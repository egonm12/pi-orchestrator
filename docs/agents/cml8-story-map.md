# cml8 story map

Maps each of the 55 user stories of parent bean `pi-orchestrator-cml8` to the original child bean that delivers it. The 13 original children are the beans created by commit a4cc5c5 ("Split cml8 into 13 tickets"). Each child's "Parent" section names its stories, and this map follows those sections.

Status on 2026-09-29: 12 of the 13 original children are completed. `pi-orchestrator-53x3` (story 19) is in progress and waits for the predeclared measurement window.

## Notes

- **Story 19 is pending.** Its result is the predeclared delegation-rate measurement, taken from natural prompts in the window that ends 2026-10-06T08:35:57Z. After that time the prompts are extracted, labelled blind to outcomes, summarized and recorded in `pi-orchestrator-53x3` and ADR 0013. The script and instructions are committed (33a1bb8, d9e3731). No result exists yet.
- **Story 55 is completed only under an owner-approved exception.** `pi-orchestrator-ugoi` closed on real success captures (Anthropic installed-extension path, Codex WebSocket and SSE) and two sanitized historical limit error texts from pi session logs. The following were not verified: Anthropic plain pi and extra usage (excluded by the owner), a quota-capture 429, near-limit headers, a reset time and a Codex SSE 429. See the "Not verified" section of the ugoi bean.
- **Story 24 was amended by `pi-orchestrator-rm9t`** (commit 02c2927), a later follow-up bean and not an original child. The original child for the story is `pi-orchestrator-k2xj`.
- **Follow-up `pi-orchestrator-r94j`** (harden the usage store after the 5inr review) is not an original child and is outside the revised goal. It is still in progress, because its Codex 429 item waits on a real Codex SSE 429.
- **Commits:** the owner approved several scoped, reviewed commits per ticket. History was not rewritten to get one commit per ticket.

## Evidence per original child

| Child | Stories | Commits | Test evidence |
|---|---|---|---|
| 2uc7 exploration nudge | 1 to 9, 20 (nudge) | 909ff9b, 8a26815 | src/subagents/extension.test.ts:3123, :3144, :3180, :3202, :3241, :3281; src/subagents/settings.test.ts:56, :67 |
| gwbk gate that reminds | 10 to 13, 20 (gate) | b1e48c7 | src/subagents/extension.test.ts:3870, :3946, :4035, :4078; src/subagents/commit-gate.test.ts:58, :91; src/subagents/review.test.ts:637 |
| 6yxt protocol on every run | 14 to 18 | 318435c, c24905f | src/subagents/extension.test.ts:2712, :2747, :2772, :2794; src/subagents/orchestrator-protocol.test.ts:37, :87, :96; src/live-check/protocol-probe.test.ts:31; live check result in the 6yxt bean |
| 53x3 delegation rate | 19 | 33a1bb8, d9e3731 | src/live-check/delegation-rate.test.ts:52, :147 (tooling only, result pending) |
| k2xj labels | 21 to 27 | 90205f4, a2c3274 (amended by rm9t 02c2927) | src/subagents/worker-widget.test.ts:71, :146, :162, :270; src/subagents/worker-picker.test.ts:93, :175; src/subagents/transcript-view.test.ts:679; src/subagents/render.test.ts:22; src/subagents/extension.test.ts:335, :2006; src/subagents/retry.test.ts:291; src/subagents/review.test.ts:248 |
| 8tgr balanced tier order | 28 to 33, 35, 36 | 2c66eb3, f121ca1, c49604b | src/routing/tier-router.test.ts:95, :109, :197 to :293, :387; src/routing/tier-map.test.ts:146; src/router/extension.test.ts:566, :586, :606, :619, :634; src/routing/decision-record.test.ts:148 |
| z4cp reviewer provider | 34 | 5a6b6ce | src/subagents/review-provider.test.ts:160, :175, :190 |
| 6c1p editing detection | 37 to 41 | 01a1789, 763b92a | src/subagents/extension.test.ts:3419, :3456, :3478, :3532, :3577 |
| ouoy failover | 42, 43, 45 | 8f635c1 | src/router/extension.test.ts:2037, :2084, :2107, :2139; src/routing/decision-record.test.ts:515 |
| 5inr usage store and error signals | 44, 46 to 49, 52, 53 | c820661 | src/router/extension.test.ts:1837, :1862 to :1879, :1983, :1998; src/routing/tier-router.test.ts:209, :216 |
| ugoi live check of headers and errors | 55 | c12af03, dce1355, 7e131c9, 8308bd3 | src/live-check/quota-capture.test.ts:49, :96; src/router/limit-errors.test.ts:22, :30, :38; fixtures in src/fixtures/usage/ |
| pus9 quota headers and low weight | 50, 51 | 9242702, ad3e228 | src/router/extension.test.ts:2170, :2186, :2257, :2272, :2410; src/routing/tier-router.test.ts:124, :138; src/router/usage-observations.test.ts:175 |
| bcix usage line | 54 | fecee1c | src/subagents/extension.test.ts:2834, :2855, :2883, :2930, :2978 |

## Story to child

| Story | Summary | Original child | Evidence |
|---|---|---|---|
| 1 | Exploratory calls never refused | 2uc7 | extension.test.ts:3123 |
| 2 | Quick lookup done by the orchestrator itself | 2uc7 | extension.test.ts:3123; orchestrator-protocol.ts:67, :72 |
| 3 | Nudged to delegate after much exploring | 2uc7 | extension.test.ts:3123 |
| 4 | Nudge threshold is a setting | 2uc7 | extension.test.ts:3180; settings.test.ts:56 |
| 5 | Old `explorationBudget` key still read | 2uc7 | settings.test.ts:67 |
| 6 | Nudge in the tool result | 2uc7 | extension.test.ts:3123 |
| 7 | Nudge names the call count | 2uc7 | extension.test.ts:3123 |
| 8 | Count restarts at each user prompt | 2uc7 | extension.test.ts:3202 |
| 9 | Workers never nudged | 2uc7 | extension.test.ts:3241 |
| 10 | Commit or push goes through | gwbk | extension.test.ts:3870 |
| 11 | Commit or push result names waiting verdicts | gwbk | extension.test.ts:3870, :3946 |
| 12 | Missing verdicts counted in the report | gwbk | extension.test.ts:3870 |
| 13 | Gate levels and actions unchanged | gwbk | extension.test.ts:3946, :4035; review.test.ts:637 |
| 14 | Protocol on a completion notice | 6yxt | extension.test.ts:2747 |
| 15 | Protocol on a worker report or question | 6yxt | extension.test.ts:2772 |
| 16 | Protocol on a gate reminder | 6yxt | The reminder is appended to the bash tool result (commit-gate.ts:150-154) and the turn-end notice is sent with `triggerTurn: false` (commit-gate.ts:161-162), so neither starts a run; the per-request hook covers both (orchestrator-protocol.test.ts:37). No end-to-end test checks the protocol on a reminder's request |
| 17 | Protocol after a typed skill prompt | 6yxt | extension.test.ts:2794; orchestrator-protocol.test.ts:87 |
| 18 | Live check of the protocol | 6yxt | protocol-probe.test.ts:31; 6yxt bean "Live check result" (PASS, 2026-09-29) |
| 19 | Delegation rate measured again | 53x3 | Pending: predeclared result after 2026-10-06T08:35:57Z; tooling delegation-rate.test.ts:147 |
| 20 | Protocol text describes nudge and reminding gate | 2uc7 (nudge), gwbk (gate) | orchestrator-protocol.ts:69, :83; orchestrator-protocol.test.ts:107; extension.test.ts:3180, :4078 |
| 21 | Short label per delegation | k2xj | extension.test.ts:335 |
| 22 | Every row shows its label | k2xj | worker-widget.test.ts:71 |
| 23 | Fallback to agent definition, then `worker` | k2xj | worker-widget.test.ts:146 |
| 24 | Reviewer shown as `reviewer: <label>` (amended by rm9t) | k2xj | worker-widget.test.ts:146; review.test.ts:248 |
| 25 | Tier shown next to the rung | k2xj | worker-widget.test.ts:71; extension.test.ts:335 |
| 26 | Same name in widget, picker, transcript and status | k2xj | worker-picker.test.ts:93; transcript-view.test.ts:679; render.test.ts:22; extension.test.ts:2006 |
| 27 | Long labels shortened | k2xj | worker-widget.test.ts:162, :270; worker-picker.test.ts:175 |
| 28 | Delegations spread across a tier's providers | 8tgr | tier-router.test.ts:95 |
| 29 | Rolling 5 hours across sessions and projects | 8tgr | router/extension.test.ts:566 |
| 30 | Counted per provider across all tiers | 8tgr | router/extension.test.ts:566 |
| 31 | Parallel fan-out spreads | 8tgr | router/extension.test.ts:619, :634 |
| 32 | List order breaks ties, ordered tier keeps preference | 8tgr | tier-router.test.ts:95, :109; tier-map.test.ts:146; router/extension.test.ts:586 |
| 33 | Hard filters, escalation and ladder unchanged | 8tgr | tier-router.test.ts:197 to :293, :387 |
| 34 | Reviewer prefers another provider | z4cp | review-provider.test.ts:160, :175, :190 |
| 35 | Decision record shows the deciding counts | 8tgr | decision-record.test.ts:148 |
| 36 | Only pinned delegations count, not shadow | 8tgr | router/extension.test.ts:566, :606 |
| 37 | Research that changed nothing needs no verdict | 6c1p | extension.test.ts:3419 |
| 38 | Bash that changed the tree is editing | 6c1p | extension.test.ts:3419 |
| 39 | `edit` and `write` always editing | 6c1p | extension.test.ts:3456 |
| 40 | Change during overlapping workers counts for each | 6c1p | extension.test.ts:3478 |
| 41 | Command rule without a git repository | 6c1p | extension.test.ts:3577 |
| 42 | First-request limit moves to another provider | ouoy | router/extension.test.ts:2037, :2084 |
| 43 | Mid-run limit fails the worker cleanly | ouoy | router/extension.test.ts:2107 |
| 44 | Rate-limited provider marked throttled | 5inr | router/extension.test.ts:1870, :1879; tier-router.test.ts:216 |
| 45 | Failover recorded and linked | ouoy | router/extension.test.ts:2037; decision-record.test.ts:515 |
| 46 | No worker on an exhausted provider | 5inr | router/extension.test.ts:1837; tier-router.test.ts:209 |
| 47 | Usage-limit error marks exhausted until reset | 5inr | router/extension.test.ts:1837 |
| 48 | No stated reset means 5 hours | 5inr | router/extension.test.ts:1863, :1879 |
| 49 | Observations shared across sessions and projects | 5inr | router/extension.test.ts:1837 |
| 50 | Quota headers read from every response | pus9 | router/extension.test.ts:2257, :2272, :2410 |
| 51 | Under 10% left used less | pus9 | router/extension.test.ts:2170, :2186; tier-router.test.ts:124 |
| 52 | Refused up front when all exhausted, with resets | 5inr | router/extension.test.ts:1983 |
| 53 | Session-model fallback skipped when exhausted | 5inr | router/extension.test.ts:1998 |
| 54 | Usage line on every run | bcix | extension.test.ts:2834, :2855, :2978 |
| 55 | Live check of real headers and limit errors | ugoi | Completed under owner-approved exception; quota-capture.test.ts:49; limit-errors.test.ts:22, :30 |

Paths without a folder in the story table: `extension.test.ts`, `settings.test.ts`, `commit-gate.test.ts`, `review.test.ts`, `review-provider.test.ts`, `worker-widget.test.ts`, `worker-picker.test.ts`, `transcript-view.test.ts`, `render.test.ts`, `retry.test.ts` and `orchestrator-protocol.ts`/`.test.ts` are in `src/subagents/`. `router/extension.test.ts`, `limit-errors.test.ts` and `usage-observations.test.ts` are in `src/router/`. `tier-router.test.ts`, `tier-map.test.ts` and `decision-record.test.ts` are in `src/routing/`. `protocol-probe.test.ts`, `quota-capture.test.ts` and `delegation-rate.test.ts` are in `src/live-check/`.
