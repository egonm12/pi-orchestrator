---
# pi-orchestrator-r94j
title: Harden the usage store after the 5inr review
status: in-progress
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T15:30:58Z
updated_at: 2026-09-28T23:08:12Z
parent: pi-orchestrator-cml8
---

Non-blocking findings from the review of commit c820661 (pi-orchestrator-5inr).

- [x] The stale-lock break races in `src/router/usage-observations.ts`: two waiters can both delete a stale lock, and the finally-delete removes a lock that another process now holds. Use a token in the lock, or rename the stale lock aside before creating a new one.
- [x] Waiters block the pi process in a synchronous `Atomics.wait` loop for up to 2 s, and leftover `.tmp` files after a crash are never cleaned up.
- [ ] Every Codex 429 counts as exhausted for 5 hours. Revisit this once ticket 13 (pi-orchestrator-pus9) provides headers.
- [x] The refusal text says no request was sent to any provider, but the classifier chain already called a model. Say that no worker request was sent.
- [x] A failed usage-store write disables routing for the session. Consider only warning.

## Summary of changes

- Lock ownership (`src/router/usage-observations.ts`): the lock file appears with its content in one step (a finished temporary file is hard-linked to `usage-observations.json.lock`) and holds the writer's pid and a random token. A writer removes the lock on release only when it still holds its own token, so it never removes a lock another writer took after breaking its own.
- Breaking an abandoned lock: a lock is abandoned when its pid no longer runs (broken at once, instead of after 2 s) or when it is older than 10 s (a hung writer, or a reused pid). Of the waiters that find the same lock abandoned, only the one that first hard-links a claim named after that lock (inode, modification time, content) may break it, and only if the claim still shows that lock. A waiter that judged a lock abandoned after another waiter replaced it drops its claim and leaves the new lock alone. A claim whose waiter died is dropped after 10 s.
- No blocking wait: waiting for a lock is asynchronous (`setTimeout` retries every 5 ms), so `recordUsageObservation` now returns a promise and the router extension awaits it before the worker sees the error or before failover routes again. The critical section (read, merge, write, rename) is still synchronous, so writers in one process never interleave inside it, and cross-process safety still comes from the lock file. A lock that is neither released nor broken within 20 s fails the write instead of waiting forever.
- Leftover temporary files: while holding the lock, a writer removes the store's temporary files whose pid no longer runs or that are older than 10 s, and any leftover claims. A running writer's young temporary file is kept. Only files named `usage-observations.json.<pid>.<uuid>.tmp` or `usage-observations.json.lock.<id>.break` are touched.
- Refusal wording (`src/router/auto-provider.ts`): the fallback refusal now ends with `No worker request was sent.`, since the classifier chain has already called a model by then. README says "before any worker request is sent (the classifier has already run)".
- Failed usage-store write, decision: it no longer disables routing. The router extension prints one `pi-orchestrator router warning: could not save the usage observation for <provider> (<state> until <time>) in <path>: <reason>. Routing in this process still avoids <provider>; other sessions don't see it until a later write succeeds.` line per store and provider per process, and routing stays live. So that a failed write never routes an exhausted provider silently, the store keeps an unsaved observation in process memory (on the process's global object, shared by every router extension copy), `readUsageObservations` returns it merged with the file (the later one per provider wins), and the next write that succeeds saves it. A first-request limit whose observation cannot be saved still fails over. Other processes don't see the observation until then, which is what the warning says. Documented in README ("How routing decides", "State" and "Fail open") and in the store's module comment.
- Tests: new `src/router/usage-observations.test.ts` at the usage store seam (a live writer's lock is waited for without blocking timers and left alone; a dead writer's lock is broken at once; a lock older than any write is broken; leftover temporary files of dead or hung writers are removed and a running writer's kept; 8 writer processes racing to break a dead writer's lock keep every provider and leave nothing behind, 3 rounds; an unsaved observation is read in process and saved by the next successful write). In `src/router/extension.test.ts` at the router extension seam: the two refusal texts, a failed write warns once across two failed writes and routing stays live and avoids the provider, and a first-request limit with a failed write still fails over. Against the previous store implementation 4 of the 6 store tests fail; the aged-lock test and the race test pass there too (the race is timing-dependent: an ad hoc run of the old code lost writes in 1 of 10 rounds, the new code in 0 of 20 with a dead writer's lock and 0 of 20 with an aged one).
- Known limit, documented in the module comment: a writer that hangs past 10 s and then resumes can still overwrite the write of the writer that broke its lock.

## Deferred

The Codex 429 item stays open. It depends on the quota headers that ticket 13 (pi-orchestrator-pus9) reads from the live capture of ticket 12 (pi-orchestrator-ugoi), and those headers are not captured yet. Nothing here changes how a Codex 429 is classified. This bean stays in progress until that item is done.
