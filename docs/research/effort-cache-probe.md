# Effort cache probe

Bean: pi-orchestrator-zv3l. Live run: 2026-10-09 (local time). Decision record: [ADR 0018](../adr/0018-dynamic-effort-per-incoming-message.md).

The probe asks, per model, whether an effort change made mid-conversation through the cache-safe path keeps the prompt cache, and whether a change placed after a tool_result-only turn reaches that reply. Code: `src/models/effort-cache-probe.ts` (payloads and verdicts, tested), `src/live-check/effort-cache-probe.ts` (the pi extension that swaps the payload) and `src/live-check/run-effort-cache-probe.ts` (the runner). Nothing is committed.

## Result

Each row is one model with one probe of seven requests: R1 writes the cache, R2 is the change on a new user turn, C2 its control, NC a top-level change with no per-message change, TA and TB the tool_result pair (control and change), and TH the tool_result turn at the changed top-level effort. Starting effort low, changed effort high.

| model | path | cache kept | tool_result-only change applied? | raw numbers | date |
|---|---|---|---|---|---|
| claude-haiku-5-5 | Claude per-message effort (beta `mid-conversation-output-config-2026-07-01`) | yes: R2 read 1,421 tokens, C2 read 1,421. NC also read 1,421, so the test did not discriminate (see below) | not applied: TB 86 reasoning tokens, TA 97, TH 217 (share -0.09) | R1 write 1,421; R2 reasoning 291; C2 192; NC 255; TA 97; TB 86; TH 217 | 2026-10-09 |
| claude-sonnet-5-5 | same | yes: 1,421 and 1,421. NC read 1,421, so the test did not discriminate | not applied: TB 0, TA 0, TH 61 | R1 write 1,421; R2 reasoning 114; C2 108; NC 115; TA 0; TB 0; TH 61 | 2026-10-09 |
| claude-opus-5-5 | same | yes: 1,421 and 1,421. NC read 1,421, so the test did not discriminate | inconclusive: no span to read against (TA, TB and TH all 109 output tokens) | R1 write 1,421; R2 output 106; C2 103; NC 98; TA 109; TB 109; TH 109. Reasoning was 47 on every request | 2026-10-09 |
| gpt-6-astra | OpenAI `configuration_update` input item, request-level effort unchanged | not measured: no request cached (cached 0, written 0 on 1,830 to 1,889 input tokens) | inconclusive: TA 32, TB 63, TH 35 reasoning tokens (the reference is 3 above the control) | R1 input 1,830; R2 reasoning 58; C2 36; NC 58; TA 32; TB 63; TH 35 | 2026-10-09 |
| gpt-6.1-sol | same | not measured: no request cached (cached 0, written 0 on 1,830 to 1,889). `prompt_cache_options` rejected | inconclusive: TA 35, TB 42, TH 61 (the reference is 26 above the control, under the 30 needed; share 0.27) | R1 input 1,830; R2 reasoning 64; C2 30; NC 69; TA 35; TB 42; TH 61 | 2026-10-09 |

Reading the columns: `cR` is cache read, `cW` cache write, `in` uncached input, `reasoning` the reasoning tokens (Anthropic's thinking tokens and OpenAI's reasoning tokens as pi reports them). The verdict rules are under Method.

## What the table does not show

- **The Claude cache test could not fail.** The negative control (the top-level effort changed, no per-message change) kept the cache on all three models. The docs say a top-level change restarts the cache. This probe did not reproduce that, so the "yes" shows only that the per-message change did not break a cache that the top-level change did not break either. The likely reason is the probe's history: its assistant turns are plain text, while a real session carries thinking blocks, and the docs' claim is about that case. Not measured here.
- **Single samples.** Each arm is one request. A reasoning move of a few tokens is noise. On Sonnet and Opus, the new-turn effort move is within what one sample can show. The verdicts read positions between the control and the reference, not proofs.
- **GPT-6 caching.** Neither model cached anything through the Codex route in any configuration tried (see the findings). Without a cache, "cache kept" cannot be judged. Under the ADR's rule (only models where a live pair shows the cache surviving may carry a dynamic rung), GPT-6 stays ineligible on this route.

## Findings

1. **The OAuth route accepts the per-message field and the beta.** Every Claude R2 returned a normal reply with a per-message system message in place. The docs say the same message without the beta returns a 400 ("Extra inputs are not permitted"), so the beta reached the API. This is inferred from the successful replies, not captured on the wire.
2. **A change placed after a tool_result turn did not reach that reply on Haiku or Sonnet.** This matches the docs: such a turn "doesn't count as new input" and the change "waits for the next user turn with new input". Opus gave no span to read.
3. **The Codex endpoint accepts `configuration_update` on both GPT-6 models.** No request returned an error for it. On new input the update moved reasoning as far as the top-level change did: astra 58 against 58 for NC, sol 64 against 69. Single samples.
4. **The Codex route created no prompt cache for either GPT-6 model.** Tried: the notes in `instructions` (1,199 and 1,820 input tokens); the notes as a developer message (1,830); and, on Sol only, the notes as a user message and `reasoning.context: "all_turns"`. Also `prompt_cache_options: {mode: "implicit"}`, which the docs' examples name, on both models. Both models rejected the option with `Codex error: prompt_cache_options is not supported on this model`. The raw usage of one astra request shows `cached_tokens: 0` and `cache_write_tokens: 0`, with per-item attribution at zero, so pi did not drop a cache count. Not tried: a prefix well above the documented 1,024 tokens, so a higher minimum on this route cannot be ruled out.
5. **pi 1.1.0 already sends per-message effort for these Claude models (source reading, not measured live).** `@earendil-works/pi-ai` 1.1.0 marks Haiku 5.5, Sonnet 5.5, Opus 5.5, Opus 5 and Fable 5.1 with `supportsMidConvoEffort`. For them it adds the beta, sets the top-level `output_config.effort` to `high`, and appends a `{role: "system", output_config: {effort}}` message to each request (`dist/api/anthropic-messages.js` lines 851-852, 878-879, 938-944 and 1207-1217). The ADR says pi has no such option, so the ADR may need revisiting for pi 1.1.0. The repo's dev dependency is pi 0.99.1, which this does not cover.

## Method

- **Route.** The runner runs one `pi --mode json -p --no-session` process per request, loading the probe extension with `-e`, with pi's normal settings. The extension replaces the payload in `before_provider_request`, the hook the ADR describes. pi resolves the credentials and refreshes OAuth itself, and the installed `@gotgenes/pi-anthropic-auth` (3.4.2) shapes the Anthropic subscription request as usual. The runner never reads or prints `auth.json`. It does not pass `-ne` or another agent directory, because the orchestrator guard refuses both (`src/guard/boundaries.ts`, `launchesUnguardedPi`).
- **Versions.** pi 1.1.0 (the global `pi`), `@earendil-works/pi-ai` 1.1.0.
- **Claude payload.** The identity block pi sends for an OAuth token, then the stable notes (3,200 characters, 1,421 tokens written by the first request) in the first user message with `cache_control`. Every request carries the top-level `output_config.effort: low` (NC carries high). Thinking is pi's own adaptive setting for these models, which pi sends with `block_binding` and the `thinking-binding-controls-2026-08-01` beta. The probe did not override either. The probe adds the mid-conversation beta, `tool_choice: none` and `max_tokens: 1024`.
- **GPT-6 payload.** The notes (9,000 characters, a developer message at the start of `input`, about 1,830 input tokens in all), a short constant `instructions`, `reasoning: {effort: low, summary: auto}` (the summary setting pi sends), `tool_choice: none`, and a fixed `prompt_cache_key` per model. Two earlier designs put the notes in `instructions` (1,199 and 1,820 input tokens). Neither cached, and neither did the developer-message design, so moving the notes did not produce a cache.
- **Verdicts** (pure functions in `src/models/effort-cache-probe.ts`):
  - Cache kept: yes when R2 reads at least C2's reads minus the larger of 128 tokens and 10 percent. Not measured when R1 wrote nothing or C2 read nothing.
  - Sensitivity: "discriminates" when NC reads below C2 by more than that tolerance. Otherwise "does not discriminate".
  - tool_result applied: the reply's reasoning tokens (output tokens when the provider does not report them) are placed between TA (control) and TH (the changed effort on the same request). At least two thirds of the way is applied, at most a third is not applied. A reference less than 30 tokens above the control is inconclusive.
- **Stop rule.** The runner stops at the first error reply or non-zero pi exit and prints the scrubbed error text.

## Raw numbers per request

Final runs. `in` is uncached input, `cR` cache read, `cW` cache write, `out` output, `reas` reasoning, `think` thinking characters.

Claude Haiku 5.5 (`effort-cache-probe-haiku-xoeQfG`):

| step | top-level | in | cR | cW | out | reas | think |
|---|---|---|---|---|---|---|---|
| R1 | low | 15 | 0 | 1,421 | 60 | 56 | 126 |
| R2 | low | 61 | 1,421 | 0 | 306 | 291 | 311 |
| C2 | low | 61 | 1,421 | 0 | 224 | 192 | 239 |
| NC | high | 61 | 1,421 | 0 | 287 | 255 | 230 |
| TA | low | 93 | 1,421 | 0 | 112 | 97 | 125 |
| TB | low | 93 | 1,421 | 0 | 101 | 86 | 124 |
| TH | high | 93 | 1,421 | 0 | 232 | 217 | 314 |

Claude Sonnet 5.5 (`effort-cache-probe-sonnet-wovshT`):

| step | top-level | in | cR | cW | out | reas | think |
|---|---|---|---|---|---|---|---|
| R1 | low | 15 | 0 | 1,421 | 5 | 0 | 0 |
| R2 | low | 61 | 1,421 | 0 | 169 | 114 | 250 |
| C2 | low | 61 | 1,421 | 0 | 165 | 108 | 188 |
| NC | high | 61 | 1,421 | 0 | 173 | 115 | 216 |
| TA | low | 93 | 1,421 | 0 | 66 | 0 | 0 |
| TB | low | 93 | 1,421 | 0 | 67 | 0 | 0 |
| TH | high | 93 | 1,421 | 0 | 125 | 61 | 146 |

Claude Opus 5.5 (`effort-cache-probe-opus-vieWP6`). Reasoning was 47 on every request after R1, so the output column carries the comparison:

| step | top-level | in | cR | cW | out | reas | think |
|---|---|---|---|---|---|---|---|
| R1 | low | 15 | 0 | 1,421 | 6 | 0 | 0 |
| R2 | low | 61 | 1,421 | 0 | 106 | 47 | 124 |
| C2 | low | 61 | 1,421 | 0 | 103 | 47 | 124 |
| NC | high | 61 | 1,421 | 0 | 98 | 47 | 138 |
| TA | low | 93 | 1,421 | 0 | 109 | 47 | 102 |
| TB | low | 93 | 1,421 | 0 | 109 | 47 | 144 |
| TH | high | 93 | 1,421 | 0 | 109 | 47 | 141 |

GPT-6 Astra (`effort-cache-probe-astra-NaALk2`):

| step | top-level | in | cR | cW | out | reas | think |
|---|---|---|---|---|---|---|---|
| R1 | low | 1,830 | 0 | 0 | 6 | 0 | 0 |
| R2 | low | 1,876 | 0 | 0 | 73 | 58 | 30 |
| C2 | low | 1,876 | 0 | 0 | 50 | 36 | 26 |
| NC | high | 1,876 | 0 | 0 | 71 | 58 | 27 |
| TA | low | 1,889 | 0 | 0 | 52 | 32 | 25 |
| TB | low | 1,889 | 0 | 0 | 83 | 63 | 29 |
| TH | high | 1,889 | 0 | 0 | 55 | 35 | 27 |

GPT-6.1 Sol (`effort-cache-probe-sol-eEXCA9`):

| step | top-level | in | cR | cW | out | reas | think |
|---|---|---|---|---|---|---|---|
| R1 | low | 1,830 | 0 | 0 | 6 | 0 | 0 |
| R2 | low | 1,876 | 0 | 0 | 78 | 64 | 0 |
| C2 | low | 1,876 | 0 | 0 | 44 | 30 | 421 |
| NC | high | 1,876 | 0 | 0 | 83 | 69 | 383 |
| TA | low | 1,889 | 0 | 0 | 55 | 35 | 384 |
| TB | low | 1,889 | 0 | 0 | 62 | 42 | 419 |
| TH | high | 1,889 | 0 | 0 | 81 | 61 | 454 |

The superseded first Haiku run (`effort-cache-probe-haiku-hOL5Ic`, cache on the system block) gave R1 write 1,349 and R2, C2, NC read 1,349 each, so its negative control also kept the cache.

## Live calls made

Every pi request that reached a provider, in order. Log directories are under the system temp folder (`effort-cache-probe-*`), with `calls.jsonl` and, for the diagnostic runs, `raw-usage.jsonl`.

| model | purpose | outcome | log |
|---|---|---|---|
| claude-haiku-5-5 | first probe, cache breakpoint on the system block. Superseded: NC kept the cache, so the test could not fail | 6 requests, all replied | `haiku-hOL5Ic` |
| claude-haiku-5-5 | final probe (R1, R2, C2, NC, TA, TB, TH) | 7 requests, all replied | `haiku-xoeQfG` |
| claude-sonnet-5-5 | one probe, same design | 7 requests, all replied | `sonnet-wovshT` |
| claude-opus-5-5 | one probe, same design | 7 requests, all replied | `opus-vieWP6` |
| gpt-6-astra | probe with the notes in `instructions` (1,199 input tokens). Superseded: no cache | 7 requests, all replied | `astra-rkHDZR` |
| gpt-6-astra | probe with the notes in `instructions` (1,820 input tokens). Superseded: no cache | 7 requests, all replied | `astra-kK5Stj` |
| gpt-6-astra | final probe, notes as a developer message | 7 requests, all replied, no cache | `astra-NaALk2` |
| gpt-6-astra | R1 with `prompt_cache_options: {mode: implicit}` | error: `Codex error: prompt_cache_options is not supported on this model`. Run stopped | `astra-FOpj92` |
| gpt-6-astra | R1 diagnostic with raw usage | replied, `cached_tokens` 0, `cache_write_tokens` 0 | `astra-eZnB5N` |
| gpt-6.1-sol | final probe, notes as a developer message | 7 requests, all replied, no cache | `sol-eEXCA9` |
| gpt-6.1-sol | R1 with `prompt_cache_options: {mode: implicit}` | error: same message. Run stopped | `sol-uA7ZTf` |
| gpt-6.1-sol | R1 with `reasoning.context: all_turns` | replied, no cache | `sol-vIYTfP` |
| gpt-6.1-sol | R1 with the notes as a user message and `context: all_turns` | replied, no cache | `sol-5tg2hC` |

Totals: 27 Anthropic requests (Haiku 13, Sonnet 7, Opus 7), all replied. 33 OpenAI requests, two of which returned the error above and stopped their run. One attempt never reached a provider: a pi run with a different agent directory was refused by the orchestrator guard, so the runner uses the default settings instead.

The GPT-6 runs went beyond the owner's "one probe each" because the first two designs did not cache and were replaced. The diagnostics were one request each.

## Could not measure

- **GPT-6 cache kept.** No cache formed on the Codex route in any configuration tried. A prefix well above 1,024 tokens was not tried. Whether these models cache through the OpenAI API with an API key, outside this subscription route, was not tried either.
- **Claude cache kept with thinking blocks in history.** This is the case the docs' claim is about, and the probe's text-only history does not test it. A follow-up would add the thinking blocks from R1 to later requests.
- **Opus tool_result.** The prompt produced no reasoning or output difference even at top-level high, so there was no span. A harder prompt, or a larger effort contrast, would be needed.
- **Sonnet and Opus new-turn effect.** The change on a new turn did not visibly move the reply on either model in one sample. Sonnet's R2 reasoning was 114, against 108 for C2 and 115 for NC. Opus reported 47 on every request. The per-message change is not confirmed on those two models.

## Reproduce

```sh
node src/live-check/run-effort-cache-probe.ts haiku --confirm
```

The `--confirm` flag is required because each run spends model quota. The runner prints the per-request log path first, then one line per request and the three verdicts. `--only=R1` runs a single request as a diagnostic and prints no verdicts. The tests run offline with `node --test src/models/effort-cache-probe.test.ts`.
