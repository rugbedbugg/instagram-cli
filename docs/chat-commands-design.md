# Chat Commands System

## Overview

Interactive command system for message operations with visual selection. Commands are prefixed with `:` and processed by `parseAndDispatchChatCommand()`.

## State Management

### ChatState Properties

```typescript
interface ChatState {
	selectedMessageIndex: number | null; // 0-based index in messages array
	isSelectionMode: boolean; // UI selection mode active
	// other existing properties...
}
```

### State Flow

1. **Selection**: `:select` → `isSelectionMode: true`, `selectedMessageIndex: lastMessage`
2. **Navigation**: `j`/`k` keys update `selectedMessageIndex`
3. **Confirmation**: `Enter` → `isSelectionMode: false` (preserves `selectedMessageIndex`)
4. **Execution**: Commands check `selectedMessageIndex !== null`
5. **Cleanup**: Commands clear `selectedMessageIndex` after execution

## Available Commands

| Command          | Description                           | Selection Required |
| ---------------- | ------------------------------------- | ------------------ |
| `:help`          | Show available commands               | No                 |
| `:select`        | Enter message selection mode          | No                 |
| `:react [emoji]` | React to selected message             | Yes                |
| `:unsend`        | Delete selected message               | Yes                |
| `:upload <path>` | Upload file to thread                 | No                 |
| `:k`             | Scroll up by 75% of viewport height   | No                 |
| `:j`             | Scroll down by 75% of viewport height | No                 |
| `:K`             | Jump to top of message history        | No                 |
| `:J`             | Jump to bottom of message history     | No                 |

## Selection Logic

### Scrolling Behavior

The message scrolling system uses a `ScrollView` component that provides smooth, viewport-relative navigation:

- **Incremental Scrolling** (`:j` / `:k`): Scrolls by 75% of the viewport height for comfortable navigation with content overlap
- **Jump Navigation** (`:J` / `:K`): Instantly jumps to the bottom or top of loaded messages
- **Infinite Scroll**: When scrolling to the top (`:K` or reaching the boundary), older messages are automatically loaded from the API
- **Auto-scroll**: After sending a message, the view automatically scrolls to the bottom to show the sent message
- **Mouse Support**: Planned for future implementation to enable scroll wheel navigation

The scrolling commands interact with the `ScrollView` component via ref methods, providing programmatic control over the scroll position while maintaining smooth UX.

### UI Behavior

- **Selection Mode**: Input disabled, shows "Selection mode active - use j/k to navigate, Esc to exit"
- **Visual Feedback**: Selected message highlighted with yellow border
- **Navigation**: `j` (down), `k` (up), `Enter` (confirm), `Esc` (cancel)

### Command Execution

- Commands check `chatState.selectedMessageIndex !== null`
- Target message: `chatState.messages[selectedMessageIndex]`
- After execution: `selectedMessageIndex` cleared to `null`

### Key Bindings

- **Normal Mode**: `Esc` → back to threads, `Ctrl+C` → quit
- **Selection Mode**: `j`/`k` → navigate, `Enter` → confirm, `Esc` → cancel

## Autocomplete System

To enhance user experience, an autocomplete system will be implemented, providing suggestions for file paths. This system is designed to be extensible for other types of autocompletion in the future.

### File Path Autocomplete

This feature assists users in finding and inputting file paths directly in the chat input, triggered by a special character combination.

#### **1. Triggering Mechanism**

- Autocomplete is triggered when the user types a space followed by `#` and begins typing a path (e.g., `:upload #p` or simply ` #p`).
- The system will use the text immediately following the `#` as the query for file path suggestions.

#### **2. UI Component (`AutocompleteView`)**

- A new component, `AutocompleteView`, will be responsible for rendering suggestions.
- It will appear directly **below** the main chat input box.
- It will display a vertical list of matching file and directory names.
- The currently highlighted suggestion will have a distinct background color.
- Directory names in the suggestion list will be appended with a `/` (e.g., `source/`) to denote they are directories and allow for easier traversal.

#### **3. State Management (`ChatView`)**

- The main `ChatView` will manage the autocomplete state. A possible structure for the state would be:
  ```typescript
  interface AutocompleteState {
  	isActive: boolean;
  	suggestions: string[];
  	selectedIndex: number;
  	triggerPosition: number; // The cursor position where '#' was typed
  	query: string; // The text after '#' used for filtering
  }
  ```
- On input change, the view will check for the `#` pattern to activate or update the autocomplete state.

#### **4. Suggestion Logic (`utils/autocomplete.ts`)**

- A new `getFilePathSuggestions(query: string): Promise<string[]>` function will be created in a new `utils/autocomplete.ts` file.
- This function will perform a case-insensitive search on the file system based on the `query`.
- **Path Resolution**: It will support:
  - **Relative paths**: (e.g., `source/`, `../`) relative to the current working directory.
  - **Absolute paths**: (e.g., `/Users/`).
  - **Home directory**: `~/` will be expanded to the user's home directory.
- It will use Node.js's `fs` module for all file system lookups.

#### **5. Keyboard Interaction**

- When the `AutocompleteView` is active, the following keys will be handled by the input component:
  - **`ArrowDown`**: Moves the selection down the list (and loops back to the top).
  - **`ArrowUp`**: Moves the selection up the list (and loops back to the bottom).
  - **`Tab` or `Enter`**: Accepts the currently selected suggestion. The text from the trigger (`#<query>`) will be replaced with the completed path (`#<suggestion>`). Note that `Enter` is locked to only handle acceptions when autocomplete is active; otherwise, it sends the message.
  - **`Escape`**: Deactivates autocomplete and closes the suggestion list without making a change.

### Command Autocomplete

This feature provides in-line suggestions for chat commands, triggered by the `:` character.

#### Triggering Mechanism

- Autocomplete is triggered when the user types `:` at the beginning of the input.
- The system will use the text immediately following the `:` as the query for command suggestions.

#### Suggestion Logic

- A new function, `getCommandSuggestions(query: string)`, will be added.
- This function will import the `chatCommands` object and filter commands whose names start with the `query`.
- It will return an array of objects, each containing the command's `name` and `description`.

#### State Management (Input Box)

- The `AutocompleteState` will be updated to differentiate between `command` and `filePath` suggestions to handle different triggers and display formats.
- The `handleInputChange` function will be expanded to detect the `:` trigger at the start of the input and fetch command suggestions.
- `handleAutocompleteSelection` will be updated to replace the partial command (e.g., `:he`) with the selected command name (e.g., `:help `).

## Message Preprocessing

Before a message is sent to a thread, `planOutgoingMessage` in `source/utils/outgoing-message.ts` parses it for attachment tokens and emoji shortcodes. Every local file goes through the policy in `source/utils/local-file-policy.ts`; see [local-file-safety.md](./local-file-safety.md).

### 1. File Attachments (`#<path>`)

- **Syntax**: `#path/to/file.ext`, or `#"path with spaces.txt"` / `#'path with spaces.txt'`. A token must start a word and look like a path (contain `/`, `\` or `.`, or start with `~`); `#travel` and URL fragments such as `https://x.com/#/route` are ordinary text. Write `\#` to send a literal `#`.
- **Explicit confirmation**: a message with attachments is not sent immediately. The chat shows each file's base name and size and waits for `y` (send) or `n`/`Esc` (cancel). Files are not read until the user confirms.
- **Images** are uploaded with `client.sendPhoto()` before the text, and their tokens are removed from the text.
- **Text files** (UTF-8, at most 16 KiB) are appended to the message as `--- <base name> ---` blocks, and their tokens are removed. The local path is never part of the sent text.
- **Videos** must be sent with `:upload`.
- **Failure is all-or-nothing**: if any attachment is missing, protected, too large, of an unsupported type, changed after confirmation, or contains a private key or access token, nothing is sent (neither files nor text) and a local error explains why, without the absolute path.
- `:reply` does not accept attachments.

> NOTE: Text files are added as an "appendix" rather than inline, an intentional UX choice adapted from Gemini CLI.
> Since Instagram uses `@` for mentions, `#` triggers file paths.

### 2. Emoji Handling (`:emoji_name:`)

- **Syntax**: `:smile:`, `:fire:`, etc.
- **Action**:
  - All occurrences of the `:emoji_name:` pattern will be replaced with a static placeholder emoji (e.g., `✨`).
  - This is a placeholder for a future implementation that could map names to actual emoji characters.
  - Example: `Hello world :wave:` becomes `Hello world ✨`
