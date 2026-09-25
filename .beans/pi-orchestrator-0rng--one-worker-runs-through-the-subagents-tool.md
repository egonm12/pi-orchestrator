---
# pi-orchestrator-0rng
title: One worker runs through the subagents tool
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:07:02Z
parent: pi-orchestrator-6bam
---

Tracer slice. New extension src/subagents/extension.ts registers `subagents` with one `{task}` item. The worker runs in process through the SDK (createAgentSession) on orchestrator/auto, sharing the orchestrator's model registry, loading the same installed extensions without the `subagents` tool. Its session is saved under the orchestrator's session folder; its session id is the delegation id.

## Todo
- [x] Test: a call with one task routes the worker (decision record keyed by the worker's session id) and returns its final text, status and session file
- [x] Test: the worker has no `subagents` tool
- [x] Text over ~50 KB is cut with a pointer to the session file
- [x] The extension can be filtered out on its own (`!src/subagents/extension.ts`)

## Decision

Each worker gets its own model runtime. pi's `ModelRegistry` keeps its runtime private, so the orchestrator's runtime cannot be handed to `createAgentSession`. The worker uses pi's `createAgentSessionServices`, which builds a runtime from the same agent dir's `auth.json` and `models.json`. It loads the same installed extensions, so the router extension registers `orchestrator/auto` in the worker's runtime. "Sharing the model registry" therefore means the same model and auth config in the same process. The fallback, a typed cast to reach the private runtime, was not needed. ADR 0007 has a one-line note on this.

## Summary of changes

- `src/subagents/worker.ts`: `runWorker` starts one worker. It builds pi's session services for the orchestrator's cwd and agent dir, drops any extension that registers the `subagents` tool, and starts the session on `orchestrator/auto`. It binds the extensions, so the router extension runs its `session_start`, then sends the task. The session is saved in `<orchestrator session folder>/subagents/<orchestrator session id>/`, or kept in memory when the orchestrator's session is not saved. The result has the status (`completed`, `failed` or `aborted`), the session id, the session file, the final text and any error. The tool call's abort signal aborts the worker.
- `src/subagents/extension.ts`: registers the `subagents` tool with one `task` parameter as plain JSON Schema. It returns the worker's result as text and in `details.results`. `cutText` cuts a final text over 50 KB and adds a pointer to the session file.
- `package.json`: lists `./src/subagents/extension.ts` as a third extension, so a package filter can drop it on its own.
- `src/subagents/extension.test.ts`: four tests. The worker is a real SDK session in a throwaway agent dir. It loads the router extension and a fake `anthropic` provider as inline extensions. The tests check that the worker runs on `orchestrator/auto`, gets one live decision record keyed by its session id, and returns its text, status and session file. They also check that other extensions' tools reach the worker but `subagents` does not, that long text is cut while the session file keeps all of it, and that `!src/subagents/extension.ts` drops only this extension.
- `docs/adr/0007-ship-an-own-subagent-runtime.md`: one-line note on what "share its model registry" means.
