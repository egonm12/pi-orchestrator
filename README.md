# pi-orchestrator

A [pi](https://pi.dev) package for sessions that hand work to subagent workers. It routes each worker to a model that fits the task, keeps banned models away from workers, and makes the orchestrator check what workers changed before it builds on their work.

## What it does

- **Subagents:** a `subagents` tool that starts workers in the orchestrator's own process, in the foreground or background, at most `workerLimit` (default 4) running at once and the rest queued. Workers can be resumed, forked from the current branch, reviewed and retried.
- **Router:** serves the auto model `orchestrator/auto`. It classifies a worker's first request into a tier (mechanical, standard, elevated, critical) and sends it to a model from your tier map.
- **Guard:** enforces a ban list of models that workers may never use, and an optional ban list for the orchestrator itself.
- **Review gate:** an editing worker needs a verdict (`subagents_verdict`) from the orchestrator or an independent reviewer, depending on its tier and the gate level (`low`, `medium`, `high`, `max`).

The three extensions are independent. You can switch any one off without touching the others.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator
```

## Set up

Run `/pi-orchestrator init` in an interactive session. It asks for your worker ban list (pick installed model families or type your own, starting from your current list, with a preview of the models each entry blocks), writes a starter tier map from your installed models in shadow mode, and asks which providers may receive task text. Review the result in `~/.pi/agent/settings.json` and start a new session.

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
