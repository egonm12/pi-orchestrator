# Live check of quota headers and limit errors

Ticket: bean `pi-orchestrator-ugoi` (parent `pi-orchestrator-cml8`, user story 55). The owner runs this check. Its output becomes the fixtures in [`src/fixtures/usage/`](../fixtures/usage/README.md). Ticket 13 (bean `pi-orchestrator-pus9`) builds header reading on those fixtures, and only for the paths that turn out to expose headers.

`quota-capture.ts` is a pi extension. Load it with `pi -e`. It never changes a request. For every provider request in the session it writes JSONL records to one file:

| Kind | From | What it holds |
|------|------|---------------|
| `session` | `session_start` | session id, start reason, session model, whether it uses OAuth (subscription), the `transport` setting in personal and project settings |
| `request` | `before_provider_request` | a sequence number per session, the provider and model of the session model, the model named in the payload. The payload itself (prompts, tools) is never written |
| `response` | `after_provider_response` | the request in flight it belongs to (`seq`), `attempt` (1, 2, … when pi retries the same request), the HTTP `status` and every response header |
| `result` | each assistant `message_end` | `stopReason`, the full `errorMessage` of a failed request, any `diagnostics` (such as a WebSocket transport failure), and `responses`: how many `response` records that request got |

Every record has `v` (1), `kind`, `at` (ISO time) and `case` (the case label). Header names are always kept. The values of cookie and credential headers (`set-cookie`, `cookie`, `authorization`, `x-api-key` and similar) become `[redacted]`. Bearer tokens, `sk-` keys and JWTs inside any other header value or error text are redacted too. Quota headers such as `anthropic-ratelimit-tokens-remaining` are kept.

## What pi 0.87.1 exposes, read from its source

These are the paths the check has to confirm or refute. They were read from the installed pi, not measured. The files are under `node_modules/@earendil-works/pi-coding-agent/`, with `pi-ai` and `@anthropic-ai/sdk` in its own `node_modules/`:

- **Anthropic:** pi calls `after_provider_response` only once the SDK has returned a successful response (`pi-ai/dist/api/anthropic-messages.js:393-398`). The Anthropic SDK throws on a non-2xx status before that (`@anthropic-ai/sdk/client.js:584`). So a rate-limit or usage-limit refusal is expected to show up as a `result` record with error text and `responses: 0`, not as a `response` record with status 429. That would not be a capture bug.
- **OpenAI Codex, WebSocket:** with the default `transport` (`auto`), Codex goes over a WebSocket first, and that path never calls `after_provider_response` (`pi-ai/dist/api/openai-codex-responses.js:190-246`). Expect `result` records with `responses: 0`. If the WebSocket fails before the stream starts, pi falls back to SSE for the session. The `result` then carries a `provider_transport_failure` diagnostic, and the SSE responses do appear.
- **OpenAI Codex, SSE:** each HTTP attempt calls `after_provider_response`, including a 429, before pi reads the body (`openai-codex-responses.js:283`). pi's usage-limit text is "You have hit your ChatGPT usage limit (<plan> plan). Try again in ~N min." (`openai-codex-responses.js:1233-1239`).
- **Attribution:** the event carries only `status` and `headers`, not the model (`pi-coding-agent/dist/core/sdk.js:214-222`). The capture ties each response to the latest request of the same session. With `--model orchestrator/auto` the session model is `orchestrator/auto`, so `provider` reads `orchestrator` and only `payloadModel` names the real model. Use a real model for these runs.

## Before you start

- Run from the repository root. Every command below assumes these two variables:

  ```sh
  cd /Users/egonmeijers/development/sandbox/pi-extensions/pi-orchestrator
  EXT="$PWD/src/live-check/quota-capture.ts"
  OUT="$HOME/quota-capture"; mkdir -p "$OUT"
  ```

- `pi --version` should print 0.87.1, the version the source notes above were read from. Note the version in what you send back.
- Each case writes to its own file through `PI_QUOTA_CAPTURE_FILE`, and the file name is the case label. The capture appends, so a rerun adds records to the same file. Delete the file first if you want a clean run.
- Keep `retry.provider.maxRetries` at its default of 0, so a limit error is not hidden behind provider retries.
- **Cost:** every case sends one short prompt to a small model. Under Anthropic's extra usage that prompt is billed per token. A request refused because of a limit costs nothing.
- Without `PI_QUOTA_CAPTURE_FILE`, the file lands in `${PI_ORCHESTRATOR_STATE_DIR:-${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator}/live-check/quota-capture-<time>-<pid>.jsonl`, one file per pi process. pi shows the path when the session starts.

After each run, check that the file has what the case expects:

```sh
grep -c '"kind":"response"' "$OUT/<case>.jsonl"   # response records
grep '"kind":"result"' "$OUT/<case>.jsonl"         # stop reason, error text, responses count
```

## Anthropic (Claude subscription)

Your personal settings install `@gotgenes/pi-anthropic-auth`, which reshapes Claude subscription (OAuth) requests. pi's own warning says: "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits." Whether the provider treats a request as plan usage or extra usage may depend on that shaping, so capture both paths.

1. **Shaped path, the way your sessions and the orchestrator's workers run** (installed packages loaded):

   ```sh
   PI_QUOTA_CAPTURE_FILE="$OUT/anthropic-shaped-ok.jsonl" pi -e "$EXT" --no-session \
     --model anthropic/claude-haiku-4-5 --thinking low -p "Reply with the word ok."
   ```

   Expect a `session` record with `"oauth":true`, one `request`, at least one `response` with status 200 and its headers, and a `result` with `stopReason` `stop`.

2. **Plain pi, the third-party-harness case the warning is about** (`-ne` disables every installed extension. The `-e` capture still loads):

   ```sh
   PI_QUOTA_CAPTURE_FILE="$OUT/anthropic-plain.jsonl" pi -ne -e "$EXT" --no-session \
     --model anthropic/claude-haiku-4-5 --thinking low -p "Reply with the word ok."
   ```

   This request may be served from extra usage, or refused. Both outcomes are findings. A refusal leaves its error text in the `result` record. Look at https://claude.ai/settings/usage before and after, and note whether the extra-usage spend moved.

3. **The warning itself:** start plain pi interactively once and note whether the warning appears. It appears only in the interactive TUI, when an Anthropic model is selected with OAuth credentials, and when `warnings.anthropicExtraUsage` is not `false`:

   ```sh
   PI_QUOTA_CAPTURE_FILE="$OUT/anthropic-plain-tui.jsonl" pi -ne -e "$EXT" --no-session --model anthropic/claude-haiku-4-5
   ```

   Send "Reply with the word ok.", then quit.

4. **Optional, extra usage switched off:** if you are willing to change the account setting for a few minutes, turn extra usage off at https://claude.ai/settings/usage, repeat step 2 with `anthropic-plain-extra-usage-off.jsonl` and step 1 with `anthropic-shaped-extra-usage-off.jsonl` as the file, then switch it back on. This may produce the refusal pi's warning implies without spending anything. What the provider actually sends is unknown, which is why it is worth capturing. Switching the setting may affect other tools on the same account. That has not been checked.

## OpenAI Codex (ChatGPT subscription)

Use any `openai-codex` model you have (`pi --list-models codex`). The commands use `gpt-5.5`.

1. **WebSocket path** (default `transport`, `auto`):

   ```sh
   PI_QUOTA_CAPTURE_FILE="$OUT/codex-websocket-ok.jsonl" pi -e "$EXT" --no-session \
     --model openai-codex/gpt-5.5 --thinking low -p "Reply with the word ok."
   ```

   Expect a `result` with `responses: 0` and no `response` records. If `response` records appear anyway, look for a `provider_transport_failure` diagnostic in the `result`: the WebSocket failed and pi fell back to SSE.

2. **SSE path:** set the transport to SSE in personal settings. Start `pi`, open `/settings`, set **Transport** to `sse` and quit. Then run:

   ```sh
   PI_QUOTA_CAPTURE_FILE="$OUT/codex-sse-ok.jsonl" pi -e "$EXT" --no-session \
     --model openai-codex/gpt-5.5 --thinking low -p "Reply with the word ok."
   ```

   The `session` record should show `"personalTransport":"sse"`. Expect at least one `response` with status 200 and its headers. **Afterwards, set Transport back to `auto` in `/settings`.**

## Rate and usage limits

A limit cannot be triggered on demand without spending real quota, so plan for the following. Once a provider refuses because of a limit, further requests are refused too and cost nothing, so capture as many paths as you can while the limit lasts.

- **When you are near or at a limit** (claude.ai/settings/usage for Claude, the Codex usage page for ChatGPT): run the commands again with limit file names:
  - Anthropic: step 1 as `anthropic-shaped-limit.jsonl` and step 2 as `anthropic-plain-limit.jsonl`.
  - Codex: both transports, as `codex-websocket-limit.jsonl` (transport `auto`) and `codex-sse-limit.jsonl` (transport `sse`, and set it back afterwards).
- **To catch a limit during normal work,** load the capture in your everyday sessions for a while. Each pi process then writes its own file under the default path above:

  ```sh
  alias pi="PI_QUOTA_CAPTURE_CASE=daily pi -e $EXT"
  ```

  When a limit hits, run the limit commands above right away, then remove the alias. Find the limit errors with:

  ```sh
  grep -h '"errorMessage"' ~/.pi/agent/pi-orchestrator/live-check/*.jsonl
  ```

  Whether in-process subagent workers load an extension given with `-e` has not been checked. If they do, their records appear with their own `sessionId`.
- **A rate limit (throttling)** as opposed to a usage limit is unlikely to show up with single prompts. If one appears in a daily capture, keep it: it is the throttled case ticket 13 needs.
- **If no limit happens before you want to hand back,** send the normal captures only, and say so. Ticket 13 then builds error-text signals first and leaves header reading for the paths that showed headers.

## What to send back

1. Check that nothing secret leaked. This should print nothing:

   ```sh
   grep -E -i 'sk-ant|sk-proj|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{8,}\.' "$OUT"/*.jsonl
   ```

2. Pack the folder, and the daily captures if you used the alias:

   ```sh
   tar czf ~/quota-capture.tgz -C "$HOME" quota-capture
   tar czf ~/quota-capture-daily.tgz -C ~/.pi/agent/pi-orchestrator live-check   # only if you used the alias
   ```

3. Send the archive with a short note:
   - `pi --version`
   - your Claude plan (Pro or Max) and ChatGPT plan
   - whether extra usage was on, and whether its spend moved during the Anthropic steps
   - whether pi showed the extra-usage warning in step 3
   - for each limit: when it hit, and the reset time the provider's usage page showed
   - anything that failed or looked odd

The agent that picks this up then copies the relevant records into `src/fixtures/usage/` and records the findings in the bean.
