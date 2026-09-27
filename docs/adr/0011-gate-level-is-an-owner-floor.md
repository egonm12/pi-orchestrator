---
status: accepted
date: 2026-09-27
---

# The gate level is an owner floor the orchestrator may only raise

How strictly the quality gate (ADR 0010) treats each tier is set by the gate level: low, medium, high or max. The owner's level fixes a floor per tier, and the orchestrator may raise it for one delegation, with a reason in the verdict call, but never lower it. Criticality is already judged by the classifier's tier, so the gate level shapes what each tier costs rather than adding a second judgement of criticality.

| Tier | low | medium | high | max |
|---|---|---|---|---|
| mechanical | none | spot check | spot check | reviewer |
| standard | none | spot check | reviewer | reviewer |
| elevated | spot check | reviewer | reviewer | reviewer |
| critical | reviewer | reviewer | reviewer | reviewer |

*None* needs no verdict, a *spot check* is the orchestrator's own verdict, and a *reviewer* is an independent reviewer worker. At max every reviewer reruns the Result's "Verified by" commands. Critical work gets a reviewer at every level, so low means "do not gate trivia", never "gate nothing".

## Considered options

- **The orchestrator judges how much review each result needs.** Simple tasks would stay cheap, but the model that gains from skipping review decides whether to review. ADR 0005's measurement (6 of 29 needed delegations made on advice alone) says it will under-review. Kept only in the safe direction: raising.
- **A fixed level with no orchestrator say.** Safe, but ignores what the orchestrator learns while working, and the user's "review this properly" in a prompt. Rejected.
- **A per-prompt level read from the user's words.** Covered by the orchestrator raising the level; lowering from prose would reopen the loophole.

## Consequences

- The personal default is medium, a project may override it, and `/pi-orchestrator gate <level>` changes it for the current session.
- A low level yields more *ungated* delegations and so fewer verdicts for the router to learn from; the routing report shows them apart from *missing* verdicts.
