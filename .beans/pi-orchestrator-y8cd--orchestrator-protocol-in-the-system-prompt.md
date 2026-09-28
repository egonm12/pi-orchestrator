---
# pi-orchestrator-y8cd
title: Orchestrator protocol in the system prompt
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T07:23:24Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-vu2o
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

The orchestrator's session always carries the orchestrator protocol in its system prompt, added when each user prompt starts its agent loop; pi applies the system prompt to every model request, so it survives compaction without a per-turn hook. The base protocol says: delegate exploration and substantial work to workers, keep small known actions (a single lookup, a small edit, a commit), and treat a worker's Result as evidence, not a verdict. Workers never get it. There is no per-prompt reminder line. Later tickets add their own paragraph (budget, verdicts, reviewer, gate level).

## Acceptance criteria

- [x] The protocol is in the orchestrator session's system prompt on every turn of a run started by a user prompt, including after compaction; the gap in runs started by a message (completion notice, question Report) is documented
- [x] Worker, forked worker and child-process sessions do not get it
- [x] The protocol text lives in one place that later tickets extend
- [x] Tests

## Blocked by

- pi-orchestrator-vu2o

## Summary of Changes

- New `src/subagents/orchestrator-protocol.ts`: the protocol text (`ORCHESTRATOR_PROTOCOL`), built from a `PARAGRAPHS` list with one entry per rule, so a later ticket (budget, verdicts, reviewer, gate level) adds one entry there. `addOrchestratorProtocol` is a `before_agent_start` handler: in the orchestrator's own session (`isOrchestratorSession`) it sets the `orchestrator_protocol` section of `event.systemPromptOptions.sections`, the structured way pi's docs recommend; returning a full `systemPrompt` would replace the whole prompt for the run.
- The subagents extension registers the handler. It is the extension that owns the `subagents`, `subagents_status` and `subagents_message` tools the protocol names, so no fourth extension. Dropping the subagents extension drops the protocol with it.
- Workers: an ordinary worker does not load the subagents extension. A worker whose definition lists `subagents` does, and the session check leaves it out. A pi-subagents child is left out by its environment marker. A forked worker's copied conversation holds the orchestrator's section as a system message; the fork's own prompt build diffs it away, and pi sends "Removed system prompt section" or collapses it out.
- Tests in `src/subagents/extension.test.ts`, run against a real orchestrator pi session with the subagents extension and a scripted provider, whose request record now has the current system prompt (sections replayed, removed ones dropped): protocol on both turns of a prompt, before and after a `compact()`; none in a `PI_SUBAGENT_CHILD=1` session; none for a routed worker, a delegating lead, the lead's own worker or a fork, while the fork's session file still holds the inherited copy. A mutation making the handler unconditional fails the child and worker tests.
- README: a new "Orchestrator protocol" subsection under the subagents tool, the intro bullet, and the switching-off note. The comment in `orchestrator-session.ts` now lists the protocol as one of the check's users.

Open, so criterion 1 is left unchecked:
- A run started by `pi.sendMessage(..., { triggerTurn: true })` skips `before_agent_start`. Examples are the background completion notice when the orchestrator is idle, and a worker's question Report. Its first turn keeps the protocol from the transcript. From its second turn on, pi rebuilds the prompt from the base options and patches the section out, until the next user prompt adds it back. I reproduced this with a real pi 0.87 session: the first triggered turn had the protocol, the second did not. The ticket's premise that pi applies a before_agent_start change to every request holds for runs started by a user prompt only. Covering these runs needs a per-request hook (`context_with_system`) or a pi change, which the ticket rules out, so this is left to the owner. The README states the limitation.


## Owner decision (2026-09-27)
Option (c): accept and document the gap. A run started by pi.sendMessage (a background completion notice or a question Report) skips before_agent_start, so from its second model request the protocol is missing until the next user prompt. No context_with_system fallback.


Orchestrator verdict: accepted. README and orchestrator-protocol.ts document the gap in message-started runs, per the owner's decision.
