---
# pi-orchestrator-faal
title: Worker widget below the editor, entered with the Down arrow
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T14:25:50Z
updated_at: 2026-09-27T15:27:58Z
parent: pi-orchestrator-kd8n
blocked_by:
    - pi-orchestrator-n0fj
---

Today the widget is placed aboveEditor (worker-widget.ts) and focused only with alt+a, through a capturing overlay that draws nothing. ctx.ui.onTerminalInput can see a key before the editor does.

## Behaviour
- The worker widget sits below the editor (placement belowEditor).
- Down enters the list only when it would do nothing in the editor: the cursor is on the editor's last line, the user is not browsing history, and at least one worker is shown.
- In the list: ↑↓ move, Enter opens the transcript view. ↑ on the first row or Esc returns to the editor with its text untouched. Any other key returns to the editor and goes into it.
- alt+a stays as a second way in.
- Leaving the transcript view returns to the list with that worker selected.
- When the selected worker leaves the list, the selection moves to a neighbour; when the list empties, focus returns to the editor.

## Todo
- [x] Find how to tell that Down would do nothing in the editor (cursor line, history browsing)
- [x] Tests first for the focus rules
- [x] Move the widget below the editor and add Down-arrow entry

## Summary of changes

- The worker widget sits below the editor (`placement: "belowEditor"`).
- Down enters it through `ctx.ui.onTerminalInput`, and only when Down would do nothing in the editor (`downDoesNothing` in worker-widget.ts):
  - The key must be Down as pi's editor binds it (its own keybindings), and a kitty release or repeat never counts.
  - The cursor must be at the end of the last line, and the last visual line when it wraps.
  - The editor must not be browsing history, showing autocomplete or in jump mode.
  - At least one worker must be shown.
- Only `getLines` and `getCursor` are public Editor API. `historyIndex`, `autocompleteState`, `jumpMode` and `isOnLastVisualLine` are pi-tui internals, read only when present.
- In the list:
  - ↑↓ move, and Enter opens the transcript view.
  - ↑ on the first row, Esc or ctrl+c return to the editor untouched.
  - Any other key returns and goes into the editor.
- Down and alt+a share a browse loop in extension.ts. Leaving the transcript view returns to the list with that worker selected, and the loop stays with its own session's widget.
- Moving the selection to a neighbour and handing focus back when the list empties work as before.
- Tests cover the entry rules, the list keys, the reselection and the extension wiring. README describes it.
