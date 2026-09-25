# Ticket 27: router extension

This personal pi extension fills in the model on `subagent` calls that name none (stories 38 to 44). It is separate from the guard: either can be installed or removed without the other. **As of 2026-09-25 it is active in live mode** in the owner's real agent directory (see "Activation").

> **Routing is a no-op until the owner has an approved-recipients store.** Approved data recipients are a hard filter (ticket 07) and fail closed: with no `authorized-recipients.json` in the state folder, every rung is removed as `unapproved recipient`, every route is a refusal, and every call proceeds exactly as the orchestrator made it, with the refusal recorded. Creating that store, through `grantOwnerApproval` and `saveAuthorization`, is a prerequisite for ticket 28 and for a real installation.

## What it does

On `session_start` it reads the personal settings file (`${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`) and the project's `.pi/settings.json` once. A change needs a new session.

| Key | Meaning |
|-----|---------|
| `harness.routing.enabled` | `true` switches routing on. Absent or `false`: the hook does nothing and writes nothing |
| `harness.routing.mode` | `shadow` (the default) classifies and records but never writes a model; `live` writes the chosen rung into the call |
| `harness.routing.classifier` | Ticket 23's `model`, `timeoutMs` and `fallback`; every rung must name a model pi has |
| `harness.routing.tiers` | Ticket 22's tier map; a project file may replace tiers, and nothing else |

The installed models are pi's live registry, `ctx.modelRegistry.getAvailable()` through pi-subagents' `toModelInfo` (the call pi-subagents makes in `src/agents/agent-management.js:1080`). The personal subagent ban list is loaded with the same settings and applied to the tier map, the classifier chain and the router.

On `tool_call` for `subagent` it finds the dispatch slots with the guard's own walk (`delegationObjects` in `../guard/boundaries.ts`): the top level when it names an agent, a task or a model, then each `tasks[i]`, `chain[i]` and `workflow.steps[i]`. For each slot:

- **A named model** (a model field by the guard's rule, `isModelField` in `../guard/boundaries.ts`, holding a non-blank string; a blank value names no model) is left alone and recorded as `recordType: "explicit"`, `cause: "explicit"`. A model named at the top level covers the nested slots, which are then neither routed nor recorded.
- **An agent whose definition pins a model** is treated the same way: left alone, recorded as explicit with slot `agent:<name>.model` and the definition's model. The agent is found the way pi-subagents finds it for the call: its own `discoverAgents` for the call's `agentScope` (default both) and `resolveAgentName` (name, local name, alias), imported in process from the installed package; discovery keeps its own fingerprinted cache, so a changed agent file is seen on the next call. Only a `model` from the agent's frontmatter or a builtin agent override is a pin. A `subagents.defaultModel` from settings also fills the agent's `model`, but pi-subagents marks it with `modelSource` (`agent-management.js:1063` tells them apart the same way); it is a global default, and replacing that default is what routing is for, so the slot is routed. `model: inherit` pins nothing. If discovery throws (pi-subagents reads `subagents` settings strictly), the router is disabled for the session like any other failure.
- **No model**: the classifier gets the slot's task text, its agent role (the slot's `agent`, else the top level's, else `unknown`) and the file paths the task names, and the router chooses a rung from the tier map with the hard filters' evidence. In live mode the rung string (`provider/model:effort`) is written into that slot's `model` field of `event.input`, in place: pi documents that `tool_call` "can mutate input" (`docs/extensions.md:103`) and that "`event.input` is mutable. Mutate it in place to patch tool arguments before execution" (`dist/core/extensions/types.d.ts:787-788`; the package is installed at `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`, not under `agent/npm/node_modules/`). In shadow mode only the record is written, with `handPickedModel` set to the model pi would run (below). A router refusal changes nothing in either mode and is recorded.

Every record is written before any slot changes, so a failed write leaves the call as it was. The hook never returns a block.

**Named paths** are found by a deliberately simple rule, not a parser: split the task text on whitespace, strip surrounding quotes, backticks, brackets and trailing punctuation, drop URLs (`://`), and keep a word that contains a `/` or looks like a file name with an extension (`README.md`; two characters before the dot, so `e.g` is not one). First mention first, each once.

**The attempt id** is pi's `toolCallId` for the top-level slot and `<toolCallId>:<path>` for a nested slot, for example `<toolCallId>:tasks[1]`. No `subagent` call carries ticket 18's id (pi-subagents' schema has no field for one), so this is the id a verdict attaches by; the orchestrator sees it in its own tool events.

**The hand-picked model in shadow mode** is the model pi would run for a routed slot, by pi-subagents' own `resolveEffectiveSubagentModel` (`src/runs/shared/model-resolution.js:281`, which resolves an explicit model, else the agent's `model`, else the parent session's model) over pi's available models: a `subagents.defaultModel` when one is set, else the session model `ctx.model`. It is recorded as canonical `provider/id` with the thinking suffix stripped. A slot with its own model, or an agent with a pinned one, is explicit and has no hand-picked model. The live test uses an agent with no model.

## The explicit record

```json
{"recordType":"explicit","schemaVersion":"decision-record/1","attemptId":"call-1:tasks[1]","timestamp":"2026-09-26T12:00:00.000Z","cause":"explicit","mode":"live","slot":"tasks[1].model","model":"anthropic/claude-opus-5-5:high","taskTextPrefix":"Review the typo fix","agentRole":"reviewer"}
```

One record per slot. It is additive under `decision-record/1`, validated on write and read with exact keys, and is not accepted by `isRoutedDecision`: it chose no tier and no rung, so it is no report row. The report counts it nowhere (not as a decision, not as an orphan). A verdict attached to an explicit attempt id is stored as an orphaned verdict.

## Evidence

Everything the hard filters read comes from one state folder, `PI_HARNESS_STATE_DIR` or `<checkout>/harness/state` (git-ignored), resolved once at session start:

| File | Used for | When absent |
|------|----------|-------------|
| `model-catalog.json` | Context windows, prices, ticket 08's `usageHeadroom` | A catalog built once from pi's available models and the pinned models.dev snapshot |
| `refresh-state.json` | Ticket 08's throttling observations | Empty: no throttle |
| `authorized-recipients.json` | Ticket 07's approved data recipients | No recipient approved: every route refuses |
| `routing/` | The decision records the hook writes | Created on the first record |

The files are read on every routed slot, so the evidence is as current as the files.

`providerUsage` is derived by `deriveProviderUsage` (`evidence.ts`). Roll-up: a provider is out of usage when any of its catalog entries has a known `usageHeadroom` with nothing left, and throttled when any throttling observation names one of its models. Staleness: a "nothing left" holds until its `resetsAt`, else for five hours after `asOf`; a throttle holds for its `retryAfterSeconds`, else five minutes after `observedAt`. Out of usage wins over throttled.

**The allowance is the session's, not the orchestrator's task allowance.** The extension cannot see the orchestrator's task. Each pi session gets one in-memory allowance, `router-session:<session id>` at the default $5, which the classifier's hops reserve against and the router's allowance preflight checks (role `subtask`, input ceiling the task text's UTF-8 byte count). When it cannot cover a rung, that rung is removed as `allowance preflight`; with every rung removed the route refuses, the call proceeds unchanged, and the refusal is recorded. The context-window filter's `estimatedPromptTokens` is the same byte count: the task text only, not the agent's system prompt.

**The classifier call** runs inside the session (ADR 0004): `sessionClassifierModelCall` in `../routing/session-classifier-call.ts` sends each hop as one request through the session's model registry, `ctx.modelRegistry.streamSimple` (installed pi 0.87.1, `dist/core/model-registry.d.ts:36`), with `find(provider, id)` for the rung's model. It keeps ticket 23's contract: the classifier system prompt and the rubric prompt as the only message, no tools, the rung's effort clamped as `pi --thinking` clamps it (off sends no reasoning), `maxTokens` set to `CLASSIFIER_MAX_OUTPUT_TOKENS`, and the hop's timeout aborting the stream through its `AbortSignal` (the call also returns at once on abort, whether or not the provider ends the stream). The final assistant message is read by `../routing/classifier-reply.ts`, shared with the `pi -p` call, so a provider refusal is an `error` hop, out of usage and a throttle (`rate_limit`) are `out-of-usage`, and an unparseable answer is `schema-invalid`, as before; pi's reported cost settles the allowance. On the Anthropic subscription route this is the path the auth package shapes (`@gotgenes/pi-anthropic-auth`, `src/oauth-transport.ts`); pi-ai's `compat.streamSimple` is not shaped and is not used. No classifier `pi` is started. Ticket 23's `pi -p` call (`../routing/pi-classifier-call.ts`) stays for its own live test, which has no session to classify in.

## Fail open

Any failure prints exactly one line, `harness router disabled: <reason>`, and the hook stays inert for the rest of the session; the call proceeds unchanged. Tested: an unreadable settings file, a classifier model name pi does not have, a router that throws, pi-subagents' agent discovery throwing at hook time (a malformed `subagents` settings key), and an unwritable record folder. `PI_HARNESS_ROUTER_DEBUG=1` also prints the stack. A load failure of the installed entry prints the same line and pi starts without the router.

With `PI_HARNESS_ROUTER_PROBE=1` the router prints `pi-orchestration-harness router: loaded` at load, `routing enabled, mode <mode>, records <folder>` at session start, `classifier <rung> first token <ms> ms, total <ms> ms, tokens <n>, reported cost $<usd>` (or `classifier <rung> failed after <ms> ms: <reason>`) after each classifier request, and `hook <ms> ms for <n> slot(s), mode <mode>` after each routed call. The classifier line is where its tokens and pi's reported cost show, since no classifier `pi` runs.

The router never blocks: refusing a banned model stays the guard's job. With both installed, a call naming a banned model is refused by the guard; with the guard uninstalled the router records it as explicit and lets it through. pi loads the extensions directory in `readdirSync` order (`loader.js:571`), which is not guaranteed, and its runner stops at the first block. With the guard first, the router never sees a refused call. With the router first, the router records the call as explicit and lets it through, and the guard then refuses it. Both orders are tested. **An explicit record therefore means the router saw the call, not that the call ran.**

The harness consumer stops on timeout or abort, requests iterator closure without waiting, and never processes late events or requests another event. Provider transport cancellation remains cooperative: the AbortSignal and iterator closure do not guarantee that provider work or billing stops. The in-session path loses pi session-level auto-retry for retryable assistant errors; provider SDK retries may still apply, and a failed request proceeds through the classifier fallback chain. With Anthropic low thinking, `maxTokens` of 4,000 can produce a provider ceiling of 6,048 (4,000 plus the 2,048 thinking budget), while the allowance reservation remains 4,000 output tokens. This is not a bound on provider work or a guarantee of subprocess behavioral parity.

## Known limits

- **`workflowScript` calls are not routed.** A call with `workflowScript`, `workflowScriptPath`, a named `workflow` or an `action` has no slot: it passes through unchanged and nothing is recorded. The children a script starts choose their models in code the hook cannot see, so a scripted workflow bypasses routing, against story 39.
- **Installed pi-subagents 0.71.0 no longer accepts top-level `tasks` or `chain`** ("Legacy top-level chain and parallel inputs were removed; use workflowScript", `src/extension/public-execution.js:103`), and its `workflow` is a resource name, not an object with steps. The walk over `tasks[]`, `chain[]` and `workflow.steps[]` is kept as the spec asks and is exercised at seam 1 only; the live sessions use the single-agent form.
- Record redaction is best effort. The record writer replaces credential-shaped text (`Authorization:` headers, `Bearer` tokens, `sk-` and `sk-ant-` keys, `<name>=<value>` or `<name>: <value>` where the name ends in key, token, secret, password or passwd) with `[redacted]` and cuts free text to 200 characters (task) or 500 (everything else) before writing; a credential in another shape within those limits is still written. The rule is in `../routing/decision-record.ts` (`recordSafeCopy`) and "Decision record (ticket 25)" in the harness README.
- A verdict reaches a decision only through a reviewer that declares pi-subagents' `outputSchema` (ticket 25). The owner's own reviewer agent does not declare one yet; that is outside this ticket.
- The session allowance is not the orchestrator's task allowance (above).

## Activation

Install and rollback are deliberate, never import side effects, and use the guard's gate (`../activation/extension-gate.ts`):

```sh
PI_HARNESS_LIVE_MODEL=anthropic/claude-haiku-4-5 node harness/router/activate.ts install --agent-dir /path/to/throwaway-agent
PI_HARNESS_LIVE_MODEL=anthropic/claude-haiku-4-5 node harness/router/activate.ts install --agent-dir ~/.pi/agent --owner-confirm-real-agent-dir
node harness/router/activate.ts uninstall --agent-dir ~/.pi/agent --owner-confirm-real-agent-dir
```

The entry is `<agentDir>/extensions/pi-harness-router.ts`, a generated re-export of `extension.ts`. Activation requires `PI_HARNESS_LIVE_MODEL`, refuses a temporary or linked-worktree checkout, requires the owner flag for the real agent directory compared canonically (a symlinked spelling included), runs typecheck and the full suite and refuses any failure or skip, verifies the written entry, probes that it loads in real pi (`PI_HARNESS_ROUTER_PROBE=1`, no model call) and removes only its own entry on a failed verification or probe. The suite runs with `PI_HARNESS_ROUTER_ACTIVATION=1`, and a nested router activation refuses immediately. Rollback removes only the router's exact entry and leaves the guard's.

**As of 2026-09-25 the router is active in live mode** in the real agent directory, as `~/.pi/agent/extensions/pi-harness-router.ts`, installed from the durable checkout. The personal settings enable routing with `mode` `live`, the classifier at `anthropic/claude-haiku-4-5:off`, and tiers that list `openai-codex` rungs first with `anthropic` rungs as the fallback. The approved-recipients store approves `anthropic` and `openai-codex`.

- **Uninstall:** run the `uninstall` command above from the durable checkout that installed the entry (the entry's own `Remove with:` line names it). It removes only the router's entry, and only while that entry is byte-identical to what this checkout would write.
- **Stop routing without uninstalling:** set `harness.routing.mode` to `shadow` (never writes a model, but still classifies every dispatch slot that names no model: at least one Haiku request per slot (a fallback hop adds another), about 3 s and ~$0.0018 each, as measured below) or `harness.routing.enabled` to `false` (does nothing and writes nothing; this is the setting that makes no model calls). Settings are read once at `session_start`, so either change takes effect in the next session, not the current one.

## Verification

Seam 1 (`extension.test.ts`, `activate.test.ts`): the hook called directly with the classifier model call, the evidence source, the clock and the settings files faked, asserting only the call's `model` fields, whether it was blocked, and the records written; the checkbox 6 test loads the installed entries from a throwaway agent dir, with and without the guard, and runs their handlers in pi's order. The in-session classifier call has its own seam 1 (`../routing/session-classifier-call.test.ts`): a fake registry (`../fixtures/session-model-registry.ts`, `find` and a scripted `streamSimple`) drives the request, the thinking clamp, usage and cost, each error mapping and the timeout's abort, and `extension.test.ts` checks that the router uses it by default. Seam 2 (`session.test.ts`): one live session per mode on `anthropic/claude-haiku-4-5`, reading the child's resolved model from pi-subagents' `details.results[0].model` (the launch model string, `runSingleAttempt` in `src/runs/foreground/execution.js:243`, set at `:355`), asserting the record's cause is `model:anthropic/claude-haiku-4-5:off` and its probe names the off classifier and that the only `pi` launches are `--list-models` and the parent. Latency, seam 1: ten hook calls per mode with the classifier faked (the router's own time, well under a millisecond per call; printed only with `PI_HARNESS_ROUTER_PROBE=1`), and the probe's hook time in each live session.

## Latency measurement

`measure-latency.ts` is a one-off script, not a suite test:

```sh
node harness/router/measure-latency.ts --live --calls 5 --rung anthropic/claude-haiku-4-5:off
```

The classifier now runs inside the pi session, so it is measured in real sessions: the script cannot build a session model registry of its own (pi's packages do not resolve from this project, and the auth package's shaping is installed by pi when it loads the extension). Per mode it runs one `pi -p` session on `anthropic/claude-haiku-4-5` with the router installed in a throwaway agent dir and `PI_HARNESS_ROUTER_PROBE=1`. The parent calls `subagent` `--calls` times (at most ten) on an agent that does not exist: the router's hook runs in full for each call (pi runs every call's `tool_call` hook before any tool executes, pi-agent-core `dist/agent-loop.js:364-440`), then pi-subagents refuses the unknown agent inside the tool, so no child starts. The script reads the probe's hook time and the classifier's first-token and total time per call, checks that every call wrote a decision record under its tool call id and came back as the unknown-agent error, and prints the median and maximum per mode with every `pi` launch and its tokens and cost. One parent launch per mode. `--rung` selects Haiku with off, minimal, low, medium or high effort; omitted, it retains the historical low measurement default. Invalid rungs are rejected before credentials are read. Without `--live`, valid arguments print usage and spend nothing.

Measured 2026-09-25, five routed calls per mode, classifier `anthropic/claude-haiku-4-5:low`. "Before" is the same script run on a scratch copy of `main` at `9c5b592`, where the classifier is a `pi -p` child:

| Classifier | Mode | Hook median | Hook max | First token median (max) | Classifier total median (max) |
|------------|------|-------------|----------|--------------------------|-------------------------------|
| `pi -p` child (before) | shadow | 11,131.0 ms | 12,761.5 ms | not observable | not observable |
| `pi -p` child (before) | live | 10,608.3 ms | 12,818.1 ms | not observable | not observable |
| in session (after) | shadow | 10,117.6 ms | 11,666.4 ms | 601.4 ms (687.1 ms) | 10,111.8 ms (11,663.7 ms) |
| in session (after) | live | 11,027.9 ms | 12,002.0 ms | 525.9 ms (781.1 ms) | 11,024.7 ms (11,999.2 ms) |

Over all ten calls the hook's median moved from 10.8 s to 10.4 s: within the call-to-call spread. The first token arrives after about half a second; the rest is Haiku generating 540 to 960 output tokens per classification, most of them thinking at `:low`. pi's startup was not the main cost. The router's own work stays under a millisecond (seam 1).

The owner chose `anthropic/claude-haiku-4-5:off` after a follow-up through this same real in-session router (2026-09-25, five calls per mode):

| Classifier effort | Mode | Hook median | Hook max |
|-------------------|------|-------------|----------|
| `:off` | shadow | 2,762.8 ms (2.8 s) | 3,065.9 ms (3.1 s) |
| `:off` | live | 3,001.9 ms (3.0 s) | 3,346.1 ms (3.3 s) |

First token was about 0.6 s; each classification used about 1,070 tokens and ~$0.0018 in provider-reported cost. All ten decision records had cause `model:anthropic/claude-haiku-4-5:off`. These are latency measurements, not classification-quality evidence. Ticket 28's acceptance gate checks the exact six classifications (two mechanical, two standard, two critical) with off; the real router session tests also use off and assert its cause and probe. The post-fix live suite passed 872/872 with zero skipped, including the off quality gate. A reviewer-subagent probe is excluded from evidence.

The real personal settings now explicitly set `harness.routing.classifier.model` to `anthropic/claude-haiku-4-5:off` (configured at installation, 2026-09-25); `DEFAULT_CLASSIFIER_RUNG` remains unchanged. The owner chose off because removing the subprocess alone barely changed latency at low (pooled median 10.8 s to 10.4 s), while removing classifier thinking reduced the measured hook to about three seconds.

Ticket 27's figures (median 11.4 s shadow, 12.0 s live, ten calls per mode) came from the earlier version of this script, which called the hook in process with the `pi -p` classifier and no session; that is a different method, so the table above compares only its own before and after.

## Carried forward to ticket 28

- **`workflowScript` calls are not routed** (story 39 gap). Installed pi-subagents 0.71.0's only workflow forms are `workflowScript` and a named `workflow`, and both pass through unrouted, so in practice a scripted workflow bypasses routing today.
- **The approved-recipients store is a prerequisite.** Without `authorized-recipients.json` in the state folder every route refuses; nothing creates the store except `grantOwnerApproval` plus `saveAuthorization` in code.
- **The allowance is the session's, not the orchestrator's.** The router's classifier reservations and allowance preflight use one in-memory `router-session:<session id>` allowance at $5 per pi session, not the orchestrator's task allowance.
