# Harness glossary

## Language

**Orchestrator**:
The role the main session takes. It owns clarification, task decomposition, delegation, synthesis and acceptance. It hands exploration and substantial work to workers and keeps only small known actions, such as a single lookup, a small edit or a commit.

**Worker**:
An agent the orchestrator hands one bounded piece of investigation, implementation or verification work to. It reports to the orchestrator, never to the user.
_Avoid_: Execution agent, subagent (that is pi-subagents' mechanism and tool name, not the role)

**Delegation**:
One handing of one piece of work from the orchestrator to a worker. Each attempt has a delegation id.
_Avoid_: Dispatch, spawn

**Routing policy**:
Rules selecting the rung for a task from the tier map, according to task risk, ambiguity, complexity and kind of work, with correctness prioritized over speed and cost. The execution role is the orchestrator's choice, not the router's.

**Approved scope**:
Work the user has authorized to proceed without further scope approval.

**Shadow decision**:
An experimental routing recommendation recorded for evaluation but not controlling execution.

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

**Verdict**:
The independent reviewer's outcome for a delegated task: accepted or changes requested. The only feedback signal the router learns from.
_Avoid_: Self-report, attestation, score

**Decision record**:
The append-only record of one routing decision: the tier and why, the resolved tier map, every removed rung, any escalation, the chosen rung or the refusal, the mode, and in shadow mode the model chosen by hand. Keyed by the delegation id, which is how a verdict is attached to it.
_Avoid_: Log entry, trace (a trace is ticket 18's detailed delegation record)

**Orphaned verdict**:
A verdict whose delegation id matches no decision record. Kept and counted, never dropped or guessed onto a decision.

**Hard filter**:
A rule that removes rungs before the tier choice and that no preference can override: the subagent ban list, the allowed-model list, usage limits, context window, task budget and approved recipients.

**Escalation**:
Moving a task to the next higher tier because the hard filters removed every rung of its current tier. Only ever upward, one tier at a time; an emptied critical tier is a refusal, not a move down.
Older harness text uses "escalation" more loosely: for ticket 06's low-confidence fallback to the most restrictive tier, and for ticket 11's stronger-model retry. Neither is this term.
_Avoid_: Fallback (ticket 06's low-confidence fallback tier is a different rule), downgrade

**Subagent ban list**:
The owner's list of model names that no worker may run on, matched by name regardless of provider or tier map. Does not bind the orchestrator's own session.
_Avoid_: Prohibited patterns, Fable/Astra rule, ban list (alone)

**Session ban list**:
The owner's optional list of model names the orchestrator's own session may not run on. Empty by default.

**Classifier**:
The step that assigns a tier to a task. A general instruction model applies a fixed rubric to the task text and role and answers in a JSON schema; keyword signals set a floor it cannot lower.
_Avoid_: Decision engine, Jev, scorer, System One

**Router extension**:
The personal pi extension that fills in the model on `subagent` calls that name none: it classifies the task, routes it through the tier map and records the decision. In shadow mode it classifies and records but never writes a model; in live mode it writes the chosen rung into the call. A named model always wins and is recorded as explicit. It never blocks a call and fails open with one line; refusing banned models stays the guard's job.
_Avoid_: Router (alone, when the extension is meant), proxy, auto-model
