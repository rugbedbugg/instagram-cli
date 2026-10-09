# Maintaining Instagram-CLI

Instagram-CLI is independently maintained at [rugbedbugg/Instagram-CLI](https://github.com/rugbedbugg/Instagram-CLI), derived from [supreme-gg-gg/instagram-cli](https://github.com/supreme-gg-gg/instagram-cli). It keeps the full upstream history and the original MIT license and copyright notice in `LICENSE`. Its `main` branch is the authoritative version of this maintained implementation.

```text
upstream ancestry
    ↓
Instagram-CLI maintained implementation
    ↓
downstream compatibility and security layer
    ↓
downstream releases (planned; none published yet)
```

Upstream contributions remain part of the project. Independent maintenance means taking responsibility for compatibility, safety, tests, and release decisions; it does not replace upstream authorship. Live authentication is currently degraded and awaits revalidation.

## Remotes

| Remote     | URL                                               | Use                            |
| ---------- | ------------------------------------------------- | ------------------------------ |
| `origin`   | `https://github.com/rugbedbugg/Instagram-CLI.git` | fetch and push                 |
| `upstream` | `https://github.com/supreme-gg-gg/instagram-cli`  | fetch only (push URL disabled) |

To reproduce this layout in a fresh clone of the maintained repository:

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

Versioning remains conservative. The application version stays at the inherited base (`2.0.1`) until a downstream release is cut. The existing plan starts downstream releases at `2.0.1-maint.1`; the rebrand does not create a version, tag, or release. Dependency upgrades are made in small, separately verified changes.

The npm package identity is `insta-cli`. Its canonical executable is `insta-cli`, with `instagram-cli` pointing to the same entry point for compatibility. `version` reports `Instagram-CLI (insta-cli)`; `--version` remains numeric. Persistent paths, `INSTAGRAM_CLI_HOME`, API identifiers, and internal module names are unchanged.

## Installing and Git hooks

`npm ci` installs dependencies and applies `patches/` through `patch-package`. It does not run Husky and does not modify Git configuration, so CI and isolated verification never depend on mutating a developer's Git setup.

Pre-commit hooks (`lint-staged` running Prettier and XO) are opt-in per clone:

```bash
npm run hooks:install
```

## Test isolation

All CLI state (config, sessions, logs, cache, downloads) lives under a single data directory resolved by `resolveDataDir()` in `source/config.ts`. It defaults to `~/.instagram-cli` and can be relocated with the `INSTAGRAM_CLI_HOME` environment variable.

AVA loads `tests/_setup-isolated-storage.ts` in every worker before any test file. It creates a fresh temporary directory, points `INSTAGRAM_CLI_HOME` at it, refuses to run if that directory would be inside the real data directory, and deletes it when the worker exits. Tests therefore never read existing sessions or write real config or logs. `tests/storage-isolation.test.ts` guards this behavior, including a check that the real config file's metadata is unchanged after a test writes config, session and log state.

## Publishing

The maintained implementation does not publish anything yet, and it must never publish to upstream-owned infrastructure:

- `.github/workflows/publish-ts.yml` (upstream npm `@i7m/instagram-cli` and `supreme-gg-gg/homebrew-tap`) and `.github/workflows/publish-python.yml` (upstream PyPI) are kept for reference, but their jobs only run when `github.repository == 'supreme-gg-gg/instagram-cli'`. Tags and manual runs in this downstream skip them. Never change those guards to the downstream repository name.
- `package.json` keeps `"private": true` to block accidental npm publication.
- The legacy `snap/snapcraft.yaml` installs upstream 1.4.0 with its historical runtime and package paths; it does not package this checkout. The Python metadata also retains its historical package identity. Neither is advertised as a downstream installation method.

To introduce a downstream release pipeline later:

1. Verify registry ownership and availability for the requested `insta-cli` name. A read-only npm lookup during the rebrand returned 404, which is not proof of registration rights. Do not silently substitute a scoped package. Revalidate service compatibility before a release.
2. Remove `"private": true` only in that change.
3. In that separately approved release change, add a new workflow using a downstream-specific tag pattern (for example `downstream-v2.0.1-maint.1`) that matches neither upstream `ts-v*` nor `v*` tags. Gate it on `github.repository == 'rugbedbugg/Instagram-CLI'` and a protected environment with approval. No downstream publishing workflow exists yet.
4. Require the TypeScript preflight to pass on the tagged commit, publish with npm provenance, and verify the published tarball afterwards.

## Repository rebrand and documentation baseline

GitHub renamed the repository from `rugbedbugg/instagram-cli` to `rugbedbugg/Instagram-CLI`; `origin` follows the canonical URL while `upstream` remains fetch-only. The old URL resolves to the same repository. No commits or contributor history were rewritten.

The README adapts the reusable `Projects/README-TEMPLATE.md` baseline with the maintainer's requested centered header and section order: About The Project, Built With, Roadmap, Getting Started, Usage, contributors/provenance, Acknowledgments, and License. It omits unrelated badges and unavailable registry installation methods.

The existing TypeScript preflight remains the CI baseline: relevant push/PR triggers, Node 22/24, `npm ci`, build, lint/test, read-only permissions, npm caching, and concurrency cancellation. Upstream-only publication workflows remain disabled here by their repository guards. Legacy Python CI is separate from the maintained TypeScript baseline.
