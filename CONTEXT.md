# Harness glossary

## Language

**Orchestrator**:
The role the main session takes. It owns clarification, task decomposition, delegation, synthesis and acceptance. It hands exploration and substantial work to workers and keeps only small known actions, such as a single lookup, a small edit or a commit.

**Worker**:
An agent the orchestrator hands one bounded piece of investigation, implementation or verification work to. It reports to the orchestrator, never to the user.
_Avoid_: Execution agent, subagent (that is the tool that starts workers, not the role)

**Forked worker**:
A worker whose context starts as a copy of the orchestrator's conversation up to the delegating call. The only worker that runs on the orchestrator's own session model and effort, unrouted.
_Avoid_: Clone, branch, fork (alone)

**Result**:
A worker's final reply to the orchestrator: what it confirmed with evidence, what it changed, what it suspects but did not verify, and what it could not check. Evidence, not a verdict: the orchestrator checks it before acting on it.
_Avoid_: Report (that is a background worker's message), answer, output

**Quality gate**:
The orchestrator's duty to judge every implementation result before using it, by its own spot check or an independent reviewer, and to record that judgement as a verdict.
_Avoid_: Review gate, report gate

**Gate level**:
How strictly the quality gate treats each tier: low, medium, high or max. Per tier it sets the gate action (none, the orchestrator's spot check, or an independent reviewer). The owner's level is a floor; the orchestrator may raise it for one delegation, never lower it.
_Avoid_: Verification level (that sounds like the worker's own checks), review level

**Gate action**:
What the quality gate requires for one editing delegation: none, a spot check (the orchestrator's own verdict) or a reviewer (an independent reviewer worker). Set by the gate level and the delegation's tier.

**Background worker**:
A worker whose delegating call returned before it finished. The orchestrator can check on it, steer it and answer its questions.

**Report**:
A message a background worker sends the orchestrator on its own: progress, or a question it waits on.
_Avoid_: Callback, notification (that is the completion notice)

**Worker state**:
Where a worker is in its life: *queued* (held back until a parallel slot frees), *running*, *asking* (waiting on the answer to a question it reported), then one end state: *completed*, *failed* or *aborted*. Only a background worker can be *asking*.
_Avoid_: Status (that is the tool that reports worker states), waiting

**Agent definition**:
A named, owner-written description of a kind of worker: its instructions and the tools it may use. Read from the owner's and the project's agent folders; pi-orchestrator ships none.
_Avoid_: Role (that is the orchestrator/worker split), persona

**Delegation**:
One handing of one piece of work from the orchestrator to a worker. Each attempt has a delegation id: the id of the worker's pi session. Resuming a finished worker continues the same delegation; a retry on the effort ladder is a new one. A delegation made by a worker, not by the orchestrator, has that worker's delegation as its parent delegation.
_Avoid_: Dispatch, spawn

**Editing delegation**:
A delegation whose worker, or a worker it started, changed files or ran something that may have: anything beyond reading, searching, building and testing. It needs a verdict; a research delegation is checked but gets none.
_Avoid_: Implementation delegation (the kind of work is the classifier's, editing is what the worker did)

**Routing policy**:
Rules selecting the rung for a task from the tier map, according to task risk, ambiguity, complexity and kind of work, with correctness prioritized over speed and cost. The execution role is the orchestrator's choice, not the router's.

**Approved scope**:
Work the user has authorized to proceed without further scope approval.

**Shadow decision**:
An experimental routing recommendation recorded for evaluation but not controlling execution.

## Watching workers

**Worker widget**:
The list below the editor, in Claude Code's agent list style: `main`, the orchestrator's own agent, then one row per worker on the board with its agent name, its activity or last status, and its elapsed time and tokens. The /subagents picker and the transcript view's nested workers use the same rows.
_Avoid_: Status line, subagent list

**Activity**:
What a worker is doing right now, in a word: `thinking…`, `writing…`, the name of the tool it runs, or why it failed. It changes by phase, never with each streamed piece of text.
_Avoid_: Current action, live status

**Transcript view**:
One worker's whole session, shown in place of the orchestrator's view until the user leaves it.
_Avoid_: Subagent view, worker view

## Routing

**Tier**:
One of four levels of care a task demands: mechanical, standard, elevated or critical. The classifier assigns a tier; the tier map says what may run it.
_Avoid_: Complexity level, SIMPLE/MEDIUM/COMPLEX/REASONING

**Rung**:
One model at one effort level, written `provider/model:effort`. The unit the router chooses.
_Avoid_: Model (alone), deployment

**Tier map**:
The owner's ordered list of rungs per tier. A project may override it. Initial routing chooses listed rungs; the effort ladder may raise a listed model to its next supported effort.
_Avoid_: Model list, pool

**Effort**:
How much thinking a model is allowed per turn, as pi's levels off through max.
_Avoid_: Reasoning effort, thinking budget

**Effort ladder**:
Bounded recovery's retry order after a changes-requested review: one supported effort step on the same model, then the next surviving listed rung in the same tier, then the first survivor in higher tiers. Every candidate passes the router's hard filters. Max requires an explicit listing for that model. Each admitted climb links its decision record to the failed attempt, and recovery limits still stop the sequence.
_Avoid_: Reclassification, suitability-score escalation

**Unplaced climb**:
A retry of an attempt the effort ladder cannot position: routing is off, the attempt was a fork or named-model worker, its route refused, or its rung is no longer in the tier map. Its effort-ladder record has step `unplaced` and no rung. It counts toward the two-climb limit; with routing on it routes normally, without a forced rung.

**Verdict**:
The quality gate's outcome for a delegated task: accepted or changes requested, recorded by the orchestrator whether it came from its own check or an independent reviewer. The only feedback signal the router learns from.
_Avoid_: Self-report, attestation, score

**Decision record**:
The append-only record of one routing decision: the tier and why, the resolved tier map, every removed rung, any escalation, the chosen rung or the refusal, the mode, and in shadow mode the model chosen by hand. Keyed by the delegation id, which is how a verdict is attached to it.
_Avoid_: Log entry, trace (a trace is ticket 18's detailed delegation record)

**Ungated delegation**:
An editing delegation whose gate action was none at its gate level, so no verdict was needed. Counted apart from missing verdicts; never a learning observation.

**Missing verdict**:
A verdict the gate level required that was never recorded. Never a learning observation.

**Same-rung review**:
A review that ran on the implementer's own rung because routing could not choose another, in shadow mode or with routing off. It still starts from a fresh context; the verdict it backs says so, and the routing report counts it apart.

**Orphaned verdict**:
A verdict whose delegation id matches no decision record. Kept and counted, never dropped or guessed onto a decision.

**Hard filter**:
A rule that removes rungs before the tier choice and that no preference can override: the subagent ban list, the allowed-model list, usage limits, context window, task budget and approved recipients.

**Escalation**:
Moving a task to the next higher tier because the hard filters removed every rung of its current tier. Only ever upward, one tier at a time; an emptied critical tier is a refusal, not a move down.
Older harness text uses "escalation" more loosely: for ticket 06's low-confidence fallback to the most restrictive tier, and for ticket 11's stronger-model retry. Neither is this term.
_Avoid_: Fallback (ticket 06's low-confidence fallback tier is a different rule), downgrade

**Subagent ban list**:
The owner's list of model names that no worker may run on, matched by name regardless of provider or tier map. The two exceptions are a forked worker, which runs on the orchestrator's session model, and a model an agent definition names, when the owner has switched that exception on. Does not bind the orchestrator's own session.
_Avoid_: Prohibited patterns, Fable/Astra rule, ban list (alone)

**Session ban list**:
The owner's optional list of model names the orchestrator's own session may not run on. Empty by default.

**Classifier**:
The step that assigns a tier to a task. A general instruction model applies a fixed rubric to the task text and role and answers in a JSON schema; keyword signals set a floor it cannot lower.
_Avoid_: Decision engine, Jev, scorer, System One

**Router extension**:
The part of pi-orchestrator that serves the auto model: it classifies a worker's first request, routes it through the tier map, pins the worker and records the decision. When routing refuses, and in shadow mode, the worker runs on the orchestrator's own session model. A worker that names a real model is not routed; refusing banned models stays the guard's job.
_Avoid_: Router (alone, when the extension is meant), proxy

**Auto model**:
The virtual model `orchestrator/auto` that workers run on. Each request to it goes to the rung the router extension chose for that worker. The orchestrator's own session never runs on it.
_Avoid_: Smart router, proxy model, auto-routing model

**Pin**:
The rung a worker keeps for all of its requests, chosen at its first request. A forked worker's pin is the orchestrator's session rung at the delegating call. It holds through compaction and ends with the worker.
_Avoid_: Session affinity, sticky model
