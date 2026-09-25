---
# pi-orchestrator-vsbt
title: Agent definitions from the owner's and the project's agent folders
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T21:42:44Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-0rng
---

Read markdown agent definitions (frontmatter: name, description, tools; body: instructions) from ~/.pi/agent/agents/ and .pi/agents/. The project wins by name. `agent` is optional in a call. A `tools:` list only narrows the orchestrator's tool set. The tool description lists each definition's name and description at session start. No built-in definitions.

## Todo
- [ ] Test: discovery, precedence and the listing in the tool description
- [ ] Test: `tools:` narrows and cannot add a tool
- [ ] Test: an unknown agent name fails the item with a reason
