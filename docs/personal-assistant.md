# Personal Assistant Module

The Personal Assistant (PA) module adds a Telegram bot to Polpo that is backed by the same agent system powering the web UI. It provides a conversational interface for daily tasks, web research, and coding session management — all from a Telegram chat.

## Architecture

The PA is not a separate LLM integration. It spawns a real coding agent (Claude Code, Codex, Gemini, OpenCode, or Pi) via Polpo's `AgentFactory`, registers it with `InstanceManager`, and bridges Telegram messages to the agent's stdin/stdout. The agent instance appears in the web UI dashboard alongside regular coding sessions.

```
Telegram Chat
    ↓ (Bot API long-polling)
PA Module (src/pa/)
    ├── Telegram Bot (grammY)
    │     ├── Access Control (allowFrom whitelist)
    │     ├── Command Handlers (/start, /agent, /remember, etc.)
    │     └── Message Handlers (text → prompt, photo, document)
    ├── Agent Bridge
    │     ├── spawnAgent() → createAgent(type, options)
    │     ├── sendPrompt(text) → InstanceManager.sendToAgent()
    │     ├── onMessage(cb) ← instance:message events
    │     ├── onApproval(cb) ← instance:approval events
    │     └── approve() / reject() / abort()
    ├── Token Monitor (Anthropic OAuth)
    │     ├── Background health check (every 5m)
    │     ├── Auto-refresh via refresh_token
    │     └── Telegram alerts when manual renewal needed
    └── Memory System (SQLite)
          ├── Conversation history (per chat)
          ├── User memories (key/value + embeddings)
          └── Hybrid search (vector + BM25)
```

## Setup

### 1. Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (e.g., `123456:ABC-DEF...`)

### 2. Find Your Telegram User ID

1. Open [@userinfobot](https://t.me/userinfobot) on Telegram
2. Send `/start` — it will reply with your user ID (a number)

### 3. Configure Polpo

**Option A: Environment variables**

```bash
export POLPO_PA_TELEGRAM_TOKEN="123456:ABC-DEF..."
export POLPO_PA_TELEGRAM_ALLOW="your_user_id"
```

**Option B: Config file** (`~/.config/polpo/pa.json`)

```json
{
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowFrom": [123456789]
  },
  "agent": {
    "type": "claude",
    "model": null,
    "name": "Personal Assistant"
  },
  "auth": {
    "checkIntervalMinutes": 5,
    "expiryBufferMinutes": 15,
    "autoRefresh": true
  },
  "notifications": {
    "approvals": true,
    "completions": true
  }
}
```

Environment variables take precedence over the config file.

### 4. Start Polpo

```bash
node bin/polpo.js server
```

If the token is configured, you will see:

```
  🐙 Polpo v1.1.7 running on http://0.0.0.0:7890
  [pa] Memory initialized at /home/user/.config/polpo/pa-memory.db
  [pa-auth] Token monitor started (interval: 5m, buffer: 15m)
  [pa] Personal Assistant active on Telegram
  [pa-telegram] Bot started polling
```

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with full command list |
| `/status` | Quick status of all active instances |
| `/instances` | Detailed instance list with IDs and agent types |
| `/new` | Spawn a new PA agent session |
| `/stop` | Stop the current PA agent |
| `/abort` | Abort the running task |

### Agent Control

| Command | Description |
|---------|-------------|
| `/agent` | Show current agent type |
| `/agent <type>` | Switch agent (claude, codex, gemini, opencode, pi) |
| `/approve <id>` | Approve a pending action by instance ID prefix |
| `/reject <id>` | Reject a pending action by instance ID prefix |

### Tools

| Command | Description |
|---------|-------------|
| `/web <query>` | Ask the agent to search the web and summarize results |
| `/remind <when> <what>` | Ask the agent to note a reminder |

### Memory

| Command | Description |
|---------|-------------|
| `/remember <key> <text>` | Save a fact (e.g., `/remember birthday March 15`) |
| `/forget <key>` | Remove a stored memory |
| `/memories` | List all stored memories |
| `/search <query>` | Search memories by keyword and similarity |

### Authentication

| Command | Description |
|---------|-------------|
| `/renew_token` | Initiate token renewal (agent-type aware) |

## Agent Types

The PA can use any agent supported by Polpo:

| Type | CLI | Multi-turn | Best For |
|------|-----|------------|----------|
| `claude` (default) | `claude` | Long-lived process | General PA, coding, research |
| `codex` | `codex exec` | Respawn per prompt | OpenAI-focused tasks |
| `gemini` | `gemini` | Respawn per prompt | Google ecosystem tasks |
| `opencode` | `opencode run` | Respawn per prompt | Local models (Ollama, etc.) |
| `pi` | `pi --mode rpc` | Long-lived process | Multi-provider flexibility |

Switch at runtime with `/agent <type>`. The previous agent is stopped and a new one spawns.

## PA Workspace

When using Claude as the agent, the PA runs in a dedicated workspace at `~/.config/polpo/pa-workspace/`. This directory contains a `CLAUDE.md` file with personal assistant instructions that Claude reads automatically.

**Customizing the PA personality:**

Edit `~/.config/polpo/pa-workspace/CLAUDE.md` to change:
- Personality and tone
- Capabilities and constraints
- Response format guidelines
- Domain-specific instructions

The file is created with sensible defaults on first run and is never overwritten — your customizations are preserved.

## Memory System

The PA persists data in a local SQLite database using Node.js 22's built-in `node:sqlite` module.

### Conversation History

All messages (user prompts and assistant responses) are automatically saved. History survives server restarts and is loaded when the PA starts.

### User Memories

Key/value store for facts the PA should remember. Created via `/remember`, removed via `/forget`, listed via `/memories`.

### Search

The `/search` command uses **hybrid search** combining:

- **Vector similarity** (70% weight) — embeddings compared via cosine similarity
- **BM25 keyword** (30% weight) — FTS5 full-text search with BM25 ranking

**Embedding providers:**

| Provider | Config | API Key Needed | Quality |
|----------|--------|---------------|---------|
| `hash` (default) | `POLPO_PA_EMBEDDING_PROVIDER=hash` | No | Basic (trigram hashing) |
| `openai` | `POLPO_PA_EMBEDDING_PROVIDER=openai` | Yes (`POLPO_PA_EMBEDDING_API_KEY` or `OPENAI_API_KEY`) | High (text-embedding-3-small) |

The hash-based fallback works without any API key, enabling basic similarity search out of the box.

## Token Renewal (Anthropic OAuth)

The PA includes a complete Anthropic OAuth 2.0 PKCE flow for renewing Claude API tokens without leaving Telegram.

### Manual Renewal

1. Send `/renew_token` to the bot
2. Open the authorization URL in a browser
3. Authenticate with your Anthropic account
4. Paste the callback URL or authorization code back in the chat
5. Bot confirms: "Token renewed. Expires in 59m 55s."

### Automatic Refresh

The background monitor checks token health every 5 minutes (configurable). When the token is within the expiry buffer:

1. **Auto-refresh**: Attempts direct API refresh using the refresh token
2. **Telegram alert**: If auto-refresh fails, sends a renewal link to the chat

### Token Storage

Renewed tokens are written to:
- `~/.claude/.credentials.json` (file permissions: 0o600) — Claude CLI reads this automatically
- `process.env.ANTHROPIC_OAUTH_TOKEN` — immediate runtime pickup

### Agent-Specific Behavior

| Agent | `/renew_token` Behavior |
|-------|------------------------|
| Claude | Full OAuth PKCE flow via Telegram |
| Codex | Guidance to set `OPENAI_API_KEY` |
| Gemini | Guidance to run `gemini` for re-auth |
| Others | Generic "check credentials" message |

## Notifications

When enabled, the PA forwards events from **all** active coding sessions to Telegram:

- **Approval requests** — inline keyboard with Approve / Reject buttons
- **Task completions** — status message when an instance goes idle
- **Tool calls** — tool name with brief input summary (file path, command, pattern)

Disable with `POLPO_PA_NOTIFY_APPROVALS=false` and `POLPO_PA_NOTIFY_COMPLETIONS=false`.

## Security

### Access Control

The PA uses an **allowlist** model. Only Telegram users listed in `allowFrom` can interact with the bot. Entries can be:

- Numeric user IDs (recommended — cannot be changed by the user)
- Usernames (case-insensitive, with or without `@` prefix)
- `*` wildcard (allows everyone — not recommended)

An empty or missing allowlist denies all access.

### Token Handling

- Bot token is loaded from env/config, never hardcoded or logged
- OAuth PKCE flow uses `crypto.randomBytes(32)` for verifiers
- Pending OAuth flows expire after 10 minutes and are consumed on use
- Credential files written with `0o600` permissions

### Message Safety

- All user-facing output is HTML-escaped to prevent injection
- Inline button callback data is validated against InstanceManager before acting
- Auth codes are intercepted before reaching the agent (not sent as prompts)
- Markdown-to-HTML conversion restricts links to `http://` and `https://` protocols

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `POLPO_PA_TELEGRAM_TOKEN` | — | Bot token from @BotFather (**required**) |
| `POLPO_PA_TELEGRAM_ALLOW` | — | Comma-separated user IDs/usernames |
| `POLPO_PA_AGENT_TYPE` | `claude` | Agent type |
| `POLPO_PA_AGENT_CWD` | PA workspace | Agent working directory |
| `POLPO_PA_AGENT_MODEL` | (agent default) | Model override |
| `POLPO_PA_AGENT_NAME` | `Personal Assistant` | Dashboard display name |
| `POLPO_PA_AUTH_CHECK_INTERVAL` | `5` | Token check interval (minutes) |
| `POLPO_PA_AUTH_EXPIRY_BUFFER` | `15` | Expiry alert buffer (minutes) |
| `POLPO_PA_AUTH_AUTO_REFRESH` | `true` | Auto-refresh via refresh_token |
| `POLPO_PA_NOTIFY_APPROVALS` | `true` | Forward approval requests |
| `POLPO_PA_NOTIFY_COMPLETIONS` | `true` | Forward task completions |
| `POLPO_PA_MEMORY_DB` | `~/.config/polpo/pa-memory.db` | SQLite database path |
| `POLPO_PA_EMBEDDING_PROVIDER` | `hash` | Embedding provider |
| `POLPO_PA_EMBEDDING_API_KEY` | — | OpenAI embedding API key |
| `POLPO_PA_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `POLPO_PA_ALLOWED_TOOLS` | `WebFetch,WebSearch` | Tool whitelist (add `Bash,Read` for coding) |
| `POLPO_PA_IDLE_TIMEOUT_MINUTES` | `30` | Kill agent after N minutes idle |
| `POLPO_PA_PROMPT_TIMEOUT_MS` | `300000` | Per-prompt timeout (5 min) |
| `POLPO_PA_HISTORY_INJECT_COUNT` | `20` | Past exchanges injected on session start |

## File Structure

```
src/pa/
  index.js              # Module entry point — wires Telegram ↔ AgentBridge ↔ InstanceManager
  config.js             # Config loader (env + ~/.config/polpo/pa.json)
  agent-bridge.js       # Spawns agents, subscribes to events, exposes prompt/approve/reject
  workspace.js          # PA workspace with CLAUDE.md personality file
  telegram/
    bot.js              # grammY bot with sequentialize + throttler
    handlers.js         # Commands, text routing, inline buttons, media
    send.js             # Message sending with 4096-char chunking + HTML fallback
    format.js           # Markdown → Telegram HTML converter
    access.js           # Allowlist access control
  auth/
    oauth.js            # Anthropic OAuth PKCE (authorize, exchange, refresh)
    state.js            # Pending OAuth flow store (10-min expiry)
    token-monitor.js    # Background health check + auto-refresh
  memory/
    index.js            # MemoryManager — conversations + memories CRUD + search
    schema.js           # SQLite schema (conversations, memories, FTS5)
    embeddings.js       # Embedding providers (OpenAI API, hash fallback)
    hybrid.js           # Vector + BM25 hybrid search merge
```
