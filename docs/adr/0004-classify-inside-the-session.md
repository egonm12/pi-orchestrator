---
status: accepted
date: 2026-09-25
---

# Classify inside the running pi session, not in a `pi -p` child

Ticket 27 ran the router's classifier as a fresh `pi -p --no-extensions` child per routed `subagent` call and rejected an in-process classifier for that ticket. Routing then added about 11 to 12 s per routed call (ticket 27's measurement), and the owner asked for the classifier to run through the running session instead, to remove pi's startup from that time. The router now classifies with `ctx.modelRegistry.streamSimple` (`routing/session-classifier-call.ts`): one request through the session's own model registry, with the same system prompt, rubric prompt, configured effort, timeout and error mapping, plus an explicit output limit. This is the extension path the Anthropic subscription auth package shapes; pi-ai's `compat.streamSimple` is not shaped and is not used.

## Consequences

- The classifier shares the session process and auth. The harness consumer stops on timeout or abort, requests iterator closure without waiting, and never processes late events or requests another event. Provider transport cancellation remains cooperative: the AbortSignal and iterator closure do not guarantee that provider work or billing stops. The in-session path loses pi session-level auto-retry for retryable assistant errors; provider SDK retries may still apply, and a failed request proceeds through the classifier fallback chain. With Anthropic low thinking, `maxTokens` of 4,000 can produce a provider ceiling of 6,048 (4,000 plus the 2,048 thinking budget), while the allowance reservation remains 4,000 output tokens. This is not a bound on provider work or a guarantee of subprocess behavioral parity.
- No classifier `pi` is started: live tests assert that the only launches are the parents and `--list-models`. The classifier's tokens and cost appear in the router's probe line instead of a launch's event stream.
- At `:low`, the measured gain from removing the subprocess is small (pooled median 10.8 s to 10.4 s). In real Haiku sessions, five routed calls per mode, the hook's median went from 11.1 s to 10.1 s in shadow mode and from 10.6 s to 11.0 s in live mode (router README, "Latency measurement"). The stream shows why: the first token arrives after about 0.5 to 0.8 s, and the rest is Haiku generating 540 to 960 output tokens, most of them thinking at `:low`. pi's startup was not the main cost.
- `routing/pi-classifier-call.ts` stayed in the harness archive in `~/.pi` (tag `archive/harness`) when the router moved to pi-orchestrator. Ticket 23's live classifier test now classifies in-session too, through a probe extension in a real pi session (`fixtures/session-classifier-probe.ts`).

## Follow-up: owner chooses classifier effort off

The owner chose `anthropic/claude-haiku-4-5:off`. A follow-up measured through the real in-session router, five calls per mode, gave shadow hook median 2.8 s / max 3.1 s (2,762.8 / 3,065.9 ms) and live median 3.0 s / max 3.3 s (3,001.9 / 3,346.1 ms). First token was about 0.6 s, with about 1,070 tokens and ~$0.0018 provider-reported cost per classification. All ten records had cause `model:anthropic/claude-haiku-4-5:off`. Removing thinking, rather than only subprocess startup, accounts for the observed improvement; these small samples are latency evidence, not a quality guarantee. A reviewer-subagent probe is excluded from evidence.

The real personal settings explicitly configured `harness.routing.classifier.model` to Haiku off when the router was installed live on 2026-09-25. `DEFAULT_CLASSIFIER_RUNG` is unchanged. The production-shaped router session tests and ticket 28 acceptance gate now exercise off and require its exact cause and probe line. Ticket 28's exact six task classifications (two mechanical, two standard, two critical) are the quality check. The post-fix live suite passed 872/872 with zero skipped, including that off quality gate. General fixture rungs and delegate efforts are unchanged.
