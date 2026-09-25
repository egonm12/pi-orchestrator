---
# pi-orchestrator-jdaz
title: README, init and fresh-install notice for the built-in tool
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:14:26Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-0rng
---

The README says the package ships the `subagents` tool (other subagent extensions still work on orchestrator/auto), documents the settings and agent definitions, and drops the pi-subagents install advice. Init and the fresh-install notice stop telling the owner to set a subagent extension's default model.

## Todo
- [x] README
- [x] Init and notice text, with their tests

## Summary of changes

- `README.md`: names three extensions instead of two. A new "Subagents tool" section documents the `subagents` tool's call shape (`{ items: [{ task, agent? }] }`, 1 to 8 items, at most `orchestrator.subagents.maxParallel` running at once), each item's result status (`completed`, `failed`, `aborted`, `not-started`), worker session storage and the `subagents` tool being left out of a worker's own tools. It documents agent definitions (markdown files with frontmatter in `~/.pi/agent/agents/` and `.pi/agents/`, project wins by name, `tools:` only narrows, listed at session start, no built-in definitions) and the settings ADR 0007 plans: `orchestrator.subagents.maxParallel`, `agentDefinitionModel.use`/`allowBanned` and `allowProjectOverrides`. Install drops the pi-subagents-specific advice and says the built-in tool needs no separate subagent extension, while other subagent extensions still work and are still routed. `Switching things off` and `Known limits` gained lines for the new extension.
- `src/init/setup.ts`, `src/init/command.ts`: dropped `AUTO_MODEL_SETUP_LINE` and the line it added to the fresh-install notice and to `/pi-orchestrator init`'s output. Workers started through the built-in `subagents` tool always run on `orchestrator/auto`, so there is nothing left to tell the owner to set up.
- `src/init/setup.test.ts`: updated the fresh-install notice test to expect one line instead of two, renamed and slimmed the init test that used to assert on the dropped line, and fixed a `notes.at(-2)` index that pointed at the now-removed last line.
- `src/router/extension.test.ts`: the router's fresh-install notice test no longer asserts on the dropped auto-model line; it checks the notice still names the missing tier map and the init command.
