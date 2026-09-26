---
# pi-orchestrator-xytd
title: 'Opening workers: alt+a, the /subagents picker and direct jumps'
status: todo
type: feature
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:18:43Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-oy50
    - pi-orchestrator-llnk
---

alt+a focuses the worker widget; arrow keys pick a worker and Enter opens its transcript view. /subagents without arguments opens a picker of every worker of the session, finished ones included, replacing the text notice. /subagents <delegation id | list number> opens one directly. /subagents stop keeps its behaviour.

## Todo
- [ ] Test: alt+a focus, arrow selection, Enter opens the chosen worker
- [ ] Test: the picker lists every worker, finished ones included
- [ ] Test: direct jump by delegation id and by list number; unknown ids refused
- [ ] Test: /subagents stop unchanged
- [ ] README
