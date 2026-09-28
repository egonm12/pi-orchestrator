# Live check: the protocol on every run

Ticket: bean `pi-orchestrator-6yxt` (parent `pi-orchestrator-cml8`, user stories 14 to 18). The owner runs this check in a real pi session. Its result goes into the bean.

`protocol-probe.ts` is a pi extension. Load it with `pi -e`. It never changes a request. For every provider request it writes one JSONL record with markers only, never prompt, message or payload text:

| Field | Meaning |
|-------|---------|
| `orchestrator` | whether the request came from the orchestrator's own session (a worker's is `false`) |
| `run`, `turn` | the run's number in the session, and the request's number within the run (2 and later follow a tool call) |
| `start` | what started the run: `prompt` (with `skill: true` for a typed `/skill:` prompt) or `message` (a completion notice, a report, a question, a gate reminder) |
| `messages` | the custom message types the run has seen so far, such as `subagents-completion` |
| `queuedSkills` | skill prompts typed while that run was streaming |
| `protocol` | whether the system text the provider got holds the protocol |
| `piPrompt` | whether pi's own view of the prompt (`ctx.getSystemPrompt()`) holds it |
| `projectRules` | whether the provider's system text holds pi-claude-rules' `## Project rules` section, which forces the prompt |

`protocol` reads the provider payload's system text only: the Anthropic `system` field, the Responses `instructions`, and system or developer items. A tool result that read `orchestrator-protocol.ts` does not count. `piPrompt` can be `no` on a run a message started while `protocol` is `yes`: the fix puts the protocol into each request, not into pi's transcript.

## Run it

1. From the repository root, start pi with your usual packages (keep pi-claude-rules installed: it is one of the causes checked) and the probe:

   ```sh
   cd /Users/egonmeijers/development/sandbox/pi-extensions/pi-orchestrator
   PI_PROTOCOL_PROBE_FILE=/tmp/protocol-probe.jsonl pi -e src/live-check/protocol-probe.ts
   ```

   pi shows `protocol-probe: writing /tmp/protocol-probe.jsonl` at start.

2. Type a skill prompt that starts one background worker, for example:

   ```text
   /skill:research Start one background worker with the subagents tool (background: true) that lists docs/adr and names the ADR that covers the exploration nudge. Do nothing else until its completion notice arrives. When it arrives, read that ADR file yourself, then answer in one line.
   ```

   Any skill works; the prompt must start with `/skill:`.

3. Wait until the completion notice has woken the orchestrator, it has read the ADR (a tool call) and answered. That run is the one the fix is for: before it, its second request lost the protocol.

4. Optional: while a run started by a notice is still streaming, type another `/skill:` prompt. The probe counts it in `queuedSkills`.

5. Quit pi, then summarize:

   ```sh
   node src/live-check/protocol-probe.ts /tmp/protocol-probe.jsonl
   ```

   It prints one line per orchestrator request, then a verdict per case, and exits 0 on `RESULT: PASS`, 1 otherwise.

## What passes

- `PASS: a typed skill prompt's run`: every request of a run a `/skill:` prompt started has the protocol.
- `PASS: a run a completion notice started`: every request of a run the notice started has it.
- `PASS: a turn after a tool call in a run a message started`: the request after the woken orchestrator's tool call has it.
- `PASS: every orchestrator request has the protocol`.
- `PASS: no worker request has the protocol`. The probe may see no worker requests (`0 worker requests probed`) if pi does not load `-e` extensions into the subagents tool's workers; the real-session tests cover workers.

`NOT SEEN` means the session did not produce that case: repeat step 2 and 3. A line with `protocol NO` and `project rules forced` points at a forced prompt; one with `protocol NO` on a `message` run points at the wake-up path.

## Record the result

Paste the summary output into the bean under `## Live check result`, with the date, the pi version (`pi --version`) and the model, and tick the last acceptance criterion if it passed:

```sh
beans update pi-orchestrator-6yxt --body-append "## Live check result ..."
```
