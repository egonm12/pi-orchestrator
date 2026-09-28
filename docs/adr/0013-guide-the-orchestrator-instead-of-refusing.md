---
status: accepted
date: 2026-09-28
supersedes: ADR 0005
amends: ADR 0010
---

# Guide the orchestrator instead of refusing its calls

ADR 0005 denied the orchestrator's exploratory calls beyond a flat budget, and ADR 0010 denied commit and push until every editing delegation had a verdict. In practice both refusals did harm. The orchestrator could no longer read what a worker changed before judging it. It started workers for lookups it could have done in one call. And a push the owner asked for directly stayed blocked because a reviewer hit a rate limit. Both are now guidance. After a set number of exploratory calls in one user prompt, the result of each further call carries an exploration nudge suggesting a worker. Commit and push go through, and their result names the delegations still waiting for a verdict. The routing report keeps counting missing verdicts, so a skipped gate stays visible.

## Considered options

- **Keep the refusals and add owner overrides** (a check allowance per result, a gate waive command): keeps the measured effect, but every override is another rule the orchestrator must work around. The unnecessary workers remain.
- **Protocol text only**: ADR 0005 measured advice alone at 6 of 29 needed delegations. That was measured while the protocol was missing from runs started by completion notices, worker reports and gate reminders, so the figure understates advice that is actually present.
- **Protocol on every run plus a nudge at the moment of drifting** (chosen).

## Consequences

- The delegation rate must be measured again once the protocol reaches every run. If it stays near 6 of 29, revisit this decision with that evidence. "Near" is made concrete in `src/live-check/delegation-rate.md`: on at least 29 prompts labelled as needing delegation, the rate counts as improved only when a one-sided Fisher exact test puts it above 6 of 29 at p < 0.05. The owner's result is recorded in bean pi-orchestrator-53x3 and summarized here in one line.
- The gate's value now lies in recorded verdicts and in the report of missing ones, not in blocking. ADR 0011's gate levels and gate actions are unchanged: critical work still calls for a reviewer, and not recording one is a missing verdict.
