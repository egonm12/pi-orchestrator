---
# pi-orchestrator-cml8
title: 'Orchestrator in practice: guidance instead of refusal, protocol on every run, labels, balanced tiers, editing detection, usage and rate limits'
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T09:31:08Z
updated_at: 2026-09-28T12:53:16Z
---

## Problem statement

Using pi-orchestrator in practice showed six problems:

1. **Hard refusals get in the way.** The exploration budget denies the orchestrator's exploratory calls after a flat 3 per user prompt (ADR 0005). So the orchestrator can't read what a worker changed before judging it, and it starts workers for lookups it could have done in one call. The quality gate denies commit and push until every editing delegation has a verdict (ADR 0010), so a push the owner asked for directly stayed blocked.
2. **The protocol is missing where it matters.** The orchestrator protocol is added on `before_agent_start`. Runs started by `pi.sendMessage` with `triggerTurn` skip that event, so they run without it. Those runs are completion notices, worker reports and the gate's "waits for your verdict" message, which are exactly the moments the orchestrator has to judge and delegate. The owner has also seen the protocol missing after a typed skill prompt, and the code does not explain that.
3. **The worker list doesn't say what each worker is for.** Every row reads `worker · <rung> · running …`, so parallel workers can't be told apart.
4. **All delegations go to the first provider in a tier.** Routing takes the first rung that survives the hard filters (ADR 0001). The owner lists one Anthropic and one OpenAI rung per tier as equals, so one subscription gets used up while the other sits idle.
5. **Read-only research is marked as an editing delegation.** Any bash command that isn't a build or test makes a delegation editing, so every research worker asks for a meaningless verdict.
6. **Workers start on providers that have no usage left.** The router has hard filters for an exhausted or throttled provider, but outside tests nothing ever gives them data. So workers are routed to Claude or Codex after that provider's usage has run out, and they fail. A worker is pinned to its rung at the first request, so a rate limit stops it for good. The gate's reviewer failed this way and nothing tried another provider. pi exposes no remaining balance. The only signals are response headers (through `after_provider_response`, which doesn't say which provider responded, and not on Codex's WebSocket path) and error text (Codex: "You have hit your ChatGPT usage limit", sometimes with a reset time). pi also warns that a Claude subscription used from a third-party harness runs on extra usage billed per token, which may behave differently from the plan window.

## Solution

- **Exploration nudge instead of refusal (ADR 0013).** Exploratory calls are never denied. After a set number in one user prompt (setting `explorationNudge`, default 3), the result of each further exploratory call carries a short nudge, such as `4 exploratory calls this prompt: consider handing the rest to a worker.`
- **A gate that reminds (ADR 0013).** Commit and push are never denied. Their result names the delegations still waiting for a verdict. The routing report keeps counting missing verdicts. Gate levels and gate actions (ADR 0011) are unchanged.
- **Protocol on every run.** The orchestrator protocol is present on every run of the orchestrator, including runs started by `sendMessage` with `triggerTurn`. Also check live why the protocol can be missing after a typed skill prompt.
- **Labels.** The orchestrator gives each delegation an optional short label, such as `research: budget code`. Worker rows show the label, falling back to the agent definition and then to `worker`. Reviewers are always shown as `reviewer`. Rows show the tier next to the rung.
- **Balanced tier order (ADR 0012).** By default a tier picks, among the rungs that survive the hard filters, the rung whose provider started the fewest delegations in the last 5 hours, across all the owner's sessions and projects. List order breaks ties. A tier can be set to *ordered* to keep "first survivor wins". A reviewer prefers a rung from a different provider than the implementer's.
- **Editing detection from the working tree.** A delegation is editing when the working tree changed while its worker ran, or when the worker used `edit` or `write`. The old command rule applies only when there is no git repository.
- **Usage and rate limits.** The router, not the classifier, checks usage before pinning a worker.
  - **Usage observations** are learned from usage-limit and rate-limit errors (exhausted until the stated reset, or for 5 hours when there's none). After a live check confirms they arrive, quota headers from every response add a percentage left.
  - Observations go into the shared state folder, keyed by provider, so every session and project sees them before routing.
  - An exhausted provider is a hard filter. A provider under 10% left counts as extra use in balancing.
  - When every provider is exhausted, the delegation is refused before any worker starts, with the reset times when known. The session-model fallback is used only if that model's provider still has usage.
  - The orchestrator sees one usage line on every run, such as `usage: anthropic exhausted until 14:00 · openai-codex 62% left`. The line is left out when nothing is known.
  - **Failover:** if a worker's first request fails on a rate limit or usage limit, before the worker has produced anything, it is pinned again to the next surviving rung, preferring another provider. A limit mid-run fails the worker, and the orchestrator can start a new one, which routing then sends elsewhere.

## User stories

1. As the owner, I want the orchestrator never refused an exploratory call, so that it can always check what a worker changed before it judges it.
2. As the owner, I want the orchestrator to do a quick lookup itself, so that it doesn't start a worker for something one call can answer.
3. As the owner, I want the orchestrator reminded to delegate once it has explored a lot in one prompt, so that it still hands research to workers.
4. As the owner, I want to set after how many exploratory calls the nudge starts, so that I can tune it per project.
5. As the owner, I want my existing `explorationBudget` setting still respected, so that my settings don't silently stop working after the rename.
6. As the orchestrator, I want the nudge in the tool result where I see it, so that I notice at the moment I'm drifting and not only in the system prompt.
7. As the orchestrator, I want the nudge to say how many exploratory calls I've made, so that I can judge how far I've drifted.
8. As the owner, I want the nudge count to start again at each user prompt, so that one long task doesn't nudge every later prompt.
9. As the owner, I want workers never nudged, so that the nudge only steers the orchestrator.
10. As the owner, I want a commit or push I asked for to go through, so that the gate never blocks my own request.
11. As the owner, I want a commit or push result to name the delegations still waiting for a verdict, so that the orchestrator records them or tells me they're missing.
12. As the owner, I want missing verdicts still counted in the routing report, so that skipping the gate stays visible.
13. As the owner, I want gate levels and gate actions unchanged, so that critical work still calls for a reviewer.
14. As the orchestrator, I want the protocol present when a completion notice wakes me, so that I judge the result as the quality gate.
15. As the orchestrator, I want the protocol present when a worker's report or question wakes me, so that I answer as the orchestrator.
16. As the orchestrator, I want the protocol present when the gate reminds me of a missing verdict, so that I record it instead of doing the work myself.
17. As the owner, I want the protocol present after a typed skill prompt, so that skill runs also delegate early.
18. As the owner, I want a live check that shows the protocol is in a real session's system prompt, so that a missing protocol can't go unnoticed again.
19. As the owner, I want the delegation rate measured again once the protocol reaches every run, so that ADR 0013 is judged on evidence.
20. As the protocol text, I want to describe the nudge and the reminding gate instead of refusals, so that the orchestrator isn't told about limits that no longer exist.
21. As the orchestrator, I want to give each delegation a short label, so that the owner can see what each worker is for.
22. As the owner, I want every worker row to show its label, so that I can tell parallel workers apart at a glance.
23. As the owner, I want rows without a label to show the agent definition name, and rows with neither to show `worker`, so that the list never has an empty name.
24. As the owner, I want reviewer workers always shown as `reviewer`, so that I can see which worker is checking another.
25. As the owner, I want each row to show the tier next to the rung, so that I can see how much care the classifier gave the task.
26. As the owner, I want the label shown the same way in the worker widget, the /subagents picker, the transcript view's nested workers and the status output, so that a worker has one name everywhere.
27. As the owner, I want long labels shortened to fit the row, so that the list keeps one line per worker.
28. As the owner, I want delegations spread across the providers in a tier, so that I use both subscriptions and don't run out of one.
29. As the owner, I want the spread to count delegations from all my sessions and projects over a rolling 5-hour window, so that it follows how subscription limits work.
30. As the owner, I want delegations counted per provider across all tiers, so that heavy use of a provider in one tier also steers the others.
31. As the owner, I want workers started in parallel in one call to spread over the providers, so that a fan-out doesn't land on one provider.
32. As the owner, I want list order to break ties, and a tier I set to ordered to keep strict preference, so that my order still means something.
33. As the owner, I want hard filters, escalation and the effort ladder's step order unchanged, so that balancing never overrides a ban, a limit or a recovery step.
34. As the owner, I want a reviewer to prefer a different provider than the implementer, so that the review is more independent.
35. As the owner, I want the decision record to show the usage counts that decided the choice, so that I can spot a skewed split.
36. As the owner, I want only delegations that actually ran on a rung to count, not shadow recommendations, so that the counts reflect real use.
37. As the owner, I want research workers that changed nothing not to need a verdict, so that the gate only asks for judgement where there's something to judge.
38. As the owner, I want a worker that changed the working tree through bash to still count as editing, so that bash can't slip changes past the gate.
39. As the owner, I want `edit` and `write` calls always to count as editing, so that changes outside the repository are still caught.
40. As the owner, I want a change made while several workers ran to count for each of them, so that no change goes unjudged.
41. As the owner, I want the old command rule used when there's no git repository, so that the gate still works outside a repository.
42. As the owner, I want a worker whose first request is rate limited moved to another rung, preferring another provider, so that a throttled provider doesn't fail my work.
43. As the owner, I want a rate limit mid-run to fail the worker cleanly, so that the orchestrator can start a new one instead of waiting.
44. As the owner, I want a rate-limited provider marked throttled for a while, so that balancing and routing avoid it until it recovers.
45. As the owner, I want every failover recorded in the decision record, linked to the refused attempt, so that I can see why a worker ran where it did.
46. As the owner, I want no worker started on a provider whose usage is exhausted, so that delegations don't fail on an empty subscription.
47. As the owner, I want a usage-limit error to mark the provider exhausted until its reset, so that the next delegation goes elsewhere at once.
48. As the owner, I want an exhausted provider without a stated reset to be avoided for 5 hours, so that it isn't retried on every delegation.
49. As the owner, I want usage observations shared across all my sessions and projects, so that one session running into a limit spares the others.
50. As the owner, I want quota headers read from every response once they're confirmed, so that the router steers away from a provider before it runs dry.
51. As the owner, I want a provider with under 10% left used less in balancing, so that I don't hit a limit in the middle of work.
52. As the owner, I want a delegation refused up front when every provider is exhausted, with the reset times, so that the orchestrator tells me instead of starting workers that will fail.
53. As the owner, I want the session-model fallback skipped when its provider is exhausted, so that a fallback never fails for the same reason.
54. As the orchestrator, I want a usage line on every run, so that I can do small work myself when every provider is low.
55. As the owner, I want a live check that records the real quota headers and limit errors of both providers, including Claude's extra-usage case, so that header reading is built on what the providers actually send.

## Implementation decisions

- **Exploration budget becomes the exploration nudge:** the `tool_call` denial is removed. The same counting (read-only and unrecognised calls per user prompt, reset at a user prompt whose source is not `extension`, workers not counted) now drives a text appended to the call's result once the count passes the setting. The `/pi-orchestrator budget` subcommand is removed.
- **Settings:** `orchestrator.subagents.explorationNudge`, a positive integer, default 3. The old `explorationBudget` key is read as its value when the new key is absent.
- **Gate:** the commit and push denial is removed. A commit or push result gets a reminder naming the delegations waiting for a verdict. The verdict-reminder messages and the routing report's missing-verdict count stay.
- **Orchestrator protocol:** its text drops the refusal and describes the nudge and the reminding gate. It must be in the system prompt of every orchestrator run, including runs started by `sendMessage` with `triggerTurn`. pi 0.87.1 clears the run options and falls back to the base system prompt for those runs. The fix makes the protocol reach them, for example by adding it to the base prompt through a supported hook or by starting follow-up runs through a path that fires `before_agent_start`. The implementer picks one that holds up across pi versions. Workers never get the protocol.
- **Subagents tool schema:** each item gains an optional `label` (short text). The worker board keeps the label and the worker's tier. The row format for widget, picker, transcript view and status becomes label · tier · rung · state · elapsed · turns · activity, with the name falling back from label to agent definition to `worker`, and reviewers always `reviewer`.
- **Tier map settings:** each tier gains an optional order, `balanced` (default) or `ordered`. A project tier replaces the personal tier with the same name, including its order.
- **Tier router:** balancing chooses among the survivors of one step, by delegations started per provider in the last 5 hours. The router extension reads the count from the global decision records under the owner's state directory, counting only rungs that were actually pinned. Rungs chosen earlier in the same call count as well, so a fan-out spreads. The effort ladder keeps its step order. The reviewer's constraint gains a provider to avoid, as a preference and not a hard filter.
- **Decision record:** gains the provider counts behind a balanced choice, the tier order in force, and failover entries linked to the refused attempt.
- **Editing detection:** a snapshot of the working tree (tracked changes plus untracked files) when a worker starts and when it ends. A difference, or any `edit` or `write` call, makes the delegation editing, and the changed paths feed the reviewer's file list. A change made while workers overlapped is attributed to each of them. Without a git repository the current command rule stays.
- **Usage observations:** a new shared store in the owner's state folder holds, per provider, the latest observation: state (available, low, exhausted, throttled), percentage left if known, reset time if known, observed at, and source (error or header). The router reads it on every routing, and it feeds the existing exhausted and throttled hard filters, which currently get no data outside tests. Whether this reuses the catalog's refresh-state file or a file of its own is the implementer's choice.
- **Signals:** the first signal is error text. The auto model classifies a worker's failure as a usage limit (exhausted) or a rate limit (throttled) and extracts any reset time. The second is quota headers read through `after_provider_response`, attributed to the provider of the request in flight. It is built only after the live check, and only for paths that expose headers.
- **Balancing and refusal:** a provider under 10% left adds weight to its count in balancing. An exhausted provider is filtered. When every tier and escalation empties because of usage, the router refuses with the reset times, and the fallback to the session model is used only when that model's provider is not exhausted.
- **Orchestrator usage line:** a short line with the known state per provider, added with the protocol on every run and left out when the store is empty.
- **Failover:** the auto model detects a usage or rate-limit failure of a worker's first request, before any output, and pins the worker again to the next survivor, excluding that provider where another survives. A limit later in the run fails the worker. Both record a usage observation.

## Testing decisions

- Tests check external behaviour only: what a tool result says, what the system prompt contains, what the rows show, which rung is pinned and what's recorded. They don't assert on internal counters.
- **Nudge, gate and protocol:** the real-session seam (`orchestratorSession` with a scripted fake provider) in the subagents extension tests. Rework the existing budget tests: calls beyond the setting succeed and carry the nudge, a user prompt resets it, workers are never nudged. A commit with a waiting verdict succeeds and names it. Protocol tests follow "protocol on every turn" and add a run started by `sendMessage` with `triggerTurn`. Settings get a unit test like the one for `explorationBudget`, including the old key.
- **Label:** worker-widget, render, picker and transcript-view tests with a real worker board and a plain theme, plus the end-to-end board and widget tests.
- **Balancing:** tier-router tests with evidence passed in as plain values (`fixtureRoute`). Router extension tests with a fixed `now` and decision records in a temporary state directory: the 5-hour window, the cross-session count, shadow records ignored, a parallel fan-out. A review test for the reviewer's provider preference.
- **Editing detection:** the end-to-end editing test (`routedHarness`) with the project directory as a git repository (`createTempRepo`): bash that changed nothing, bash that changed the tree, an `edit` outside the repository, two overlapping workers, and no repository.
- **Usage and failover:** router extension tests with a provider double and a temporary state folder.
  - A first request answered with a usage-limit error pins the worker again to the other provider, records the failover and an exhausted observation, and the next routing, even from another session, avoids that provider until the reset.
  - A mid-run limit fails the worker.
  - A stored low percentage shifts balancing.
  - All providers exhausted gives a refusal with reset times and no worker.
  - A header-reading test uses the headers captured by the live check.
  - The orchestrator's usage line is checked through the real-session seam.
- **Live:** one live acceptance check that a real session's system prompt holds the protocol after a typed skill prompt and after a completion notice. A live measurement of the delegation rate for ADR 0013.

## Out of scope

- Isolating each worker in its own git worktree (bean `pi-orchestrator-79dp`).
- A nudge that grows more insistent with the count.
- Balancing by tokens used, and owner-weighted shares per rung.
- Asking provider usage endpoints at session start, until one is known for subscription sign-ins.
- More than one account per provider.
- Moving the classifier's tier choice based on usage. The classifier only judges the task.

## Further notes

- Domain terms are in CONTEXT.md: exploration nudge, quality gate, label, tier order, editing delegation.
- Decisions: ADR 0012 (balanced tier order, amending 0001) and ADR 0013 (guidance instead of refusal, superseding 0005 and amending 0010).
- Suggested order: the nudge and reminding gate first (they remove today's blocks), then the protocol fix, editing detection, usage and rate limits (error signals first, the live header check before header reading), labels and balancing.
