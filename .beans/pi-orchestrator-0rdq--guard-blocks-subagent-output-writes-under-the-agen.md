---
# pi-orchestrator-0rdq
title: Guard blocks subagent output writes under the agent directory
status: completed
type: bug
priority: normal
created_at: 2026-09-25T21:02:09Z
updated_at: 2026-09-25T21:12:08Z
---

## Observed
Live test (2026-09-25): pi-subagents told the scout to write its output to ~/.pi/agent/sessions/.../subagent-artifacts/outputs/<id>/standard.md. The guard refused the write because it is inside the agent directory. The scout fell back to returning the text inline.

## Todo
- [x] Decide whether session artifact paths are allowed (for example `sessions/**/subagent-artifacts/`) or stay blocked
- [x] Test the chosen rule

## Summary of changes
- Decision: `write` and `edit` may use paths strictly below `<agentDir>/sessions/`. That is where subagent extensions keep run artifacts, and the rule does not depend on pi-subagents' layout (ADR 0006). Everything else in the agent directory stays protected, including settings, auth, extensions and `pi-orchestrator/` state.
- Paths are canonicalised first, so `..`, a symlink inside `sessions/` pointing back at the agent directory, and a `sessions` symlink to the agent directory itself are still refused.
- `withinAgentDir` is renamed `protectedAgentPath`, since it now answers that question.
- README's guard section names the exception.
- Live check: a background scout's `write` to its `subagent-artifacts/outputs/` path succeeded.
