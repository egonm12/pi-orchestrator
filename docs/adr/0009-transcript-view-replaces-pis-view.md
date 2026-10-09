---
status: accepted
date: 2026-09-27
---

# The transcript view replaces pi's view

Spike rcjm first used a full-screen overlay. In regular tuiMode the terminal owns scrollback and does not send mouse events to pi, so the overlay could not scroll with the terminal. The regular-mode view therefore replaced pi's root. Fullscreen mode initially kept the overlay and later handled wheel events manually, but that overlay rendered its own body window and pinned the header and picker above it. It did not use pi's chat viewport. The owner reported that the wheel did not work live and that the picker covered the top of the transcript.

The worker view now replaces the visible root in both modes. Regular mode swaps pi-tui's children and lets the terminal own scrollback. Fullscreen mode swaps the layout root for a `ScrollView` and dock shaped like pi's chat viewport. No capturing overlay sits above the chat. The transcript and its metadata scroll together; the message editor, worker picker and footer occupy the dock, in that order. The root is restored on exit, and pi restores its editor and focus.

## Considered options

- **Keep the overlay and handle the wheel.** It relies on the overlay's mouse dispatch and duplicates pi's viewport behavior. It also leaves the header and picker pinned above the chat.
- **Print the transcript below the chat.** The orchestrator's chat stays above it in regular-mode scrollback.
- **Replace the visible root (chosen).** The worker chat uses terminal scrollback in regular mode and pi-tui's native `ScrollView` wheel routing in fullscreen mode.

## Consequences

- In regular mode, opening, leaving and switching worker reprint the terminal and land at the bottom. Changes above the visible area can also reprint, as in pi's main chat. The scroll keys do not replace terminal scrolling.
- In fullscreen mode, the chat follows the end until the user scrolls. The wheel, page, top, bottom and prompt keys and search address the chat viewport, as in pi's chat; the view handles none of them. New output does not move a scrolled-up chat. The metadata is the chat's first item, rather than a sticky header. The picker remains below the editor.
- While the worker view is open, orchestrator output updates the saved chat tree and appears when the view closes. Neither mode changes the orchestrator session or its editor draft.

## Transcript rendering

The transcript is one pi component per message, in session order. A finished message's component is built once and kept, so scrolling and the header's one-second tick do not rebuild finished messages. Only the live reply and a tool call that is still running receive updates (bean gmrl).

Tool boxes follow the mode. In fullscreen tuiMode a completed box shows pi's green when its call succeeds and red when it fails, as in pi's chat. Fullscreen has no scrollback for pi-tui to reprint. In regular tuiMode a box keeps the steady pending tint, so a finished call changes only its last line and pi-tui does not reprint the terminal (bean efd2).

In fullscreen tuiMode a left click on a tool result or a thinking block expands or collapses it, as in pi's chat. The wrappers forward mouse events to pi's components. Regular tuiMode gets no mouse reports, so clicks do nothing there.

`PI_ORCHESTRATOR_TRANSCRIPT_TRACE=<file>` appends one JSON line per frame to that file, plus a frame count each second. The trace writes only to its file, since pi-tui owns stdout and stderr. Without the variable there is no file and no timing call.

## Implementation note

The fullscreen chat takes pi's chat viewport options (follow the end, primary, chained overscroll) and pi's scrollbar colours. Its scrollbar mode is pi's `fullscreenScrollbar` setting, read when the view opens; settings cannot change while the view holds the editor's place. The view has no scroll key of its own, so its scrolling is pi's on any pi-tui version. Prompt marks stay in the fullscreen chat, so pi's prompt jumps find the task and the replies. The fullscreen lines are not cut per frame: pi-tui clamps the rows it draws, and the regular transcript caches each child's width cut until its lines change.

`ctx.ui.custom` is opened without an overlay in both modes. Pi places its key-handling component in the editor container and focuses it. The view swaps the appropriate root from inside the factory and restores it before completing the custom interaction. The fullscreen layout root is not exposed by the public `ViewportTUI` interface; the replacement preserves pi's current root from the runtime instance before calling `setLayoutRoot` and restores that root on exit.
