---
# pi-orchestrator-xytd
title: 'Opening workers: alt+a, the /subagents picker and direct jumps'
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-27T13:52:07Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-oy50
    - pi-orchestrator-llnk
---

alt+a focuses the worker widget; arrow keys pick a worker and Enter opens its transcript view. /subagents without arguments opens a picker of every worker of the session, finished ones included, replacing the text notice. /subagents <delegation id | list number> opens one directly. /subagents stop keeps its behaviour.

## Todo
- [x] Test: alt+a focus, arrow selection, Enter opens the chosen worker
- [x] Test: the picker lists every worker, finished ones included
- [x] Test: direct jump by delegation id and by list number; unknown ids refused
- [x] Test: /subagents stop unchanged
- [x] README


## Decisions

- **Focus mechanism (alt+a).** `pi.registerShortcut("alt+a", ...)` (unbound by pi itself, checked in `keybindings.js`). The handler is guarded with `isWorkerSession(ctx)` and a local `widget` reference so it is a no-op in a worker's own copy of this extension and whenever the orchestrator's widget is not shown; it calls `widget.focus(ctx.ui)` (worker-widget.ts, already built by the earlier worker) and, on a chosen worker, opens its transcript through the shared `openWorker` helper.
- **Picker.** `pickWorker` (worker-picker.ts, already built) shown through `ctx.ui.custom` when `ctx.hasUI`; without a UI, `/subagents` with no arguments falls back to `workerListing(...)` as text (or a literal "No workers in this session." when the board is empty, since `workerListing([])` alone would print nothing).
- **`/subagents <other>` behaviour, replaced deliberately.** Before xytd, `backgroundCalls.command(args)` handled every argument: `""` and `"list"` showed the *background-calls-only* listing, `"stop ..."` stopped one, and anything else returned a fixed `Usage: /subagents ...` string. Now only `"stop ..."` still reaches `backgroundCalls.command` unchanged; `""` opens the picker/full listing (every worker, not only background ones, per the epic); every other argument (including the old `"list"` keyword) is tried as a direct jump through `findWorker` and refused by name if it matches no worker. `background.ts`'s own `command()` method is untouched (its `""`/`"list"` branches remain there but are no longer reachable from `/subagents`; `subagents_status` still reads `backgroundCalls.listing()` directly for the LLM-facing tool, unaffected).
- **Empty board.** The picker already showed "No workers in this session." (worker-picker.ts); the text-listing fallback now does the same instead of notifying with an empty string.
- **Argument completions.** Added `getArgumentCompletions` (pi supports it, `RegisteredCommand.getArgumentCompletions`): offers `stop` and every worker's current list number, filtered by prefix.

## Review findings (fixed inline)

- `npm run typecheck`'s one error (`stopWidget: (() => void) | undefined` vs. `WorkerWidget`) was the closure variable never having been updated after `startWorkerWidget`'s return type changed to expose `.focus()`; renamed to `widget: WorkerWidget | undefined` and its two call sites (`session_shutdown`, `session_start`) updated to `widget?.stop()`.
- worker-widget.ts and worker-picker.ts (already built): reviewed in full. Both leave on `tui.select.cancel` (Esc, Ctrl+C) as required, match keys only through pi's keybindings manager, and the widget's `hide()` ends an active focus when the board empties. No changes needed.
- Two existing extension.test.ts tests asserted the old `/subagents` routing (`""` -> background-only listing, `"list"`/an unrecognized word -> the fixed usage string); updated to the new behaviour (`"stop all"` for the empty-board check, `"list"`/`"halt"` now refused as unknown direct jumps) rather than left broken.
- README: also corrected two other mentions of the old behaviour outside the Transcript view section that the routing change made stale (Background calls' lead sentence about `/subagents` listing background calls; Status and wait's "as `/subagents list` does").

## Summary of changes

- `src/subagents/extension.ts`: wired `/subagents` (no args -> picker or text listing; `stop ...` -> unchanged; delegation id or list number -> direct jump via `findWorker`; anything else -> refused) and the `alt+a` shortcut (guarded to the orchestrator's session) to the already-built worker widget focus and picker; added the shared `openWorker` helper calling `openTranscript(ctx.ui, workerBoard(), id)` with no header/bar options (vo0z's fuller header and orchestrator bar apply as the transcript view's own defaults); added argument completions; fixed the `stopWidget`/`WorkerWidget` typecheck error.
- `src/subagents/extension.test.ts`: updated two tests for the deliberately changed `/subagents` routing; extended the `loadSubagents` test harness with `registerShortcut`/`runShortcut`, `runCommandWithUI` (a raw `ctx.ui`, for tests that mount a real picker or transcript overlay) and `commandCompletions`; added four new tests (picker + text-listing fallback, direct jump by list number/delegation id + unknown-ref refusal, alt+a wiring + worker-session no-op, argument completions).
- `src/subagents/worker-widget.ts` / `worker-widget.test.ts`, `src/subagents/worker-picker.ts` / `worker-picker.test.ts`: the earlier worker's code, reviewed and kept as built (see Review findings).
- `README.md`: documented alt+a, the picker (with its no-UI text fallback) and direct jumps in the Transcript view section (and a short alt+a mention in Worker widget); corrected two other stale mentions of the old `/subagents` default behaviour.

Commit: `feat: Open workers with alt+a, the /subagents picker and direct jumps (xytd)`.
