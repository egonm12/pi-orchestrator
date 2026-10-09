---
status: accepted
date: 2026-10-08
---

# Routed workers delegate by default, one level deep

ADR 0008 made nested delegation opt-in through an agent definition and limited it to foreground, routed calls. A worker now decides whether its own bounded task needs another worker, including a background worker or a fork of its context. This supersedes the nested-delegation rule and the later foreground-only note in ADR 0008. ADR 0007 still governs the worker runtime.

## Decision

- Every routed worker the orchestrator starts gets `subagents` by default, even without an agent definition. A definition with a `tools:` list narrows the worker's tools: leaving out `subagents` removes it. A delegating worker also gets `subagents_status` and `subagents_message` for its own background calls, unless its tools list leaves them out. `subagents_verdict` stays the orchestrator's alone, and so do reviews and retries.
- Delegation is one level deep. A worker started by another worker never gets `subagents`, whatever its definition lists and whether or not it is forked. A worker that resumes one of its own workers passes itself as the parent, so the resumed worker stays one level down and gets no tool either. A top-level forked worker does not delegate: it carries the orchestrator's context on an unrouted session model, which is not an ordinary routed worker, and nothing in the new rule needs it to.
- A worker's ordinary workers are routed through the auto model. Under `agentDefinitionModel.use: "preserve"` their definition's model is still ignored, as before: only the orchestrator's own workers run on a preserved agent model.
- A worker's call is foreground by default but may set `background: true`. The worker's own session owns the call's status, messages, reports and completion notice. Before its run settles, the worker waits for its background workers and receives each notice as a new turn, so their results can reach its Result. The children are never left running detached from the worker.
- A stop of the worker, an abort of the call that started it, or the end of the orchestrator's session stops its background workers too, also while it waits for them before it settles. pi clears a run's own abort signal before `agent_before_settle`, so that wait listens to the worker's stop signal instead.
- A background worker of a worker may ask it a question with `report`. When the worker would end its run with a question still unanswered, it gets one reminder that names the asking worker and starts another turn. When it ends that turn again without answering, the asking worker gets a fallback answer, marked `No answer (fallback)` and naming no one as answering, which tells it to go on without one and to say what it assumed. Its result then reaches the worker as a notice, so the question does not end the child or silently drop its result.
- A worker may set `fork: true`. The fork copies the calling worker's active branch before the delegating tool call and runs, without routing, on the rung and effort that served the calling worker. A worker on a preserved agent model forks on that model and its effort. The fork's record and board entry name the parent delegation.
- The orchestrator's worker limit and FIFO queue cover all of its workers, including nested ones. A worker's calls do not change the limit. A worker gives its slot up while it waits for its own foreground call, for a status wait, for its background workers before it settles, or for the answer to its own question, then queues to take it back before it goes on. Overlapping waits of one worker, such as a call and a question run in parallel, give the slot up once and take it back once, when the last of them ends. A wait that starts while an earlier one still queues to take the slot back holds no slot: the earlier wait gives the slot it gets straight back, and the later wait takes one back when it ends. This keeps a full limit, even a limit of one, from deadlocking a parent waiting for its own child.
- Nested edits still count toward the parent delegation's editing result and quality gate.

## Consequences

A background child may keep its parent's run open longer than the parent's last reply. The completion notice enters the parent's session before it ends, so the parent can use the child's result rather than drop it. A parent that ignores a child's question costs one extra turn, then the child goes on on its own judgement. Explicit tools restrictions and the one-level boundary remain the owner's controls on delegation.
