---
# pi-orchestrator-jeyq
title: Exploration budget per user prompt
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:07:20Z
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

- [ ] The 4th exploratory call in one user prompt is denied with the delegate instruction; the counter resets on the next user prompt
- [ ] Actions are never counted; unrecognised bash is counted
- [ ] Workers, forked workers and child processes are never budgeted
- [ ] The threshold is an owner setting, default 3
- [ ] /pi-orchestrator budget off lifts the budget until the next user prompt
- [ ] The protocol describes the budget
- [ ] Tests for the classification, the counter, the reset and the command

## Blocked by

- pi-orchestrator-vu2o
- pi-orchestrator-y8cd
