---
# pi-orchestrator-itu1
title: Remove the call rewriting and the pi-subagents copies
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T20:37:10Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-yd75
    - pi-orchestrator-c28l
    - pi-orchestrator-3kau
---

## Parent

pi-orchestrator-6nhd

## What to build

The router extension no longer hooks `tool_call`: the `subagent` call rewriting, slot planning and explicit-model recording are removed, as are the pi-subagents agent lookup, model resolution, the lookup of the installed pi-subagents, their parity tests and the old live router cases. The guard gains two cases: `orchestrator/auto` in a `subagent` call is not refused, and a banned real model still is.

## Acceptance criteria

- [x] Nothing in pi-orchestrator reads pi-subagents' agent files or its installed code
- [x] The router extension registers no `tool_call` handler
- [x] Guard tests cover `orchestrator/auto` allowed and a banned named model refused
- [x] The offline suite, the typecheck and a clean-clone run pass

## Blocked by

- pi-orchestrator-yd75
- pi-orchestrator-c28l
- pi-orchestrator-3kau

## Summary of Changes

- The router extension registers no `tool_call` handler: the `subagent` call rewriting, slot planning, `planSlot`, agent lookup, model resolution and explicit-model recording are gone from `src/router/extension.ts`. `routeTask` stays for the auto provider.
- Removed `src/subagents/` (agent discovery, installed pi-subagents lookup, model resolution and their parity tests), the call-rewriting live cases (`src/router/session.test.ts`), the hook latency script (`src/router/measure-latency.ts` and test) and `buildExplicitModelRecord`. Readers still accept `decision-record/2` records, explicit ones included (tests build them from a `legacyExplicitRecord` fixture).
- Router tests that went through `tool_call` either went away with the behaviour or now drive the auto model (provider usage, classifier input with named paths, allowance refusal, approved recipients, in-session classifier, probe lines); a test checks no `tool_call` handler is registered.
- Guard tests: `orchestrator/auto` in a `subagent` call is not refused; a banned real model is still refused, also next to an `orchestrator/auto` task. Detection of hosting delegated sessions is unchanged.
- The live tests no longer pin `model: orchestrator/auto` in their worker agent files; workers get it through `subagents.defaultModel` only, and the tests assert no explicit records.
- The verdict reviewer test reads the reviewer file's frontmatter with our own parser instead of importing pi-subagents. Nothing in pi-orchestrator reads pi-subagents' agent files or imports its installed code (grep); only live tests start a real pi with pi-subagents, as the spec requires.
- Evidence: worktree and clean clone (`npm ci`) 506 pass, 0 fail, typecheck clean; parent live run of `auto-model-session` and `routing-acceptance`: 14 pass, 1 skipped (verdicts), 0 fail.
- Implemented by claude (opus-5-5), reviewed by codex (gpt-6-sol): OK.
