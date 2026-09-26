---
# pi-orchestrator-rcjm
title: 'Spike: replace the whole screen with a transcript in regular tuiMode'
status: in-progress
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:37:53Z
parent: pi-orchestrator-a338
---

Prototype, throwaway. Answer: can an extension show a component on the alternate screen from regular tuiMode (via ctx.ui.custom or pi-tui's TuiAltScreen) and return to the orchestrator session exactly as it was, with no broken scrollback, cursor or editor state? Also try it in fullscreen tuiMode.

## Todo
- [ ] Prototype in a scratch extension, tried in a live pi session in both tuiModes
- [ ] Record the answer and the chosen mechanism (or the fallback) in an ## Answer section

## Spike notes

### Mechanisms found

- **`ctx.ui.custom()` as a full-screen overlay.** `ExtensionUIContext.custom<T>(factory, { overlay: true, overlayOptions, onHandle? })` (node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts). With `overlay: true`, `InteractiveMode.showExtensionCustom` (dist/modes/interactive/interactive-mode.js, ~L2236-2299) calls `this.ui.showOverlay(component, resolveOptions())`, i.e. pi-tui's `TuiBase.showOverlay` (node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js, ~L347). Overlays live on a stack and are composited every render pass by `TuiBase.compositeOverlays` (tui.js ~L904), called from both `TuiMainScreen.doRender` (dist/tui-main-screen.js ~L232) and `TuiAltScreen.doRender` (dist/tui-alt-screen.js ~L1444), so the same code path runs in both tuiModes. `overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 }` resolves to the full terminal width and height (tui.js's `resolveOverlayLayout`), so the component visually covers everything, chat history included. Keyboard input: `showOverlay` gives the overlay focus automatically (unless `nonCapturing`), so the component's own `handleInput(data)` receives every key while shown. Leaving: the component calls the `done` callback passed into the factory; `showExtensionCustom`'s `close()` then calls `this.ui.hideOverlay()`, which removes the entry, restores focus to whatever had it before, and requests a render. The editor (text, cursor) is never touched by this path, so it is untouched on return.
- **`ctx.ui.custom()` without overlay (the editor-slot swap).** Same API, no `overlay` option. `showExtensionCustom`'s non-overlay branch instead does `this.editorContainer.clear(); this.editorContainer.addChild(component); this.ui.setFocus(component);` (interactive-mode.js ~L2288-2293), i.e. it swaps the component into pi's fixed editor slot only. The chat/transcript above stays visible in both tuiModes (in fullscreen tuiMode the shared `createChatViewport` layout, dist/modes/interactive/chat-viewport.d.ts, keeps the transcript `ScrollView` and the input dock as separate regions; only the dock swaps). This is `examples/extensions/snake.ts`'s mechanism. It is not a full-screen replacement, kept here only as the contrasting, known-partial mechanism.
- **tuiMode itself.** `InteractiveTuiOptions.tuiMode: "regular" | "fullscreen"` (dist/modes/interactive/tui-renderer.d.ts) selects `TuiMainScreen` (regular; ordinary terminal print plus real scrollback) or `TuiAltScreen` (fullscreen; pi-tui's own alternate-screen, application-owned viewport with its own scrolling, entered/exited by the terminal wrapper around TUI start/stop). Setting: `SettingsManager.getTuiMode()/setTuiMode()` (dist/core/settings-manager.d.ts), exposed to the user as the "TUI mode" row in `/settings` (dist/modes/interactive/components/settings-selector.js ~L473, handled in interactive-mode.js's `onTuiModeChange`, which calls the internal `switchTuiMode`). CLI flag: `--tui-mode regular|fullscreen` (dist/cli/args.js ~L195; default regular). Nothing on `ExtensionContext` lets an extension switch tuiMode itself; `switchTuiMode` is internal to `InteractiveMode` and, notably, refuses to switch while any overlay is open (`if (previousUi.hasOverlayEntries) return false;`), so our overlay and a live tuiMode switch cannot collide.
- **pi-tui's `TuiAltScreen`/`ViewportTUI.setLayoutRoot` directly.** In fullscreen tuiMode the `tui` an extension's `ctx.ui.custom` factory receives is a `ViewportTUI` (`isViewportTUI(tui)` true), which exposes `setLayoutRoot(component)`. This is the same call `switchTuiMode` uses internally to mount pi's own transcript+editor layout. In principle an extension could call this directly for a "true" full replacement, bypassing the editor-slot swap entirely. Not attempted live: there is no getter for the current layout root anywhere on `TUI`/`ViewportTUI` or `ExtensionContext`, so there is no supported way to save it before swapping and restore it after, only `undefined`. Noted as an unsafe path, not used.

### Expectation per tuiMode

- **Regular tuiMode, overlay mechanism (primary candidate):** expected to work cleanly. `TuiMainScreen` never touches the terminal's real alternate screen; it is a plain differential printer over the terminal's own scrollback. The overlay composites only over the currently-rendered viewport lines and is never written to the terminal as new scrollback content; closing it triggers an ordinary re-render of the untouched underlying tree. Expect: scrollback (real terminal history above the current viewport) intact, editor text and cursor untouched (editorContainer was never touched by this path), no leftover lines, a live-resize picked up because the component reads `tui.terminal.rows` on every render.
- **Fullscreen tuiMode, overlay mechanism:** expected to work identically; `TuiAltScreen` already owns the terminal's real alternate screen for the whole pi session, and the same `compositeOverlays` code runs. Expect: on leaving, the fullscreen transcript `ScrollView` and its scroll position, and the editor dock, reappear exactly as before, since the overlay never altered them.
- **Both tuiModes, editor-slot swap (contrast mechanism):** expected to only ever cover the input dock (fullscreen) or push new printed lines below the existing chat (regular), i.e. visibly NOT a full-screen replacement. In regular tuiMode specifically, since this path uses ordinary terminal printing (not overlay compositing), a long-running growing component here could in principle push real content further into terminal scrollback than the overlay mechanism ever would; this is the concrete risk the overlay mechanism avoids.
- **Not attempted:** directly driving `TuiAltScreen`/`setLayoutRoot` from an extension (see above); left for a real implementation only if the overlay mechanism turns out to be unsuitable.

### Try-out steps

Scratch extension: `scratch/alt-screen-spike/extension.ts` (not in package.json's `pi.extensions`; loaded only via `--extension`). It registers:
- `/spike-transcript-overlay` (also bound to `alt+t`): the full-screen overlay mechanism.
- `/spike-transcript-editor`: the editor-slot swap, for contrast.

Both show a fake transcript that grows one line every 300 ms, follows the end until scrolled, and takes PageUp/PageDown/Home/End to scroll and Escape to leave.

1. Start pi with the spike loaded, regular tuiMode (default):
   ```
   pi --extension scratch/alt-screen-spike/extension.ts
   ```
2. Type a message or two first (so there is real scrollback and editor history to check afterwards), then run `/spike-transcript-overlay` (or press `alt+t`). Watch it for a few seconds so lines accumulate, try PageUp/PageDown/Home/End, then press Escape.
3. Repeat step 2 with `/spike-transcript-editor` instead, to see the contrast (chat history stays visible above it; not a full-screen replacement).
4. Restart with fullscreen tuiMode and repeat steps 2 and 3:
   ```
   pi --extension scratch/alt-screen-spike/extension.ts --tui-mode fullscreen
   ```
   (or toggle "TUI mode" to fullscreen from `/settings` in a regular-mode session already running the spike).

Checklist after leaving each time:
- [ ] Scrollback intact: earlier turns (and, in fullscreen tuiMode, the transcript scroll position) are exactly as they were, nothing missing or duplicated.
- [ ] Cursor position correct and visible where the editor left it.
- [ ] Editor text and cursor preserved: type some text into the editor *before* opening the spike, confirm it, and the cursor position within it, are unchanged after Escape.
- [ ] No leftover lines: no stray fragments of the fake transcript remain on screen after leaving.
- [ ] Resize while open: resize the terminal window while the spike is showing; it should redraw at the new size without artifacts (only the overlay mechanism is expected to fill exactly the new size).
- [ ] A pi message arriving while open: send a message to the orchestrator from another pane/session sharing the same session file, or simply note whether anything from the live pi session bleeds through or corrupts the spike's rendering while it is open.

Both todos below are left unchecked and no `## Answer` section is written: the orchestrator records the answer once these steps are tried live.
