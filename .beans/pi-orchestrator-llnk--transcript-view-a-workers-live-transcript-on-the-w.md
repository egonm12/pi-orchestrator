---
# pi-orchestrator-llnk
title: 'Transcript view: a worker''s live transcript on the whole screen'
status: todo
type: feature
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:18:43Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-rcjm
    - pi-orchestrator-2jba
---

Shows one worker's transcript on the whole screen with the mechanism the spike chose, and restores the orchestrator session on Esc. Reuses pi's message rendering (thinking, tool calls and results, the tool-output expand toggle); reports and steers are marked messages. Live: follows the end until the user scrolls (PgUp, PgDn, Home, End; End follows again). Left and right switch to the previous or next worker; Enter on a nested worker's line opens it; x stops the worker after a confirmation. Read-only otherwise. A finished worker's transcript stays open; finished workers are read from their session file.

## Todo
- [ ] Test: opens and restores the orchestrator session
- [ ] Test: live updates, follow and scroll
- [ ] Test: switching workers and opening a nested worker
- [ ] Test: x stops after confirmation
- [ ] Test: a finished worker's transcript from its session file
- [ ] README
