---
# pi-orchestrator-76jj
title: Resume a finished worker
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:45Z
updated_at: 2026-09-26T08:13:00Z
parent: pi-orchestrator-l1yp
---

An item `{ resume: <delegation id>, task }` continues the same delegation, session and pin. It excludes `agent` and `fork`. Allowed for any worker saved under this orchestrator session (including after /resume of the session) whose status is completed, failed or aborted; refused for not-started or still-running workers. The pin is checked against the hard filters again and a failing pin refuses the resume, never re-routes. No new decision record; the latest verdict on a delegation counts, earlier ones are kept. Resume items may be background.

## Todo
- [ ] Test: resume continues the session and pin with the new task
- [ ] Test: refused for not-started, running, unknown ids and ids outside this orchestrator session
- [ ] Test: a pin that now fails a hard filter refuses the resume
- [ ] Test: the latest verdict counts
- [ ] README
