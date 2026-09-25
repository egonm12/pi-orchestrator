---
# pi-orchestrator-0rng
title: One worker runs through the subagents tool
status: todo
type: feature
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T21:42:44Z
parent: pi-orchestrator-6bam
---

Tracer slice. New extension src/subagents/extension.ts registers `subagents` with one `{task}` item. The worker runs in process through the SDK (createAgentSession) on orchestrator/auto, sharing the orchestrator's model registry, loading the same installed extensions without the `subagents` tool. Its session is saved under the orchestrator's session folder; its session id is the delegation id.

## Todo
- [ ] Test: a call with one task routes the worker (decision record keyed by the worker's session id) and returns its final text, status and session file
- [ ] Test: the worker has no `subagents` tool
- [ ] Text over ~50 KB is cut with a pointer to the session file
- [ ] The extension can be filtered out on its own (`!src/subagents/extension.ts`)
