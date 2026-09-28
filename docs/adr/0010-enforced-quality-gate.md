---
status: accepted, amended by ADR 0013
date: 2026-09-27
---

# The quality gate is enforced, not advised

The orchestrator is the quality gate for every worker result that changed files, and pi-orchestrator enforces that it judged the result. A worker that edited needs a verdict: its session, or a worker it delegated to, ran `edit`, `write`, a `bash` command not recognised as a read-only search or a build or test run, or code through `ctx_execute` or `ctx_execute_file`; a `ctx_batch_execute` counts when one of its commands would. The orchestrator records the verdict with a `subagents_verdict` tool (delegation id, accept or request changes, reason). Until it does, `git commit` and `git push` are blocked, and the turn end names the unjudged delegations. New delegations are not blocked, because the runtime cannot tell before a worker runs whether it will edit. This differs from the Claude Code orchestrator plugin, whose gate is advice in its protocol only.

## Considered options

- **Advice only (the Claude plugin, version 0.2.0).** The protocol says "a worker report is evidence, not a verdict", and nothing checks it. ADR 0005 measured that advice alone does not hold the orchestrator role, and it leaves the router without verdicts to learn from: `attachVerdict` existed but had no caller.
- **A report gate on the worker's side (the Claude plugin, version 0.1.0).** A model call judged each worker's closing text for evidence. It read the wrong text, fired for internal agents and cost one model call per worker; the plugin removed it. The runtime here only checks the Result's section headers, without a model call, and annotates rather than rejects.
- **A reviewer worker records verdicts by structured output.** Leaves the orchestrator's own spot checks unrecorded and ties verdicts to one agent definition. Rejected: the orchestrator records every verdict, whoever did the checking.
- **Block the orchestrator's final reply.** Traps the user in a loop. Committing unjudged work is the real harm, so that is what is blocked.

## Consequences

- Every non-fork worker gets the reporting rules and the Result format (Confirmed with `file:line`, Changed, Unverified, Could not check, Verified by) appended to its system prompt, whatever its agent definition says.
- A delegation without a tier (a forked worker, or one whose agent definition names a model) is gated as elevated.
- Elevated and critical delegations need a reviewer worker, routed through the auto model at the implementer's tier or higher and never on the implementer's rung. When routing cannot choose another rung, in shadow mode or with routing off, the reviewer runs on the same rung with a fresh context, and its verdict is recorded as a same-rung review. A reviewer may read, search, build and test, but its editing calls are denied, so it never becomes an editing delegation itself. `subagents_verdict` refuses a self-judged verdict there unless it names the reviewer delegation. The gate level (ADR 0011) can require a reviewer for lower tiers too.
- `request_changes` returns the next effort-ladder rung; the orchestrator starts a retry delegation carrying the feedback, linked to the failed attempt. After two climbs the task goes back to the user. In shadow mode or with routing off the retry runs on the session model like any worker; its effort-ladder record names the rung it would have used, and the two-climb limit still applies.
- Research results are checked by the protocol but get no verdict. The orchestrator's spot checks count toward the exploration budget (ADR 0005); larger checks go to a reviewer worker.
- A verdict that was needed and never recorded is *missing*; one that was not needed is *ungated*. Neither is a learning observation, and the routing report counts both.
