---
# pi-orchestrator-bcix
title: Usage line for the orchestrator
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
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

- [ ] Usage line present on every orchestrator run when the store has observations
- [ ] Line left out when the store is empty
- [ ] Workers never get the line
- [ ] Checked through the real-session seam

## Blocked by

- 03 Protocol on every run
- 07 Usage store and error signals
