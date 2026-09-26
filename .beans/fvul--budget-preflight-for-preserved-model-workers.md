---
# fvul
title: Budget preflight for preserved-model workers
status: todo
type: task
created_at: 2026-09-26T08:30:13Z
updated_at: 2026-09-26T08:30:13Z
parent: pi-orchestrator-l1yp
---

Fresh preserved-model workers bypass the router allowance preflight. Resume follows the same behaviour for a preserved model using the ban-list exception: its pin passes the other hard filters, but allowanceConstraint rejects globally banned models before checking the budget. Add a budget preflight that supports a verified preserved-model exception without changing the ban-list guard for routed workers.
