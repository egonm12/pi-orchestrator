---
# pi-orchestrator-2vox
title: 'subagents_status: snapshot and wait'
status: todo
type: feature
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:12:55Z
parent: pi-orchestrator-l1yp
blocked_by:
    - pi-orchestrator-399w
---

Tool `subagents_status({ id?, wait? })`. Without id: this session's background calls. With a call id: a snapshot per item; with a delegation id: one item. A snapshot holds state, current tool, turn count, elapsed time, the last lines of text and the session file. `wait: true` blocks until the call finishes and returns its results; that call's completion notice is then not delivered. Ctrl+C during a wait stops only the wait. Workers do not get this tool.

## Todo
- [ ] Test: list, call snapshot and delegation snapshot
- [ ] Test: wait returns results and suppresses the notice
- [ ] Test: Ctrl+C stops the wait, not the workers
- [ ] README
