---
# pi-orchestrator-8ftz
title: Worker reporting rules and Result header check
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:34:32Z
parent: pi-orchestrator-3p1z
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. Every non-fork worker gets the reporting rules in its system prompt, whatever its agent definition says: verify before reporting; give file:line for every factual claim; label unverified claims; say what could not be checked and why; do only what the task asks. Its Result has five sections: Confirmed, Changed, Unverified, Could not check, Verified by (the commands it ran).

When a worker finishes, the runtime checks the Result's section headers without a model call. A missing section adds a note to that worker's part of the subagents tool result. It never rejects.

## Acceptance criteria

- [x] A worker with no agent definition and one with an agent definition both get the rules; the definition's instructions still follow
- [x] A forked worker does not get them
- [x] A Result missing one or more sections gets a note naming them; a complete Result gets none
- [x] Tests

## Blocked by

None, can start immediately.

## Summary of Changes

- New `src/subagents/result-format.ts`: the reporting rules and five-section Result format (`REPORTING_RULES`, `RESULT_SECTIONS`), the header check `missingResultSections` (markdown heading or bold label starting with a section name, or a plain line of the name alone or with a colon; no model call) and the note text `missingSectionsNote`.
- `src/subagents/worker.ts`: every non-fork worker (fresh, resumed or nested) gets the reporting rules appended to its system prompt before any agent definition's instructions; a fork, resumed or not, gets none. A completed non-fork worker's final text is checked, and `WorkerResult.missingSections` lists the missing sections.
- `src/subagents/extension.ts`: `resultText()` appends the note after the worker's text when sections are missing, so foreground results and background completion notices carry it. The status never changes.
- Tests: three integration tests in `src/subagents/extension.test.ts` (rules with and without a definition and on resume, fork and resumed fork without rules, note on a partial Result and none on a complete one) and unit tests in `src/subagents/result-format.test.ts`.
- README: new Results section, plus notes in the fork and agent definitions paragraphs.
- Only completed workers are checked; failed and aborted ones get no note.


Orchestrator verdict: accepted. Only completed workers are checked; failed and aborted workers have no Result to check. The TUI draws finalText without the note, which is fine: the note is for the orchestrator's tool result.
