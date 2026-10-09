# Releasing

The package is released as git tags on GitHub, with a GitHub release per tag. It is not published to npm.

## Versioning

The package follows [semantic versioning](https://semver.org/). While the version is 0.x:

- **Minor (0.2.0):** a breaking change, or a notable new feature.
- **Patch (0.1.1):** a fix or a small change that keeps settings and behaviour compatible.

## Steps

1. Check that `main` is clean and green: `git status`, `npm run typecheck`, `npm test`.
2. Move the entries under `## [Unreleased]` in `CHANGELOG.md` to a new `## [X.Y.Z] - YYYY-MM-DD` section, and update the compare links at the bottom.
3. Set `"version"` in `package.json` to `X.Y.Z`.
4. Commit: `git commit -am "chore: Release vX.Y.Z"`.
5. Tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z"`, then `git push origin main vX.Y.Z`.
6. Create the GitHub release from the changelog section: `gh release create vX.Y.Z --title vX.Y.Z --notes "..."`.

## How users get a release

- Pin a version: `pi install git:github.com/egonm12/pi-orchestrator@vX.Y.Z`. `pi update` does not move a pinned ref; install again with the new tag.
- Follow `main`: `pi install git:github.com/egonm12/pi-orchestrator`, then `pi update git:github.com/egonm12/pi-orchestrator`.
