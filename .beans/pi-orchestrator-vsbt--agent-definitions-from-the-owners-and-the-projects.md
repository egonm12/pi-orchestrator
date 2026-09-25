---
# pi-orchestrator-vsbt
title: Agent definitions from the owner's and the project's agent folders
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:13:16Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-0rng
---

Read markdown agent definitions (frontmatter: name, description, tools; body: instructions) from ~/.pi/agent/agents/ and .pi/agents/. The project wins by name. `agent` is optional in a call. A `tools:` list only narrows the orchestrator's tool set. The tool description lists each definition's name and description at session start. No built-in definitions.

## Todo
- [x] Test: discovery, precedence and the listing in the tool description
- [x] Test: `tools:` narrows and cannot add a tool
- [x] Test: an unknown agent name fails the item with a reason

## Summary of changes

- src/subagents/agent-definitions.ts: loadAgentDefinitions reads the `.md` files in `<agent dir>/agents` and `<cwd>/.pi/agents`. A file needs a string `name` and `description` in its frontmatter; `tools:` is a comma list or a YAML list; the body is the instructions. A project file wins by name. agentDefinitionListing builds the tool description's listing. resolveAgent turns a task item's optional `agent` into instructions and a tool list, or a failure reason for an unknown name. The tool list keeps only tools the orchestrator has active, and never subagents.
- src/subagents/worker.ts: runWorker takes optional `instructions`, appended to the worker's system prompt, and optional `tools`, the worker's tool allowlist.
- src/subagents/extension.ts: the tool takes an optional `agent` next to `task`, and its description says so. The tool is still registered at load, so a worker can leave the extension out, and is registered again at session_start with the listing of definitions for the session's cwd. An unknown agent fails the item without starting a worker: the result has no session id and the reason is in `error` and the text.
- src/subagents/extension.test.ts: three tests at the tool seam, in a throwaway agent dir and project. The first covers discovery in both folders, the project winning by name, the listing in the description and the project instructions reaching the worker. The second shows `tools:` narrows the orchestrator's tools and cannot add pi's grep or subagents. The third shows an unknown name fails the item with a reason, and no worker request or routing record follows.
