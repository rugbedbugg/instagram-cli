# Developing Instagram-CLI

The maintained implementation is the TypeScript client. It descends from the original project's Python/curses client, retained under `instagram-py/` for legacy reference.

Live Instagram authentication is currently degraded and has not been revalidated. Routine development and verification use mocks without Instagram requests.

## Setup

Use Node.js >=22 through `mise`; CI validates Node 22 and 24. The existing version policy is conservative. This rebrand changes no runtime requirements, dependency versions, or application version.

```bash
git clone https://github.com/rugbedbugg/Instagram-CLI.git
cd Instagram-CLI
mise exec node@24 -- npm ci
```

`npm ci` installs the lockfile and applies `patches/` through `patch-package`. It does not modify Git configuration. Pre-commit hooks are opt-in:

```bash
npm run hooks:install
```

This sets `core.hooksPath` and runs Prettier/XO on staged files. Use `git config --unset core.hooksPath` to disable it for the clone.

## Build and run

```bash
npm run dev          # development build, including mocks
npm run dev:watch    # rebuild when source changes
npm run start -- --help
npm run start -- version
npm run build        # type-check and build production output, excluding mocks
```

The bundler is configured in `esbuild.config.mjs`. Commands live in `source/commands/`; use `npm run start -- <command>` to invoke the built CLI.

After building, optional `npm link` installs links for canonical `insta-cli` and compatibility alias `instagram-cli` in the active npm prefix. Both point to `dist/cli.js`. Links can replace existing commands with those names; no registry installation is required.

## Offline UI development

```bash
npm run dev
npm run start:mock -- --chat
npm run start:mock -- --feed
npm run start:mock -- --story
```

Use one view per invocation. Update `source/mocks/mock-data.ts` alongside changes to the UI's expected data. See [the mock guide](source/mocks/README.md) and design documents in `docs/`.

## Required gates

Run the complete sequence separately for both supported CI runtimes:

```bash
mise exec node@22 -- npm ci
mise exec node@22 -- npm run build
mise exec node@22 -- npm run lint-check
mise exec node@22 -- npm test

mise exec node@24 -- npm ci
mise exec node@24 -- npm run build
mise exec node@24 -- npm run lint-check
mise exec node@24 -- npm test
```

AVA automatically creates temporary state via `tests/_setup-isolated-storage.ts`. Never point tests at real `~/.instagram-cli` data. `INSTAGRAM_CLI_HOME` and all established storage paths remain unchanged. Mock the client; do not use automated tests to probe Instagram.

`npm run format` applies formatting; `npm run lint-check` checks Prettier and XO. `npm test` repeats those checks and runs AVA. Identity tests build an isolated package layout and exercise both executable names without an existing `dist/` build.

For Ink tests, use `ink-testing-library`, assert on `lastFrame()`, and wait for rendered state rather than relying on fixed delays. Add coverage for keyboard input, empty states, Unicode, and any changed local-file behavior.

## Source layout

| Path                                                    | Responsibility                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `source/cli.ts`, `source/commands/`                     | Pastel entry point and commands                                    |
| `source/client.ts`                                      | Instagram API and realtime integration                             |
| `source/config.ts`, `source/session.ts`                 | Compatible local state and sessions                                |
| `source/ui/components/`, `views/`, `hooks/`, `context/` | Ink rendering, orchestration, derived state, and client boundaries |
| `source/utils/`                                         | Logging, message parsing, file policy, and shared utilities        |
| `source/mocks/`, `tests/`                               | Offline fixtures and verification                                  |
| `patches/`                                              | Maintained patches to API and CLI dependencies                     |

Keep ESM imports with explicit `.js` extensions. Use `initializeLogger()` and contextual loggers; preserve stdout for the TUI. Call `InstagramClient.shutdown()` when realtime sessions are torn down.

## Reference documentation

- [Maintenance and releases](docs/maintenance.md)
- [Local-file safety](docs/local-file-safety.md)
- [Logging](docs/logging.md)
- [Login implementation](docs/login.md) and [API debugging](docs/api-debugging.md), which describe implementation rather than current live compatibility

## Legacy Python client

The Python client keeps its historical package identity and upstream publishing guard. It is not the maintained TypeScript implementation and is not covered by the Node CI claims. See its [legacy documentation](instagram-py/README.md); use `uv` for Python environments and honor `pyproject.toml` if working on it separately.
