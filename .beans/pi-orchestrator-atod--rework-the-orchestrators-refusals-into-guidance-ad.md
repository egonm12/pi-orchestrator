---
# pi-orchestrator-atod
title: Rework the orchestrator's refusals into guidance (ADR 0013)
status: todo
type: epic
tags:
    - needs-triage
created_at: 2026-09-28T13:47:32Z
updated_at: 2026-09-28T13:47:32Z
---

ADR 0013 supersedes ADR 0005 and amends ADR 0010 (owner, 2026-09-28). Committed work from epic pi-orchestrator-3p1z still follows the old rules:

- [ ] jeyq: the exploration budget denies calls past the threshold. Replace with an exploration nudge added to the result of each further exploratory call.
- [ ] mw81: git commit and push are denied while a verdict is missing. Let them through; their result names the delegations waiting for a verdict.
- [ ] kokv, mw81, 247s: an editing delegation is detected from tool calls (edit, write, unrecognised bash, ctx_execute). Replace with a working-tree comparison before and after the worker, per CONTEXT.md.
- [ ] Remeasure the delegation rate once the protocol reaches every run (ADR 0013 consequences).
- [ ] Revisit the y8cd protocol gap in message-started runs, which ADR 0013 names as a flaw in the old measurement.
