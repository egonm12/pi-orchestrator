# pi-orchestrator

A [pi](https://pi.dev) package with two extensions for sessions that delegate work to workers:

- **Router extension**: serves the auto model `orchestrator/auto`. It classifies a worker's first request into a tier and routes it to a rung from your tier map.
- **Guard**: enforces a personal subagent ban list for workers and an optional session ban list for the orchestrator.

The two are independent. You can switch either off without touching the other.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator
```

Or from a local checkout:

```sh
pi install ~/path/to/pi-orchestrator
```

Use any subagent extension that can start workers on `orchestrator/auto`. For background workers, install pi-orchestrator as a package, not just with `pi -e`: their separate process loads installed packages. The package has no runtime dependencies of its own.

## Set up with `init`

A fresh install ships no tier map, no ban list and no approved recipients, so routing is not enabled yet. At session start the notice names what is missing and shows the worker setup step:

```text
pi-orchestrator: not set up: no tier map (...), no approved recipients (...). Run /pi-orchestrator init.
pi-orchestrator: make orchestrator/auto the default worker model in your subagent extension (for example, subagents.defaultModel in pi-subagents settings).
```

Run `/pi-orchestrator init` in an interactive session. It:

1. Asks which models workers may never use (comma-separated substrings, such as `fable, astra`, or empty for none).
2. Writes a starter tier map from your installed models into personal settings, in **shadow** mode, together with the ban list. An existing tier map, classifier or ban list is never replaced.
3. Asks you to approve each provider the map would send task text to. Only the providers you say yes to are approved. A declined provider's rungs are skipped.
4. Tells you to make `orchestrator/auto` the default worker model in your subagent extension, for example `subagents.defaultModel` in pi-subagents settings. Init does not edit that extension's settings.

Review the written map in `~/.pi/agent/settings.json`, set the default worker model in your subagent extension, then start a new session.

## Settings

pi-orchestrator settings live under the `orchestrator` key in personal settings, `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`. The extensions read them at session start, so a change needs a new session.

```json
{
  "orchestrator": {
    "subagentBanList": ["fable", "astra"],
    "sessionBanList": [],
    "routing": {
      "enabled": true,
      "mode": "shadow",
      "classifier": { "model": "anthropic/claude-haiku-4-5:off", "timeoutMs": 30000, "fallback": [] },
      "tiers": {
        "mechanical": ["anthropic/claude-haiku-4-5:low"],
        "standard": ["anthropic/claude-sonnet-5:medium"],
        "elevated": ["anthropic/claude-opus-5:high"],
        "critical": ["anthropic/claude-opus-5:xhigh"]
      }
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `subagentBanList` | Case-insensitive substrings of model ids that workers may never use. The guard refuses explicitly named banned models, and the router extension excludes them from the tier map and fallback. Empty when absent |
| `sessionBanList` | The same rule for the orchestrator's session model. While the session runs on a banned model, no turn runs. Empty when absent |
| `routing.enabled` | `true` switches routing on. Absent or `false`: a worker on the auto model runs on the orchestrator's session model without a decision record |
| `routing.mode` | `shadow` (the default) records a shadow decision while the worker runs on the orchestrator's session model. `live` runs the worker on the chosen rung |
| `routing.classifier` | The model that classifies each task, with its timeout and fallbacks. Every rung must name an installed model |
| `routing.tiers` | Four tiers, each a list of `provider/model:effort` rungs tried in order |

A project's `.pi/settings.json` may replace individual tiers under `orchestrator.routing.tiers`, and nothing else. A project cannot change either ban list. The guard logs each ignored key once.

### How routing decides

A worker started on the auto model is identified by its pi session id (its delegation id). The router extension classifies its first request from the task text, agent role and named file paths. Keyword signals (credentials, security, destructive operations) set a minimum tier. The first rung that passes the hard filters (subagent ban list, allowed-model list, installed model, approved recipient, usage limits, context window and task allowance) is chosen. If no rung survives, routing escalates through higher tiers, then refuses.

The worker keeps that rung as its pin across later requests and compaction. In live mode, a resumed worker can restore its pin from the decision record if the rung still passes the hard filters. The auto model declares the largest context window in the tier map; an overflow on the pinned rung lets pi compact and retry on that rung. A compaction summary has a new session id and is classified separately. The classifier runs in the worker's process through its session model registry, without an extra `pi` process.

In live mode the worker runs on the chosen rung. In shadow mode the router extension records the shadow decision, but the worker runs on the orchestrator's session model. A routing refusal, disabled routing or an internal routing failure also runs the worker on that model. The router extension sets `PI_ORCHESTRATOR_SESSION_MODEL` from the orchestrator's session model, including for a background worker at delegation time. If that variable is missing or names a model on the subagent ban list, the auto model request fails with a reason instead. A worker started on a real model is not routed; the guard still enforces the subagent ban list.

The orchestrator's main thread stays on the model picked in `/model`. Selecting `orchestrator/auto` there restores the previous model and warns; a saved `orchestrator/auto` default is also put back to the previous model. Without a previous model, it only warns, and the saved default stays unchanged. Only workers should run on the auto model.

## State

Runtime state lives in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator/`, or in `PI_ORCHESTRATOR_STATE_DIR` when set. Nothing is written inside the package checkout.

| File | Contents | When absent |
|------|----------|-------------|
| `authorized-recipients.json` | Providers you approved as data recipients | No provider is approved, so every route refuses |
| `routing/*.jsonl` | One decision record per classified worker session (delegation id), one file per day | Created on the first record |
| `model-catalog.json` | Prices, context windows and usage headroom | Built from installed models and a pinned models.dev snapshot |
| `refresh-state.json` | Throttling observations | No throttle |

Decision records keep the first 200 characters of the task text, with credential-shaped text redacted. The redaction is best effort.

## Switching things off

- **Routing only**: set `orchestrator.routing.enabled` to `false` for the session-model fallback without records, or use `mode: "shadow"` to keep shadow decisions while workers run on the session model.
- **One extension**: filter the package in settings, or use `pi config`:

  ```json
  { "packages": [{ "source": "git:github.com/egonm12/pi-orchestrator", "extensions": ["!src/router/extension.ts"] }] }
  ```

  Use `!src/guard/extension.ts` to keep the router and drop the guard.
- **Everything, for one run**: `pi --no-extensions`.
- **Uninstall**: `pi remove git:github.com/egonm12/pi-orchestrator`.

## Fail open

An internal routing failure prints one `pi-orchestrator router disabled: <reason>` line and sends auto model requests to the orchestrator's session model. If that model is unknown or on the subagent ban list, the request fails with a reason. The guard prints `pi-orchestrator guard disabled: <reason>` on an internal failure and stays inert. The guard refuses explicitly named banned worker models.

Debug and probe switches:

| Variable | Effect |
|----------|--------|
| `PI_ORCHESTRATOR_ROUTER_PROBE=1` | Print load, routing mode, classifier timings and each request's rung, pin and timing |
| `PI_ORCHESTRATOR_GUARD_PROBE=1` | Print load and the effective ban lists |
| `PI_ORCHESTRATOR_ROUTER_DEBUG=1`, `PI_ORCHESTRATOR_GUARD_DEBUG=1` | Print the stack on a failure |

## What the guard does not do

The guard protects against accidental mistakes, not a determined agent. It refuses banned models in `model` fields (including nested delegations), `write` and `edit` paths inside the agent directory, and nested `pi` runs that disable extensions or switch agent directory. Bash can still write anywhere, and other extensions' processes are not checked.

## Known limits

- A worker started on a real model is not routed. A workflow's workers are routed only if the subagent extension starts them on `orchestrator/auto`.
- The task allowance is per session ($5 by default), not shared between the orchestrator and background workers.

## Development

```sh
npm install
npm test            # offline
npm run typecheck
PI_ORCHESTRATOR_LIVE=1 npm test   # also runs live pi sessions; needs credentials and spends usage
```

Domain vocabulary is in [CONTEXT.md](CONTEXT.md), and design decisions are in [docs/adr/](docs/adr/).
