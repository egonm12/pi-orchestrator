# pi-orchestrator

A [pi](https://pi.dev) package with three extensions for sessions that delegate work to workers:

- **Subagents**: the built-in `subagents` tool. It starts workers in the orchestrator's own process, on the auto model `orchestrator/auto`.
- **Router extension**: serves the auto model `orchestrator/auto`. It classifies a worker's first request into a tier and routes it to a rung from your tier map.
- **Guard**: enforces a personal subagent ban list for workers and an optional session ban list for the orchestrator.

The three are independent. You can switch any one off without touching the others.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator
```

Or from a local checkout:

```sh
pi install ~/path/to/pi-orchestrator
```

The package ships its own `subagents` tool (see below), so an orchestrator session needs no separate subagent extension to start workers. Other subagent extensions that start workers on `orchestrator/auto` still work and are still routed; use one for background workers, chains, resume or nested delegation, which the built-in tool does not do yet. For background workers, install pi-orchestrator as a package, not just with `pi -e`: their separate process loads installed packages. The package has no runtime dependencies of its own.

## Set up with `init`

A fresh install ships no tier map, no ban list and no approved recipients, so routing is not enabled yet. At session start the notice names what is missing:

```text
pi-orchestrator: not set up: no tier map (...), no approved recipients (...). Run /pi-orchestrator init.
```

Run `/pi-orchestrator init` in an interactive session. It:

1. Asks which models workers may never use (comma-separated substrings, such as `fable, astra`, or empty for none).
2. Writes a starter tier map from your installed models into personal settings, in **shadow** mode, together with the ban list. An existing tier map, classifier or ban list is never replaced.
3. Asks you to approve each provider the map would send task text to. Only the providers you say yes to are approved. A declined provider's rungs are skipped.

Review the written map in `~/.pi/agent/settings.json`, then start a new session. Workers started through the built-in `subagents` tool always run on `orchestrator/auto` already; nothing else needs setting up for them.

## Subagents tool

The `subagents` tool starts workers in the orchestrator's own process, by default on the auto model `orchestrator/auto`. One call takes 1 to 8 items:

```json
{ "items": [
  { "task": "Fix the typo in README.md" },
  { "task": "Add a test for the new validation rule", "agent": "reviewer" }
] }
```

Each item's `task` is the whole task for that worker, with every fact it needs: a worker sees nothing else. `agent` is optional; see Agent definitions below. At most `orchestrator.subagents.maxParallel` items (default 4) run at once, the rest queue. The orchestrator waits for every item; Ctrl+C aborts running workers and drops queued ones.

Each item's result has a status:

| Status | Meaning |
|--------|---------|
| `completed` | The worker finished and returned its final text |
| `failed` | The worker's model call or setup failed, or the item names an unknown agent and no worker started; the result names why |
| `aborted` | The item's worker was running when the call was aborted |
| `not-started` | The item was still queued when the call was aborted |

A worker's session is saved under the orchestrator's session folder, and its session id is its delegation id. It loads the same installed extensions as the orchestrator, without the `subagents` tool itself unless its agent definition lists it (see Nested delegation below). A worker's final text over 50 KB is cut, with a pointer to its session file, which keeps the whole text.

While a call runs, pi shows one line per worker: its agent name (`worker` without one), its short task, and its current tool or state: queued, running, done, error, aborted or not started. A worker on a preserved model also shows that model, marked `(ban-list exception)` when the exception let it run. Expanding the result shows each worker's final text or error.

### Agent definitions

An item's `agent` name picks a named, owner-written kind of worker: its instructions and the tools it may use. Agent definitions are markdown files with frontmatter (`name`, `description`, `tools`, `model`, `thinking`) and a body of instructions, read from `~/.pi/agent/agents/` and the project's `.pi/agents/`. A project's definition wins by name. `model` (`provider/model`, optionally with `:effort`) and `thinking` apply only when `agentDefinitionModel.use` is `"preserve"` (see below). A `tools:` list only narrows the orchestrator's tool set for that worker; it cannot add a tool the orchestrator itself does not have. Each definition's name and description are listed in the subagents tool's description at session start. `agent` is optional in a call: without it, a worker gets pi's default tools plus extension tools (except `subagents`) and no agent-specific instructions. pi-orchestrator ships no built-in definitions; the owner writes them.

### Nested delegation

A worker may start workers of its own only when its agent definition lists `subagents` in `tools:`. That is one level deep: the workers it starts never get the `subagents` tool, even when their own definition lists it. A worker's call is foreground only; asking for a background call fails the call before any worker starts. Its workers always run on the auto model and are routed, even when `agentDefinitionModel.use` is `"preserve"` and their definition names a model. Each of its calls has its own `maxParallel` limit, read from the same settings. The decision record of a worker started by another worker has `parentDelegationId`: the delegation id of the worker that started it.

### `orchestrator.subagents` settings

```json
{
  "orchestrator": {
    "subagents": {
      "maxParallel": 4,
      "agentDefinitionModel": { "use": "route", "allowBanned": false },
      "allowProjectOverrides": false
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `subagents.maxParallel` | At most this many of one call's items run at once; the rest queue. Default 4 |
| `subagents.agentDefinitionModel.use` | `"route"` (the default) ignores an agent definition's `model` and `thinking`, with one warning, and routes the worker as usual. `"preserve"` runs a worker whose definition names a model on that model and thinking, unrouted, and writes an agent-model record (delegation id, agent name, definition file, model, effort). A definition without a model is routed either way |
| `subagents.agentDefinitionModel.allowBanned` | Default `false`. With `"preserve"`, a worker whose agent definition names a model on the subagent ban list runs on it; with `false`, that item fails before a worker starts. For a definition from the project's `.pi/agents/` this also needs `allowProjectOverrides` in personal settings. With that flag on, a project's `agentDefinitionModel` replaces the personal one, `allowBanned` included. When the exception lets a worker run, its agent-model record gets `banListException: true`, its item result gets `banListException: true`, and its line is marked `(ban-list exception)`. The guard and the router extension do not stop such a worker. Under `"route"`, a `true` value has no effect and warns once per session. Every other path still refuses a banned model: the tier map drops its rungs, and the guard refuses a tool call that names it |
| `subagents.allowProjectOverrides` | Personal settings only, default `false`. Lets a project's `.pi/settings.json` set every `orchestrator.subagents` key except this one. A project key replaces the personal value whole: a project's `agentDefinitionModel` replaces the personal object, it is not merged into it. Without the flag every project `orchestrator.subagents` key is ignored; with it, a project value for the flag itself is ignored. Each ignored key is logged once to stderr, as `pi-orchestrator subagents: ignored project settings key <key>`, the way the guard logs ignored ban-list keys |

## Settings

pi-orchestrator settings live under the `orchestrator` key in personal settings, `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`. The guard and the router extension read them at session start, so a change to their keys needs a new session. The subagents extension reads `orchestrator.subagents`, the subagent ban list and the agent definitions on every call.

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

A project's `.pi/settings.json` may replace individual tiers under `orchestrator.routing.tiers`, and, when personal settings switch `orchestrator.subagents.allowProjectOverrides` on, `orchestrator.subagents` keys; nothing else. A project cannot change either ban list. The guard logs each ignored key once.

### How routing decides

A worker started on the auto model is identified by its pi session id (its delegation id). The router extension classifies its first request from the task text, agent role and named file paths. The task text is the first user message, the delegated prompt; context that other extensions append to the request is not part of it. Keyword signals (credentials, security, destructive operations) set a minimum tier. The first rung that passes the hard filters (subagent ban list, allowed-model list, installed model, approved recipient, usage limits, context window and task allowance) is chosen. If no rung survives, routing escalates through higher tiers, then refuses.

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

  Use `!src/guard/extension.ts` to keep the router and drop the guard, or `!src/subagents/extension.ts` to drop only the built-in `subagents` tool and keep routing for other subagent extensions.
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

The guard protects against accidental mistakes, not a determined agent. It refuses banned models in `model` fields (including nested delegations), `write` and `edit` paths inside the agent directory (except its `sessions/` subtree, where subagent extensions keep run artifacts), and nested `pi` runs that disable extensions or switch agent directory. Bash can still write anywhere, and other extensions' processes are not checked.

## Known limits

- A worker started on a real model is not routed. A workflow's workers are routed only if the subagent extension starts them on `orchestrator/auto`.
- The task allowance is per session ($5 by default), not shared between the orchestrator and background workers.
- The built-in `subagents` tool runs one call to its end in the orchestrator's own process; it has no background workers, chains, resume or nested delegation yet (workers do not get the `subagents` tool). Use another subagent extension for those.

## Development

```sh
npm install
npm test            # offline
npm run typecheck
PI_ORCHESTRATOR_LIVE=1 npm test   # also runs live pi sessions; needs credentials and spends usage
```

Domain vocabulary is in [CONTEXT.md](CONTEXT.md), and design decisions are in [docs/adr/](docs/adr/).
