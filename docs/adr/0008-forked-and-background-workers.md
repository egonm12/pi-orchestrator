---
status: accepted, amended by the dated amendments below
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
- Superseded by ADR 0016: a worker may delegate only when its agent definition lists `subagents`, one level deep, foreground only, routed, with its own `maxParallel` per call. Its records name the parent delegation. Forked workers never delegate.
- Note (2026-09-30, bean 3cbz): an orchestrator's call that leaves `background` out now runs in the background too, and `background: false` chooses the foreground. A foreground call holds the orchestrator's turn, so the user's steering waited until its slowest worker returned. Superseded by ADR 0016: a worker's call stays foreground only: leaving the option out keeps it foreground, and `background: true` is still refused. Limits, stop, status, wait, messages and notices are unchanged.

## Amendment, 2026-10-13: one result per worker

A background call no longer sends one completion notice after all its items finish. Each worker's result is delivered once, as soon as that worker finishes: to a pending `subagents_status` wait on its call, otherwise as its own notice. The last item's notice also says the call finished and names the workers whose results came earlier. A wait on a call still blocks until the call finishes, and returns the results not yet delivered with the call-finished line; results delivered earlier are named by id, not repeated. A result that finished while a wait was pending gets its own notice if the wait stops early. Notices are still held until the orchestrator settles.

The reason is the speed benchmark (bean pi-orchestrator-2gri). 38% of delegated turns had several workers, and the slowest finished a median of 4 minutes (p90 20 minutes) after the fastest. The orchestrator waited for it before it could act on any result.

## Amendment, 2026-10-13: forced check-in and a reply timeout

Questions still wait without a time limit, but a worker no longer runs for an hour without reporting back. After 15 minutes or 40 model calls, whichever comes first, and every 15 minutes after that (owner settings under `orchestrator.subagents.checkIn`, which can turn it off), the harness steers the worker to check in: what it has done, what blocks it and its planned next step.

- A background worker's check-in takes the question's path: it waits, and the orchestrator answers with `subagents_message`: `continue`, `accept` (the worker ends with its Result as it stands), `stop` (it aborts) or `hint: <text>`. Any other text counts as a hint, so a reply cannot stop a worker by accident. Unlike a question, a check-in has a reply timeout, 5 minutes by default: without a reply the worker goes on and the orchestrator gets a note. A worker must not stall on an orchestrator that is busy elsewhere.
- A foreground worker cannot wait for a reply, since its caller's turn waits on it. Its check-in ends its run: its tool calls are blocked and it returns its partial Result, which a resume continues.
- Accepted or ended work that edited still goes through the quality gate.

This replaces a separate pause and abort control (bean pi-orchestrator-mfli): stop and accept are the check-in's answers.
