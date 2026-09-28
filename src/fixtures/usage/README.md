# Usage fixtures

These fixtures hold the real quota headers and limit errors of Anthropic and OpenAI Codex. They come from the owner's run of the live check in [`src/live-check/quota-capture.md`](../../live-check/quota-capture.md) (bean `pi-orchestrator-ugoi`). Ticket 13 (bean `pi-orchestrator-pus9`, reading quota headers) tests against them.

Nothing here is written by hand. Every record is a line from the owner's capture. The folder stays empty until that run is handed back.

## Layout

One JSONL file per case, under the provider's name:

```
src/fixtures/usage/
  anthropic/
    shaped-ok.jsonl                  # installed packages, Claude subscription
    plain.jsonl                      # plain pi (-ne): the third-party-harness, extra-usage case
    shaped-extra-usage-off.jsonl     # optional
    plain-extra-usage-off.jsonl      # optional
    shaped-limit.jsonl               # when a limit was hit
    plain-limit.jsonl
  openai-codex/
    websocket-ok.jsonl
    sse-ok.jsonl
    websocket-limit.jsonl
    sse-limit.jsonl
```

A file name is the capture's case name without its provider prefix (`anthropic-shaped-ok.jsonl` becomes `anthropic/shaped-ok.jsonl`). Only cases the owner actually captured get a file. A case that never happened has no file, and the notes below say so.

## Format

The capture's JSONL records, version 1, unchanged: `session`, `request`, `response` and `result`. [`quota-capture.md`](../../live-check/quota-capture.md) describes their fields. Cookie and credential header values are already `[redacted]` by the capture.

When copying records in, you may drop records that do not belong to the case, and replace `sessionId` values with a stable placeholder. Do not edit headers, statuses or error text.

A test reads a file line by line with `JSON.parse`. It passes the `headers` of each `response` record to the header reader, and the `errorMessage` of each `result` record to the error-text classifier.

## Notes on which paths expose headers

Filled in from the owner's run. Until then every row is open.

| Provider | Path | `after_provider_response` fires | Quota headers seen | Limit error text |
|----------|------|---------------------------------|--------------------|------------------|
| Anthropic | shaped (installed packages) | not yet captured | not yet captured | not yet captured |
| Anthropic | plain pi (extra usage) | not yet captured | not yet captured | not yet captured |
| OpenAI Codex | WebSocket (`transport` auto) | not yet captured | not yet captured | not yet captured |
| OpenAI Codex | SSE (`transport` sse) | not yet captured | not yet captured | not yet captured |
