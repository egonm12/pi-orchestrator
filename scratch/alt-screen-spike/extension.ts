/**
 * Alt-screen spike, bean pi-orchestrator-rcjm.
 *
 * Throwaway prototype, not shipped (not listed in package.json's pi.extensions).
 * Question: can an extension show a component that replaces the whole screen
 * from regular tuiMode (via ctx.ui.custom), and return to the orchestrator
 * session exactly as it was, with no broken scrollback, cursor or editor
 * state? Also tried in fullscreen tuiMode.
 *
 * Load it with:
 *   pi --extension scratch/alt-screen-spike/extension.ts
 * (regular tuiMode is the default; add --tui-mode fullscreen to try the other)
 *
 * Two commands offer the two candidate mechanisms so they can be compared
 * side by side:
 *
 * - /spike-transcript-overlay (also bound to alt+t): ctx.ui.custom with
 *   `overlay: true` and overlayOptions sized to 100% width and height. This
 *   composites the component over the whole current viewport through
 *   pi-tui's overlay stack (TuiBase.showOverlay / compositeOverlays), the
 *   same mechanism used by every full-width dialog pi itself shows. It never
 *   touches the terminal's real alternate screen in regular tuiMode; it
 *   fills the visible viewport with a floating layer instead. This is the
 *   primary candidate.
 *
 * - /spike-transcript-editor: ctx.ui.custom with no options. Internally this
 *   swaps the component into pi's editor slot only (see
 *   InteractiveMode.showExtensionCustom in dist/modes/interactive/
 *   interactive-mode.js), so the transcript above (regular tuiMode) or the
 *   scroll view above (fullscreen tuiMode) stays visible. It does not
 *   replace the whole screen; kept here as the contrasting, known-partial
 *   mechanism.
 *
 * Both commands share one component: a fake transcript that grows one line
 * every 300 ms, follows the end until scrolled, and supports PageUp/
 * PageDown/Home/End to scroll and Escape to leave.
 *
 * Key matching here is hand-rolled (plain VT/xterm escape sequences), not
 * pi-tui's matchesKey: pi-tui is a nested dependency of
 * @earendil-works/pi-coding-agent (not hoisted to this project's own
 * node_modules, see src/subagents/render.ts's own note on this), and
 * pi-coding-agent's public entry point does not re-export it. Fine for a
 * throwaway spike; a shipped version would want that helper exposed.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

const TICK_MS = 300;
const MAX_LINES = 2000;

/** Which candidate mechanism opened the component, shown in its header. */
type Mechanism = "full-screen overlay (ctx.ui.custom, overlay: true, 100%x100%)" | "editor-slot swap (ctx.ui.custom, no overlay)";

/** The bits of pi-tui's TUI this component actually needs. */
interface SpikeTui {
  requestRender(): void;
  readonly mode: string;
  readonly terminal: { readonly rows: number };
}

function isEscape(data: string): boolean {
  return data === "\x1b";
}
function isPageUp(data: string): boolean {
  return data === "\x1b[5~";
}
function isPageDown(data: string): boolean {
  return data === "\x1b[6~";
}
function isHome(data: string): boolean {
  return data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH";
}
function isEnd(data: string): boolean {
  return data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF";
}

/** A fake, ever-growing transcript. Surfaces its own state (mechanism, tuiMode,
 *  line count, follow/scroll state) in its header so a tester can see at a
 *  glance what they are looking at. */
class TranscriptSpikeComponent {
  private lines: string[] = [];
  private scrollOffset = 0;
  private followEnd = true;
  private tickCount = 0;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: SpikeTui,
    private readonly theme: Theme,
    private readonly mechanism: Mechanism,
    private readonly done: (result: undefined) => void,
  ) {
    this.lines.push(`spike started, mechanism: ${mechanism}, tuiMode: ${tui.mode}`);
    this.timer = setInterval(() => {
      if (this.lines.length >= MAX_LINES) return;
      this.tickCount += 1;
      this.lines.push(`[${new Date().toLocaleTimeString()}] fake transcript line ${this.tickCount}`);
      if (this.followEnd) this.scrollOffset = 0;
      this.tui.requestRender();
    }, TICK_MS);
  }

  private viewportHeight(): number {
    return Math.max(5, this.tui.terminal.rows - 3);
  }

  private maxScrollOffset(height: number): number {
    return Math.max(0, this.lines.length - height);
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.dispose();
      this.done(undefined);
      return;
    }
    const height = this.viewportHeight();
    if (isPageUp(data)) {
      this.scrollOffset = Math.min(this.maxScrollOffset(height), this.scrollOffset + height);
      this.followEnd = this.scrollOffset === 0;
    } else if (isPageDown(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - height);
      this.followEnd = this.scrollOffset === 0;
    } else if (isHome(data)) {
      this.scrollOffset = this.maxScrollOffset(height);
      this.followEnd = false;
    } else if (isEnd(data)) {
      this.scrollOffset = 0;
      this.followEnd = true;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    // pi-tui's regular screen throws on a line wider than the terminal; the
    // overlay path cuts lines itself, the editor-slot path does not. All text
    // here is single-width, so cutting the plain text before styling is enough.
    const fit = (text: string) => (text.length > width ? text.slice(0, Math.max(0, width)) : text);
    const height = this.viewportHeight();
    const max = this.maxScrollOffset(height);
    if (this.scrollOffset > max) this.scrollOffset = max;
    const start = Math.max(0, this.lines.length - height - this.scrollOffset);
    const visible = this.lines.slice(start, start + height);
    const th = this.theme;
    const status = this.followEnd ? "following end" : `scrolled, −${this.scrollOffset} from end`;

    const out: string[] = [
      th.fg("accent", fit(`── alt-screen spike (rcjm) ── ${this.mechanism} ── tuiMode: ${this.tui.mode} ──`)),
      th.fg("dim", fit(`${this.lines.length} lines, ${status}`)),
      "",
      ...visible.map(fit),
    ];
    while (out.length < height + 3) out.push("");
    out.push(th.fg("dim", fit("PgUp/PgDn scroll · Home/End jump · Esc leave (should restore the orchestrator session)")));
    return out;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
  }
}

function registerSpikeCommand(pi: ExtensionAPI, name: string, description: string, mechanism: Mechanism, overlay: boolean): void {
  pi.registerCommand(name, {
    description,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("This spike requires interactive (tui) mode", "error");
        return;
      }
      await ctx.ui.custom<undefined>(
        (tui, theme, _keybindings, done) => new TranscriptSpikeComponent(tui, theme, mechanism, done),
        overlay ? { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } } : undefined,
      );
      ctx.ui.notify(`Left /${name}`, "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSpikeCommand(
    pi,
    "spike-transcript-overlay",
    "Spike (rcjm): full-screen transcript via a 100%x100% ctx.ui.custom overlay",
    "full-screen overlay (ctx.ui.custom, overlay: true, 100%x100%)",
    true,
  );
  registerSpikeCommand(
    pi,
    "spike-transcript-editor",
    "Spike (rcjm), contrast mechanism: ctx.ui.custom without overlay (editor-slot swap only)",
    "editor-slot swap (ctx.ui.custom, no overlay)",
    false,
  );

  pi.registerShortcut("alt+t", {
    description: "Spike (rcjm): open the full-screen transcript overlay",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      await ctx.ui.custom<undefined>(
        (tui, theme, _keybindings, done) =>
          new TranscriptSpikeComponent(tui, theme, "full-screen overlay (ctx.ui.custom, overlay: true, 100%x100%)", done),
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
      );
    },
  });
}
