---
# pi-orchestrator-5inr
title: Usage store and error signals
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T15:20:21Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 44, 46 to 49, 52, 53).

## What to build

A new shared usage store, in its own file in the owner's state folder (not the catalog's refresh-state file), holds per provider the latest usage observation: state (available, low, exhausted, throttled), percentage left if known, reset time if known, observed at, and source (error or header). The auto model classifies a worker's failure text as a usage limit (exhausted until the stated reset, or 5 hours without one) or a rate limit (throttled for a while) and records an observation. The router reads the store on every routing and feeds the existing exhausted and throttled hard filters. When every tier and escalation empties because of usage, the router refuses with the reset times before any worker starts, and the session-model fallback is used only when that model's provider is not exhausted.

## Acceptance criteria

- [x] Usage store in a new file in the owner's state folder, shared across sessions and projects
- [x] Usage-limit error text (e.g. Codex "You have hit your ChatGPT usage limit") marks the provider exhausted until the stated reset, or 5 hours without one
- [x] Rate-limit error marks the provider throttled for a while
- [x] The next routing, even from another session, avoids that provider
- [x] All providers exhausted: refusal with reset times, no worker started
- [x] Session-model fallback skipped when its provider is exhausted
- [x] Router extension tests with a provider double and a temporary state folder

## Blocked by

None, can start immediately.

## Summary of changes

- New usage store `usage-observations.json` in the state folder (`src/router/usage-observations.ts`), keyed by provider, holding the latest usage observation: state, percentage left and reset time when known, observed at, and source. A write takes a lock file next to the store, merges its one provider into what is there and renames a finished temporary file over the store, so concurrent sessions keep each other's providers and a reader never sees half a file. Unreadable files or entries read as nothing known.
- New limit-error signal (`src/router/limit-errors.ts`): a rung's error text is a usage limit (Codex `You have hit your ChatGPT usage limit ...`, the Codex WebSocket `Codex error: ... usage limit ...`, Anthropic `You're out of extra usage.`), recorded as exhausted, or a rate limit (`rate limit`, `rate_limit_error`, `429`, `too many requests`), recorded as throttled. A stated `Try again in ~N min` (or seconds or hours) becomes the reset time.
- The auto model records the observation for the pinned rung's provider when the rung's stream ends in an error, before the worker sees the error (`src/router/auto-provider.ts`). Nothing is recorded with routing off.
- The router reads the store on every routing, first requests, restored pins and effort-ladder climbs, and feeds the existing `provider out of usage` and `provider throttled` hard filters (`src/router/route-task.ts`). Exhausted holds until the stated reset or 5 hours; throttled until the stated time or 5 minutes. The removal detail names when the limit lifts.
- After a live refusal, the session-model fallback is skipped when that model's provider is exhausted: the worker fails before any request is sent, with a reason naming every limited provider and when its limit lifts, and no decision record is written. A merely throttled session provider still gets the fallback.
- Tests in `src/router/extension.test.ts` through the router extension seam, with the scripted session registry as the provider double and a temporary state folder: a stated Codex reset seen from another session and project, a table of usage-limit and rate-limit texts with their windows, a non-limit error, every provider exhausted from two projects at once, and the fallback with and without usage left.
- README: the usage observations paragraph, the refusal exception and the new state file. CONTEXT.md: the usage observation now covers throttled, and a new term, limit error.

Follow-ups not done here: `src/subagents/resume.ts` checks a resumed pin against ticket 08's evidence only, not the usage store, and the classifier's own limit errors record no observation.
