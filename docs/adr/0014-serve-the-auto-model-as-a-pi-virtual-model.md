# Serve the auto model as a pi virtual model

We serve the auto model through pi's `registerVirtualModel` instead of our own `orchestrator` provider that forwarded each request, and we keep a worker's pin in the virtual model's session state instead of in process memory and the decision record. Pi's virtual models give us compaction against the physical model's context window, cost per physical model and branch-persisted router state for free, so our provider shim and its process-wide resume-pin map have nothing left to do.

## Consequences

- pi-orchestrator requires pi v0.99 or later. Older hosts are not supported, and there is no fallback to the old provider.
- Pi owns retries. It retries rate limits and transient errors on its own, so a limit later in the run stays on the pin until pi's retries run out. Pi never retries quota or billing errors, so failover on the first request is driven by the worker runtime calling `continue` after recording the usage observation.
- A virtual model cannot route to another virtual model. In shadow mode, when the orchestrator runs on another extension's virtual model, a worker runs on the physical model that last answered the orchestrator.
