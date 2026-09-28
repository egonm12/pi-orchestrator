---
# pi-orchestrator-6yxt
title: Protocol on every run
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 14 to 18).

## What to build

The orchestrator protocol is in the system prompt of every orchestrator run, including runs started by `pi.sendMessage` with `triggerTurn` (completion notices, worker reports and questions, gate verdict reminders), which pi 0.87.1 starts with cleared run options and the base system prompt. Investigate both ways: adding the protocol to the base prompt through a supported hook, or starting follow-up runs through a path that fires `before_agent_start`. Pick the one that holds up across pi versions and record the reason in this bean. Also check why the protocol can be missing after a typed skill prompt. Workers never get the protocol. Prepare a live acceptance check (script and instructions) that the owner runs to confirm a real session's system prompt holds the protocol after a typed skill prompt and after a completion notice.

## Acceptance criteria

- [ ] Both approaches investigated; the choice and its reason recorded in this bean
- [ ] Protocol present on a run started by `sendMessage` with `triggerTurn` (real-session test)
- [ ] Protocol present after a typed skill prompt, with the cause of the earlier gap explained
- [ ] Workers never get the protocol
- [ ] Live check script and instructions prepared
- [ ] Owner has run the live check and its result is recorded here

## Blocked by

None, can start immediately.
