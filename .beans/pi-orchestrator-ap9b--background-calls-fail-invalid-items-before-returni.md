---
# pi-orchestrator-ap9b
title: 'Background calls: fail invalid items before returning delegation ids'
status: todo
type: task
created_at: 2026-09-26T08:29:44Z
updated_at: 2026-09-26T08:29:44Z
parent: pi-orchestrator-l1yp
---

A background subagents call returns one delegation id per item at once, but items are validated (agent name, preserved model, ban list) only when the queue reaches them. An item that then fails before a worker starts (for example an unknown agent) was announced with a delegation id that never becomes a worker session; its completion notice says 'No worker started'. Validate every item before the call returns, so a failing item is reported in the immediate result and gets no delegation id. Found while implementing pi-orchestrator-399w; left out to keep the queue loop in src/subagents/extension.ts unchanged while rc8i, 76jj and qdz9 edit it.
