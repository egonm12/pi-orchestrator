---
# pi-orchestrator-y8cd
title: Orchestrator protocol in the system prompt
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:07:20Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-vu2o
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

The orchestrator's session always carries the orchestrator protocol in its system prompt, added on every turn so it survives compaction. The base protocol says: delegate exploration and substantial work to workers, keep small known actions (a single lookup, a small edit, a commit), and treat a worker's Result as evidence, not a verdict. Workers never get it. There is no per-prompt reminder line. Later tickets add their own paragraph (budget, verdicts, reviewer, gate level).

## Acceptance criteria

- [ ] The protocol is in the orchestrator session's system prompt on every turn, including after compaction
- [ ] Worker, forked worker and child-process sessions do not get it
- [ ] The protocol text lives in one place that later tickets extend
- [ ] Tests

## Blocked by

- pi-orchestrator-vu2o
