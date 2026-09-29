# Usage fixtures

These fixtures hold real quota headers of Anthropic and OpenAI Codex, captured with the live check in [`src/live-check/quota-capture.md`](../../live-check/quota-capture.md) (bean `pi-orchestrator-ugoi`). Ticket 13 (bean `pi-orchestrator-pus9`, reading quota headers) tests against them.

Nothing here is written by hand. Every record is a line from a real capture, sanitized as described under "Redaction exceptions". The captures were agent-run at the owner's request on 2026-09-29 with pi 0.87.1 (not the owner's own run). At the owner's request only the installed-extension Anthropic path was captured. Plain pi (`-ne`), the TUI warning step and the extra-usage cases were skipped.

## Layout

One JSONL file per captured case, under the provider's name:

```
src/fixtures/usage/
  anthropic/
    shaped-ok.jsonl          # installed packages, Claude subscription, claude-haiku-4-5
  openai-codex/
    websocket-ok.jsonl       # transport auto (WebSocket), gpt-5.5
    sse-ok.jsonl             # transport sse, gpt-5.5
```

A file name is the capture's case name without its provider prefix (`anthropic-shaped-ok.jsonl` becomes `anthropic/shaped-ok.jsonl`, `codex-sse-ok.jsonl` becomes `openai-codex/sse-ok.jsonl`). Only captured cases get a file. A case that never happened has no file, and the path matrix below says so.

## Format

The capture's JSONL records, version 1: `session`, `request`, `response` and `result`. [`quota-capture.md`](../../live-check/quota-capture.md) describes their fields. Record order, record count, every field name, every header name, every status, every quota header value and every timestamp are as captured.

A test reads a file line by line with `JSON.parse`. It passes the `headers` of each `response` record to the header reader, and the `errorMessage` of each `result` record to the error-text classifier. No fixture has a `result` record with an `errorMessage` yet.

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

## Path matrix

| Provider | Path | Fixture | `after_provider_response` fires | Quota headers seen | Limit error text |
|----------|------|---------|---------------------------------|--------------------|------------------|
| Anthropic | shaped (installed packages, `@gotgenes/pi-anthropic-auth`) | `anthropic/shaped-ok.jsonl` | yes, once, status 200 | yes, `anthropic-ratelimit-unified-*` | not captured, no limit was hit |
| Anthropic | plain pi (`-ne`, extra usage) | none | skipped at owner request | skipped at owner request | skipped at owner request |
| Anthropic | extra usage switched off (shaped or plain) | none | skipped at owner request | skipped at owner request | skipped at owner request |
| OpenAI Codex | WebSocket (`transport` auto) | `openai-codex/websocket-ok.jsonl` | no: no `response` record, `result.responses` is 0 | none, the path exposes no headers | not captured, no limit was hit |
| OpenAI Codex | SSE (`transport` sse) | `openai-codex/sse-ok.jsonl` | yes, once, status 200 | yes, `x-codex-*` | not captured, no limit was hit |

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

- **Limit errors on every path.** No usage limit or rate limit was hit during the capture, so there is no 429, no limit error text and no `result` record with an `errorMessage`. The Anthropic expectation from the pi source (a limit arrives as error text with no `response` record, because the SDK throws on a non-2xx first) and the Codex SSE expectation (`after_provider_response` fires for a 429 too) are still unconfirmed.
- **Headers near or at a limit.** Every captured status is `allowed`, and usage was low (Anthropic 5%/39%, Codex 2%/37%). Values such as a non-`allowed` status, a `seven_day` representative claim, or utilization at 1 have not been seen.
- **Anthropic plain pi and extra usage.** Plain pi (`-ne`), the TUI warning, and extra usage switched on or off were skipped at the owner's request. The shaped path reports `overage-status` `rejected` with `org_level_disabled`, but how the extra-usage path behaves is unknown.
