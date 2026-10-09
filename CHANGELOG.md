# Changelog

All notable changes to this package are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [semantic versioning](https://semver.org/). While the version is 0.x, a minor bump can contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-10-09

First tagged release.

### Added

- **Subagents:** a `subagents` tool that starts workers in the orchestrator's own process, in the foreground or background, with a worker limit and a queue. Workers can be resumed, forked, reviewed and retried, and get the orchestrator's installed extensions.
- **Router:** the auto model `orchestrator/auto`, which classifies a worker's first request into a tier and sends it to a model from your tier map.
- **Guard:** a ban list of models workers may never use, and an optional ban list for the orchestrator.
- **Review gate:** editing workers need a verdict from the orchestrator or an independent reviewer, depending on tier and gate level.
- **Setup:** `/pi-orchestrator init` walks through the ban list, gate level, worker limit, tier map and providers.
- **Worker view:** a live transcript of each worker, opened with alt+a or `/subagents`. It looks and scrolls like pi's chat, with a session picker, a message input to steer a running worker, and `PI_ORCHESTRATOR_TRANSCRIPT_TRACE` to log frame times.

[Unreleased]: https://github.com/egonm12/pi-orchestrator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/egonm12/pi-orchestrator/releases/tag/v0.1.0
