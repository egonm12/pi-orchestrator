---
status: accepted
date: 2026-10-14
amends: ADR 0013
---

# Judge the handling per prompt

ADR 0013 nudges the orchestrator after a set number of exploratory calls in one user prompt. The count is the wrong signal: a single lookup over a few files passes the threshold and gets nudged to delegate, while a prompt that really needs several workers may stay under it. The decision belongs to the task, not to the number of reads. Each owner prompt now gets a handling verdict from a small model call: `self` for one lookup, edit or check, `delegate` for several independent things, open research, or work likely to run for minutes.

## Decision

- **Handling judge.** Each user prompt the owner types in the orchestrator's own session gets one judgement, when its user message is shown and before the first request. Prompts from another extension, and any worker's prompts, are never judged. The judge has its own settings key, `orchestrator.routing.handlingJudge`, defaulting to the effort judge's model (`anthropic/claude-haiku-5-5:low`) and fallbacks. A failed judgement is `self`, and it is recorded and warned about once per session.
- **Shared call.** When the effort judge also runs for a prompt, one model call returns both the effort and the handling. The effort judge's reply carries `handling` and `handlingWhy` beside `effort` and `why`. A reply without them still works, and the handling judge then runs on its own.
- **Verdict in the prompt.** The verdict is one line of the orchestrator protocol, `Handling: delegate (three independent edits)`, added to the protocol section that `context_with_system` keeps current for every request. It is in the system prompt, not in the user's message.
- **Nudge replaced.** On a `self` prompt the exploration nudge stays silent until a safety limit of 8 exploratory calls in that prompt, which the existing setting `orchestrator.subagents.explorationNudge` now defaults to. On a `delegate` prompt the result of the first exploratory call carries a reminder to hand the work to workers. A prompt with no verdict counts as `self`. Nothing is ever refused, as ADR 0013 holds.
- **Owner overrides.** `/pi-orchestrator delegate [prompt]` and `/pi-orchestrator self [prompt]` force the mode for one prompt and skip the judge. With a prompt argument, the text is sent as the next user prompt with the forced mode. Without one, the override applies to the next owner prompt. Overrides last for one prompt only.
- **Decision log.** Each verdict is written to the routing log as a `handling-decision` record with its source (`judged`, `fallback` or `forced`). Bean pi-orchestrator-53x3 compares the delegation rate with these labels.

## Considered options

- **Keep the count and lower the threshold.** Still counts reads, so a lookup over a few files gets the same nudge as a real research task. Rejected.
- **Judge every exploratory call.** Adds a model call per read, and the same judgement is repeated. Rejected.
- **Judge in the nudge's own hook, not at the prompt.** The nudge runs after the first call, which is too late for the first call's reminder and would need the verdict to arrive mid-run. Rejected in favour of judging before the first request.
- **A separate call per prompt for handling, even when the effort judge runs.** Simpler to reason about, but doubles the judge cost on dynamic-effort sessions. Rejected: the reply can carry both.
- **Judge handling for steers and follow-ups too.** A steer is a user message and the nudge already counts it as a new prompt, so it is judged. Rejected as a separate case: keeping one rule, "each owner message that starts a prompt", matches the nudge's reset.

## Consequences

- The orchestrator gets one small model call per owner prompt, or none extra when the effort judge also runs. A failed judge costs nothing but its fallback to `self`.
- The nudge no longer fires on the fourth read of a prompt. Prompts that need research get their reminder at the first read, if the judge chose `delegate`, and the safety limit of 8 otherwise.
- The delegation rate must be measured against these labels. Bean pi-orchestrator-53x3 holds the measurement, and its result is recorded there. ADR 0013's "near 6 of 29" check still applies.
- ADR 0013 stays accepted for its refusal-free design. Its nudge is replaced by this decision.
