# Maintenance Fork

This repository is a downstream maintenance fork of [supreme-gg-gg/instagram-cli](https://github.com/supreme-gg-gg/instagram-cli). It keeps the full upstream history and the MIT license and copyright notice in `LICENSE`. Its `main` branch is the authoritative working version for the fork.

## Remotes

| Remote     | URL                                               | Use                            |
| ---------- | ------------------------------------------------- | ------------------------------ |
| `origin`   | `https://github.com/rugbedbugg/instagram-cli.git` | fetch and push                 |
| `upstream` | `https://github.com/supreme-gg-gg/instagram-cli`  | fetch only (push URL disabled) |

To reproduce this layout in a fresh clone of the fork:

```bash
git remote add upstream https://github.com/supreme-gg-gg/instagram-cli
git remote set-url --push upstream no_push_to_upstream
git config remote.pushDefault origin
```

The invalid push URL makes any `git push upstream ...` fail locally before contacting GitHub, while `git fetch upstream` keeps working.

## Upstream changes

Upstream work is imported deliberately, not merged wholesale:

- Fetch with `git fetch upstream` and review changes against `upstream/main`.
- Open upstream pull requests are evaluated individually; they are cherry-picked with verification or re-implemented, never merged blindly.
- History is never rewritten.

## Versioning

Versioning is conservative. The application version stays at the upstream base (`2.0.1`) until a downstream release is cut. Downstream releases use a pre-release suffix on the upstream base, starting at `2.0.1-maint.1`. Dependency upgrades are made in small, separately verified changes.

## Installing and Git hooks

`npm ci` installs dependencies and applies `patches/` through `patch-package`. It does not run Husky and does not modify Git configuration, so CI and isolated verification never depend on mutating a developer's Git setup.

Pre-commit hooks (`lint-staged` running Prettier and XO) are opt-in per clone:

```bash
npm run hooks:install
```

## Test isolation

All CLI state (config, sessions, logs, cache, downloads) lives under a single data directory resolved by `resolveDataDir()` in `source/config.ts`. It defaults to `~/.instagram-cli` and can be relocated with the `INSTAGRAM_CLI_HOME` environment variable.

AVA loads `tests/_setup-isolated-storage.ts` in every worker before any test file. It creates a fresh temporary directory, points `INSTAGRAM_CLI_HOME` at it, refuses to run if that directory would be inside the real data directory, and deletes it when the worker exits. Tests therefore never read existing sessions or write real config or logs. `tests/storage-isolation.test.ts` guards this behavior, including a check that the real config file's metadata is unchanged after a test writes config, session and log state.
