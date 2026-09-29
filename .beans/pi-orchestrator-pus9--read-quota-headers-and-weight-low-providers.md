---
# pi-orchestrator-pus9
title: Read quota headers and weight low providers
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-29T08:51:17Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-5inr
    - pi-orchestrator-8tgr
    - pi-orchestrator-ugoi
---

## Parent

pi-orchestrator-cml8 (user stories 50, 51).

## What to build

Quota headers are read through `after_provider_response`, attributed to the provider of the request in flight, only for paths the live check showed expose headers. They add a percentage left to the usage store (source header). A provider under 10% left adds weight to its count in balancing.

## Acceptance criteria

- [x] Header reading built on the headers captured in ticket 12, attributed to the in-flight provider
- [x] Percentage left stored as a header-sourced observation
- [x] A stored low percentage (under 10%) shifts balancing
- [x] Header-reading test uses the captured headers

## Blocked by

- 07 Usage store and error signals
- 10 Balanced tier order
- 12 Live check of quota headers and limit errors

## Prerequisite boundary

Ticket 12 (`pi-orchestrator-ugoi`) stays in progress: no limit or error response was captured on any path, and the Anthropic plain-pi and extra-usage paths were skipped at the owner's request. Its committed success captures (dce1355: `anthropic/shaped-ok.jsonl`, `openai-codex/sse-ok.jsonl`, `openai-codex/websocket-ok.jsonl`) meet this ticket's fixture prerequisite for success-header reading only. So this ticket reads 2xx utilization/used-percent and reset headers and nothing else: no `*-status` header, no `overage-*` header, no non-2xx response, and a header never makes a provider exhausted or throttled. Limit and error header behaviour waits for ticket 12's limit captures and r94j's open item on Codex 429s.

## Summary of changes

- `src/router/quota-headers.ts` (new): reads the captured quota headers of a 2xx response into a header-sourced usage observation. Anthropic `anthropic-ratelimit-unified-{5h,7d}-utilization` (fraction used) and Codex `x-codex-{primary,secondary}-used-percent` (whole percent used) become percentage left, rounded to hundredths; the tightest window wins, with its Unix-seconds reset. Under 10% left is `low`, else `available`. Values outside the captured shape are skipped. `-window-minutes` is not needed for the percentage and is not read.
- `src/router/auto-provider.ts`: keeps the provider of the rung each auto-model request runs on, by session id, from request start to end (process-global, like the pins), exposed as `providerInFlight`. `recordQuotaHeaders` writes the observation unless routing is off, the store holds a limit that still holds, or the store already holds the same reading still current (one write per changed reading, not per response).
- `src/router/extension.ts`: `before_provider_request` notes the model of a session's own request (never `orchestrator`); `after_provider_response` attributes headers to the auto model's in-flight rung, else that noted model, and records them. A failure warns once and never breaks the response.
- `src/router/usage-observations.ts`: a non-limit observation never replaces an exhausted/throttled one that still holds at its time (also under the store lock, for racing writers). New `lowOnUsage` and `percentHoldsUntil`: a percentage holds until its window's reset, or 5 hours without one.
- `src/routing/tier-router.ts`: `RouterEvidence.lowUsageProviders`; in a balanced tier a low candidate provider scores `LOW_USAGE_WEIGHT` (5) extra delegations. Never a filter; ordered tiers, hard filters, escalation and pending-choice counts unchanged. The choice names weighted providers in `lowUsageProviders`; `providerCounts` stays the pinned counts.
- `src/router/route-task.ts` passes the store's low providers into routing and the effort ladder; `src/routing/decision-record.ts` records and validates `route.lowUsageProviders`.
- Tests: tier-router seam (weight shifts, ties, not a filter, ordered, all low); router-extension seam replaying every `response` record of the three sanitized fixtures (worker rung attribution for Anthropic and Codex SSE, no headers on Codex WebSocket, a session's own request keeps its request-time provider), then a separately labelled synthetic block (under 10%, exact 10% boundaries, 0% left, malformed windows and resets, non-2xx not read, an active error limit kept, unchanged reading not rewritten), plus balancing from a stored low percentage and its lapse at reset; usage-store seam for the limit-preservation rule under the lock. The fake session registry can now hand a scripted response to `onResponse`, as pi-ai does.
- Docs: README (balancing weight, header reading and its limits), CONTEXT (tier order, usage observation), fixture README (the ticket 12 boundary).

Not verified live: that a worker's auto-model request in a real pi session fires `after_provider_response` with the rung's headers. pi 0.87.1 source shows the agent's `onResponse` option passes through `ModelRuntime.streamSimple` and the auto model forwards it to the rung (existing test), but no live run checked it.

