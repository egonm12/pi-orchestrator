---
# pi-orchestrator-i81j
title: 'Transcript view: apply pi''s chat settings and a worker''s own renderers'
status: todo
type: task
tags:
    - needs-triage
created_at: 2026-09-27T13:58:27Z
updated_at: 2026-09-27T13:58:27Z
parent: pi-orchestrator-a338
---

Gaps found while building the transcript view (llnk), where the extension cannot get what pi's chat uses:

- A custom message's own renderer, registered in the worker's session, is out of reach, so custom messages such as a nested worker's `subagents-report` get pi's default drawing.
- pi's markdown transformers, the hide-thinking setting and image settings are not applied.
- In a finished worker's transcript read from its session file, only pi's built-in tools, `subagents` and `report` keep their renderers; other extension tools fall back to pi's plain drawing.

Needs triage: find out which of these pi's extension API can reach at all, and which are worth it.

## Todo

- [ ] Find out what pi exposes for each gap
- [ ] Close the gaps that can be closed, with tests
- [ ] README
