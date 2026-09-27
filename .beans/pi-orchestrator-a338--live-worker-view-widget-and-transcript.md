---
# pi-orchestrator-a338
title: 'Live worker view: widget and transcript'
status: completed
type: epic
priority: normal
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-27T13:58:58Z
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

## Summary of Changes

All six child beans are built and merged into main, in three waves:

- Wave 1: rcjm (spike) and 2jba (worker board). The spike's answer: a full-screen `ctx.ui.custom` overlay restores the session cleanly in both regular and fullscreen tuiMode, as the owner confirmed live, so the fallback was not needed. The first live try trapped the user, because the prototype matched raw key bytes under the kitty keyboard protocol. From then on every view matches keys through pi's keybindings manager and always leaves on Esc and ctrl+c. The worker board confirmed the open fact: the router's chosen rung is readable in-process, through a new served-rungs hook in the auto provider.
- Wave 2: oy50 (worker widget above the editor) and llnk (transcript view). oy50 started as soon as 2jba was merged, while the spike waited for the live try.
- Wave 3: xytd (alt+a, the `/subagents` picker and direct jumps) and vo0z (transcript header and orchestrator bar). Both first workers' model requests timed out on long sessions; fresh workers finished the uncommitted work.

Integration work done while merging:

- c1sw: the fork rung test expected routing records in write order, which only held on 2026-09-26, because the test router's clock is fixed while fork records carry the real date. It now compares the record types sorted.
- Merging vo0z: both branches appended tests to the end of extension.test.ts; both are kept. The merged suite, run under a long TMPDIR, showed that the transcript view kept only the first row of an over-wide notice or end-state line. The view now wraps those lines.
- xytd deliberately changed `/subagents`: without arguments it opens the picker of every worker, and any argument but `stop ...` is a direct jump, so `/subagents list` is now refused. The README was updated to match.

How the recorded decisions landed:

- Every worker of the session, nested ones under their parent delegation: board, widget, picker and view (2jba, oy50, xytd, llnk).
- The widget's line, cap, 10 s linger and disappearing: oy50.
- A routed worker's model, "routing…" and the escalation marker: 2jba, shown in the widget and the header.
- The whole-screen view and restoring the session: rcjm and llnk.
- The ways in (alt+a, the picker, direct jumps, `/subagents stop` unchanged): xytd.
- Keys inside the view, following the end, nested workers, x with a confirmation: llnk.
- Read-only, never pulling the user out, and the top bar: llnk and vo0z.
- The header fields: vo0z.
- Reusing pi's message rendering with marked reports and steers: llnk. What an extension cannot reach is deferred to i81j.

Each piece has its own tests. On main, `npm run typecheck` passes and `npm test` shows 653 tests: 636 passing, 0 failing and 17 skipped.

Follow-ups left open under this epic:

- i81j: the transcript view's rendering gaps (needs triage).
- 5utr: subagents_status reads the worker board.
- 5798: remove the unreachable listing branch from `BackgroundCalls.command`.
- sgym: which workers the widget's 6-line cap keeps (needs the owner's decision).
