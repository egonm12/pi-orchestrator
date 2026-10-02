---
status: accepted
date: 2026-10-01
---

# Only the classifier model chooses the tier

A keyword floor used to sit under the classifier model: two security or destructive words in a task made it critical, one made it elevated, and the model could not go lower. In the routing log from 2026-09-25 to 2026-10-01 the floor raised 66 decisions and caught none the model had genuinely under-rated (one borderline case, which the model had already flagged in its reason). 39 of the 46 critical decisions came from the floor, matched on words such as "commit hash", "escalation", "token count" and on the orchestrator's own prohibitions ("do NOT purge"). Critical runs on the strongest rung and always gets a reviewer, so these false alarms were expensive. We removed the floor and the keywords-only tier: the classifier model alone chooses the tier, and its `why` and `risk.reasons` explain the choice.

The rubric now judges the action a task asks for, not its subject. A review, audit or investigation that changes nothing is never critical; a prohibition is a constraint, not a risk. Five of the model's own seven critical calls in the same log were read-only security reviews.

A task no classifier model could classify runs as elevated, recorded as unclassified. A retry keeps the tier of the delegation it retries; the effort ladder already gives it more care.

## Considered options

- **Cap the floor at elevated and tighten the word list.** Fewer false criticals, but the list needs endless exceptions (negation, `/tmp` paths, project glossary words) and still caught nothing. Rejected.
- **Skip negated matches.** Covered about 20% of the false matches and is fragile. Rejected with the list.
- **Keep keywords for the unclassified case only.** That path ran 32 times in 380 decisions with the same false positives. A fixed elevated tier is cheaper to reason about.

## Consequences

- If the model under-rates a risky change, nothing catches it before the quality gate. The rubric's examples are the place to correct that.
- Old routing records keep their `floor` field; readers treat it as optional.
