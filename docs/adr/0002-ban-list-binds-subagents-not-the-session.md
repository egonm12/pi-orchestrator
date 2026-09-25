---
status: accepted
date: 2026-09-24
---

# The model ban binds delegated agents, not the orchestrator's own session

The owner prohibits certain models (today: any id containing `fable` or `astra`) for delegated work, but wants to be free to run the main session on any model, including those. So there are two lists: a subagent ban list, which every dispatch layer and the personal guard enforce by name, and a session ban list, empty by default, which the guard enforces on the session's own model selection. A model on the subagent ban list may therefore be visible as the running session model while every `subagent` call naming it is refused; that is intended, not a gap.

## Consequences

- The guard must not refuse a session because its model is on the subagent ban list; it refuses only `subagent` calls (and other model-carrying tool fields) that name one.
- `isProhibitedModel` and every layer that calls it read the subagent ban list from settings, with `fable` and `astra` as the shipped defaults, instead of hard-coding the names.
- A project may not extend, shorten or replace either list.
