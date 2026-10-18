# Changelog

All notable changes to this package are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [semantic versioning](https://semver.org/). While the version is 0.x, a minor bump can contain breaking changes.

## [Unreleased]

### Added

- **Router:** a worker budget for mechanical and standard workers: a tool-call budget in their system prompt and no delegation tools (ADR 0021). `orchestrator.routing.workerBudget: false` turns it off.
- **Setup:** `/pi-orchestrator init` offers per-message effort for cache-safe tier models, supports custom ranges on rebuild, and configures session effort in personal settings.
- **Router:** a handling judge gives each owner prompt a `self` or `delegate` verdict (ADR 0020). It has its own setting, `orchestrator.routing.handlingJudge`, and shares the effort judge's call when both run. A failed judgement is `self`.
- **Protocol:** each prompt's verdict is a handling line in the orchestrator's system prompt.
- **Commands:** `/pi-orchestrator delegate [prompt]` and `/pi-orchestrator self [prompt]` force the handling for one prompt and skip the judge.
- **Routing log:** verdicts are written as `handling-decision` records.

### Changed

- **Subagents:** the orchestrator protocol makes doing the work itself the default (ADR 0021). It delegates for parallel parts, large work or large output, no longer past two exploratory commands.
- **Router:** the handling judge and the effort judge's combined question answer `self` by default and `delegate` only for parallel parts or large work; running for minutes is no longer a reason.
- **Router:** classifier rubric `tier-rubric-6` puts read-only fact-finding (lookups, inventories, summaries, explanations) on mechanical.
- **Router:** balanced tiers now weigh effective quota headroom, including a tighter weekly window, as well as recent provider usage counts.
- **Router:** the tier classifier defaults to `anthropic/claude-haiku-5-5:low` (was `openai-codex/gpt-6-luna:low`), the same as the effort judge. Its default fallback is `openai-codex/gpt-6-luna:low`, which the judges inherit. The effort judge's inherited fallback no longer repeats its own model.
- **Subagents:** the exploration nudge follows the handling verdict (ADR 0020, amending ADR 0013). A `self` prompt is nudged after 20 exploratory calls (ADR 0021), up from 3; a `delegate` prompt is reminded at its first exploratory call. `orchestrator.subagents.explorationNudge` now defaults to 20.

## [0.3.0] - 2026-10-11

### Added

- **Router:** dynamic rungs. A rung may give an effort band (`provider/model:low-high`) or no effort on a cache-safe model, and an effort judge picks the level for each incoming message within the band. Retries climb the band before the next rung.
- **Router:** `routing.sessionEffort` lets the orchestrator's own session move its effort within a band. `routing.effortJudge` sets the judge model, timeout and fallbacks.
- **Routing report:** effort decisions are logged as `effort-decision` records and summarized in the report.
- **Effort cache probe:** measures which models keep their prompt cache across an effort change.

### Changed

- **Breaking:** requires pi 1.1.0 or later.

## [0.2.0] - 2026-10-09

### Added

- **Review gate:** `subagents_verdict` takes a `verdicts` list, so several verdicts can be recorded in one call. The single form still works.

### Changed

- **Router:** a routed worker's tier classification starts when its session starts, overlapping the MCP connection wait, not at its first request.
- **Router:** the classifier is asked for a `why` of one short sentence, at most 120 characters (rubric `tier-rubric-4`).
- **Review gate:** working-tree snapshots run asynchronously, so they no longer stall other workers, and reuse a file's hash when its stat is unchanged.
- **Routing records:** parsed record files are cached by stat, and appended lines are parsed on their own, so repeat reads take under a millisecond.

## [0.1.0] - 2026-10-09

First tagged release.

### Added

- **Subagents:** a `subagents` tool that starts workers in the orchestrator's own process, in the foreground or background, with a worker limit and a queue. Workers can be resumed, forked, reviewed and retried, and get the orchestrator's installed extensions.
- **Router:** the auto model `orchestrator/auto`, which classifies a worker's first request into a tier and sends it to a model from your tier map.
- **Guard:** a ban list of models workers may never use, and an optional ban list for the orchestrator.
- **Review gate:** editing workers need a verdict from the orchestrator or an independent reviewer, depending on tier and gate level.
- **Setup:** `/pi-orchestrator init` walks through the ban list, gate level, worker limit, tier map and providers.
- **Worker view:** a live transcript of each worker, opened with alt+a or `/subagents`. It looks and scrolls like pi's chat, with a session picker, a message input to steer a running worker, and `PI_ORCHESTRATOR_TRANSCRIPT_TRACE` to log frame times.

[Unreleased]: https://github.com/egonm12/pi-orchestrator/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/egonm12/pi-orchestrator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/egonm12/pi-orchestrator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/egonm12/pi-orchestrator/releases/tag/v0.1.0
