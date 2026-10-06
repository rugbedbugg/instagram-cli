# Local File Safety

Every local file that can leave the machine (chat attachments, `:upload`, `send --file`) goes through one policy module: `source/utils/local-file-policy.ts`.

## Threat model

The policy protects against local files being read or transmitted because of:

- accidental or pasted text that happens to look like a path (for example a copied log line containing `#~/.ssh/id_ed25519`);
- untrusted text from other sources being pasted into the composer;
- symlinks, `..` segments, case variations or alternate separators that disguise a protected location;
- files that are too large to buffer safely, or that are not what their name claims (a key renamed to `photo.jpg`);
- the file on disk changing between approval and reading.

It does not protect against:

- a user deliberately sending a file that is not recognized as sensitive (the deny rules cannot be exhaustive; secrets in files with ordinary names and no recognizable key or token format can still be sent after explicit confirmation);
- a malicious process running as the same user, which can read these files directly;
- data Instagram's servers retain after a legitimate send.

## Flow

```text
requested path (as typed)
   ↓  resolve: ~ → injected home, relative → injected cwd, normalize ..
   ↓  classify the spelling          → reject if sensitive
   ↓  realpath (follows every symlink hop)
   ↓  classify the canonical target  → reject if sensitive
   ↓  stat: regular file only, size ≤ purpose limit
   ↓  open (O_NOFOLLOW | O_NONBLOCK) + fstat: pin dev/ino/size/mtime
ApprovedLocalFile  (no content read yet)
   ↓  readTextForEmbedding / readMediaForUpload / readAttachment
   ↓  reopen, verify identity unchanged, bounded read
   ↓  sniff content type; text: UTF-8 only, no NUL, no key/token patterns
PreparedMedia / embedded text  →  InstagramClient
```

`ApprovedLocalFile` and `PreparedMedia` are registered in module-private `WeakMap`/`WeakSet` registries. Look-alike objects built elsewhere are rejected at runtime, and `InstagramClient.sendPhoto` / `sendVideo` accept only `PreparedMedia`, so there is no path-string upload API left to call.

## Sensitive classifications

Matching is case-insensitive on every platform and accepts both `/` and `\` separators, which over-blocks slightly on case-sensitive filesystems (the intended fail-closed direction). Both the typed spelling and the canonical target are checked.

- **Directories anywhere in the path:** `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gcloud`, `.git`, `.config/gh`, `.config/hub`, Cargo/Gem credentials, `.instagram-cli`, `.password-store`, keyrings and macOS Keychains, and Firefox, Thunderbird, Chrome, Chromium, Brave, Edge and Vivaldi profiles on Linux, macOS and Windows.
- **The CLI's own data directory**, as resolved by `resolveDataDir()`, including a relocated `INSTAGRAM_CLI_HOME`.
- **System locations at the root:** `/proc`, `/sys`, `/dev`, `/etc/shadow`, `/etc/gshadow`, `/etc/sudoers`, `/etc/ssh`, and `Windows\System32\config`.
- **File names:** `.netrc`, `.git-credentials`, `.gitconfig`, `.npmrc`, `.yarnrc`, `.pypirc`, `.pgpass`, `.my.cnf`, `credentials*`, `token*`, `.vault-token`, `kubeconfig`, browser login and cookie databases, `known_hosts`, `authorized_keys`, `session.ts.json`, `config.ts.yaml`.
- **Name patterns:** SSH key names (`id_rsa`, `id_ed25519`, …, including `.pub`), `.env` and `.env.*`, `*.pem|key|p12|pfx|jks|keystore|kdbx|ppk|ovpn|gpg`, `client_secret*.json`, `secrets.*`, `*.token`, `*_history`. `.key` also matches Keynote files; this is deliberate.
- **Content (text embeds only):** PEM/OpenSSH/PGP private key headers and common token formats (AWS, GitHub, GitLab, Slack, npm, `sk-…` API keys, Google API keys).

## Size limits

| Use          | Limit   | Reason                                                   |
| ------------ | ------- | -------------------------------------------------------- |
| Text embed   | 16 KiB  | Appended inline to one DM; kept to a readable snippet    |
| Photo upload | 25 MiB  | Buffered in memory and sent in one request               |
| Video upload | 100 MiB | Buffered in memory and sent in one non-segmented request |

Limits are inclusive (a file exactly at the limit is accepted), enforced at approval from `stat` and again on the bytes actually read. Reads never exceed the approved size plus one byte. Instagram's own server-side limits have not been verified; the constants live in `defaultFileSizeLimits`.

## Logging

Rejections are logged as `Local file rejected: <code> (<category>)` only: no path and no file name. Approvals log the purpose and byte count. User-facing errors include only the base name the user typed, never the resolved absolute path.

## Entry points

| Entry point                                    | Kind                                                | Policy path                                                                                            | Confirmation                                         |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `#path` in the chat composer (`chat-view.tsx`) | implicit preprocessing → text embed or photo upload | `planOutgoingMessage` → `approveLocalFile('attachment')`, then `sendPlannedMessage` → `readAttachment` | Yes: `y`/`n` prompt; nothing read before `y`         |
| `:upload <path>`                               | explicit command → photo/video upload               | `uploadLocalMedia` → `approveLocalFile('media-upload')` → `readMediaForUpload`                         | No: the command is the explicit intent               |
| `send <thread> --file <path> [--type]`         | explicit one-turn command → photo/video upload      | `uploadLocalMedia`; `--type` must match the content                                                    | No: non-interactive; the flag is the explicit intent |
| `:reply <text>`                                | text only                                           | attachment tokens refused without filesystem access                                                    | —                                                    |
| `InstagramClient.sendPhoto` / `sendVideo`      | upload sink                                         | accepts only `PreparedMedia` (runtime-checked)                                                         | —                                                    |
| `#` path autocomplete (`autocomplete.ts`)      | local directory listing for suggestions             | not covered: names are shown locally and never sent                                                    | —                                                    |
| `:download`, `read --download`                 | write local files from Instagram media              | out of scope (writes, not reads)                                                                       | —                                                    |

## Explicit intent and failure behavior

Typing `#path` is not treated as sufficient intent, because the same text can arrive by accident or by pasting. The chat therefore asks for confirmation, and only then reads and transmits. `:upload` and `send --file` are explicit file operations, so they skip the prompt but still pass the full policy, and refuse anything that is not really an image or video.

For `#path` messages, every attachment is approved before the prompt and every file is read and validated after confirmation, before anything is transmitted. Any failure rejects the whole message: no file content, no text and no path is sent. For example, `hello #/home/user/.ssh/id_ed25519` produces a local `Not sent: … protected location (SSH keys and config) …` error and sends nothing.

The draft is cleared when a message is submitted, so after a rejection it has to be retyped; restoring the draft is a possible UX follow-up.

## Adding new entry points (e.g. drag-and-drop)

New ways to pick a file must produce an attachment request, not read files themselves:

1. Convert the input into the same explicit token, e.g. a dropped path becomes `#"<path>"` in the composer, or call `approveLocalFile(path, 'attachment')` directly.
2. Let `planOutgoingMessage` approve it, show the same confirmation prompt, and send with `sendPlannedMessage`.
3. Never fall back to sending the raw path text when approval fails.
