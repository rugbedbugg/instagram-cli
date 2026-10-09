# Contributing to Instagram-CLI

Instagram-CLI is independently maintained downstream at [rugbedbugg/Instagram-CLI](https://github.com/rugbedbugg/Instagram-CLI), derived from [supreme-gg-gg/instagram-cli](https://github.com/supreme-gg-gg/instagram-cli). Current work targets the TypeScript client in `source/`; `instagram-py/` is legacy code.

Live authentication is currently degraded and awaits revalidation. Prefer offline reproductions, mocks, and fixtures when proposing fixes. A passing unit test is not evidence of live API compatibility.

## Issues and proposals

Use the downstream [issue tracker](https://github.com/rugbedbugg/Instagram-CLI/issues) for bugs and feature proposals. For substantial work, discuss the scope before implementation. Include the output of `insta-cli version`, runtime and terminal details, and reproducible steps. Redact credentials and personal information from logs.

## Development setup

1. Fork **rugbedbugg/Instagram-CLI** on GitHub and clone your fork.
2. Follow [DEVELOPMENT.md](DEVELOPMENT.md) with Node >=22 and npm.
3. Create a branch such as `fix/chat-navigation` or `docs/command-examples`.

If adding remotes to a contributor clone, use `downstream` for the maintained repository. Reserve `upstream` for the original ancestry:

```bash
git remote add downstream https://github.com/rugbedbugg/Instagram-CLI.git
git remote add upstream https://github.com/supreme-gg-gg/instagram-cli
git remote set-url --push upstream no_push_to_upstream
```

The maintainer's `origin` points to the downstream; a contributor's `origin` points to their own fork. See the [maintenance model](docs/maintenance.md) for upstream import and release policy.

## Changes and verification

- Keep API integration in `source/client.ts` and its helpers; preserve client teardown and logger boundaries.
- Read the relevant design document in `docs/` before changing an existing component.
- Add focused tests for changed behavior. UI tests use Ink mocks; tests must not use real sessions or contact Instagram.
- Follow the [local-file safety policy](docs/local-file-safety.md) for every new attachment entry point.
- Run `npm run build`, `npm run lint-check`, and `npm test` on Node 22 and 24. Run `npm run format` when formatting needs correction.
- Keep dependency changes separate and conservative.

## Pull requests

Open pull requests against `rugbedbugg/Instagram-CLI:main`. Explain the problem, resulting behavior, and verification; reference a related issue when available. Include a mock-based screenshot for visual changes when useful.

Use signed commits with a subject such as `[Fix]: Handle empty chat lists` and exactly one body line describing the change. Keep history reviewable; do not rewrite existing commits without explicit agreement. Preserve original authorship and MIT attribution.
