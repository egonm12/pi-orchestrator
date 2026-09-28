---
# pi-orchestrator-6yxt
title: Protocol on every run
status: in-progress
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T22:08:24Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 14 to 18).

## What to build

The orchestrator protocol is in the system prompt of every orchestrator run, including runs started by `pi.sendMessage` with `triggerTurn` (completion notices, worker reports and questions, gate verdict reminders), which pi 0.87.1 starts with cleared run options and the base system prompt. Investigate both ways: adding the protocol to the base prompt through a supported hook, or starting follow-up runs through a path that fires `before_agent_start`. Pick the one that holds up across pi versions and record the reason in this bean. Also check why the protocol can be missing after a typed skill prompt. Workers never get the protocol. Prepare a live acceptance check (script and instructions) that the owner runs to confirm a real session's system prompt holds the protocol after a typed skill prompt and after a completion notice.

## Acceptance criteria

- [x] Both approaches investigated; the choice and its reason recorded in this bean
- [x] Protocol present on a run started by `sendMessage` with `triggerTurn` (real-session test)
- [x] Protocol present after a typed skill prompt, with the cause of the earlier gap explained
- [x] Workers never get the protocol
- [x] Live check script and instructions prepared
- [ ] Owner has run the live check and its result is recorded here

## Blocked by

None, can start immediately.


## Decision: which path

Read from pi 0.87.1 (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`):

- `sendCustomMessage` with `triggerTurn` on an idle session calls `_runAgentPrompt` directly (lines 1504, 1507), skipping `prompt()` and so `before_agent_start` (emitted only in `prompt()`, line 1283).
- `_runAgentPrompt` clears `_runSystemPromptOptions` when a run ends (line 1100). The next-turn refresh (`_installAgentNextTurnRefresh`, line 391) diffs `_runSystemPromptOptions ?? _baseSystemPromptOptions` against the transcript's replayed system messages. In a run a message started that is the base prompt, so the run's first request still has the section the last prompt recorded, its second request (after a tool call) gets a `null` patch that removes it, and every later such run starts without it. The real-session test and the probe smoke run below both show exactly this: turn 1 yes, turn 2 no.

Options investigated:

1. **Protocol in the base prompt through a supported hook.** The base options come only from the resource loader (SYSTEM.md, APPEND_SYSTEM.md, skills, context files) and from tool `promptSnippet`/`promptGuidelines` (`_rebuildSystemPrompt`, line 991). No extension hook adds a named section there. Tool guidelines render only when there is no custom SYSTEM.md (`system-prompt.js` `buildSystemPromptSections`), as single bullets, are fixed at registration while the protocol text follows the gate level in force, and reach every worker that has the subagents tool (lead agents), which breaks "workers never get the protocol". `ctx.getSystemPromptOptions()` returns the live base object, but only in command contexts, and pi rebuilds it on every tool change: not supported. Rejected.
2. **Start wake-ups through a path that fires `before_agent_start`.** Only `prompt()`/`sendUserMessage` do. That would turn completion notices, reports, questions and gate reminders into user messages: the model reads them as the owner speaking, they lose their custom type, rendering and details, and runs other extensions start by a message would still lack the protocol. Rejected.
3. **Chosen: keep `before_agent_start`, and add a `context_with_system` guard.** `context_with_system` is documented (docs/extensions.md, "request-local transformation") and fires before every request of every run, however it started (`runner.js` `emitContext`). When the request's replayed prompt lacks the current protocol, the handler inserts a section patch right after the last system message; the transcript is not changed. Providers without mid-conversation system messages collapse it into the head (`pi-ai` `resolveTranscript`). It holds across pi versions: if a later pi keeps run options for message-started runs, the guard finds the section and does nothing; on a pi without the event, behaviour falls back to today's.

Edge left as is: a run started by a message in a session that never had a prompt has no system message at all in pi 0.87.1 (pi sends no prompt and no tools). The guard leaves such a request alone rather than send the protocol as the whole prompt. Our wake-ups always follow the prompt that started the worker.

## Cause of the gap after a typed skill prompt

A typed skill prompt on an idle session goes through `prompt()`, so `before_agent_start` does fire (`_expandSkillCommand` runs before it). Two code-level causes found:

1. **A forced prompt.** `pi-claude-rules` (`~/.pi/agent/git/github.com/jordyvanvorselen/pi-claude-rules/src/index.ts:201-206`) returns `systemPrompt: event.systemPrompt + rules` whenever any rule exists (the owner has `~/.claude/rules/em-dash.md`). That sets `forceSystemPrompt`, and the provider gets that forced text instead of the sections (`_installAgentForcedPromptProjection`). It is listed before pi-orchestrator in `~/.pi/agent/settings.json` `packages`; if pi runs handlers in that order (unverified), its forced text is rendered before our section exists, so the protocol reaches the transcript but not the provider. Fixed: when an earlier handler forced the prompt without the protocol, ours returns the forced text with the protocol appended.
2. **A skill prompt typed while a message-started run streams** is queued into that run (`_queueFollowUp`, no `before_agent_start`) and so ran on the base prompt. Fixed by the guard above.

Which of the two the owner hit is not known; the live check tells them apart (`project rules forced` on a skill prompt's run, `queuedSkills` on a message's run).

## Live check

Prepared, not yet run by the owner: `src/live-check/protocol-probe.ts` (a `pi -e` extension that records, per provider request, whether the payload's system text holds the protocol and what started the run) and `src/live-check/protocol-probe.md` (steps and pass criteria). A smoke run in a real pi session with a fake provider that calls `onPayload` passed with the fix and failed without it (run 2 turn 2: `protocol NO`). That is not the owner's live result.

## Summary of changes

- `src/subagents/orchestrator-protocol.ts`: `addOrchestratorProtocol` now returns a forced prompt with the protocol appended when an earlier extension forced one without it; new `keepOrchestratorProtocol` (context_with_system) puts the protocol back into any orchestrator request whose replayed prompt lacks it, after the last system message, with a stable timestamp; header comment records the decision.
- `src/subagents/extension.ts`: registers both hooks for the orchestrator's session only.
- `src/subagents/orchestrator-protocol.test.ts`: unit tests for both hooks and the protocol text.
- `src/subagents/extension.test.ts`: the scripted provider now also renders a forced prompt's text; three real-session tests: a completion notice waking the idle orchestrator (a real background worker, two turns), a worker question sent with triggerTurn, and a typed skill prompt under an extension that forces the prompt.
- `src/live-check/protocol-probe.ts`, `.test.ts`, `.md`: the owner's live check.
- `CONTEXT.md`: glossary entry **Orchestrator protocol**.

Remaining: the owner runs the live check and records its result here; then this bean can be completed.
