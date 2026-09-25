---
# pi-orchestrator-5he0
title: Router floors every task on text injected by other extensions
status: completed
type: bug
priority: normal
created_at: 2026-09-25T21:02:09Z
updated_at: 2026-09-25T21:08:00Z
---

## Observed
Live test (2026-09-25): a scout asked to count .ts files was classified mechanical by the model but floored to **elevated** (data-loss, matched `purge`) and ran on anthropic/claude-opus-5-5:high. A plain summary task got the same floor. A security review got critical (credential + purge).

## Cause
`firstTaskAndRole` in src/router/auto-provider.ts joins every user message before the first assistant message. context-mode's pi adapter pushes an extra plain `{role: "user"}` message via the `context` hook containing its routing anchor ("... Purge → ctx_purge."). The keyword floor in src/routing/classifier.ts:87 matches `purge`, so every worker in a session with context-mode gets at least elevated. The injected message has no marker, so any extension that appends context this way pollutes the task text.

## Options
- Use only the first user message (the delegated prompt) as task text
- Run keyword floors only on the first user message, still give the classifier more context
- Strip known injected blocks (fragile)

## Todo
- [x] Pick the task-text boundary
- [x] Add a test with an injected trailing user message
- [x] Re-run the live three-tier test

## Summary of changes
- Cause confirmed: `firstTaskAndRole` joined every user message before the first reply, so context-mode's `context`-hook anchor ("Purge → ctx_purge") became task text and tripped the data-loss floor.
- Fix: the task text is the first user message only (src/router/auto-provider.ts). pi puts the delegated prompt before `nextTurn` and `before_agent_start` messages.
- Regression test: "text another extension appends after the delegated prompt sets no keyword floor" (src/router/extension.test.ts), red before and green after.
- README states what the task text is.
- Live check: the count scout now routes mechanical, no floor, anthropic/claude-haiku-4-5:low (before: elevated, opus-5-5:high).

## Residual risk
A custom message an extension sends before the first prompt (flushed by `_flushPendingCustomMessages`) would become the first user message. Not seen in practice.
