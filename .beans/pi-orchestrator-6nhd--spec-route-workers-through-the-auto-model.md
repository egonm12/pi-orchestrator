---
# pi-orchestrator-6nhd
title: 'Spec: route workers through the auto model'
status: completed
type: epic
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:33:32Z
updated_at: 2026-09-25T20:51:53Z
---

## Problem Statement

The owner uses pi-orchestrator to choose the model a worker runs on. Today the router extension does that by rewriting the `model` field of pi-subagents' `subagent` tool calls. That ties pi-orchestrator to pi-subagents: to decide whether an agent file already pins a model, and to record which model a worker would have got, it carries a copy of pi-subagents' agent discovery and model resolution that can drift from the installed version. The owner wants the orchestrator to decide the model and effort for every worker with any subagent extension, including one they may write themselves, and wants the main thread to stay on the model they picked.

## Solution

pi-orchestrator registers a virtual model, the auto model `orchestrator/auto`, as a pi provider (ADR 0006). A subagent extension starts workers on it, for example as its default worker model. The first model request of each worker is classified and routed through the tier map and the hard filters to a rung, and the worker keeps that rung, its pin, for every later request. The request is forwarded to the real rung with the owner's own login, and the reply comes back labelled `orchestrator/auto`. It works for foreground workers in the main thread's process and for background workers in their own process. The main thread is never routed: it stays on the model picked in `/model`, and selecting `orchestrator/auto` there is undone with one line. When the hard filters remove every rung, and in shadow mode, the worker runs on the orchestrator's own session model. Each routing decision is kept as a decision record keyed by the worker's session.

## User Stories

1. As the owner, I want `orchestrator/auto` to be available as a model in every pi session where pi-orchestrator is installed, so that any subagent extension can start workers on it.
2. As the owner, I want a worker started on `orchestrator/auto` to be routed to a rung from my tier map, so that the orchestrator decides the model and effort, not the subagent extension.
3. As the owner, I want routing to work with pi-subagents without pi-orchestrator reading pi-subagents' agent files or internals, so that a pi-subagents update cannot silently break routing.
4. As the owner, I want routing to work with a subagent extension I write myself, so that I am free to replace pi-subagents.
5. As the owner, I want a worker's first request to be classified into a tier, so that the rung matches the care the task needs.
6. As the owner, I want the classifier to read the worker's task from the user text before the worker's first reply, so that the task is classified and not the system prompt.
7. As the owner, I want keyword floor signals in the task text to keep raising the minimum tier, so that credentials or destructive work never land on a mechanical rung.
8. As the owner, I want the classifier to run in the process that received the request, through that session's model registry, so that no extra `pi` process starts (ADR 0004).
9. As the owner, I want the hard filters (subagent ban list, allowed-model list, usage limits, context window, task allowance, approved recipients) to remove rungs before the choice, so that no preference can override them.
10. As the owner, I want escalation to the next higher tier when every rung of a tier is removed, so that the task still runs on an adequate rung.
11. As the owner, I want every later request of the same worker to go to the same rung without a new classification, so that a worker never switches model in the middle of its task.
12. As the owner, I want a worker to be known by the session id pi passes with each model request, so that the pin works for foreground and background workers alike.
13. As the owner, I want a resumed worker session to find its pin again from its decision record, so that resuming a worker in a new process does not switch its model.
14. As the owner, I want the rung's effort to be sent with the forwarded request, so that the effort is the router's choice.
15. As the owner, I want a thinking level on the requested model, such as the `:high` pi-subagents adds from an agent file, to be ignored, so that an agent file cannot override the rung's effort.
16. As the owner, I want forwarded requests to use the rung provider's own credentials, including OAuth logins from other extensions, so that I do not configure credentials twice.
17. As the owner, I want replies labelled `orchestrator/auto`, so that a subagent extension that checks the reply's model against the launch model accepts it.
18. As the owner, I want earlier replies relabelled as the pinned rung when a request is forwarded, so that the rung accepts its own tool calls and thinking blocks.
19. As the owner, I want usage and cost of each reply to be the real rung's, so that pi's accounting and the task allowance stay correct.
20. As the owner, I want a worker that overflows its rung's context window to be compacted by pi and retried on the same rung, so that long tasks finish without a model switch.
21. As the owner, I want the auto model to declare the largest context window in my tier map, so that pi does not compact a worker on a large rung too early.
22. As the owner, I want the summary request that compaction sends to be classified and routed like any other first request, so that it needs no special handling that breaks when pi changes its wording.
23. As the owner, I want a worker to run on the orchestrator's own session model when the hard filters remove every rung in every tier, so that the worker still runs.
24. As the owner, I want that fallback refused with a clear reason when the orchestrator's model is on the subagent ban list, so that no worker runs on a banned model (ADR 0002).
25. As the owner, I want a background worker to know the orchestrator's model from the moment of delegation, so that the fallback and shadow mode work in a separate process.
26. As the owner, I want the request to fail with a clear reason when a worker's process does not know the orchestrator's model, so that nothing is guessed.
27. As the owner, I want shadow mode to run the worker on the orchestrator's model and record the rung the router extension would have chosen, so that I can evaluate routing before I let it choose.
28. As the owner, I want live mode to run the worker on the chosen rung, so that routing takes effect when I switch it on.
29. As the owner, I want a worker started on the orchestrator's model when routing is not enabled, with no decision record, so that `orchestrator/auto` never breaks a worker.
30. As the owner, I want a worker that names a real model to run on it unrouted, so that an explicit choice still wins.
31. As the owner, I want the guard to keep refusing a worker that names a model on the subagent ban list, so that explicit choices cannot bypass the ban.
32. As the owner, I want the guard not to refuse `orchestrator/auto` as a model name, so that routed workers start.
33. As the owner, I want my main thread to stay on the model I picked in `/model`, so that my chat keeps its cache and plans consistently.
34. As the owner, I want selecting `orchestrator/auto` for the main thread to be undone with one line naming the reason, so that I cannot put my chat on routing by mistake.
35. As the owner, I want only my own selection in `/model` to be undone, so that workers that start on `orchestrator/auto` are never refused.
36. As the owner, I want one decision record per classified worker session, keyed by the worker's session id as its delegation id, so that every routing decision can be found again.
37. As the owner, I want each decision record to name the model the worker actually ran on, so that shadow mode and fallbacks are visible next to the chosen rung.
38. As the owner, I want decision records written by background workers to land in the same state folder as foreground ones, so that one folder holds every decision.
39. As the owner, I want my existing decision records to stay readable, so that the history from before this change is kept.
40. As the owner, I want an internal failure of the router extension to print one line and run the worker on the orchestrator's model, so that a bug in routing never stops a worker when a safe model is known.
41. As the owner, I want the router's probe line to show each routed request's rung, pin and timing under `PI_ORCHESTRATOR_ROUTER_PROBE=1`, so that I can see routing work.
42. As a new user, I want `/pi-orchestrator init` to tell me to make `orchestrator/auto` the default worker model in my subagent extension, so that routing takes effect.
43. As a new user, I want init not to edit another extension's settings, so that pi-orchestrator stays independent of any subagent extension.
44. As a new user, I want the README to explain the auto model, the main thread rule, the fallback and how to point a subagent extension at it, so that I can set it up without reading the ADRs.
45. As the owner, I want nothing written inside the package checkout at runtime, so that an installed checkout stays clean.
46. As a maintainer, I want pi-subagents' agent discovery and model resolution copies removed, so that there is nothing left to drift.
47. As a maintainer, I want the model helpers the routing needs (thinking levels, thinking suffixes, the allowed-model match) to be pi-orchestrator's own and tested on their own, so that they no longer depend on a pi-subagents version.
48. As a maintainer, I want offline tests at one seam, the router extension as pi loads it, so that behaviour is tested the way pi drives it.
49. As a maintainer, I want live tests with a real foreground and a real background worker, so that pi-subagents' model check, compaction and the separate process are confirmed for real.

## Implementation Decisions

- **Router extension becomes a provider.** The router extension stops hooking `tool_call` for `subagent`. It registers the `orchestrator` provider with one model, `auto`, through `pi.registerProvider`, with its own `streamSimple`. The model declares reasoning and image input as supported, and the largest context window and output limit among the tier map's rungs, taken from pi's model registry. It re-registers when the tier map is read at session start.
- **Forwarding.** The provider forwards through the `modelRegistry` of the session that loaded the router extension in that process, calling `streamSimple` on the chosen rung's model. It drops the `apiKey` and `headers` pi resolved for the `orchestrator` provider, so the registry resolves the rung provider's own auth. It passes on the abort signal, `sessionId`, `onPayload`, `onResponse` and the other request options, and sets `reasoning` to the rung's effort, clamped to the model's supported levels.
- **Relabelling.** Outward, every streamed event's partial, final message and error are labelled with provider `orchestrator`, model `auto` and the provider's api. Inward, assistant messages labelled `orchestrator/auto` are relabelled as the pinned rung's provider, model and api before forwarding. This came from the spike (branch `spike/auto-model`), where pi-subagents refused a reply labelled with the real model.
- **Pins.** A pin table maps `sessionId` to the chosen rung and its decision record, in memory per process. A request whose `sessionId` has no pin is a first request: it is classified, routed, recorded and pinned. Before classifying, the router extension looks for the latest decision record with that delegation id and reuses its rung when the rung still passes the hard filters. A pinned rung is not checked again: pinned requests go straight to the rung.
- **Task text.** The task is the text of the user messages before the first assistant message. The agent role is read from an `<active_agent name="...">` tag in the system prompt when one is present, otherwise it is recorded as unknown. The existing classifier chain, floor signals, tier map and tier router are reused unchanged.
- **Orchestrator's model.** The router extension in the main thread's process sets `PI_ORCHESTRATOR_SESSION_MODEL` to the session's `provider/id:effort` at session start and on every `model_select`, skipping `orchestrator/auto`. A process that starts a worker passes its environment on, so a background worker's process reads the value it had at delegation. A foreground worker reads the same variable in the shared process.
- **Fallback.** When the tier router refuses (every rung removed in every tier), when routing is in shadow mode, when routing is not enabled, and on an internal failure of the router extension, the request goes to the model in `PI_ORCHESTRATOR_SESSION_MODEL`. If that variable is missing, or its model is on the subagent ban list, the stream ends with an error naming the reason. An internal failure also prints one `pi-orchestrator router disabled:` line, once per process.
- **Main thread refusal.** On `model_select` with a user source (`set` or `cycle`) that selects `orchestrator/auto`, the router extension calls `pi.setModel` with the previous model and shows one line. Startup and restore sources are left alone, because a worker's session starts on `orchestrator/auto`.
- **Overflow.** An overflow error from the rung passes back unchanged except for the outward label, so pi's own overflow check (which requires the reply's model to match the session model) compacts and retries.
- **Decision records.** The schema moves to `decision-record/3`. `delegationId` holds the worker's `sessionId`. A new `ranOn` field names the model the worker actually ran on: the rung in live mode, the orchestrator's model in shadow mode and on a refusal. In shadow mode `handPickedModel` holds the orchestrator's model. Explicit-model records are no longer written, because the router extension no longer sees tool calls. Readers keep accepting `decision-record/2` records, including explicit and verdict records.
- **Task allowance.** The task allowance stays per router-extension process, owned by the first session that loads it. A background worker's process starts its own allowance.
- **Guard.** The guard keeps refusing banned models in model-carrying tool fields and the session ban list on the main thread. `orchestrator/auto` is not banned by any list and needs no special case. The guard's detection of hosting delegated sessions stays.
- **Removed.** The pi-subagents agent discovery, agent-name resolution and model resolution copies, the lookup of the installed pi-subagents, and their parity tests. The router extension's `subagent` call rewriting, slot planning and explicit-model recording.
- **Kept as pi-orchestrator's own.** Thinking-suffix handling, supported thinking levels and the allowed-model match, used by the tier map, tier router, classifier, ban lists and init. They are no longer compared with pi-subagents.
- **Init and notice.** `/pi-orchestrator init` and the fresh-install notice add one line telling the user to make `orchestrator/auto` the default worker model in their subagent extension. Init writes no other extension's settings.
- **Documentation.** The README describes the auto model, the main thread rule, pins, the fallback and the setup step. `CONTEXT.md` already has auto model and pin, and its delegation id is the worker's session id.

## Testing Decisions

- A good test drives the router extension the way pi does and checks only what pi or the owner can observe: the events the stream returns, the request forwarded to the real rung, the decision records in the state folder, and printed lines. It never inspects the pin table or other internals.
- **Seam 1 (offline): the router extension as pi loads it.** A fake `ExtensionAPI` records the registered provider and the `session_start` and `model_select` handlers. A test calls the provider's `streamSimple` with a worker's request, as pi does. Fakes sit only at the system boundaries: the session model registry, which records every forwarded call with its model and options; the evidence source (catalog, refresh state, approved recipients); the clock; settings files in a throwaway agent dir and project dir; and the environment, including `PI_ORCHESTRATOR_SESSION_MODEL` and `sessionId`. This replaces the current seam 1, which calls the `tool_call` hook directly, and reuses its fakes.
- Seam 1 covers: classification and routing of a first request; the pin across later requests; a resumed session finding its pin from a record; relabelling outward and inward; the rung's effort replacing a requested thinking suffix; auth fields dropped; overflow passing through; the summary request classified as a first request; refusal falling back to the orchestrator's model; the fallback refused when the orchestrator's model is banned or unknown; shadow mode; routing not enabled; internal failures with one line; the `/model` refusal for user sources only; the declared context window; records in `decision-record/3` and old records still readable.
- **Seam 2 (live, only with `PI_ORCHESTRATOR_LIVE=1`, Haiku only).** A real `pi -p` session with pi-subagents and pi-orchestrator installed in a throwaway agent dir starts one foreground and one background worker on `orchestrator/auto`. It checks the workers' answers, that pi-subagents accepts the replies, and the decision records in the state folder. A third case forces compaction on a worker and checks the retry on the same rung.
- The live routing acceptance gate is ported to the auto model with the same six classifications. Its verdict parts are skipped until verdicts can be linked to decision records.
- The guard's existing tests stay. New guard cases: `orchestrator/auto` in a `subagent` call is not refused, and a banned real model is still refused.
- The pure modules (tier map, tier router, classifier, decision record) keep their unit tests. The decision record tests gain `ranOn` and the version change.
- Prior art: the router extension's seam 1 tests and the fake session model registry fixture; the router and guard live session tests; the routing acceptance gate; the spike on branch `spike/auto-model`, whose commit message lists what pi 0.87.1 and pi-subagents 0.71.0 do.

## Out of Scope

- Linking a verdict to its decision record, the reviewer and the effort ladder.
- Sharing one task allowance across a background worker's process and the main thread's process.
- Parallel workers through pi-subagents' workflow scripts, beyond what the pins already give.
- Making the allowed-model list and model scope configurable instead of hard-coded.
- The orchestrator enforcement extension from ADR 0005.
- Changes to pi (hiding a model from `/model`) or to pi-subagents.
- Editing another extension's settings from init.

## Further Notes

- Decisions and evidence: ADR 0006, the prototype on branch `prototype/auto-model`, and the spike on branch `spike/auto-model`.
- The owner's `worker` agent runs as a background worker by default (pi-subagents' `asyncByDefault`), so the background path is the main path, not an edge case.
- Background workers are routed only when pi-orchestrator is installed as a package, because their process loads installed packages, not extensions loaded with `-e`.
- Two choices in this spec were made without asking the owner and follow from the owner's fallback decision: an internal failure runs the worker on the orchestrator's model, and a resumed worker reuses the rung in its decision record. Revisit them if they do not fit.

## Summary of Changes

All 11 child tickets are done, each as one commit on main: yd75 (493203b), j27y (28562cd), ihm0 (365ff26), rowk (5b7d6b7), bjyw (9b47c8f), bmid (a17b0ae), kqli (1845cd3), c28l (8153861), 3kau (3842bab), itu1 (eaa83c7), ol6t (4b8444f). Implementers alternated between codex (gpt-6-sol) and claude (opus-5-5), and each ticket was reviewed by the other model before merge.

- The router extension registers the auto model `orchestrator/auto`. A worker's first request is classified, routed through the tier map and hard filters, recorded as `decision-record/3` with its session id as delegation id and `ranOn`, and pinned; every request is forwarded to the pinned rung with the rung's own login and effort and relabelled both ways.
- Resumed workers reuse their recorded rung; long workers compact and retry on their rung; the auto model declares the tier map's largest context window.
- Workers fall back to the orchestrator's model (`PI_ORCHESTRATOR_SESSION_MODEL`) on a refusal, in shadow mode, when routing is off and on an internal failure; a missing or banned orchestrator's model ends the request with a reason.
- `/model` refuses `orchestrator/auto` for the main thread, including a saved default.
- The `subagent` call rewriting and every pi-subagents copy are gone; model helpers are pi-orchestrator's own.
- Init, the fresh-install notice and the README explain the setup step.

Final verification on main (4b8444f): `npm test` 508 pass, 0 fail; typecheck clean; clean-clone run green (itu1). Live (`PI_ORCHESTRATOR_LIVE=1`, Haiku only): the acceptance gate passes (12 pass, verdict reviews skipped as specified), and the c28l foreground, background and compaction cases pass. The fg/bg case failed once in the full parallel run (Haiku made 5 subagent calls) and passed on two reruns (pi-orchestrator-ojjh). The live guard test `live guard handles six tool calls` fails, and fails the same way at 10f1c69 before this epic (pi-orchestrator-kdo3).

User stories: a strict audit found 46 of 49 fully covered. Story 33 is covered for the real flow; story 34 is not undone only when pi supplies no previous model, where the one line asks the owner to pick another model. For story 40, routing failures fall back with one line (tested), while forwarding errors from the rung, including a pinned rung missing from the registry, come back as labelled errors like overflow (follow-up pi-orchestrator-ui06). Out of scope per the spec: verdict linking, shared allowance across processes, configurable model scope, ADR 0005 enforcement.
