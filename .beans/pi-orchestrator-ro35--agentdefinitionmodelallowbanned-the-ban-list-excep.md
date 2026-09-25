---
# pi-orchestrator-ro35
title: 'agentDefinitionModel.allowBanned: the ban-list exception'
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T21:42:44Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-bbge
---

With `use: "preserve"` and `allowBanned: true`, a model on the subagent ban list named by an agent definition may run. For a project's definition this also needs `allowProjectOverrides`. The agent-model record gets `banListException: true`. Under "route", a true value warns once. The guard and the router must not refuse such a worker; every other path stays banned.

## Todo
- [ ] Test: personal definition with a banned model runs only with allowBanned on
- [ ] Test: project definition with a banned model runs only with allowBanned and allowProjectOverrides on
- [ ] Test: tier map and tool-call paths still refuse the banned model
