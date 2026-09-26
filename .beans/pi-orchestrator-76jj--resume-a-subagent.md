---
# pi-orchestrator-76jj
title: Resume a finished worker
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:45Z
updated_at: 2026-09-26T08:30:56Z
parent: pi-orchestrator-l1yp
---

An item `{ resume: <delegation id>, task }` continues the same delegation, session and pin. It excludes `agent` and `fork`. Allowed for any worker saved under this orchestrator session (including after /resume of the session) whose status is completed, failed or aborted; refused for not-started or still-running workers. The pin is checked against the hard filters again and a failing pin refuses the resume, never re-routes. No new decision record; the latest verdict on a delegation counts, earlier ones are kept. Resume items may be background.

## Todo
- [x] Test: resume continues the session and pin with the new task
- [x] Test: refused for not-started, running, unknown ids and ids outside this orchestrator session
- [x] Test: a pin that now fails a hard filter refuses the resume
- [x] Test: the latest verdict counts
- [x] README

## Summary of Changes

A resume item continues a finished saved session under the same orchestrator session with the original delegation id and actual pin. The subagents tool checks ownership, completion and the pin's current hard filters before starting it, and refuses missing or failing pins without routing or writing another decision. Preserved agent models retain their instructions and narrowed tools; their ban-list exception requires current preserve and allowBanned settings, plus project override permission when applicable. Fork pins are read from ADR 0008 fork records when the forked-worker branch supplies that record type. Resume does not change verdict attachment: all verdict records remain, and the existing report uses only the latest one per delegation. Tests cover live, shadow, preserved-model and ban-list-exception resumes, rejection cases, and latest-verdict accounting. As for fresh preserved-model workers, a preserved model using a ban-list exception has no routed allowance preflight; follow-up fvul tracks that gap.
