# pi-orchestrator

A [pi](https://pi.dev) package for sessions that hand work to subagent workers. It routes each worker to a model that fits the task, keeps banned models away from workers, and makes the orchestrator check what workers changed before it builds on their work.

## What it does

- **Subagents:** a `subagents` tool that starts workers in the orchestrator's own process, in the foreground or background, at most `workerLimit` (default 4) running at once and the rest queued. Workers can be resumed, forked from the current branch, reviewed and retried. They get the orchestrator's installed extensions, including its MCP servers, `tool_search` and `codemode`.
- **Router:** serves the auto model `orchestrator/auto`. It classifies a worker's first request into a tier (mechanical, standard, elevated, critical) and sends it to a model from your tier map.
- **Guard:** enforces a ban list of models that workers may never use, and an optional ban list for the orchestrator itself.
- **Review gate:** an editing worker needs a verdict (`subagents_verdict`) from the orchestrator or an independent reviewer, depending on its tier and the gate level (`off`, `low`, `medium`, `high`, `max`).

Workers need the subagents extension: it is the supported way to start them. You can switch the router or the guard off on its own. Another subagent extension might work if its workers can resolve the virtual model `orchestrator/auto`, but that is not supported or tested.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator@v0.1.0
```

That pins a release; see [releases](https://github.com/egonm12/pi-orchestrator/releases) and [CHANGELOG.md](CHANGELOG.md). To move to a newer release, install again with its tag. To follow `main` instead, install without `@v...` and update with `pi update git:github.com/egonm12/pi-orchestrator`. How releases are made is in [docs/releasing.md](docs/releasing.md).

## Set up the orchestrator

The orchestrator is your own pi session: the one you type into. Workers it starts with the `subagents` tool run on `orchestrator/auto`, and the router picks their model. A fresh install has no tier map, no ban list and no approved providers, so until you set it up every worker runs on the orchestrator's session model. Each new session says what is missing:

```text
pi-orchestrator: not set up: no tier map (...), no approved recipients (...). Run /pi-orchestrator init.
```

### 1. Run `init`

Run `/pi-orchestrator init` in an interactive session. It walks you through:

1. **Worker ban list:** pick installed model families or type your own, with a preview of the models each entry blocks.
2. **Gate level and worker limit:** saved to your personal settings or to this project's `.pi/settings.json`.
3. **Tier map:** a starter map built from your installed models, in shadow mode. An existing map is rebuilt only when you confirm.
4. **Providers:** which providers may receive task text.

Running it again starts from your current values. Escape at any step keeps what you had.

### 2. Review the settings

`init` writes to the `orchestrator` key in `~/.pi/agent/settings.json`:

```json
{
  "orchestrator": {
    "subagentBanList": ["opus"],
    "sessionBanList": [],
    "routing": {
      "enabled": true,
      "mode": "shadow",
      "classifier": { "model": "anthropic/claude-haiku-4-5:off" },
      "tiers": {
        "mechanical": ["anthropic/claude-haiku-4-5:low"],
        "standard": ["anthropic/claude-sonnet-4-5:medium"],
        "elevated": ["anthropic/claude-sonnet-4-5:high"],
        "critical": ["anthropic/claude-sonnet-4-5:xhigh"]
      }
    },
    "subagents": { "gateLevel": "medium", "workerLimit": 4 }
  }
}
```

Each rung is `provider/model:effort`. Add `sessionBanList` entries if the orchestrator itself must never run on some models. A project's `.pi/settings.json` may replace single tiers, and `orchestrator.subagents` keys when you allow project overrides; it can never change either ban list.

### 3. Start a new session

The router and the guard read their settings at session start, so start a new session after `init` or any edit. Pick the orchestrator's model as usual: it does the planning, delegation and checking, so a capable model pays off. The session gets the orchestrator protocol in its system prompt and the `subagents`, `subagents_status`, `subagents_message` and `subagents_verdict` tools. Workers need no setup of their own.

### 4. Switch routing to live

A new tier map starts in `shadow` mode: the router classifies each worker and records which model it would have picked, but the worker still runs on the orchestrator's session model. Once the recorded choices look right, set `orchestrator.routing.mode` to `"live"` and start a new session. From then on workers run on the model the router picks.

### Change settings in a session

Use `/pi-orchestrator gate [off|low|medium|high|max]` to change the gate level for the current session, and `/pi-orchestrator workers [1-32]` to change how many workers run at once in the current session.

## Learn more

- [Reference](docs/reference.md): every tool, setting and behaviour in detail.
- [CONTEXT.md](CONTEXT.md): the domain language.
- [docs/adr](docs/adr): architectural decisions.

## Development

```sh
npm test
npm run typecheck
```
