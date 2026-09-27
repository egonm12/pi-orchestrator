---
# pi-orchestrator-8ftz
title: Worker reporting rules and Result header check
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:07:20Z
parent: pi-orchestrator-3p1z
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. Every non-fork worker gets the reporting rules in its system prompt, whatever its agent definition says: verify before reporting; give file:line for every factual claim; label unverified claims; say what could not be checked and why; do only what the task asks. Its Result has five sections: Confirmed, Changed, Unverified, Could not check, Verified by (the commands it ran).

When a worker finishes, the runtime checks the Result's section headers without a model call. A missing section adds a note to that worker's part of the subagents tool result. It never rejects.

## Acceptance criteria

- [ ] A worker with no agent definition and one with an agent definition both get the rules; the definition's instructions still follow
- [ ] A forked worker does not get them
- [ ] A Result missing one or more sections gets a note naming them; a complete Result gets none
- [ ] Tests

## Blocked by

None, can start immediately.
