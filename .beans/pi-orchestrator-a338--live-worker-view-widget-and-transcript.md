---
# pi-orchestrator-a338
title: 'Live worker view: widget and transcript'
status: todo
type: epic
priority: normal
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:22:17Z
---

The user cannot see which workers are active, which model serves them or what they are doing, and cannot read a live worker's transcript. Goal: a view that works like Claude Code's agent list, for every worker of the orchestrator session.

## Decisions (grilling session 2026-09-26)
- Covers every worker of the session: foreground, background and nested. Nested workers are shown indented under their parent delegation.
- Worker states come from the glossary (CONTEXT.md, Worker state): queued, running, asking, completed, failed, aborted.
- Worker widget above the editor: one line per worker (agent, model and effort, worker state, elapsed time, turns, current tool or latest text). At most 6 lines, then "+N more". A finished worker stays about 10 s with its end state, then drops out. The widget disappears when no worker runs.
- Model of a routed worker: the rung serving its latest request, updated live, "routing…" before the first request, an escalation marker after one. Forks and preserved-model workers show their fixed model.
- The transcript view replaces the whole screen (alternate screen) and restores the orchestrator session on leaving. A spike proves this in regular tuiMode first; if it fails, the fallback is true replacement in fullscreen tuiMode and a full-height view in regular tuiMode.
- Getting in: alt+a focuses the widget, arrows pick a worker, Enter opens it. /subagents without arguments opens a picker of every worker of the session, finished ones included (it replaces the text notice). /subagents <delegation id | list number> opens one directly. /subagents stop keeps working.
- Inside: Esc goes back; left and right switch worker; the view follows the end until scrolled (PgUp, PgDn, Home, End; End follows again); Enter on a nested worker's line opens it; x stops the worker after a confirmation.
- Read-only: answering and steering stay with the orchestrator through subagents_message.
- The view never pulls the user out. A top bar shows the orchestrator's state and asking workers. A finished worker's transcript stays open with its end state.
- Rendering reuses pi's message rendering (tool-output expand toggle included); reports and steers are marked messages.
- Header: agent, worker state, elapsed time, turns, model and effort with rung history, tokens and cost, delegation id and parent delegation, first line of the task.

## Open facts
- Confirm the display can read the router's chosen rung per worker request in-process (worker board bean).
