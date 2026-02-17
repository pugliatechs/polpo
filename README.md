# 🐙 Polpo

**Work on Claude Code from your phone.**

Polpo lets developers send prompts, see responses, and control Claude Code sessions from any mobile device over VPN, Wi-Fi, or LAN.

## Architecture

```
                    📱 Phone (VPN / LAN)
                       │
              ┌────────▼─────────┐
              │  Polpo Hub       │ :7890
              │  (Express + WS)  │
              └──┬───────────┬───┘
                 │           │
    ┌────────────▼──┐   ┌────▼───────────┐
    │ Session Agent │   │ Hook Bridge    │
    │ (wrapped)     │   │ (monitoring)   │
    └────────┬──────┘   └───┬────────────┘
             │              │
    ┌────────▼──────┐   ┌───▼────────────┐
    │ claude CLI    │   │ Claude Code    │
    │ (stream-json) │   │ (VS Code)      │
    └───────────────┘   └────────────────┘
       full control        read-only
```

Two integration modes:

- **Session**: spawns `claude` CLI with JSON streaming for full bidirectional control from phone
- **Hooks**: taps into existing VS Code sessions via Claude Code hooks for read-only monitoring

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

Type a prompt, see the response stream in real-time, watch tool calls execute, and abort if needed.

## Use Case: Work from Anywhere

1. Start the hub + a session on your workstation
2. Leave your desk (keep the PC running)
3. On your phone over VPN, open the Polpo dashboard
4. Continue working: send prompts, see tool calls, review output

The session process stays alive between prompts. If it exits, resume with `--resume <session-id>`.

## Features

| Feature | Description |
|---------|-------------|
| Full Remote Control | Send prompts and see responses from your phone |
| Real-time Streaming | Tool calls, results, and text stream as they happen |
| Instance Dashboard | See all sessions at a glance with live status |
| Tool Call Cards | Bash commands, file edits, and searches rendered as mobile-native cards |
| Abort | Stop any running task with a tap |
| Session Resume | Pick up where you left off with `--resume` |
| Multi-Instance | Run and monitor unlimited parallel sessions |
| Cost Tracking | Per-turn API costs displayed inline |
| Mobile-First UI | Dark OLED theme, touch-optimized, safe-area support |
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

Options:

| Flag | Description |
|------|-------------|
| `--name <name>` | Display name for this session |
| `--cwd <dir>` | Project directory (default: current) |
| `--resume <id>` | Resume an existing Claude Code session |
| `--model <model>` | Model to use (e.g. opus, sonnet) |
| `--permissions <mode>` | Permission mode: `default` or `bypass` |
| `--server <url>` | Hub WebSocket URL (default: `ws://127.0.0.1:7890`) |

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

## Mobile UI

- Dark theme optimized for OLED screens
- Tool calls rendered as cards (Bash commands, file paths, search patterns)
- Tool results shown as collapsible code blocks
- Per-turn cost displayed inline
- Touch-friendly with safe-area support for notched phones
- Auto-reconnect on network changes

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/instances` | List all instances |
| GET | `/api/instances/:id` | Get instance details |
| GET | `/api/instances/:id/conversation` | Get conversation history |
| POST | `/api/instances` | Register a new instance |
| DELETE | `/api/instances/:id` | Unregister an instance |
| POST | `/api/instances/:id/prompt` | Send a prompt |
| POST | `/api/instances/:id/approve` | Approve pending action |
| POST | `/api/instances/:id/reject` | Reject pending action |
| POST | `/api/instances/:id/abort` | Abort current task |

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
