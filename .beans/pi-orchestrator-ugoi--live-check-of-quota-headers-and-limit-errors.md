---
# pi-orchestrator-ugoi
title: Live check of quota headers and limit errors
status: in-progress
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-29T08:43:28Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user story 55).

## What to build

A live check that records the real quota headers (through `after_provider_response`) and limit errors of both providers, Anthropic and OpenAI Codex, including Claude's extra-usage case when used from a third-party harness and Codex's WebSocket path. The agent prepares the script and instructions; the owner runs it. The captured headers and errors are stored as fixtures for ticket 13.

## Acceptance criteria

- [x] Live check script and instructions prepared
- [x] Owner has run it for both providers (agent-run at owner request on 2026-09-29, normal cases only: Anthropic shaped path, Codex WebSocket and SSE. Anthropic plain pi, TUI warning and extra-usage steps skipped at owner request)
- [ ] Captured headers and limit errors stored as fixtures, with notes on which paths expose headers (headers and path notes done, agent-run at owner request; limit errors still open, none observed)
- [x] Findings recorded in this bean (for the captured normal cases)

## Blocked by

None, can start immediately.

## Prepared, waiting for the owner's run

The capture tool and instructions are ready. The remaining criteria wait for the owner to run the check and hand back the output. No results are recorded yet.

- **Tool:** `src/live-check/quota-capture.ts`, a pi extension loaded with `pi -e`. It writes JSONL records: `session`, `request` (session model and payload model, never the payload), `response` (from `after_provider_response`: the request in flight, attempt, HTTP status, every header) and `result` (from each assistant `message_end`: stop reason, full error text, diagnostics, response count). Cookie and credential header values, bearer tokens, `sk-` keys and JWTs are redacted. Unit test: `src/live-check/quota-capture.test.ts`.
- **Instructions:** `src/live-check/quota-capture.md`. Each case writes to `~/quota-capture/<case>.jsonl` through `PI_QUOTA_CAPTURE_FILE`. Without it, the file lands in `<state dir>/live-check/quota-capture-<time>-<pid>.jsonl`.
  - Anthropic: the shaped path with installed packages (`@gotgenes/pi-anthropic-auth` is installed), and plain pi with `-ne`, which is the third-party-harness case pi warns about ("draws from extra usage and is billed per token"). There is also a TUI step to note the warning, and an optional step with extra usage switched off at claude.ai/settings/usage.
  - OpenAI Codex: the WebSocket path (`transport` auto) and the SSE path (`transport` sse through `/settings`, set back to auto afterwards).
  - Limits: a limit cannot be triggered on demand. Run the limit cases when near or at a limit, or load the capture in daily sessions with an alias until one hits. Otherwise hand back the normal captures only.
  - Hand-back: a leak check with grep, a tar of `~/quota-capture`, and a note with the pi version, plans, extra-usage state and spend, the warning, and the limit and reset times.
- **Fixtures:** `src/fixtures/usage/README.md` sets the layout `<provider>/<case>.jsonl` (the capture's v1 records, unchanged) and a notes table on which paths expose headers. Filled on 2026-09-29 with the captured normal cases (see Summary).
- **Read from pi 0.87.1 source, still to be confirmed live:** Anthropic calls `after_provider_response` only for successful responses, because the SDK throws on a non-2xx first. So a limit is expected as error text with no response record. Codex's WebSocket path never calls it, and its SSE path calls it for every attempt, including a 429. The event carries no model, so the capture ties each response to the latest request of the same session.

## Summary

Captures were agent-run at the owner's request on 2026-09-29 with pi 0.87.1, not by the owner. At the owner's request only the installed-extension Anthropic path is in scope. Plain pi (`-ne`), the TUI warning step and the extra-usage cases were skipped. No limit was hit, so no limit error was captured.

- **Fixtures:** `src/fixtures/usage/anthropic/shaped-ok.jsonl`, `src/fixtures/usage/openai-codex/websocket-ok.jsonl`, `src/fixtures/usage/openai-codex/sse-ok.jsonl`. These are the v1 records from `~/quota-capture/`, unchanged except for the redaction exceptions listed in `src/fixtures/usage/README.md`: `sessionId` becomes a placeholder, `pid` becomes 0, and the organization, workspace and request IDs, `traceresponse`, `cf-ray`, `x-codex-turn-state` and `report-to` become `[redacted]`. No quota header was changed.
- **Anthropic, shaped:** `after_provider_response` fires (status 200). Quota headers are `anthropic-ratelimit-unified-*`: overall, 5h and 7d `status`/`utilization`/`reset`, plus `representative-claim` (`five_hour`), `fallback-percentage`, `overage-status` (`rejected`) and `overage-disabled-reason` (`org_level_disabled`). Utilization is a fraction (`0.05`), and reset is in Unix seconds. There are no `ratelimit-tokens-*`/`requests-*` headers.
- **Codex, WebSocket:** confirmed that `after_provider_response` never fires (no response record, `responses` 0), so this path has no headers.
- **Codex, SSE:** `after_provider_response` fires (status 200). Quota headers are `x-codex-*`: primary (300 min) and secondary (10080 min) `used-percent`, `window-minutes`, `reset-at` and `reset-after-seconds`, plus `plan-type`, `active-limit` and `credits-*`. Used percent is a whole number (`2`), and reset is in Unix seconds.
- **Still open:** limit errors on every path (no 429, no error text), headers near or at a limit, the Anthropic plain and extra-usage paths. The expectations from the pi source for limits remain unconfirmed.

## Why this stays in progress

The limit-error half of the fixture criterion is not met, because no limit was observed and no error data is invented. The parent story 55 (`pi-orchestrator-cml8`) also asks explicitly for "Claude's extra-usage case", which the owner chose to skip. Completing this bean would claim story 55 is covered when it isn't. It should close only once limit errors are captured and the owner decides whether the extra-usage case is still required or dropped from story 55.
