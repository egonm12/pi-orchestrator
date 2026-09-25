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

- The main thread runs on the model picked in `/model` and changes only when the user changes it. pi cannot hide a registered model from `/model`, so when the user selects `orchestrator/auto` for the main thread, pi-orchestrator restores the previous model and shows one line. Only a user's selection is undone: a worker starts on `orchestrator/auto` on purpose.
- A worker is known by the `sessionId` pi passes with every model request, for a foreground worker in the main thread's process and for a background worker in its own process alike. Its first request is classified and routed, and every later request goes to the same rung. A worker never switches rung in the middle of its task.
- The summary request that compaction sends arrives with a new `sessionId`. It is classified and routed like any other first request, which costs one classifier call per compaction.
- Replies are labelled `orchestrator/auto`, the model the worker was started on, because a subagent extension may check that (pi-subagents does). When a request is forwarded, earlier replies are labelled as the pinned rung again, so the rung accepts its own tool calls and thinking. pi and the subagent extension therefore show `orchestrator/auto`; the decision record names the real rung.
- A thinking level on the requested model, such as the `:high` pi-subagents adds from an agent file, is ignored: the rung sets the effort.
- Workers compact like any pi session. The auto model declares the largest context window in the tier map. When the pinned rung reports a context overflow, the provider passes it to pi labelled `orchestrator/auto`, so pi compacts and retries on the same rung.
- When the hard filters remove every rung in every tier, the worker runs on the main thread's model, and the decision record says so. The main thread's process keeps its current model in the environment variable `PI_ORCHESTRATOR_SESSION_MODEL`, set at start and on every model change. A background worker gets a copy of that environment when its process starts, so it keeps the value from the moment of delegation. If the variable is missing, because a subagent extension started the worker with an empty environment, the request fails with the reason. This replaces "the router never blocks a call": there is no longer a call to leave unchanged. If the main thread's model is on the subagent ban list, the request fails with the reason instead, because ADR 0002 lets the main thread run on a model that no worker may use.
- Shadow mode follows from that: the worker runs on the main thread's model and the decision record keeps the rung the router would have chosen.
- A worker that names a real model is not routed and gets no decision record. The guard still enforces the subagent ban list on it.
- pi-orchestrator no longer reads agent definitions. `src/subagents/` and its parity tests are removed. To be routed, a subagent extension must start workers on `orchestrator/auto`, for example as its default worker model. A background worker's process loads the installed packages, so pi-orchestrator must be installed, not only loaded with `-e`, for background workers to be routed.
- Decision records are keyed by the worker's `sessionId` instead of the `subagent` tool call id. How a verdict finds its decision record is left open.
- A spike (branch `spike/auto-model`, pi 0.87.1 and pi-subagents 0.71.0) confirmed forwarding with the user's own login, a stable `sessionId` per worker, compact-and-retry on the pinned rung, and the refusal in `/model`. It did not test parallel workers, which pi-subagents 0.71.0 runs only through a workflow script.
