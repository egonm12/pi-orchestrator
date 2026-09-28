---
# pi-orchestrator-jeyq
title: Exploration budget per user prompt
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T07:46:20Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-vu2o
    - pi-orchestrator-y8cd
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0005. The orchestrator gets 3 exploratory calls per user prompt (owner-configurable); the next one is denied with an instruction to hand the research to a worker with subagents. The count resets on each user prompt, not each model turn.

Classification of a tool call, as one reusable module (ticket "Orchestrator records verdicts" reuses it to detect editing through bash):
- exploratory: read; bash searches and listings (rg, grep, find, ls, cat, git log/show/diff); web_search, fetch_content, get_search_content, source_check; ctx_execute, ctx_execute_file, ctx_search, ctx_batch_execute, ctx_fetch_and_index; mcp and mcpScript reads
- action: edit, write, bash builds, tests and commits, the subagents tools
- unrecognised bash counts as exploratory

The budget binds only the orchestrator's own session. /pi-orchestrator budget off lifts it for the current prompt only; the model cannot lift it. The protocol gains a paragraph on the budget.

## Acceptance criteria

- [x] The 4th exploratory call in one user prompt is denied with the delegate instruction; the counter resets on the next user prompt
- [x] Actions are never counted; unrecognised bash is counted
- [x] Calls the orchestrator makes to spot-check a Result count like any other exploratory call
- [x] Workers, forked workers and child processes are never budgeted
- [x] The threshold is an owner setting, default 3
- [x] /pi-orchestrator budget off lifts the budget until the next user prompt
- [x] The protocol describes the budget
- [x] Tests for the classification, the counter, the reset and the command

## Blocked by

- pi-orchestrator-vu2o
- pi-orchestrator-y8cd

## Summary of Changes

- `src/subagents/tool-call-kind.ts` (new): one reusable classification. `classifyToolCall(toolName, input)` returns a kind: `read-only`, `build-test`, `version-control`, `unrecognised` (bash or powershell only), `edit`, `delegation` or `other`. `classifyBashCommand(command)` splits chains, pipes and command substitution (quote-aware, heredocs skipped) and takes the strongest part: unrecognised, then version-control, then read-only, then build-test; a read-only filter after a pipe adds nothing; a redirect into a file other than /dev/null is unrecognised. For pi-orchestrator-kokv: editing is `edit`, or bash that is neither `read-only` nor `build-test`.
- `src/subagents/exploration-budget.ts` (new): `ExplorationBudget` (count, per-prompt reset, owner lift for this or the next user prompt) and `registerExplorationBudget`, which hooks `session_start`, `input` (every user input except `source: "extension"`), `tool_call` (deny with `{ block: true, reason }`) and adds the `budget` subcommand. It binds only where `isOrchestratorSession` is true. A settings failure keeps the default 3 and logs once.
- The budget lives in the subagents extension, beside the protocol, because its deny sends the orchestrator to the `subagents` tool; dropping `src/subagents/extension.ts` drops the budget too.
- `src/init/subcommands.ts`: `registerSubcommands` lets several extensions share one `/pi-orchestrator` command over the session's `pi.events` bus: the first to load hosts it, later ones join; with either extension switched off the other still hosts its own. `showOwner` shares the UI-or-stderr notice. The router now registers `init` through it.
- `src/subagents/settings.ts`: `orchestrator.subagents.explorationBudget`, positive integer, default 3 (`DEFAULT_EXPLORATION_BUDGET`), project override only with personal `allowProjectOverrides`.
- `src/subagents/orchestrator-protocol.ts`: `orchestratorProtocol(budget)` with a budget paragraph naming the configured threshold; `addOrchestratorProtocol` takes the threshold.
- README: Exploration budget section, the setting, the `budget` subcommand, and the switch-off note.
- Tests: classification table, counter and lift, settings, subcommand sharing on a real pi event bus, and real pi sessions for the deny, reset, threshold in protocol, workers/forks/pi-subagents child exempt, and `budget off` both while running (pi runs extension commands during streaming) and while idle (a message-started run is not lifted).
- Interpretation to confirm: a prompt the user types while the orchestrator runs (steer or follow-up) is a user prompt, so it resets the count and ends a lift made for the running prompt.


## Owner decisions (2026-09-28)
- A message the user types while the orchestrator runs (steer or follow-up) is a user prompt: it resets the count and ends a budget off given for the running prompt.
- ctx_execute and ctx_execute_file stay exploratory for the budget; kokv treats them as possible edits in a worker's session.


Orchestrator verdict: accepted. Deny path, per-prompt reset, lift and orchestrator-only binding read in exploration-budget.ts; typecheck clean; npm test 707 pass 0 fail.
