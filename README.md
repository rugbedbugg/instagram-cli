<div align="center">

# Instagram-CLI

A maintained terminal client for Instagram, focused on keyboard-driven messaging, feeds, stories, media, and compatibility with Instagram's evolving private APIs.

**[Explore the docs](https://github.com/rugbedbugg/Instagram-CLI/tree/main/docs)**

[Visit](https://github.com/rugbedbugg/Instagram-CLI) · [Report Bug](https://github.com/rugbedbugg/Instagram-CLI/issues/new?template=bug_report.md) · [Request Feature](https://github.com/rugbedbugg/Instagram-CLI/issues/new?template=feature_request.md)

[![CI](https://github.com/rugbedbugg/Instagram-CLI/actions/workflows/test-ts.yml/badge.svg?branch=main)](https://github.com/rugbedbugg/Instagram-CLI/actions/workflows/test-ts.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-43853d)](package.json)
[![MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

</div>

## About The Project

Instagram-CLI is a terminal and TUI client with keyboard navigation, interactive views, and commands for scripting. It descends from [supreme-gg-gg/instagram-cli](https://github.com/supreme-gg-gg/instagram-cli). As upstream maintenance slowed relative to Instagram's protocol changes, this implementation became independently maintained downstream by [rugbedbugg](https://github.com/rugbedbugg).

The goal is to keep the client safe, testable, and compatible. Compatibility repairs and reliable operation take priority over adding features.

### Development Status

The downstream engineering baseline is stable: CI on Node 22 and 24, isolated offline tests, hardened local-file handling, and maintained repository infrastructure.

**Live Instagram authentication compatibility is currently being repaired and has not yet been revalidated against the current private API.** Chat, feeds, stories, and other authenticated flows are implemented, but are not currently claimed as live-validated. Passing tests does not establish that Instagram accepts those flows.

> [!WARNING]
> This is unofficial software, unaffiliated with Instagram or Meta. It uses private, undocumented Instagram APIs that can change without notice. Use may conflict with platform terms or lead to account restrictions.

### Capabilities

| Area            | Implemented                                                                                | Validation status                                                                              |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Messaging       | Chat TUI, inbox, read/send/reply/unsend commands, realtime updates, photo/video sending    | UI and local-file paths are offline-tested; service compatibility awaits authentication repair |
| Browsing        | Feed, stories, profiles, notifications, terminal media rendering                           | Mock views and selected components are offline-tested; live flows are unverified               |
| Local operation | Help, version, configuration, saved-account handling                                       | Offline-tested; saved-session acceptance still depends on Instagram                            |
| File safety     | Protected-path checks, bounded reads, content validation, explicit attachment confirmation | Offline-tested; see the security policy below                                                  |

### Security

Local file sending uses canonical path resolution, protected-location checks, symlink-aware validation, size limits, and content/type validation. Attachments written as `#path` require explicit confirmation before content is read or sent. Upload methods enforce prepared media produced by the file policy.

These checks reduce accidental disclosure; they cannot identify every possible secret in an ordinary file. See [Local File Safety](docs/local-file-safety.md) for the threat model, limits, and enforcement details.

## Built With

- **TypeScript and Node.js >=22** for the maintained client.
- **React, Ink, and Pastel** for the terminal interface and command routing.
- **instagram-private-api and instagram_mqtt** for private API and realtime integration, with local patches where needed.
- **AVA, ink-testing-library, XO, and Prettier** for offline verification and code quality.

The inherited Python client remains under [`instagram-py/`](instagram-py/README.md) as legacy code. Current downstream work targets TypeScript.

## Roadmap

- [x] Establish Node 22/24 CI and isolated tests.
- [x] Harden local-file sending and preserve existing session/configuration paths.
- [x] Establish the Instagram-CLI downstream identity and command compatibility.
- [ ] Build an offline Instagram fingerprint/compatibility harness.
- [ ] Repair authentication and separately revalidate live flows.
- [ ] Prepare a downstream release after compatibility validation and registry ownership checks.

See [issues](https://github.com/rugbedbugg/Instagram-CLI/issues) and the [maintenance model](docs/maintenance.md).

## Getting Started

### Prerequisites

- Git, npm, and **Node.js >=22**. CI validates Node 22 and 24; use `mise` to select either runtime.
- A terminal for the TUI. Image rendering depends on terminal capabilities; text-based rendering is also available.

### Installation

**Current source install:** no downstream npm release exists.

```bash
git clone https://github.com/rugbedbugg/Instagram-CLI.git
cd Instagram-CLI
npm ci
npm run build
npm run start -- --help
npm run start -- version
```

To make the commands available outside the checkout, optionally link this local build:

```bash
npm link
insta-cli --help
```

`npm link` registers `insta-cli` and the compatibility alias `instagram-cli` in your npm prefix. Both run the same entry point; an existing command with either name may be replaced by the link. You can keep using `npm run start -- <command>` without linking.

**Future npm release:** the requested package name is `insta-cli`, but this checkout remains `"private": true`. Registry installation is not a supported downstream installation method yet. Upstream npm, Homebrew, PyPI, and Snap packages do not contain this maintained implementation.

## Usage

`insta-cli` is the canonical command. Existing scripts using `instagram-cli` continue to work through the compatibility alias. `insta-cli version` reports the project, package, and API versions; `--version` retains its plain numeric output for scripts.

### Local commands

```bash
insta-cli --help
insta-cli version
insta-cli config
insta-cli config image.protocol ascii
```

### Authenticated commands

The following commands exist, but require Instagram authentication and are **not currently live-validated**. These examples describe the interface, not a promise that login or service operations succeed today.

```bash
insta-cli auth login
insta-cli auth whoami
insta-cli auth switch saved_username
insta-cli auth logout
insta-cli chat
insta-cli feed
insta-cli stories
insta-cli profile --help
insta-cli notify
insta-cli inbox --output json
insta-cli read username --limit 10 --output json
insta-cli send username --text "Hello"
insta-cli send username --file ./photo.jpg
insta-cli reply username --message-id MESSAGE_ID --text "Thanks"
insta-cli unsend username --message-id MESSAGE_ID
```

Run `insta-cli <command> --help` for arguments and flags. Chat supports `j`/`k` navigation and in-app commands described in [Chat Commands](docs/chat-commands-design.md). For scripting, see the [one-turn command guide](skills/instagram-skill/SKILL.md).

### Configuration

Existing state remains in **`~/.instagram-cli`**, including `config.ts.yaml`, saved sessions under `users/`, and logs under `logs/`. **`INSTAGRAM_CLI_HOME`** overrides the root directory. The rebrand does not move or invalidate stored data; Instagram may still reject a saved session independently of its local format.

Use `insta-cli config` to inspect settings or `insta-cli config <key> <value>` to update them. Review logs before sharing them and remove credentials, session data, and personal information. See [Logging](docs/logging.md).

### Development and testing

With Node 22 or 24 selected through `mise`, run the same gates as CI:

```bash
npm ci
npm run build
npm run lint-check
npm test
```

AVA creates temporary state directories through `INSTAGRAM_CLI_HOME`. Tests use mocks and do not require Instagram credentials or requests. For an offline TUI preview:

```bash
npm run dev
npm run start:mock -- --chat
# Other views: --feed or --story
```

`npm run dev` includes mocks; the production build excludes them. See [Development](DEVELOPMENT.md) and [Contributing](CONTRIBUTING.md) for setup, hooks, and review guidance.

## Contributors / Upstream & Attribution

Instagram-CLI is derived from **[supreme-gg-gg/instagram-cli](https://github.com/supreme-gg-gg/instagram-cli)** and continues under the **MIT license**. The original copyright notice for **Jet Chiang and James Zheng** remains intact in [LICENSE](LICENSE).

[rugbedbugg](https://github.com/rugbedbugg) maintains this downstream implementation. The repository preserves the original Git history and contributor authorship; upstream contributors are acknowledged for their work without implying they maintain this downstream. See the [commit history](https://github.com/rugbedbugg/Instagram-CLI/commits/main/) and [upstream contributors](https://github.com/supreme-gg-gg/instagram-cli/graphs/contributors).

Contributions to compatibility, safety, tests, and usability are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgments

Thanks to the original project authors and contributors, and to the maintainers of Ink, Pastel, ink-picture, instagram-private-api, instagram_mqtt, and the testing tools this client builds on.

## License

Distributed under the [MIT License](LICENSE). Original copyright notices and inherited authorship are preserved.
