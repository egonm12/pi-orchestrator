---
# pi-orchestrator-ui06
title: A pinned rung missing from the registry falls back to the orchestrator's model
status: todo
type: task
tags:
    - needs-triage
created_at: 2026-09-25T20:51:25Z
updated_at: 2026-09-25T20:51:25Z
---

Found in the user story audit of pi-orchestrator-6nhd (story 40). In src/router/auto-provider.ts, routing failures fall back to the orchestrator's model with one disabled line, but a pinned rung that is missing from the session model registry at request time ends the stream with an error. Rung provider errors are passed through by design (as overflow is), but a missing pinned rung is closer to an internal failure. Decide whether it should fall back.
