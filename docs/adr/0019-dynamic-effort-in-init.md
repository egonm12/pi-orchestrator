---
status: proposed
date: 2026-10-11
---

# Dynamic effort in init

ADR 0018 lets a tier rung choose its effort per incoming message, but until now the owner had to edit the tier map by hand. `/pi-orchestrator init` should expose the feature without asking owners to understand the routing format or cache behavior. Init already has the installed model registry, so it can offer dynamic effort only where pi flags mid-conversation effort and the effort cache probe measured the model as cache-safe.

## Decision

- In each tier's effort picker, offer `auto` first for cache-safe models when the tier's useful range contains at least two supported efforts. The hint is: “Saves cost on easy messages, thinks harder on hard ones. Same model, cache kept.” Other models keep the existing fixed-effort choices.
- Write a fixed, tier-specific range for `auto`: mechanical `low-medium`, standard `low-high`, elevated `medium-high` and critical `high-xhigh`. Narrow either end to the model's supported efforts, never include `max`, and omit `auto` when fewer than two supported efforts remain in the range. Critical defaults to `auto` when it is available.
- Use the same defaults in the starter map. Keep the classifier on one fixed effort.
- On rebuild, show an existing dynamic range that differs from the tier's automatic range as a `custom (...)` choice, selected first. Honor the choice in the written map rather than silently restoring the old value after the picker returns. If the model remains installed but is no longer cache-safe, convert its dynamic rung to a fixed rung at the range's highest supported effort and notify the owner. Escape keeps the current selection, except for that required conversion of an invalid dynamic rung.
- After the tier map, ask whether the orchestrator's own session should adjust its effort between low and high. Store `orchestrator.routing.sessionEffort` only in personal settings. Selecting No removes the setting only when one already exists; Escape keeps the current value. Show an existing custom value as a selectable custom choice.
- Do not ask the owner to choose an effort judge. When the default judge model is not installed and dynamic effort is configured, tell the owner which installed classifier model and fallback chain will judge messages.
- Summarize the number of dynamic tier rungs. In shadow mode, explain that dynamic effort takes effect once routing is live.

## Considered options

- Keep dynamic effort as a manual settings-only feature: rejected because it hides a useful capability behind a configuration syntax and cache-safety rule.
- Offer `auto` on every installed model: rejected because a model must be flagged by pi and measured to keep its prompt cache across an effort change.
- Store a bare model name for `auto`: rejected because the tier-specific effort range should be visible in settings and decision records, and a bare name can imply a wider range than the tier needs.
- Ask owners to select or configure the judge during init: rejected because the existing default and classifier fallback chain are sufficient for setup; an informational notice covers a missing default model.
- Silently retain dynamic values after the owner picks a fixed effort: rejected because it makes the picker dishonest. Preserve the dynamic choice visibly instead.

## Consequences

- Fresh starter maps use dynamic effort on qualified models, with each tier capped to its purpose and the model's supported efforts.
- Init can convert a previously valid dynamic rung when registry capability or cache-safety evidence changes, so the rebuilt map remains loadable.
- Existing fixed choices and non-cache-safe pickers are unchanged. A custom dynamic range is preserved only when the owner leaves or selects that visible choice.
- The effort judge remains a separate classifier fallback chain. If its default rung is unavailable, init explains the chain it will try without adding a judge setting.
- Session effort remains personal because it controls the orchestrator's own session, not an individual project tier map.
