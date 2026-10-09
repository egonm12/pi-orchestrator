---
status: accepted
date: 2026-10-09
---

# Only the owner's agent definitions pin a model

Agent definitions load from the owner's folder and from the project's `.pi/agents/`, with no trust check, and a project definition wins by name. Under `agentDefinitionModel.use: "preserve"` a cloned repo could therefore replace the owner's `reviewer`, pin any model and, with `allowBanned`, run one the owner banned. We decided that only definitions from the owner's folder may pin a model or use the ban-list exception. A project definition keeps its instructions and tools, but its `model` and `thinking` are ignored and the worker is routed, as in `route` mode. Pins exist for the owner's preference, so only the owner may express one; a project can still shape how a worker works, never what it runs on.

## Considered options

- Leave it as is, gated by `allowProjectOverrides`: rejected, because that setting is about project settings, not about trusting whatever definitions a repo ships.
- Load project definitions only for trusted projects: rejected as too coarse; project instructions and tools are useful and carry no model risk.

## Consequences

- The loader records which folder each definition came from.
- This narrows the follow-up to ADR 0002: `allowBanned` applies to the owner's definitions only, whatever `allowProjectOverrides` says.
- A pinned model whose provider is exhausted or throttled falls back to routing, and a retry of a pinned attempt first climbs one effort step on the pinned model. Both are preferences yielding to physical limits and recovery, not exceptions to this rule.
