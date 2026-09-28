---
# pi-orchestrator-5inr
title: Usage store and error signals
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 44, 46 to 49, 52, 53).

## What to build

A new shared usage store, in its own file in the owner's state folder (not the catalog's refresh-state file), holds per provider the latest usage observation: state (available, low, exhausted, throttled), percentage left if known, reset time if known, observed at, and source (error or header). The auto model classifies a worker's failure text as a usage limit (exhausted until the stated reset, or 5 hours without one) or a rate limit (throttled for a while) and records an observation. The router reads the store on every routing and feeds the existing exhausted and throttled hard filters. When every tier and escalation empties because of usage, the router refuses with the reset times before any worker starts, and the session-model fallback is used only when that model's provider is not exhausted.

## Acceptance criteria

- [ ] Usage store in a new file in the owner's state folder, shared across sessions and projects
- [ ] Usage-limit error text (e.g. Codex "You have hit your ChatGPT usage limit") marks the provider exhausted until the stated reset, or 5 hours without one
- [ ] Rate-limit error marks the provider throttled for a while
- [ ] The next routing, even from another session, avoids that provider
- [ ] All providers exhausted: refusal with reset times, no worker started
- [ ] Session-model fallback skipped when its provider is exhausted
- [ ] Router extension tests with a provider double and a temporary state folder

## Blocked by

None, can start immediately.
