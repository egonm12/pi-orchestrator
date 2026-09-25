---
status: accepted
date: 2026-09-25
---

# Route workers through the auto model, not by rewriting `subagent` calls

The router extension filled in the model on pi-subagents' `subagent` calls. That tied pi-orchestrator to one subagent extension: to know whether an agent file pins a model, it had to reimplement pi-subagents' agent discovery and model resolution (`src/subagents/`). The owner wants the orchestrator to work with any subagent extension, including one of their own. So pi-orchestrator registers a virtual model, `orchestrator/auto`, as a pi provider. Workers run on it. The first request of each worker is classified and routed to a rung, and the worker keeps that rung. This is how LiteLLM's auto router works: it routes at the model layer and never asks who started the agent. The main thread is not routed.

## Considered options

- **Rewrite `subagent` calls (the old design).** Works only with pi-subagents and needs a copy of its internals that can drift from the installed version.
- **An own `delegate` tool and worker runtime.** The orchestrator owns the whole path, but it has to build and maintain a subagent runtime, and other subagent tools bypass it unless they are hidden.
- **The auto model (chosen).** Any subagent extension that starts a worker on `orchestrator/auto` is routed, without an adapter.
- **The main thread on the auto model too (rejected).** Each prompt can switch model, and each switch rereads the whole history without a cache: 138k against 29k uncached tokens in the prototype's walkthroughs (branch `prototype/auto-model`).

## Consequences

- The main thread runs on the model picked in `/model` and changes only when the user changes it. `orchestrator/auto` is hidden from `/model`. If pi cannot hide it, a main thread that selects it is refused with one line.
- A worker is known by the `sessionId` pi passes with every model request. Its first request is classified and routed, and every later request goes to the same rung. A worker never switches rung in the middle of its task.
- Workers compact like any pi session. When the pinned rung reports a context overflow, the provider passes it to pi as `context_length_exceeded`, so pi compacts and retries on the same rung.
- When the hard filters remove every rung in every tier, the worker runs on the main thread's current model, and the decision record says so. This replaces "the router never blocks a call": there is no longer a call to leave unchanged. If the main thread's model is on the subagent ban list, the request fails with the reason instead, because ADR 0002 lets the main thread run on a model that no worker may use.
- Shadow mode follows from that: the worker runs on the main thread's model and the decision record keeps the rung the router would have chosen.
- A worker that names a real model is not routed and gets no decision record. The guard still enforces the subagent ban list on it.
- pi-orchestrator no longer reads agent definitions. `src/subagents/` and its parity tests are removed. To be routed, a subagent extension must start workers on `orchestrator/auto`, for example as its default worker model.
- Decision records are keyed by the worker's `sessionId` instead of the `subagent` tool call id. How a verdict finds its decision record is left open.
- A spike must confirm, before implementation: that pi can hide a model from `/model`; that each worker gets its own `sessionId`; that compact-and-retry works on the pinned rung; and that the provider can read the main thread's current model, both for workers in the same process and for workers in a `pi -p` subprocess.
