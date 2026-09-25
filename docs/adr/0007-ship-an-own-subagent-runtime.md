---
status: accepted
date: 2026-09-25
---

# Ship an own subagent runtime, and keep the auto model as the routing seam

ADR 0006 rejected an own worker runtime because pi-orchestrator would have to build and maintain one. The owner has since removed pi-subagents and wants pi-orchestrator to start workers itself. It now ships a third extension, `src/subagents/extension.ts`, with a `subagents` tool. Routing does not move: the tool starts workers on `orchestrator/auto`, and the router extension routes them as ADR 0006 describes. Other subagent extensions that start workers on the auto model are still routed.

## Considered options

- **Route inside the tool, and remove the auto model.** The tool could classify and start the worker on the real rung. That discards the tested pin, compaction and fallback paths, and routes only this tool's workers.
- **A separate `pi` process per worker** (pi's own subagent example). It isolates crashes and can outlive the turn, but it starts more slowly and needs pi-orchestrator installed as a package. Workers run in the orchestrator's process through the SDK instead, and share its model registry.
- **Built-in agent definitions.** pi-orchestrator ships none. The owner writes them.

## Consequences

- The tool is named `subagents`, so it does not clash with pi-subagents' `subagent` if that is installed again. The role stays "worker" (CONTEXT.md).
- Version 1 has one call with up to 8 tasks, at most `maxParallel` (default 4) running at once. The orchestrator waits on them, and abort stops them. Background workers, chains, resume and nested delegation are left for later. Workers do not get the `subagents` tool.
- A worker loads the same installed extensions as the orchestrator. Its session is saved under the orchestrator's session folder, and its session id is the delegation id.
- Agent definitions are markdown files with frontmatter in `~/.pi/agent/agents/` and `.pi/agents/`. A project file wins by name. A `tools:` list only narrows the tool set.
- `orchestrator.subagents.agentDefinitionModel.use` is `"route"` by default: a definition's `model` and `thinking` are ignored, with a warning. With `"preserve"`, a definition that names a model runs on it without routing, and gets an `agent-model` record naming the definition file.
- `agentDefinitionModel.allowBanned` lets a preserved model be on the subagent ban list (see the note on ADR 0002). For a project's agent definition, this applies only when `allowProjectOverrides` is also on.
- `orchestrator.subagents.allowProjectOverrides`, in personal settings only, lets a project set every `orchestrator.subagents` key except the flag itself.
