# Architecture & Core Design

## 1. System Overview
LazyGravity communicates with the Discord/Telegram APIs entirely within the user's local PC, without routing through any external intermediary server.

```mermaid
graph TD
    A[📱 Discord App] -->|WebSocket Gateway| B[🔒 Local PC - LazyGravity Bot]
    T[📱 Telegram App] -->|Long Polling| B
    B -->|REST API| A
    B -->|Bot API| T

    subgraph Local Environment (Your PC)
        B -->|Platform Abstraction Layer| PA[PlatformAdapter]
        PA -->|CDP / WebSocket| C[Antigravity / AI Coding Agent]
        B -->|Read/Write| D[📁 Local Workspaces]
        B -.->|Secure Storage| E[.env File (Local)]
        B -.->|Persist State| F[SQLite Database]
    end
```

## 1.5. Platform Abstraction Layer

An abstraction layer decouples core logic from platform-specific details.

```
src/platform/
├── types.ts              # Common interfaces (PlatformMessage, PlatformChannel, RichContent, etc.)
├── adapter.ts            # PlatformAdapter / PlatformAdapterEvents interfaces
├── richContentBuilder.ts # Immutable builder (createRichContent → withTitle → addField → pipe)
├── discord/
│   ├── discordAdapter.ts # DiscordAdapter implements PlatformAdapter
│   └── wrappers.ts       # discord.js objects ↔ Platform type conversions
└── telegram/
    ├── telegramAdapter.ts    # TelegramAdapter implements PlatformAdapter
    ├── telegramFormatter.ts  # Markdown → Telegram HTML conversion
    └── wrappers.ts           # Telegram objects ↔ Platform type conversions
```

### Core Shared Types
- `PlatformMessage` — Message (author, channel, text, attachments)
- `PlatformChannel` — Channel/chat (sends MessagePayload via `send`)
- `RichContent` — Abstraction over Discord Embed / Telegram HTML (title, description, fields, color, footer)
- `MessagePayload` — Outgoing content (text + richContent + components + ephemeral)
- `PlatformButtonInteraction` / `PlatformSelectInteraction` — Button/select menu abstractions

### Event Flow
1. `PlatformAdapter.start(events)` registers platform-specific event handlers
2. `EventRouter` dispatches events from all platforms to unified handlers
3. Platform-agnostic `messageHandler`, `buttonHandler`, `selectHandler`, `commandHandler` process events
4. `WorkspaceQueue` serializes requests per workspace (cross-platform)

## 2. Authentication & Security
No port mapping or webhooks are used since nothing is exposed externally.

- **Bot Token & API Key Management:**
  - Stored in a local `.env` file via the `dotenv` package. For enhanced security, **tightening file permissions (e.g., `chmod 600`)** is recommended (OS-native credential integration may also be considered).
  - Only `.env.example` is committed to GitHub to prevent credential leaks.
- **Authorization:**
  - **Discord**: `allowedUserIds` whitelist check at the top of `messageCreate` and `interactionCreate` event handlers.
  - **Telegram**: `EventRouter` authenticates via `telegramAllowedUserIds`. If unset, all users are rejected (warn log emitted).
  - Cross-platform auth managed in `platform:userId` format.
- **Input Validation & Directory Traversal Protection:**
  - To prevent directory traversal attacks (e.g., `../../etc/passwd`) via user input or workspace specification, a root directory (`WORKSPACE_BASE_DIR`) is defined and all path resolutions are strictly validated to stay within it using `path.resolve`.

## 3. Project Management (Category ↔ Project, Channel ↔ Chat Session)
Discord **categories = projects** and **channels = chat sessions**.

### Implemented Features
- **`/project`**: Displays subdirectories under the base directory (up to 25) in a select menu. Selecting one auto-creates a category + `session-1` channel and binds them.
- **`/new`**: Creates a new session channel (`session-N`) under the current project category and starts a new chat in Antigravity.
- **`/chat`**: Shows current chat session info (session number, project, rename status) along with a list of all sessions in the same project.
- **Auto-rename**: On the first message in a session channel, a channel name is auto-generated from the prompt content (e.g., `session-1` → `1-react-auth-bug-fix`).

### Data Flow
1. User runs `/project` → selects a project from the select menu
2. `ChannelManager.ensureCategory()` creates a category, `createSessionChannel()` creates the `session-1` channel
3. `WorkspaceBindingRepository` persists channel_id ↔ workspace_path in the `workspace_bindings` table
4. `ChatSessionRepository` persists session info (category ID, session number, rename status) in the `chat_sessions` table
5. `/new` → creates a new `session-N` under the same category + starts a new chat in Antigravity
6. On first message → `TitleGeneratorService` generates a title → `ChannelManager.renameChannel()` renames the channel

### Architecture
```
src/database/workspaceBindingRepository.ts  — SQLite CRUD (workspace_bindings table)
src/database/chatSessionRepository.ts       — SQLite CRUD (chat_sessions table)
src/database/telegramBindingRepository.ts   — SQLite CRUD (telegram_bindings table: chat_id ↔ workspace)
src/services/workspaceService.ts            — FS operations & path validation (scanWorkspaces, validatePath)
src/services/channelManager.ts              — Discord category/channel management (ensureCategory, createSessionChannel, renameChannel)
src/services/titleGeneratorService.ts       — Auto channel name generation (CDP-based + text extraction fallback)
src/services/chatSessionService.ts          — Antigravity UI operations (new chat & session info via CDP)
src/commands/workspaceCommandHandler.ts     — /project command + select menu handling
src/commands/chatCommandHandler.ts          — /new, /chat commands
src/bot/telegramMessageHandler.ts           — Telegram message → CDP direct integration handler
src/bot/eventRouter.ts                      — Multi-platform event routing + authentication
src/bot/workspaceQueue.ts                   — Per-workspace exclusive queue (cross-platform)
```

### Future Enhancements
- Switch Antigravity workspaces directly via CDP (currently uses prompt prefix approach)
- High-accuracy title generation via LLM API (currently text-extraction based)

## 4. Context Continuity
Instructions to the LLM agent and execution results are managed and persisted through Discord's reply chains.

- **Metadata Embedding in Embeds:**
  - Long logs and results are stored in Embeds.
  - State is persisted in less-visible Embed fields (`Footer`, `Author URL`) or in local SQLite keyed by message ID, holding file paths and recent instruction history (task IDs).
- **Follow-up via Reply:**
  - When a user replies to a Bot-generated Embed, the Bot uses metadata from the parent message (or context pulled from SQLite) to resume work from where it left off, passing the original directory and context to Antigravity.

## 5. Scheduled Tasks (Cron / Scheduling) — *Coming Soon*
- Backend implementation is in progress, but Discord command integration is planned for a future phase.
- Uses `node-cron` on the local PC.
- Schedule definitions are persisted in SQLite (`id`, `cron_expression`, `prompt`, `workspace_id`, `status`).
- On bot startup, definitions are loaded from SQLite and re-scheduled in-memory via node-cron.

## 6. Real-Time Progress Bar Updates
- Monitors logs and status output (stdout or structured log formats) from backend AI agents like Antigravity via streaming.
- Discord's message edit API (`message.edit`) is called at most once every few seconds (e.g., 3–5s) with aggressive Debounce/Throttle to avoid hitting rate limits.

> **Details:** See [RESPONSE_MONITOR.md](./RESPONSE_MONITOR.md) for the CDP-based response monitoring and process log extraction mechanism via ResponseMonitor.

## 7. Antigravity Process Launch (CLI Spawn) & Resource Control
- **CLI Spawn:** Antigravity (or the target directory's AI coding tool) is launched as an independent background process via `child_process.spawn`.
- **Exclusive Locking & Queuing (Task Queue):** To prevent local PC resource exhaustion (DoS), concurrent task counts are limited per workspace or globally (Mutex/Queue).
- **Kill Switch:** To guard against infinite loops or runaway processes, spawned process PIDs are tracked and can be forcefully terminated (kill) via the `/stop` Discord command.
- **Message Chunking (Discord Limit Workaround):** For output exceeding Discord's character limits (2000 for messages, 4096 for Embeds), a fallback mechanism splits long text into multiple messages or sends it as an attached text file.
