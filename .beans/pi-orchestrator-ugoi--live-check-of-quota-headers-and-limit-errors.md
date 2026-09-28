---
# pi-orchestrator-ugoi
title: Live check of quota headers and limit errors
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user story 55).

## What to build

A live check that records the real quota headers (through `after_provider_response`) and limit errors of both providers, Anthropic and OpenAI Codex, including Claude's extra-usage case when used from a third-party harness and Codex's WebSocket path. The agent prepares the script and instructions; the owner runs it. The captured headers and errors are stored as fixtures for ticket 13.

## Acceptance criteria

- [ ] Live check script and instructions prepared
- [ ] Owner has run it for both providers
- [ ] Captured headers and limit errors stored as fixtures, with notes on which paths expose headers
- [ ] Findings recorded in this bean

## Blocked by

None, can start immediately.
