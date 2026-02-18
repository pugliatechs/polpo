# Polpo

**Work on Claude Code from your phone.**

Polpo lets developers send prompts, see responses, and control Claude Code sessions from any mobile device over VPN, Wi-Fi, or LAN.

## Architecture

```
                    Phone (VPN / LAN)
                       |
              +--------v---------+
              |  Polpo Hub       | :7890
              |  (Express + WS)  |
              +--+-------+---+---+
                 |       |   |
    +------------v--+ +--v---+----------+  +--v-----------+
    | Session Agent | | Hook Bridge     |  | Session      |
    | (wrapped)     | | (monitoring)    |  | Browser      |
    +--------+------+ +---+------------+   +--------------+
             |             |                reads JSONL
    +--------v------+ +---v------------+    session files
    | claude CLI    | | Claude Code    |
    | (stream-json) | | (VS Code/term) |
    +-------+-------+ +----------------+
            |            read-only
    +-------v-------+
    | MCP Permission|
    | Server        |
    +---------------+
      phone approval
```

Three integration modes:

- **Session**: spawns `claude` CLI with JSON streaming for full bidirectional control from phone, including MCP-based tool approval
- **Hooks**: taps into existing VS Code/terminal sessions via Claude Code hooks for read-only monitoring (with optional approval)
- **Session Browser**: discovers and displays past Claude Code sessions from JSONL files, with the ability to resume them

## Quick Start

### 1. Install

```bash
cd polpo && npm install
```

### 2. Start the Hub

```bash
node bin/polpo.js server
```

### 3. Start a Session

```bash
# New session in a project directory
node bin/polpo.js session --cwd /path/to/project --name "Backend API"

# Resume an existing Claude Code session
node bin/polpo.js session --resume <session-id>
```

### 4. Open on Your Phone

Navigate to `http://<your-computer-ip>:7890` on your phone's browser.

The dashboard shows active sessions, past session history, and lets you send prompts, watch tool calls, approve or reject actions, and abort tasks.

## Features

| Feature | Description |
|---------|-------------|
| Full Remote Control | Send prompts and see responses from your phone |
| Real-time Streaming | Tool calls, results, and text stream as they happen |
| Phone-based Approval | Approve or reject tool use from your phone (MCP for sessions, hooks for VS Code) |
| Auto-approve | Tap "Approve All" to auto-approve all tool use for the rest of the session |
| File Attachments | Send any file from your phone — images, PDFs, code, documents, etc. |
| Session Browser | Browse past Claude Code sessions with conversation history |
| Session Resume | Resume any past session directly from the phone dashboard |
| Instance Dashboard | See all active sessions at a glance with live status |
| Tool Call Cards | Bash commands, file edits, and searches rendered as mobile-native cards |
| Abort | Stop any running task with a tap |
| Multi-Instance | Run and monitor unlimited parallel sessions |
| Cost Tracking | Per-turn API costs displayed inline |
| Mobile-First UI | Dark OLED theme, touch-optimized, safe-area support, responsive layout |
| VS Code Monitoring | Passively watch existing VS Code sessions via hooks |

## Remote Sessions (Full Control)

The `session` command spawns a `claude` CLI process with JSON streaming and gives your phone full bidirectional control.

```bash
node bin/polpo.js session --cwd /path/to/project --name "My Task"
```

How it works:

1. Agent registers with the hub and connects via WebSocket
2. Waits for a prompt from your phone
3. Spawns `claude --input-format stream-json --output-format stream-json`
4. Relays everything: prompts in, responses + tool calls + results out
5. Process stays alive for multi-turn conversations

### Tool Approval

When a session runs in `default` permission mode, an MCP permission server handles tool approval. When Claude needs to run a tool that requires permission, the request appears on your phone as a banner with three options:

- **Approve** — allow this single tool use
- **Approve All** — allow this tool use and enable auto-approve for the rest of the session (all future tool calls are approved instantly without involving the phone)
- **Reject** — deny this tool use

When auto-approve is active, a green "Auto-approve ON" indicator appears with a "Stop" button to disable it.

To skip approval entirely (use with caution):

```bash
node bin/polpo.js session --cwd /path/to/project --permissions bypass
```

### Options

| Flag | Description |
|------|-------------|
| `--name <name>` | Display name for this session |
| `--cwd <dir>` | Project directory (default: current) |
| `--resume <id>` | Resume an existing Claude Code session |
| `--model <model>` | Model to use (e.g. opus, sonnet) |
| `--permissions <mode>` | `default` (phone approval via MCP) or `bypass` (skip all) |
| `--server <url>` | Hub WebSocket URL (default: `ws://127.0.0.1:7890`) |

## Session Browser

The dashboard automatically discovers past Claude Code sessions from `~/.claude/projects/` and displays them as cards with the session's first prompt as the title. Tap a session to view its full conversation history, or resume it to continue working from your phone.

Sessions are loaded from JSONL files and deduplicated to show clean conversation threads.

## VS Code Monitoring (Hooks)

For passively monitoring existing VS Code Claude Code sessions, use the hooks integration.

### Setup

```bash
# Print the hook config JSON
node bin/polpo.js hooks
```

Add the output to `~/.claude/settings.json`. Instances appear on your phone automatically when Claude Code uses a tool.

### Approval Mode

By default hooks are read-only. To enable phone-based tool approval, set `POLPO_APPROVE=1`:

```json
{
  "matcher": "",
  "command": "POLPO_APPROVE=1 node /path/to/polpo/src/hooks/pre-tool-use.js"
}
```

## File Attachments

Tap the paperclip icon to attach files from your phone. Supported types:

- **Images** — sent as base64 to Claude's vision (multimodal)
- **PDFs** — sent as native document content blocks
- **Text/code files** — small files (up to 100KB) are inlined directly in the prompt; larger files are saved to disk and Claude reads them with the Read tool
- **Any other file** — saved to disk and referenced by path for Claude to read

## Mobile UI

- Dark theme optimized for OLED screens
- Tool calls rendered as cards (Bash commands, file paths, search patterns)
- Tool results shown as collapsible code blocks
- Per-turn cost displayed inline
- Touch-friendly with 44px minimum touch targets
- Safe-area support for notched/island phones
- Responsive layout with breakpoints for small phones, landscape, and tablets
- Virtual keyboard handling (no content jump on iOS/Android)

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List discovered Claude Code sessions |
| GET | `/api/sessions/:id/history` | Get conversation history from JSONL |
| POST | `/api/sessions/:id/resume` | Resume a session (spawns wrapped agent) |
| GET | `/api/instances` | List all active instances |
| GET | `/api/instances/:id` | Get instance details |
| GET | `/api/instances/:id/conversation` | Get conversation history |
| POST | `/api/instances` | Register a new instance |
| DELETE | `/api/instances/:id` | Unregister an instance |
| POST | `/api/instances/:id/prompt` | Send a prompt |
| POST | `/api/instances/:id/approve` | Approve pending tool use |
| POST | `/api/instances/:id/reject` | Reject pending tool use |
| POST | `/api/instances/:id/auto-approve` | Toggle auto-approve for an instance |
| POST | `/api/instances/:id/abort` | Abort current task |
| POST | `/api/upload` | Upload a file attachment (base64) |
| POST | `/api/permission-request` | MCP permission server long-poll |
| GET | `/health` | Health check |

### WebSocket

Connect to `ws://<host>:<port>?role=dashboard` for real-time updates.

Connect to `ws://<host>:<port>?role=agent&instanceId=<id>` as an agent.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `POLPO_PORT` | `7890` | Server port |
| `POLPO_HOST` | `0.0.0.0` | Server bind address |
| `POLPO_SERVER` | `ws://127.0.0.1:7890` | Hub URL (used by session, agent, bridge) |
| `POLPO_NAME` | auto from directory | Display name for the instance |
| `POLPO_APPROVE` | `0` | Set to `1` for phone approval (hooks only) |
| `POLPO_TIMEOUT` | `300000` | Approval timeout in ms (default 5 min) |

## License

MIT
