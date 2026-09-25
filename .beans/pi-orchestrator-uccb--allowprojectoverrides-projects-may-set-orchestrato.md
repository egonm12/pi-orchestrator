---
# pi-orchestrator-uccb
title: 'allowProjectOverrides: projects may set orchestrator.subagents'
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T21:42:44Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-bbge
---

`orchestrator.subagents.allowProjectOverrides` (personal settings only, default false) lets a project's .pi/settings.json set every `orchestrator.subagents` key except the flag itself. Ignored project keys are logged once, as the guard does for the ban lists.

## Todo
- [ ] Test: without the flag a project's subagents keys are ignored and logged
- [ ] Test: with the flag they apply, and a project value for the flag itself is ignored
