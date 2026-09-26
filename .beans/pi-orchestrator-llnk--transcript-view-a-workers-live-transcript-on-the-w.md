---
# pi-orchestrator-llnk
title: 'Transcript view: a worker''s live transcript on the whole screen'
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T10:45:44Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-rcjm
    - pi-orchestrator-2jba
---

Shows one worker's transcript on the whole screen with the mechanism the spike chose, and restores the orchestrator session on Esc. Reuses pi's message rendering (thinking, tool calls and results, the tool-output expand toggle); reports and steers are marked messages. Live: follows the end until the user scrolls (PgUp, PgDn, Home, End; End follows again). Left and right switch to the previous or next worker; Enter on a nested worker's line opens it; x stops the worker after a confirmation. Read-only otherwise. A finished worker's transcript stays open; finished workers are read from their session file.

## Todo
- [x] Test: opens and restores the orchestrator session
- [x] Test: live updates, follow and scroll
- [x] Test: switching workers and opening a nested worker
- [x] Test: x stops after confirmation
- [x] Test: a finished worker's transcript from its session file
- [x] README

## Summary of Changes

- `src/subagents/transcript-view.ts` (new): the view. `openTranscript(ui, board, workerId, options?)` is the entry point for xytd. It opens `ctx.ui.custom` as a full-screen overlay (`TRANSCRIPT_OVERLAY`: 100% by 100%, top-left, no margin), resolves when the user leaves, and throws for an unknown worker id. `TranscriptView` is the component. It takes `TranscriptViewTui` (`terminal.rows`, `requestRender`), a theme, `TranscriptKeys` (pi's keybindings manager), a `TranscriptBoard` (`WorkerBoardView` plus `stop`), the worker id, a close callback and `TranscriptViewOptions` (`cwd`, `header`, `bar`, `expanded`, `now`, `readSession`). It draws in slots, top to bottom: bar, header, the worker's nested workers, the transcript and a footer. For vo0z: `header` and `bar` are `TranscriptSlot = (frame: TranscriptFrame) => readonly string[]`, where `TranscriptFrame` holds `worker`, `position`, `count`, `now`, `theme` and `width`. The default header is `transcriptHeader`, one line: agent, worker state and "worker N of M". The default bar is none. The view cuts slot lines to the width and sizes itself from `tui.terminal.rows` on every render. It has no timer yet; a live header with elapsed time would add one.
- `src/subagents/transcript.ts` (new): `Transcript` feeds a worker's messages into pi's own components, the way pi's interactive mode feeds its chat. It uses `AssistantMessageComponent`, `ToolExecutionComponent` (by tool call id, from the streaming reply to the saved one), `UserMessageComponent`, `CustomMessageComponent`, the summary components and `BashExecutionComponent`. It follows live session events for the streaming reply and running tools, and honours the expand toggle (ctrl+o, `app.tools.expand`). `userMessageKinds` tells the task prompt from steers and follow-ups. The first user message with one of the delegation's tasks is the prompt: a resume's task is a new board entry with the same delegation id. After it, a message following a tool result is a steer, any other a follow-up. A fork's copied conversation before the prompt is left unmarked. Steers and follow-ups get a `▸ Steer from the orchestrator` or `▸ Follow-up from the orchestrator` line. `report` calls get their own renderers, `◆ Report: progress` or `◆ Report: question` with the text, and the answer for a question. `readWorkerTranscript(file)` parses the session file and builds its context in memory. It never uses `SessionManager.open`, which may write (a migration, an empty file's header).
- `src/subagents/worker-board.ts`: `add(setup, control?)` takes a `WorkerControl { stop }`. `stop(id)` calls it for an unfinished worker and says whether it did. `unsavedMessages(id)` keeps a finished worker's last messages when nothing was saved on disk. `WorkerSession` and `LiveWorker` carry `toolDefinition`, which `worker.ts` fills from `session.getToolDefinition`. `hasEnded(worker)` is exported.
- `src/subagents/extension.ts`: every item gets its own AbortController, combined with the call's or the background call's signal, and the board gets its stop. A running worker aborts. A queued item ends at once as not started, aborted on the board, and never starts in a freed slot. A nested worker's stop leaves its parent running, which hears "aborted" as its tool result. The not-started result is shared with the call's end.
- `src/subagents/worker-widget.ts`: `agentLabel` and `STATE_COLOR` are exported for the header. `src/subagents/render.ts`: `textComponent` is exported for the report renderers.
- Decisions:
  - Finished in-memory workers: when the orchestrator's session is not saved, no worker session is either, so the board keeps a finished worker's last messages (`unsavedMessages`) and the view shows them. A saved worker whose file cannot be read shows why.
  - A worker that finishes while shown keeps its live transcript. It is not reread from the file, so extension tools keep their own renderers.
  - "Enter on a nested worker's line": the worker's nested workers are listed under the header, one widget line each. ↑ and ↓ select one, and Enter opens it. Esc always goes back to the orchestrator's session, not to the parent.
  - Paging back down to the end with PgDn follows again, as End does.
  - x asks "Stop this worker? y/n". Only y stops, and any other key, Esc included, only dismisses the question, so a second Esc leaves. x on a finished worker says it has already finished.
  - Left and right stop at the first and last worker instead of wrapping around.
  - When a transcript is dropped (switch or close), a tool still running gets an empty final result. pi's bash renderer ticks elapsed time on a timer that only a final result stops.
- Gaps, where the extension cannot get what pi's chat uses: a custom message's own renderer, registered in the worker's session, is out of reach, so custom messages such as a nested worker's `subagents-report` get pi's default drawing. pi's markdown transformers, the hide-thinking setting and image settings are not applied. In a finished worker's transcript read from its file, only pi's built-in tools, `subagents` and `report` keep their renderers; other extension tools fall back to pi's plain drawing.
- Tests: 7 in transcript-view.test.ts (open and restore with Esc, kitty Esc and ctrl+c, fit and resize; live follow and scroll; pi rendering with marked reports, steers and follow-ups and the expand toggle; switching and nested Enter; x with confirmation; finished from a session file, unsaved and unreadable; finishing while shown and a queued worker starting). 2 in worker-board.test.ts (stop, unsaved messages). 2 end to end in extension.test.ts: x stops one running foreground worker and a queued one while the other runs on, and x stops a nested worker alone. The view tests use pi's real keybindings manager through a deep import, since the public entry exports only its type.
- README.md: a Transcript view section under the subagents tool.
