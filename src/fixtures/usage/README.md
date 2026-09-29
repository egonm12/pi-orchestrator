# Usage fixtures

These fixtures hold real quota headers of Anthropic and OpenAI Codex, captured with the live check in [`src/live-check/quota-capture.md`](../../live-check/quota-capture.md) (bean `pi-orchestrator-ugoi`). Ticket 13 (bean `pi-orchestrator-pus9`, reading quota headers) tests against them.

Ticket 12 stays open for the limit cases it has not observed. Its captured 200 responses are enough for ticket 13's success-header reading and nothing more: the header reader reads a 2xx response's utilization or used-percent and reset headers only, and interprets no `*-status` header and no non-2xx response, because no limit response has been captured. Those wait for ticket 12's limit captures.

No data here is written by hand. Every capture record is a line from a real capture, sanitized as described under "Redaction exceptions". The captures were agent-run at the owner's request on 2026-09-29 with pi 0.87.1 (not the owner's own run). At the owner's request only the installed-extension Anthropic path was captured. Plain pi (`-ne`), the TUI warning step and the extra-usage cases were skipped. The `session-errors/` files are the exception to the capture format: their error texts come from pi session logs, and only their `redactions` and `uncertainty` notes are written by hand.

## Layout

One JSONL file per captured case, under the provider's name:

```
src/fixtures/usage/
  anthropic/
    shaped-ok.jsonl          # installed packages, Claude subscription, claude-haiku-4-5
  openai-codex/
    websocket-ok.jsonl       # transport auto (WebSocket), gpt-5.5
    sse-ok.jsonl             # transport sse, gpt-5.5
  session-errors/            # not capture records, see "Session errors" below
    anthropic-rate-limit-error.json
    openai-codex-usage-limit-error.json
```

A file name is the capture's case name without its provider prefix (`anthropic-shaped-ok.jsonl` becomes `anthropic/shaped-ok.jsonl`, `codex-sse-ok.jsonl` becomes `openai-codex/sse-ok.jsonl`). Only captured cases get a file. A case that never happened has no file, and the path matrix below says so.

## Format

The capture's JSONL records, version 1: `session`, `request`, `response` and `result`. [`quota-capture.md`](../../live-check/quota-capture.md) describes their fields. Record order, record count, every field name, every header name, every status, every quota header value and every timestamp are as captured.

A test reads a file line by line with `JSON.parse`. It passes the `headers` of each `response` record to the header reader, and the `errorMessage` of each `result` record to the error-text classifier. No capture fixture has a `result` record with an `errorMessage` yet. The only real limit error texts are the session errors below.

### Redaction exceptions

The records are the capture's v1 records unchanged, except for these fields, which identify the owner's account, process or a single request. Everything else is byte-for-byte what the capture wrote, after a JSON round trip.

| Field | Where | Replaced with |
|-------|-------|---------------|
| `sessionId` | every record | `session-<capture case>`, for example `session-anthropic-shaped-ok` |
| `pid` | `session` record | `0` |
| `anthropic-organization-id` | Anthropic response headers | `[redacted]` |
| `anthropic-workspace-id` | Anthropic response headers | `[redacted]` |
| `request-id` | Anthropic response headers | `[redacted]` |
| `traceresponse` | Anthropic response headers | `[redacted]` |
| `x-oai-request-id` | Codex response headers | `[redacted]` |
| `x-codex-turn-state` | Codex response headers (opaque encrypted token) | `[redacted]` |
| `cf-ray` | both providers' response headers | `[redacted]` |
| `report-to` | Codex response headers (Cloudflare reporting URL with a signed token) | `[redacted]` |

`set-cookie` was already `[redacted]` by the capture. No quota header was changed.

## Session errors

`session-errors/` holds real limit error texts taken from assistant messages in local pi session logs (`~/.pi/agent/sessions`), found by timestamp and provider on 2026-09-29. These files are separate from the capture's v1 JSONL. They are single JSON objects, not capture records, and have none of the capture's `request`, `response` or `result` detail.

Each file holds only `provider`, `timestamp` (the session entry's own), `stopReason`, `errorMessage` (redacted), `provenance` (`pi session assistant message`), `redactions` and `uncertainty` notes. Neither has a routed model: both entries come from worker sessions whose recorded model is `orchestrator/auto`, and the session does not record the rung. The provider is attributed from the error text. No HTTP status, response count, headers, reset time or transport is recorded or claimed. The leading `429` in the Anthropic file is part of the error text as pi recorded it. The only redaction is the Anthropic `request_id` value, which becomes `[redacted]`.

| File | Provider | Timestamp | Error text (redacted) |
|------|----------|-----------|-----------------------|
| `anthropic-rate-limit-error.json` | anthropic | 2026-09-28T15:50:54.413Z | `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"[redacted]"}` |
| `openai-codex-usage-limit-error.json` | openai-codex | 2026-09-28T19:29:36.088Z | `Codex error: The usage limit has been reached` |

`src/router/limit-errors.test.ts` passes each text to the error-text classifier.

## Path matrix

| Provider | Path | Fixture | `after_provider_response` fires | Quota headers seen | Limit error text |
|----------|------|---------|---------------------------------|--------------------|------------------|
| Anthropic | shaped (installed packages, `@gotgenes/pi-anthropic-auth`) | `anthropic/shaped-ok.jsonl` | yes, once, status 200 | yes, `anthropic-ratelimit-unified-*` | not captured by the live check. The session-log Anthropic 429 `rate_limit_error` text in `session-errors/` has no recorded path, so it is not tied to this one |
| Anthropic | plain pi (`-ne`, extra usage) | none | skipped at owner request | skipped at owner request | skipped at owner request |
| Anthropic | extra usage switched off (shaped or plain) | none | skipped at owner request | skipped at owner request | skipped at owner request |
| OpenAI Codex | WebSocket (`transport` auto) | `openai-codex/websocket-ok.jsonl` | no: no `response` record, `result.responses` is 0 | none, the path exposes no headers | not captured by the live check. The session-log Codex text in `session-errors/` has no recorded transport, so it is not tied to this path |
| OpenAI Codex | SSE (`transport` sse) | `openai-codex/sse-ok.jsonl` | yes, once, status 200 | yes, `x-codex-*` | not captured by the live check. The session-log Codex text in `session-errors/` has no recorded transport, so an SSE 429 remains unverified |

## Findings

### Anthropic, shaped path

One request, one `response` record (status 200), one `result` with `stopReason` `stop` and `responses` 1. The quota headers, as captured:

| Header | Value | Meaning |
|--------|-------|---------|
| `anthropic-ratelimit-unified-status` | `allowed` | overall state |
| `anthropic-ratelimit-unified-reset` | `1790682600` | Unix seconds, 2026-09-29T11:50:00Z, same as the 5-hour reset |
| `anthropic-ratelimit-unified-representative-claim` | `five_hour` | the window that currently decides the overall state |
| `anthropic-ratelimit-unified-5h-status` | `allowed` | |
| `anthropic-ratelimit-unified-5h-utilization` | `0.05` | a fraction used (5%), not a percentage |
| `anthropic-ratelimit-unified-5h-reset` | `1790682600` | Unix seconds |
| `anthropic-ratelimit-unified-7d-status` | `allowed` | |
| `anthropic-ratelimit-unified-7d-utilization` | `0.39` | fraction used (39%) |
| `anthropic-ratelimit-unified-7d-reset` | `1791086400` | Unix seconds, 2026-10-04T04:00:00Z |
| `anthropic-ratelimit-unified-fallback-percentage` | `0.5` | not interpreted yet |
| `anthropic-ratelimit-unified-overage-status` | `rejected` | extra usage (overage) is not available to this account |
| `anthropic-ratelimit-unified-overage-disabled-reason` | `org_level_disabled` | why overage is rejected |

There are no `anthropic-ratelimit-tokens-*` or `anthropic-ratelimit-requests-*` headers on this path. The response's `content-type` is `text/event-stream`.

### OpenAI Codex, WebSocket path

One request, no `response` record, one `result` with `stopReason` `stop` and `responses` 0. This confirms what the pi 0.87.1 source suggested: `after_provider_response` never fires on the WebSocket path, so it gives no quota headers. On this path the only usage signal is error text.

### OpenAI Codex, SSE path

One request, one `response` record (status 200), one `result` with `stopReason` `stop` and `responses` 1. `responseModel` is `null`. The quota headers, as captured:

| Header | Value | Meaning |
|--------|-------|---------|
| `x-codex-plan-type` | `plus` | |
| `x-codex-active-limit` | `premium` | |
| `x-codex-primary-used-percent` | `2` | a percentage used, not a fraction |
| `x-codex-primary-window-minutes` | `300` | 5-hour window |
| `x-codex-primary-reset-at` | `1790687649` | Unix seconds, 2026-09-29T13:14:09Z |
| `x-codex-primary-reset-after-seconds` | `17871` | agrees with `reset-at` against the `date` header |
| `x-codex-secondary-used-percent` | `37` | percentage used |
| `x-codex-secondary-window-minutes` | `10080` | 7-day window |
| `x-codex-secondary-reset-at` | `1791193637` | Unix seconds, 2026-10-05T09:47:17Z |
| `x-codex-secondary-reset-after-seconds` | `523859` | agrees with `reset-at` |
| `x-codex-primary-over-secondary-limit-percent` | `0` | not interpreted yet |
| `x-codex-credits-has-credits` | `False` | capitalised string |
| `x-codex-credits-unlimited` | `False` | capitalised string |
| `x-codex-credits-balance` | `0` | |

### Units differ between providers

Anthropic sends utilization as a fraction (`0.05`). Codex sends used percent as a whole number (`2`). Both send resets as Unix seconds. A header reader must convert both to the same "percentage left".

## Not captured

These cases have no fixture. Do not add hand-written data for them.

- **Limit errors in the live check.** No usage limit or rate limit was hit during the capture, so there is no capture `result` record with an `errorMessage` and no non-2xx `response` record. Two real error texts from session logs are in `session-errors/`, but they carry no HTTP status, headers, response count, reset time or transport, so they confirm neither of these expectations. The Anthropic expectation from the pi source (a limit arrives as error text with no `response` record, because the SDK throws on a non-2xx first) and the Codex SSE expectation (`after_provider_response` fires for a 429 too) are still unconfirmed.
- **Headers near or at a limit.** Every captured status is `allowed`, and usage was low (Anthropic 5%/39%, Codex 2%/37%). Values such as a non-`allowed` status, a `seven_day` representative claim, or utilization at 1 have not been seen.
- **Reset times for a limit.** Neither session error text states a reset, and no limit response header has been seen.
- **Anthropic plain pi and extra usage.** Plain pi (`-ne`), the TUI warning, and extra usage switched on or off were skipped at the owner's request. The shaped path reports `overage-status` `rejected` with `org_level_disabled`, but how the extra-usage path behaves is unknown.
