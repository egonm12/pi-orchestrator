---
status: accepted
date: 2026-09-24
---

# Route from an owner-written tier map, not from earned suitability scores

Tickets 06 and 08 admitted a model to a task only once it had earned a task-suitability score from at least three verified outcomes. In practice that meant the router could never pick anything, because a model earns a score only by being picked. Following LiteLLM's auto-routing design, the router now starts from a tier map the owner writes: four tiers, each an ordered list of rungs (model plus effort). The classifier assigns the tier, hard filters remove rungs, and the first surviving rung wins. Review verdicts are recorded from day one so that adaptive choice within a tier can be switched on once data exists, but no evidence is required to route.

## Considered options

- **Earned scores only** (the ticket 06/08 design): honest about evidence, but deadlocked at the start and blind to effort level.
- **Run LiteLLM's proxy**: the design fits, but the proxy needs metered API keys and the owner's Claude and Codex access are subscription sign-ins inside pi.
- **Owner tier map with optional adaptation** (chosen): works from the first dispatch, encodes the owner's preferences and subscriptions, and leaves room to learn.

## Consequences

- The ticket 06 suitability floor and the ticket 08 promotion bar stop gating dispatch. They remain as recorded evidence, not as admission rules.
- A wrong tier map is the owner's mistake, not the router's: the router records which tier, which rung and why, so a wrong map is visible.
- A project may override the tier map, so a client project can pin its own models. The ban list and the other hard filters cannot be relaxed by a project.
