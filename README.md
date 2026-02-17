# 🐙 Polpo

**Control multiple Claude Code instances from your phone.**

Polpo is a lightweight hub that lets developers monitor and control their Claude Code instances — running in VS Code or terminal — from any mobile device on the same network.

## Architecture

```
┌──────────────────────────────────────────────┐
│                Your Computer                 │
│                                              │
│  ┌─────────────┐   ┌─────────────┐          │
│  │ Claude Code  │   │ Claude Code  │   ...   │
│  │ + polpo      │   │ + polpo      │         │
│  │   agent      │   │   agent      │         │
│  └──────┬───────┘   └──────┬───────┘         │
│         │   WebSocket      │                 │
│         └────────┬─────────┘                 │
│                  │                           │
│          ┌───────▼────────┐                  │
│          │  Polpo Server  │ :7890            │
│          │  (Hub)         │                  │
│          └───────┬────────┘                  │
│                  │                           │
└──────────────────┼───────────────────────────┘
                   │ Wi-Fi / LAN
          ┌────────▼─────────┐
          │   📱 Phone       │
          │   Browser UI     │
          └──────────────────┘
```

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Start the Hub Server

```bash
# Start with defaults (port 7890, all interfaces)
node bin/polpo.js server

# Or with options
node bin/polpo.js server --port 8080 --verbose
```

The server will print the URL to open on your phone.

### 3. Register Claude Code Instances

In each terminal or VS Code session where Claude Code is running, start an agent:

```bash
# Terminal instance
node bin/polpo.js agent --name "Backend API" --type terminal

# VS Code instance
node bin/polpo.js agent --name "Frontend UI" --type vscode

# Connecting to a remote server
node bin/polpo.js agent --name "My Task" --server ws://192.168.1.100:7890
```

### 4. Open on Your Phone

Navigate to `http://<your-computer-ip>:7890` on your phone's browser. You'll see all connected instances with real-time status.

## Features

- **Instance Dashboard** — See all running Claude Code instances at a glance
- **Real-time Status** — Live updates via WebSocket (idle, busy, waiting, paused)
- **Remote Prompting** — Send prompts to any instance from your phone
- **Approval Control** — Approve or reject tool/action requests remotely
- **Abort/Pause** — Stop or pause any instance with a tap
- **Conversation History** — View the conversation stream for each instance
- **Mobile-First UI** — Dark theme, touch-optimized, PWA-ready
- **Multi-Instance** — Manage unlimited concurrent instances

## Mobile UI

The web interface is designed for smartphones:

- Dark theme optimized for OLED screens
- Touch-friendly card layout with swipe gestures
- Real-time WebSocket updates (no polling)
- Auto-reconnect on network changes
- Safe-area support for notched phones

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

Connect to `ws://<host>:<port>?role=agent&instanceId=<id>` as a Claude Code agent.

## Programmatic Usage

### Using the Agent in Your Own Scripts

```javascript
const { PolpoAgent } = require('./src/agent');

const agent = new PolpoAgent({
  name: 'My Custom Agent',
  type: 'terminal',
  project: 'my-project',
  onPrompt: (text) => {
    console.log('Received prompt from mobile:', text);
    // Feed this into Claude Code
  },
  onApprove: () => {
    console.log('Action approved from mobile');
  },
  onReject: () => {
    console.log('Action rejected from mobile');
  },
});

await agent.start();

// Report status changes
agent.sendStatus('busy');

// Send output back to mobile
agent.sendOutput('Working on your request...');

// Request approval from mobile user
agent.requestApproval('bash', 'Run deployment script', 'npm run deploy');
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `POLPO_PORT` | `7890` | Server port |
| `POLPO_HOST` | `0.0.0.0` | Server bind address |
| `POLPO_SERVER` | `ws://127.0.0.1:7890` | Agent: hub server URL |

## License

MIT
