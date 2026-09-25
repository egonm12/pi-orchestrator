---
# pi-orchestrator-uccb
title: 'allowProjectOverrides: projects may set orchestrator.subagents'
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:36:21Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-bbge
---

`orchestrator.subagents.allowProjectOverrides` (personal settings only, default false) lets a project's .pi/settings.json set every `orchestrator.subagents` key except the flag itself. Ignored project keys are logged once, as the guard does for the ban lists.

## Todo
- [x] Test: without the flag a project's subagents keys are ignored and logged
- [x] Test: with the flag they apply, and a project value for the flag itself is ignored

## Summary of changes

Added `src/subagents/settings.ts`, one loader for the effective `orchestrator.subagents` settings (`loadSubagentsSettings`, pure `subagentsSettingsFromSettings`). It returns the settings (`maxParallel`, `agentDefinitionModel.use`), the personal-only `allowProjectOverrides` flag and the ignored project keys. With the flag on, a project key replaces the personal value whole and a project value for the flag is ignored; with it off, every project `orchestrator.subagents` key is ignored. The subagents extension now uses this loader instead of its two ad hoc readers, and logs each ignored key once to stderr as `pi-orchestrator subagents: ignored project settings key <key>`. Added integration tests for both todo items and unit tests for the loader. The README describes the replace-whole semantics and the log line.
