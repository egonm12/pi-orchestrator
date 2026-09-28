---
# pi-orchestrator-bcix
title: Usage line for the orchestrator
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T22:57:08Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-6yxt
    - pi-orchestrator-5inr
---

## Parent

pi-orchestrator-cml8 (user story 54).

## What to build

The orchestrator sees one usage line on every run, added with the protocol, such as `usage: anthropic exhausted until 14:00 · openai-codex 62% left`. The line is left out when the usage store is empty.

## Acceptance criteria

- [x] Usage line present on every orchestrator run when the store has observations
- [x] Line left out when the store is empty
- [x] Workers never get the line
- [x] Checked through the real-session seam

## Blocked by

- 03 Protocol on every run
- 07 Usage store and error signals

## Decisions

- **On ticket03's per-request path.** The usage line is the last paragraph of the orchestrator protocol (`orchestratorProtocol(explorationNudge, gateLevel, usage)`). Both protocol hooks, `before_agent_start` and the `context_with_system` guard, read the usage store for each request and pass the line in. So it reaches every request of every orchestrator run, a run a message starts with triggerTurn included, and never a worker, which never gets the protocol. There is no second injection path.
- **No duplicate or stale line.** The guard now compares the replayed section exactly with the current one instead of checking containment. The protocol without a line is a prefix of the protocol with one, so containment kept a line whose limit had lifted (red test first). A patch replaces the section by name, so a changed line replaces the old one.
- **Forced prompt limit (pi 0.87.1).** When an earlier extension forces the prompt, pi projects that forced text onto every request of the run after the context handlers (agent-session.js `_installAgentForcedPromptProjection`, lines 1044 to 1058). So the line keeps the value the run started with and cannot change mid-run. It is still there once. The next run picks up the current store.
- **What the line shows.** Per provider, in name order: an exhausted or throttled limit still in force, with the local time it lifts (`about` when no reset was stated and the time is the store's 5-hour or 5-minute estimate, with the date when not today). A throttled limit also shows its percentage left when known. Otherwise it shows `N% left`, `low[, N% left]` or `available`. A provider whose limit has lifted is left out. With nothing left, or an empty store, there is no line. The lift time comes from the new `limitLiftsAt` in the usage store, which `usageLimits` now also uses, so the line and the hard filters agree.

## Cross-ticket documentation

This commit also updates README paragraphs that other tickets left stale:
- ticket09 (pi-orchestrator-ouoy) asked for these and did not edit the README. How routing decides now explains the failover: a limit error on a worker's first request, before output, re-pins the worker to a surviving rung on another provider. A later limit, or one with no other provider left, fails the worker. The pin paragraph names failover as the one way the pin moves, and the state table's `routing/*.jsonl` row lists failover records linked to the refused attempt.
- ticket03 (pi-orchestrator-6yxt): the Orchestrator protocol paragraph still said a message-started run had the protocol on its first turn only. It now describes the per-request guard and the forced-prompt case, followed by the usage line paragraph.
- CONTEXT.md gains the glossary term **Usage line**.

## Summary of changes

- `src/subagents/usage-line.ts` (new): `usageLine(observations, now)` formats the line, or returns undefined when nothing still holds.
- `src/router/usage-observations.ts`: `limitLiftsAt` extracted from `usageLimits`, so the line and the hard filters share one lift time. Behaviour is unchanged.
- `src/subagents/orchestrator-protocol.ts`: the protocol text and both hooks take the optional usage line. The guard compares the section exactly.
- `src/subagents/extension.ts`: a `now` dependency. Both hooks read the usage store for each request.
- `src/subagents/extension.test.ts`: eight real-session tests (orchestratorSession, scripted fake provider, temporary state folder): a prompt's run on every request, a triggerTurn run after the store filled, replacement and removal within a run, removal once the only limit lifts, a forced prompt, no worker (routed or forked), format variants, and an empty store.
- `src/subagents/orchestrator-protocol.test.ts`: the "already has the current protocol" fixture now uses pi's real section wrapping.
- README.md and CONTEXT.md: see Cross-ticket documentation.
