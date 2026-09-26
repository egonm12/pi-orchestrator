---
status: accepted
date: 2026-09-26
---

# Forked workers run on the session model, and background workers talk both ways

Version 2 of the `subagents` tool (ADR 0007) adds forked workers, background workers with two-way communication, resume and nested delegation. A forked worker is the one exception to routing: it starts from a copy of the orchestrator's conversation and runs on the orchestrator's own session rung, so the context it inherits was built on that model. Chains are dropped, because composing results is the orchestrator's job.

## Considered options

- **Route forked workers like other workers.** A fork's value is its inherited context; a cheaper rung would read a conversation it did not help build. Rejected.
- **Keep the subagent ban list for forks.** The owner's session may run on a model banned for workers, and then forks could never run. A fork is the main thread continued, so it is exempt, and its record says so.
- **Background workers with only a completion notice.** Without a way to see progress, steer or answer a question, the orchestrator would guess or fall back to a foreground call. Rejected in favour of status, wait, messages and reports.
- **Chains** (one step's output feeds the next). They hide a decision point from the orchestrator, which can already make two calls in a row. Dropped.
- **Per-agent settings.** No concrete need beyond the definition's `model` and the global switches. Dropped.

## Consequences

- A forked worker's copy ends before the assistant message that makes the delegating call. Its pin is the session model and effort at that call, and it does not follow later model switches. It may name an agent definition for instructions and narrowed tools; the definition's `model` and `thinking` are ignored. It writes a `fork` record keyed by its delegation id.
- A `background: true` call returns at once with the delegation ids. Each call keeps its own `maxParallel`; `orchestrator.subagents.maxBackgroundWorkers` (default 8) refuses a background call that would exceed it. Ctrl+C leaves background workers running; `/subagents` lists and stops them, and session shutdown aborts them.
- `subagents_status({ id?, wait? })` lists background calls, gives a snapshot of a call or a delegation, and can wait for a call. `subagents_message({ id, text, mode })` steers one delegation or answers its question. A result is delivered once: to a pending wait, otherwise as a completion notice. Ctrl+C during a wait stops only the wait.
- A background worker has a `report` tool: progress waits for the orchestrator's next turn, a question starts a turn and blocks the worker until it gets a reply or is stopped. Foreground workers get progress only.
- A resume item `{ resume, task }` continues the same delegation, session and pin, for any worker saved under the orchestrator's session except a not-started or still-running one. The pin must pass the hard filters again, or the resume is refused; it is never re-routed. The latest verdict on a delegation counts.
- A worker may delegate only when its agent definition lists `subagents`, one level deep, foreground only, routed, with its own `maxParallel` per call. Its records name the parent delegation. Forked workers never delegate.
