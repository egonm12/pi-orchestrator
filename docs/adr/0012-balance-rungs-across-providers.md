---
status: accepted
date: 2026-09-28
amends: ADR 0001
---

# Balance a tier's rungs across providers instead of taking the first survivor

ADR 0001 let the first surviving rung of a tier win. In practice the owner lists one Anthropic and one OpenAI rung per tier as equals, and every delegation went to the first one, Anthropic, which used up one subscription while the other sat idle. A tier now picks, by default, the surviving rung whose provider has the lowest balance score. The score starts with the provider's delegations pinned in the last 5 hours, across all the owner's sessions and projects, because subscription limits belong to the account, not the session. Known quota headroom adds usage pressure to that score. Owner order breaks ties. A tier can still be set to ordered, where the first survivor wins as before.

## Considered options

- **Round-robin**: simple, but it doesn't see usage from other sessions or other tiers on the same provider.
- **Least-used by tokens**: more accurate, but tokens are only known after a worker finishes, so parallel workers started together would all land on the same provider.
- **Owner-weighted shares**: possible later as an addition; not needed to fix the imbalance.
- **Switch only under quota pressure**: at the time of this decision, usage signals weren't connected (`updateFromCallResult` had no caller outside tests). Header-derived usage was added later; its effect on balance is described in the amendment below.
- **Least-used by delegations started, per provider** (chosen): known the moment a worker is pinned, so parallel calls spread correctly.

## Consequences

- Hard filters, escalation and the effort ladder keep their order. Balancing only chooses among candidates at the same step. The ladder still tries a higher effort on the same model before moving to the next rung.
- A reviewer prefers a surviving rung from a different provider than the implementer's, for a more independent check.
- The decision record gains the usage counts and known headroom that decided the choice, so a skewed split is visible.

## Amendment: account for effective quota headroom

Quota response headers report 5-hour and 7-day windows for Anthropic, and primary and secondary windows for Codex. The observation uses the lowest remaining percentage among the windows it can read; a missing window does not discard a known one. A balanced choice adds `5 × (100 − percentLeft) / 100` to that provider's delegation count. Under 10% left retains the full 5-point penalty from story 51. Missing or expired percentages add no penalty. The weight lets a provider with more remaining weekly headroom win when delegation counts are otherwise equal, without turning usage pressure into a hard filter or changing ordered tiers.
