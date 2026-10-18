---
status: accepted
date: 2026-10-18
amends: ADR 0015, ADR 0016, ADR 0020
---

# Delegate less and budget simple workers

The owner found simple work much slower than in Claude Code. Session data from 30 days (about 670 workers) showed where the time went, beyond tier maps set to high effort:

- The handling judge chose `delegate` for 64% of owner prompts. Its reasons were mostly "several stages" or "likely to run for minutes", which describes almost any task.
- The protocol told the orchestrator to delegate past two exploratory commands, or for any open question.
- The classifier put read-only research in standard 113 times and in mechanical 13 times, because rubric question 3 ("does the task need real reasoning?") caught any fact-finding.
- Standard workers took a median of 32 turns, and routed workers may delegate again (ADR 0016).

Each worker costs a routing call, its own startup, a task the orchestrator writes and a Result it checks: often a minute before useful work starts. For a short task that overhead is most of the time.

## Decision

- **Self is the default.** The protocol tells the orchestrator to do the work itself: a question, a few reads and searches, an edit in a few files, a fix it can see, a build, test run or commit. It delegates when the work has independent parts that can run in parallel, when it is large (broad research, changes across many files), or when its output would be large. Taking a few minutes is no reason to delegate. The two-command trigger is gone.
- **Handling criteria.** The handling judge and the effort judge's combined question share one text (`handling-criteria.ts`): self is the default, delegate only for parallel parts or large work, and running for minutes is not a reason.
- **Safety limit 20.** `orchestrator.subagents.explorationNudge` now defaults to 20, so a self prompt is not nudged mid-task after 8 reads.
- **Rubric `tier-rubric-6`.** Question 3 asks whether the task diagnoses a cause, reviews a design or pull request, or changes more than a small, clear fix. Read-only gathering (finding, listing, inventorying, summarising, comparing documented facts, explaining code) is mechanical however many files it reads, and a read-only task between standard and mechanical goes to mechanical.
- **Worker budget.** A routed worker whose task is mechanical or standard gets a `worker_budget` section in its system prompt and loses `subagents`, `subagents_status` and `subagents_message`. Mechanical aims for about 8 tool calls and stops near 15; standard aims for about 25 and stops near 50. Stopping means replying with a partial Result and what is left, never a hard abort. Elevated and critical workers keep delegating, as ADR 0016 holds for them. The router applies the budget in `before_agent_start`, awaiting the classification the first request awaits anyway. `orchestrator.routing.workerBudget: false` turns it off.

## Considered options

- **A hard turn limit.** Aborting a worker mid-change can leave a half-edited tree. Rejected: the budget asks the worker to stop and report, and the orchestrator decides.
- **Strip the delegation tools in the virtual model's route.** The route chooses a model and effort; it cannot change the tools a request declares. Rejected in favour of `setActiveTools` before the run.
- **Keep nested delegation for standard.** Standard work is routine by definition; a second level of workers multiplies the per-worker overhead. Rejected.

## Consequences

- More prompts run in the orchestrator's own session, on its model and effort, which costs more per token than a cheap rung but less wall time for short tasks.
- Delegation rates and tier spreads change; compare `handling-decision` and `decision` records from before and after this date.
- A standard worker that needs its own workers must be elevated, or the owner turns the budget off.
