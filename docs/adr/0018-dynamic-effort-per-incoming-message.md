---
status: proposed
date: 2026-10-09
---

# Dynamic effort per incoming message

A rung pins one effort for a whole delegation, so a tier must be set for its hardest turns and overpays on the easy ones. A rung may now carry an effort band (`provider/model:low-high`) or no effort at all. An effort judge, a small model call separate from the classifier, picks the effort inside the band for each incoming message: a user prompt, a task, a steer, a follow-up or retry feedback. It never judges between tool calls. The model stays pinned; only the effort moves. This covers the orchestrator's main thread as well as workers.

Changing the top-level effort restarts the prompt cache on every provider and model we use, which would cost more than the lower effort saves. The cache-safe path is a per-message effort change: an empty `system` message carrying `output_config.effort` (Claude, beta header `mid-conversation-output-config-2026-07-01`) or a `configuration_update` input item (OpenAI GPT-6 family), with the request's top-level effort left at its starting value. pi has no such option, so the extension rewrites the payload in `before_provider_request`. Because the response keeps reporting the starting effort, the decision log records the effort the judge chose.

Only models where a live request pair shows the cache surviving an effort change may carry a dynamic rung. Documentation and effortless (github.com/HeyCubit/effortless, the precedent for per-prompt judging) disagree on which models qualify, so we measure. A dynamic rung on an unmeasured model is a load error.

Rules taken from effortless: a higher effort applies at once, a lower one waits until the running turn ends; a follow-up of at most 12 characters and 2 words keeps the current effort without a judgement. A failed judgement runs the turn at the top of the band. A retry on a dynamic rung raises the band's floor one step before the ladder moves to another rung.

## Considered options

- **Re-judge in the background after each turn and apply it to the next request.** In a tool loop the next request holds only tool results. Claude reportedly defers a per-message change on such requests, and a top-level change restarts the cache. Effortless does not do it either. Rejected.
- **Deterministic rules on the turn's shape** (low after a read, high after a failed test). Cheap but brittle. Rejected in favour of a model judgement per message.
- **Let the worker set its own effort with a tool.** Gives the worker a lever over its own budget. Rejected.
- **Also downshift to a cheaper model per turn**, as effortless does. Deferred to its own design (bean pi-orchestrator-knz7): it splits the cache and changes what a pin means.
- **Top-level effort switching on any model.** Simple, but pays a cache rewrite per change. Rejected.

## Consequences

- On Claude, a worker's effort usually changes once per task, plus on each steer or follow-up. The orchestrator gains on every user prompt.
- The payload rewrite depends on a beta header and provider specifics, and needs a capability table kept current per model.
- The judge adds one small model call (`anthropic/claude-haiku-5-5:low` by default, key `orchestrator.routing.effortJudge`) before each judged message.
