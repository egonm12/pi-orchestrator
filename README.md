# pi-orchestrator

A [pi](https://pi.dev) package for sessions that hand work to helpers. Your session plans the work and checks the results. For bigger jobs it starts workers, and pi-orchestrator picks a model for each worker that fits the task. It also keeps banned models away from workers and makes you check what they changed before you build on it.

## How it works

- **Orchestrator:** your own pi session. It plans, delegates and checks.
- **Workers:** helpers started with the `subagents` tool. A few run at once, the rest wait in line.
- **Router:** picks each worker's model from your tier map, based on how hard the task looks.
- **Judges:** small model calls that pick the thinking effort for each message and decide whether a prompt is better handled by the orchestrator or delegated.
- **Review gate:** an editing worker's changes need a verdict before the orchestrator builds on them.

The tier classifier, effort judge and handling judge all default to `anthropic/claude-haiku-5-5:low`. You can change them in settings.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator@v0.3.0
```

You need pi 1.1.0 or later. This pins release v0.3.0. To follow `main` instead, install without the `@v0.3.0` tag and update with `pi update git:github.com/egonm12/pi-orchestrator`. See [releases](https://github.com/egonm12/pi-orchestrator/releases) and [CHANGELOG.md](CHANGELOG.md) for what changed.

## Quick start

1. Run `/pi-orchestrator init` in an interactive session. It asks about a ban list, the review gate, the worker limit, a starter tier map, effort and the providers that may receive your task text. Escape keeps your current value at any step.
2. Start a new session. Settings are read when a session starts.
3. Let the tier map run in `shadow` mode for a while. The router records the model it would pick, but workers still run on your session model.
4. When the recorded choices look right, set `orchestrator.routing.mode` to `"live"` and start a new session again.

Until you run init, every worker runs on your session model. A new session tells you what is still missing.

Init writes to the `orchestrator` key in `~/.pi/agent/settings.json`. A project's `.pi/settings.json` can override some keys, but it can never change the ban lists. See [Settings](docs/reference.md#settings) and [Tier map](docs/reference.md#tier-map).

## Everyday commands

- `/pi-orchestrator gate [off|low|medium|high|max]`: change the review gate for this session.
- `/pi-orchestrator workers [1-32]`: change how many workers run at once for this session.
- `/pi-orchestrator delegate [prompt]` or `/pi-orchestrator self [prompt]`: decide how one prompt is handled, skipping the handling judge.
- `alt+a` or `/subagents`: open the worker view.

Changes to settings files need a new session. The commands above apply to the current session only.

## Learn more

- [Reference](docs/reference.md): every tool, setting and behaviour. Good starting points are [How routing decides](docs/reference.md#how-routing-decides), [Routing report](docs/reference.md#routing-report) and [Gate level](docs/reference.md#gate-level).
- [CONTEXT.md](CONTEXT.md): the domain language.
- [docs/adr](docs/adr): architectural decisions.

## Development

```sh
npm test
npm run typecheck
```
