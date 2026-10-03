# Harness glossary

## Language

**Orchestrator**:
The role the main session takes. It owns clarification, task decomposition, delegation, synthesis and acceptance. It hands exploration and substantial work to workers and keeps only small known actions, such as a single lookup, a small edit or a commit.

**Orchestrator protocol**:
The rules the orchestrator follows to delegate and judge, carried in its system prompt. It is on every request of every orchestrator run: a run a prompt starts (typed, a skill or a template) and a run a message starts, such as a completion notice, a worker's report or question, or a gate reminder. Workers never get it.
_Avoid_: Orchestrator prompt, system rules

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
The orchestrator's duty to judge every implementation result before using it, by its own spot check or an independent reviewer, and to record that judgement as a verdict. It reminds, never blocks: commit and push go through and name the delegations still waiting for a verdict. At gate level off there is no quality gate.
_Avoid_: Review gate, report gate

**Gate level**:
How strictly the quality gate treats each tier: off, low, medium, high or max. Per tier it sets the gate action (none, the orchestrator's spot check, or an independent reviewer); at off every tier's action is none. The owner sets a personal level and each project may set its own, higher or lower. The owner's level is a floor; the orchestrator may raise it for one delegation, never lower it.
_Avoid_: Verification level (that sounds like the worker's own checks), review level

**Worker limit**:
How many workers run at the same time across the whole orchestrator session, foreground and background together. Workers beyond it are queued, never refused. The owner sets a personal limit and each project may set its own, higher or lower.
_Avoid_: Max parallel, background worker limit, items per call

**Gate action**:
What the quality gate requires for one editing delegation: none, a spot check (the orchestrator's own verdict) or a reviewer (an independent reviewer worker). Set by the gate level and the delegation's tier.

**Background worker**:
A worker whose delegating call returned before it finished. The orchestrator can check on it, steer it and answer its questions; the user can steer it from its transcript view.

**Report**:
A message a background worker sends the orchestrator on its own: progress, or a question it waits on.
_Avoid_: Callback, notification (that is the completion notice)

**Worker state**:
Where a worker is in its life: *queued* (held back until a parallel slot frees), *running*, *asking* (waiting on the answer to a question it reported), then one end state: *completed*, *failed* or *aborted*. Only a background worker can be *asking*.
_Avoid_: Status (that is the tool that reports worker states), waiting

**Agent definition**:
A named, owner-written description of a kind of worker: its instructions and the tools it may use. Read from the owner's and the project's agent folders; pi-orchestrator ships none. Its tools list names MCP tools, `codemode` and `tool_search` like any other tool; a worker without one gets them as the orchestrator does.
_Avoid_: Role (that is the orchestrator/worker split), persona

**Delegation**:
One handing of one piece of work from the orchestrator to a worker. Each attempt has a delegation id: the id of the worker's pi session. Resuming a finished worker continues the same delegation; a retry on the effort ladder is a new one. A delegation made by a worker, not by the orchestrator, has that worker's delegation as its parent delegation.
_Avoid_: Dispatch, spawn

**Editing delegation**:
A delegation whose worker, or a worker it started, changed files in the working tree, as a comparison of the tree before and after the worker shows. When workers run at the same time, a change counts for every worker that was running when it happened. Running commands alone does not make it one. Where there is no repository to compare, anything beyond reading, searching, building and testing counts. It needs a verdict; a research delegation is checked but gets none.
_Avoid_: Implementation delegation (the kind of work is the classifier's, editing is what the worker did)

**Exploration nudge**:
A reminder added to the result of each exploratory call the orchestrator makes beyond a set number in one user prompt, suggesting it hand the rest to a worker. Guidance, never a denial.
_Avoid_: Exploration budget (the earlier hard limit), call limit

**Label**:
A short text the orchestrator gives one delegation to say what it is for, such as `research: budget code`. Shown wherever the worker is listed, falling back to its agent definition and then to `worker`. A retry keeps the label of the delegation it retries. A reviewer is shown as `reviewer: <label>`, with its own label or else the reviewed delegation's, and as plain `reviewer` when neither has one.
_Avoid_: Role (that is the orchestrator/worker split), title, name

**Routing policy**:
Rules selecting the rung for a task from the tier map, according to task risk, ambiguity, complexity and kind of work, with correctness prioritized over speed and cost. The execution role is the orchestrator's choice, not the router's.

**Approved scope**:
Work the user has authorized to proceed without further scope approval.

**Shadow decision**:
An experimental routing recommendation recorded for evaluation but not controlling execution.

## Watching workers

**Worker widget**:
The list below the editor, in Claude Code's agent list style: `main`, the orchestrator's own agent, then one row per worker on the board: label · tier · rung · elapsed time · worker state, and while the worker runs its activity. The rung is short, the model without its provider plus the effort (`opus-5-5:xhigh`); the transcript view and the status snapshot show the full rung. A row that is not running ends with its worker state, never with task text. The label takes the room the rest of the row leaves and is shortened only when the row does not fit. The /subagents picker, the transcript view's nested workers and the status output use the same rows.
_Avoid_: Status line, subagent list

**Activity**:
What a worker is doing right now, in a word: `thinking…`, `writing…`, the name of the tool it runs, or why it failed. It changes by phase, never with each streamed piece of text. A worker row shows it only while the worker runs; why a worker failed is in its transcript view.
_Avoid_: Current action, live status

**Transcript view**:
One worker's whole session, shown in place of the orchestrator's view until the user leaves it. For a running background worker it has a message input for user steering.
_Avoid_: Subagent view, worker view

**User steering**:
A message the user sends a running background worker from its transcript view: a steer, a follow-up or the answer to its question, delivered as the orchestrator's messages are. The orchestrator is told of each one in its session, and the worker's result lists them as the user's.
_Avoid_: Direct message, user override

## Routing

**Tier**:
One of four levels of care a task demands: mechanical, standard, elevated or critical. The classifier assigns a tier; the tier map says what may run it.
_Avoid_: Complexity level, SIMPLE/MEDIUM/COMPLEX/REASONING

**Rung**:
One model at one effort level, written `provider/model:effort`. The unit the router chooses. In pi's terms, a rung names a physical model and its thinking level.
_Avoid_: Model (alone), deployment

**Tier map**:
The owner's list of rungs per tier. A project may override it. Initial routing chooses listed rungs; the effort ladder may raise a listed model to its next supported effort. Each tier has a tier order.

**Tier order**:
How a tier picks among the rungs that survive the hard filters. *Balanced* (the default): the rung whose provider started the fewest delegations in the last 5 hours, across all the owner's sessions and projects, with list order breaking ties. A provider under 10% left counts 5 extra delegations; it is weighed, never removed. *Ordered*: the first survivor in the list.
_Avoid_: Load balancing, round-robin, priority
_Avoid_: Model list, pool

**Effort**:
How much thinking a model is allowed per turn, as pi's levels off through max.
_Avoid_: Reasoning effort, thinking budget

**Effort ladder**:
Bounded recovery's retry order after a changes-requested review: one supported effort step on the same model, then the next surviving listed rung in the same tier, then the first survivor in higher tiers. Every candidate passes the router's hard filters. Max requires an explicit listing for that model. Each admitted climb links its decision record to the failed attempt, and recovery limits still stop the sequence.
_Avoid_: Reclassification, suitability-score escalation

**Unplaced climb**:
A retry of an attempt the effort ladder cannot position: routing is off, the attempt was a fork or named-model worker, its route refused, its rung is no longer in the tier map, or the climb failed with an error, which its record names. Its effort-ladder record has step `unplaced` and no rung. It counts toward the two-climb limit; with routing on it routes normally, without a forced rung.

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

**Usage observation**:
The latest known state of one provider's usage for the owner's account: available, low, exhausted or throttled, with the percentage left and the reset time when known. Learned from limit errors and response headers, shared by all the owner's sessions and projects. An exhausted or throttled provider is removed by a hard filter until its limit lifts. Response headers only ever give available or low (under 10% left), from a success response, attributed to the provider of the request in flight; they never end a limit an error reported while it holds, in whichever order sessions record the two. A header-derived percentage is current until the earlier of its reported window reset and five hours after observation.
_Avoid_: Quota, headroom (alone), balance

**Usage line**:
The last line of the orchestrator protocol, such as `usage: anthropic exhausted until 14:00 · openai-codex 62% left`: per provider, a limit still in force with when it lifts, else the percentage left when known. Read from the usage observations for each request, so it is on every orchestrator run; left out when no observation still says anything. Workers never get it.

**Limit error**:
A rung's error whose text says the provider refused for usage: a usage limit (the account's allowance is used up until a reset), which makes the provider exhausted, or a rate limit (too many requests for now), which makes it throttled. Each holds until the reset the text states, or for a set time when it states none.
_Avoid_: Quota error, 429 (alone: Codex also reports a usage limit as a 429)

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
The step that assigns a tier to a task. A general instruction model applies a fixed rubric to the task text and role and answers in a JSON schema, with a reason. No keyword list raises or replaces its answer. A task's tier follows the action it asks for, not the subject it touches: a review or investigation that changes nothing is never critical, and a prohibition ("do not delete anything") is a constraint, not a risk.
_Avoid_: Decision engine, Jev, scorer, System One, keyword floor

**Unclassified task**:
A task no classifier model could classify. It runs as elevated, and the routing log records it as unclassified.
_Avoid_: Keyword fallback

**Retry tier**:
A retry keeps the tier of the delegation it retries. Extra care comes from the effort ladder's next rung, not from classifying the retry again.

**Router extension**:
The part of pi-orchestrator that serves the auto model: it classifies a worker's first request, routes it through the tier map, pins the worker and records the decision. When routing refuses, and in shadow mode, the worker runs on the orchestrator's own session model. A worker that names a real model is not routed; refusing banned models stays the guard's job.
_Avoid_: Router (alone, when the extension is meant), proxy

**Auto model**:
The virtual model `orchestrator/auto` that workers run on. Each request to it goes to the rung the router extension chose for that worker. The orchestrator's own session never runs on it. In pi's terms, it is pi-orchestrator's virtual model, and the rung it routes to is the physical model.
_Avoid_: Smart router, proxy model, auto-routing model

**Pin**:
The rung a worker keeps for all of its requests, chosen at its first request. A failover on that first request is the one way it moves. A forked worker's pin is the orchestrator's session rung at the delegating call. It holds through compaction and ends with the worker.
_Avoid_: Session affinity, sticky model

**Failover**:
Pinning a worker again when its first request fails on a limit error before the rung produced anything: the worker is routed once more, now that the limit error's usage observation removes that provider, and runs on the next surviving rung, on another provider. The worker sees only the new rung's answer. A rate limit later in the run is retried on the pin by pi; when those retries run out, the worker fails. A quota limit later in the run fails the worker at once, as pi never retries it. A limit with no other provider's rung left fails the worker too. The decision record keeps the refused attempt's decision, a failover record linked to it by its time and rung, and the decision for the rung the worker moved to.
_Avoid_: Retry (that is the effort ladder's new delegation), fallback (the session model after a refusal)
