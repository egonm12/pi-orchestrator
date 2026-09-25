---
# pi-orchestrator-ws8b
title: Keep in-process workers from acting as the orchestrator's session
status: completed
type: bug
priority: normal
created_at: 2026-09-25T22:53:25Z
updated_at: 2026-09-25T22:55:48Z
parent: pi-orchestrator-6bam
---

Final review findings for epic 6bam.

- [x] A preserved-model worker does not overwrite PI_ORCHESTRATOR_SESSION_MODEL
- [x] The session ban list does not bind in-process workers
- [x] The fresh-install notice is not printed per worker
- [x] Preserved model ids with a slash after the provider run
- [x] README: settings read per call; frontmatter lists model and thinking

## Summary of changes

- New `src/subagents/worker-sessions.ts`: a process-global set (on `globalThis` under a `Symbol.for` key, since pi loads each extension with a fresh module copy) of the session ids of in-process workers. `runWorker` marks the worker's session id before `bindExtensions` and unmarks it after `dispose`. `isWorkerSession(ctx)` looks up `ctx.sessionManager.getSessionId()`.
- Router extension: `rememberSessionModel` and the fresh-install notice skip a worker session, so a preserved-model worker no longer overwrites `PI_ORCHESTRATOR_SESSION_MODEL` and the notice prints once, in the orchestrator's session.
- Guard: the session ban list is not applied in a worker session (ADR 0002).
- Preserved model ids split at the first slash in the subagents extension and in `runWorker`, so `provider/vendor/model` runs.
- README: the subagents extension reads its settings, the subagent ban list and agent definitions on every call; the frontmatter list names `model` and `thinking`.
- Tests in `src/subagents/extension.test.ts`: an env assertion in the preserve-mode test, and new tests for the session ban list, the fresh-install notice and a slash in the model id.
