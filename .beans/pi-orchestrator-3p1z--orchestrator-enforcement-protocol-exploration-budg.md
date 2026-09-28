---
# pi-orchestrator-3p1z
title: 'Orchestrator enforcement: protocol, exploration budget, quality gate'
status: in-progress
type: epic
priority: normal
created_at: 2026-09-27T21:45:45Z
updated_at: 2026-09-28T08:40:24Z
---

Design session (split-plan 'orchestrator enforcement', ADR 0005). Keeps the main session in the orchestrator role.

## Settled
- Protocol appended to the system prompt on every before_agent_start (survives compaction).
- No per-prompt reminder line.
- Exploratory calls: read; bash searches/listings (rg, grep, find, ls, cat, git log/show/diff) and unknown bash; web_search, fetch_content, get_search_content, source_check; ctx_execute, ctx_execute_file, ctx_search, ctx_batch_execute, ctx_fetch_and_index; mcp/mcpScript reads. Not counted: edit, write, bash build/test/commit, subagents tools.
- Budget resets per user prompt (input), not per model turn.
- Threshold 3 per prompt, then deny with a delegate instruction; owner-configurable.
- Binds only the orchestrator session; workers, forked workers and pi-subagents children are exempt.

## Open
- [ ] Worker self-verification and orchestrator as quality gate (learn from claude-plugins)
- [ ] Classifier-adjusted threshold per prompt
- [ ] User override of the budget


## Findings: claude-plugins quality gate
- The plugin enforces nothing with hooks. Workers get four reporting rules in the verifying-worker agent prompt (verify before reporting, file:line for every claim, label unverified, say what could not be checked) and a Confirmed/Changed/Unverified/Could not check format.
- v0.2.0 removed its SubagentStop report gate (wrong reply format, read closing text instead of the report, fired for internal agents, one model call per stop).
- The protocol makes the orchestrator the gate: 'A worker report is evidence, not a verdict. Check it before you act on it.' No retry limit, no separate reviewer.
## Findings: pi-orchestrator today
- Workers get no reporting rules; only the report tool is added. No agent definitions are shipped.
- verdicts.ts (attachVerdict) and effort-ladder.ts exist, but only tests call attachVerdict. src/routing/verdict-reviewer.md targets pi-subagents outputSchema, not the own runtime.


## Settled (round 2)
- Term: a worker's final reply is a **Result**; **Report** keeps its meaning (CONTEXT.md updated, plus **Quality gate**).
- Reporting rules are appended to every non-fork worker's system prompt, whatever its agent definition.
- Result format: Confirmed (file:line), Changed, Unverified, Could not check, plus Verified by (commands run).
- Gate spot checks count toward the exploration budget; larger checks go to a reviewer worker.
- New subagents_verdict tool (delegationId, accept|request_changes, reason) wires attachVerdict; the orchestrator records every verdict.


## Settled (round 3)
- A verdict is required for any worker whose session ran edit or write. Research results are checked but get no verdict.
- A missing verdict blocks git commit/push and new editing delegations; the turn end names unjudged delegations. The final reply is never blocked.
- Elevated and critical tiers need a reviewer worker; mechanical and standard may be judged by the orchestrator's spot check. subagents_verdict refuses a self-judged verdict on elevated/critical without a named reviewer delegation.
- Reviewer is routed through the auto model at the implementer's tier or higher, never on the implementer's rung.
- request_changes: subagents_verdict returns the next effort-ladder rung; the orchestrator starts a retry delegation with the feedback, linked to the failed attempt. Max 2 climbs, then back to the user.
- The runtime checks Result section headers without a model call and only annotates when one is missing.

## Open (round 4)
- [ ] Configurable gate strength (low/medium/high/max) or orchestrator-judged criticality


## Settled (round 4)
- Gate level: low, medium, high, max. The owner's level sets a floor per tier; the orchestrator may raise it for one delegation (reason in the verdict call), never lower it.
- Table (tier: low / medium / high / max): mechanical none/spot/spot/reviewer; standard none/spot/reviewer/reviewer; elevated spot/reviewer/reviewer/reviewer; critical reviewer at every level. At max every reviewer reruns the result's Verified by commands.
- Personal default medium in settings, project override, /orchestrator gate <level> for the session.
- [x] Configurable gate strength


## Settled (round 5)
- Ungated (gate action none) and missing (needed, never recorded) are counted apart in the decision record and routing report; neither is a learning observation. Replaces verdicts.ts' current meaning of missing.
- Budget stays a flat 3 per prompt; no classifier call per prompt.
- /orchestrator budget off lifts the budget for the current prompt only; the model cannot lift it from prose.
- ADRs written: 0010 (enforced quality gate), 0011 (gate level is an owner floor). CONTEXT.md: Result, Quality gate, Gate level, Ungated delegation, Missing verdict.
- [x] Worker self-verification and orchestrator as quality gate
- [x] Classifier-adjusted threshold per prompt
- [x] User override of the budget

## Next
- [x] Confirm shared understanding with the owner
- [x] Split into implementation beans (protocol, exploration budget, worker reporting rules, subagents_verdict + commit block, gate level, routing report ungated/missing)


## Ticket review (worker 01a0e4ee)
10 of 11 ok, mxmz needed changes. Applied:
- mxmz: criterion 'The protocol names the current gate level'. CONTEXT.md gains Gate action.
- l8af: missing is derived in the report from recorded gate requirements, not recorded at session_shutdown (which also fires for reload, resume, new, fork). Missing verdict definition adjusted.
- mw81: commit/push matcher is new plumbing; chained commands and git options covered.
- jeyq: spot checks count, as an explicit criterion.
- y8cd: before_agent_start runs once per user prompt; system prompt applies to every model request.
- vu2o: the subcommand dispatcher is new.
Rejected: jeyq's redundant vu2o edge (it uses vu2o directly, kept); kokv's stale file slug (cosmetic, title is correct).


- y8cd: owner chose to accept and document the protocol gap in message-started runs (no context_with_system fallback).


- Open for the owner (from kokv): should ctx_batch_execute in a worker count as editing, like ctx_execute?
