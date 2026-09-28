---
# pi-orchestrator-pus9
title: Read quota headers and weight low providers
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-5inr
    - pi-orchestrator-8tgr
    - pi-orchestrator-ugoi
---

## Parent

pi-orchestrator-cml8 (user stories 50, 51).

## What to build

Quota headers are read through `after_provider_response`, attributed to the provider of the request in flight, only for paths the live check showed expose headers. They add a percentage left to the usage store (source header). A provider under 10% left adds weight to its count in balancing.

## Acceptance criteria

- [ ] Header reading built on the headers captured in ticket 12, attributed to the in-flight provider
- [ ] Percentage left stored as a header-sourced observation
- [ ] A stored low percentage (under 10%) shifts balancing
- [ ] Header-reading test uses the captured headers

## Blocked by

- 07 Usage store and error signals
- 10 Balanced tier order
- 12 Live check of quota headers and limit errors
