# pi-orchestrator

A [pi](https://pi.dev) package with two extensions for sessions that delegate work to workers through pi-subagents:

- **Router**: when a `subagent` call names no model, it classifies the task into a risk tier and fills in a model from your tier map.
- **Guard**: a personal ban list. It refuses delegations to models you never want workers to use, and it can refuse a session model too.

The two are independent. You can switch either off without touching the other.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator
```

Or from a local checkout:

```sh
pi install ~/path/to/pi-orchestrator
```

The package needs pi-subagents to be installed for the `subagent` tool. It has no runtime dependencies of its own.

## Set up with `init`

A fresh install ships no tier map, no ban list and no approved recipients, so the router does nothing yet. At session start it prints one line naming what is missing:

```text
pi-orchestrator: not set up: no tier map (...), no approved recipients (...). Run /pi-orchestrator init.
```

Run `/pi-orchestrator init` in an interactive session. It:

1. Asks which models workers may never use (comma-separated substrings, such as `fable, astra`, or empty for none).
2. Writes a starter tier map from your installed models into personal settings, in **shadow** mode, together with the ban list. An existing tier map, classifier or ban list is never replaced.
3. Asks you to approve each provider the map would send task text to. Only the providers you say yes to are approved. A declined provider's rungs are skipped.

Review the written map in `~/.pi/agent/settings.json`, then start a new session.

## Settings

Everything lives under the `orchestrator` key in personal settings, `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`. The extensions read it at session start, so a change needs a new session.

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
| `subagentBanList` | Case-insensitive substrings of model ids that workers may never use. The guard refuses a `subagent` call naming one, and the router never picks one. Empty when absent |
| `sessionBanList` | The same rule for your own session model. While the session runs on a banned model, no turn runs. Empty when absent |
| `routing.enabled` | `true` switches routing on. Absent or `false`: the router does nothing and writes nothing |
| `routing.mode` | `shadow` (the default) classifies and records but never changes a call. `live` writes the chosen rung into the call |
| `routing.classifier` | The model that classifies each task, with its timeout and fallbacks. Every rung must name an installed model |
| `routing.tiers` | Four tiers, each a list of `provider/model:effort` rungs tried in order |

A project's `.pi/settings.json` may replace individual tiers under `orchestrator.routing.tiers`, and nothing else. A project cannot change either ban list. The guard logs each ignored key once.

### How routing decides

For each delegation in a `subagent` call:

- A delegation that names a model, or whose agent definition pins one in frontmatter, is left alone and recorded as explicit.
- Otherwise the classifier reads the task text, the agent role and the file paths the task names, and picks a tier. Keyword signals (credentials, security, destructive operations) set a floor it cannot go below.
- The router then takes the first rung in that tier that passes the hard filters: ban list, allowed-model list, installed, approved recipient, provider usage, context window and allowance. If none passes, it escalates to the next tier and, failing that, refuses. A refusal leaves the call unchanged.

The classifier runs inside your session, through its own model registry, so no extra `pi` process starts.

## State

Runtime state lives in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator/`, or in `PI_ORCHESTRATOR_STATE_DIR` when set. Nothing is written inside the package checkout.

| File | Contents | When absent |
|------|----------|-------------|
| `authorized-recipients.json` | Providers you approved as data recipients | No provider is approved, so every route refuses |
| `routing/*.jsonl` | One decision record per delegation, one file per day | Created on the first record |
| `model-catalog.json` | Prices, context windows and usage headroom | Built from installed models and a pinned models.dev snapshot |
| `refresh-state.json` | Throttling observations | No throttle |

Decision records keep the first 200 characters of the task text, with credential-shaped text redacted. The redaction is best effort.

## Switching things off

- **Routing only**: set `orchestrator.routing.enabled` to `false`, or use `mode: "shadow"` to keep records without changing calls.
- **One extension**: filter the package in settings, or use `pi config`:

  ```json
  { "packages": [{ "source": "git:github.com/egonm12/pi-orchestrator", "extensions": ["!src/router/extension.ts"] }] }
  ```

  Use `!src/guard/extension.ts` to keep the router and drop the guard.
- **Everything, for one run**: `pi --no-extensions`.
- **Uninstall**: `pi remove git:github.com/egonm12/pi-orchestrator`.

## Fail open

Neither extension can break a session. If a handler fails, it prints one line (`pi-orchestrator router disabled: <reason>` or `pi-orchestrator guard disabled: <reason>`), stays inert for the rest of the session and lets the call through. The router never blocks a call. Refusing a banned model is the guard's job.

Debug and probe switches:

| Variable | Effect |
|----------|--------|
| `PI_ORCHESTRATOR_ROUTER_PROBE=1` | Print load, routing mode, classifier timings and hook timings |
| `PI_ORCHESTRATOR_GUARD_PROBE=1` | Print load and the effective ban lists |
| `PI_ORCHESTRATOR_ROUTER_DEBUG=1`, `PI_ORCHESTRATOR_GUARD_DEBUG=1` | Print the stack on a failure |

## What the guard does not do

The guard protects against accidental mistakes, not a determined agent. It refuses banned models in `model` fields (including nested delegations), `write` and `edit` paths inside the agent directory, and nested `pi` runs that disable extensions or switch agent directory. Bash can still write anywhere, and other extensions' processes are not checked.

## Known limits

- `workflowScript` calls and named workflows are not routed. The children a script starts choose their models in code the router cannot see.
- The allowance is per session ($5 by default), not per orchestrator task.
- The router reimplements the parts of pi-subagents 0.71.0 it needs to find agent definitions (pi loads packages with separate module roots). It scans the global npm root for agent packages as 0.71.0 does, except when `PI_OFFLINE` is set.

## Development

```sh
npm install
npm test            # offline
npm run typecheck
PI_ORCHESTRATOR_LIVE=1 npm test   # also runs live pi sessions; needs credentials and spends usage
```

Domain vocabulary is in [CONTEXT.md](CONTEXT.md), and design decisions are in [docs/adr/](docs/adr/).
