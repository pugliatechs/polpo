<h1 align="center">Polpo</h1>

<p align="center">
  <img src="assets/logo.png" alt="Polpo" width="240" height="240">
</p>

<p align="center"><strong>Work on Claude Code, Codex, Gemini, OpenCode, and Pi from your phone.</strong></p>

Polpo lets developers send prompts, see responses, and control Claude Code, OpenAI Codex CLI, Google Gemini CLI, OpenCode, and Pi coding agent sessions from any mobile device over VPN, Wi-Fi, LAN, or a public tunnel.

> **Help us test!** Claude Code support is stable and battle-tested. Support for **Codex**, **Gemini**, **OpenCode**, and **Pi** is functional but still being stabilized — edge cases in multi-turn, auto-discovery, and session resume may exist. If you use any of these agents, we'd love your feedback: open an issue with reproduction steps and we'll fix it fast.

## Why

AI coding sessions can run for minutes while reading files, writing code, and running tests. During that time, developers are tethered to their terminal waiting to approve tool calls, review output, or send the next prompt.

Polpo frees you from the keyboard. Grab a coffee, kick off a refactor while waiting for a train, or review tool calls from an airport lounge - your phone becomes a full remote control for Claude Code, Codex, Gemini, OpenCode, and Pi. You see every tool call as it happens, approve or reject actions with a tap, send follow-up prompts, and abort tasks when something goes wrong. All in real time, from any network.

## Architecture

Four integration modes, supporting **Claude Code**, **OpenAI Codex CLI**, **Google Gemini CLI**, **OpenCode**, and **Pi**:

- **Session** - spawns `claude`, `codex exec --json`, `gemini --output-format stream-json`, `opencode run --format json`, or `pi --mode rpc` with full bidirectional control from phone, including MCP-based tool approval
- **Auto-Discovery** - watches `~/.claude/projects/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, `~/.local/share/opencode/opencode.db`, and `~/.pi/agent/sessions/` for active sessions, auto-registers them on the dashboard — no setup needed
- **Hooks** - taps into existing terminal sessions via Claude Code hooks for terminal prompt forwarding and phone-based tool approval
- **Session Browser** - discovers and displays past sessions from Claude Code, Codex, Gemini, OpenCode, and Pi, with the ability to resume them

## Requirements

- **Node.js** 18+ (for built-in test runner; 16+ works for everything else)
- **Claude Code** CLI installed and authenticated, **and/or** **Codex CLI** installed and authenticated, **and/or** **Gemini CLI** installed and authenticated, **and/or** **OpenCode** installed and configured, **and/or** **Pi** installed and configured
- **macOS** or **Linux** (Windows is not currently supported)

### macOS Notes

Polpo works natively on macOS - no extra setup needed. For tunnel providers:

```bash
# cloudflared (recommended)
brew install cloudflare/cloudflare/cloudflared

# ngrok (optional)
brew install ngrok
```

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
# New Claude Code session
node bin/polpo.js session --cwd /path/to/project --name "Backend API"

# New Codex session
node bin/polpo.js session --agent codex --cwd /path/to/project --name "Codex Task"

# New Gemini session
node bin/polpo.js session --agent gemini --cwd /path/to/project --name "Gemini Task"

# New Pi session
node bin/polpo.js session --agent pi --cwd /path/to/project --name "Pi Task"

# Resume an existing session
node bin/polpo.js session --resume <session-id>
```

### 4. Open on Your Phone

Navigate to `http://<your-computer-ip>:7890` on your phone's browser.

The dashboard shows active sessions, past session history, and lets you send prompts, watch tool calls, approve or reject actions, and abort tasks.

> **Security**: Running on localhost alone does not protect you. Use `--tunnel` with auth for internet access, or connect via VPN for private access. Read the [Security](#security) section before exposing Polpo to any network.

## Features

<p align="center">
  <img src="assets/session-detail.jpg" alt="Session detail with tool calls and auto-approve" width="300">
</p>

| Feature | Description |
|---------|-------------|
| Full Remote Control | Send prompts and see responses from your phone |
| Real-time Streaming | Tool calls, results, and text stream as they happen |
| Phone-based Approval | Approve or reject tool use from your phone (MCP for sessions, hooks for VS Code) |
| Plan Review | Review proposed plans with full markdown rendering before approving |
| Question Answers | Answer multi-choice questions from your phone when Claude asks |
| Auto-approve | Tap "Approve All" to auto-approve tool calls (plans and questions always require review) |
| File Attachments | Send any file from your phone - images, PDFs, code, documents, etc. |
| Multi-Agent | Full support for Claude Code, OpenAI Codex CLI, Google Gemini CLI, OpenCode, and Pi |
| Session Browser | Browse past sessions from Claude Code, Codex, Gemini, OpenCode, and Pi with conversation history |
| Session Resume | Resume any past session directly from the phone dashboard |
| Auto-Discovery | Active sessions detected automatically via filesystem watching — no hooks required |
| Live History Sync | Terminal/VS Code conversations synced to phone in real-time via JSONL watcher |
| Phone Takeover | Take over a terminal session from your phone to send prompts |
| Instance Dashboard | See all active sessions at a glance with live status (busy/idle derived from JSONL) |
| Tool Call Cards | Bash commands, file edits, and searches rendered as mobile-native cards |
| Abort | Stop any running task with a tap |
| Multi-Instance | Run and monitor unlimited parallel sessions |
| Cost Tracking | Per-turn API costs displayed inline |
| New Session from Phone | Create fresh sessions of any agent type directly from the dashboard |
| Skills Management | Browse, search, install, and remove [skills.sh](https://skills.sh) skills from your phone |
| Mobile-First UI | Dark OLED theme, touch-optimized, safe-area support, responsive layout |
| Tunnel Access | Expose the hub over the internet with `--tunnel` (cloudflared, localtunnel, ngrok, SSH) |

> **Note**: Polpo streaming is **near real-time**, not strictly real-time. Auto-discovery relies on filesystem events (`fs.watch`) which have inherent OS-level latency; JSONL/JSON watchers debounce file changes; agents using one-shot process invocation (Codex, Gemini) accumulate deltas before flushing; and when `fs.watch` is unavailable (e.g. inotify limit exhaustion), the system falls back to periodic polling. In practice, latency is typically under one second, but it is not zero.

## Security

Polpo gives your phone full control over coding agents running on your machine: sending prompts, approving tool calls, reading conversation output. Securing this access is critical.

### Recommended Setup

**Option A: Tunnel + Auth (internet access from anywhere)**

Use `--tunnel` with an auth mode. This exposes Polpo via a public URL with authentication enabled. Best when you need access from cellular, a different network, or when you don't control the network.

```bash
# Token-only (single-use URL, auto-generated)
polpo server --tunnel

# Token + 4-digit PIN (displayed in terminal)
polpo server --tunnel --auth pin

# Token + TOTP via authenticator app (highest security)
polpo server --tunnel --auth paranoid
```

**Option B: VPN to your machine (no public exposure)**

Connect your phone to the same network as your machine via a VPN (WireGuard, Tailscale, ZeroTier, etc.), then access Polpo directly at `http://<machine-ip>:7890`. No tunnel, no public URL. The connection stays private within your VPN.

```bash
# Start without tunnel - accessible only on local/VPN network
polpo server
```

### Why Localhost Is Not Enough

Running on `localhost` does not make Polpo safe. A malicious webpage you visit in your browser can open a WebSocket to `ws://localhost:7890` and read all session data (tool calls, file contents, API keys) via a CSRF attack. Polpo mitigates this with **Origin header validation** on both WebSocket and API connections: the server rejects any request whose Origin doesn't match its own host. This blocks cross-origin attacks from malicious pages while allowing legitimate connections from the Polpo dashboard and agents.

### Auth Modes

| Mode | Flag | Token | MFA | Use Case |
|------|------|-------|-----|----------|
| **token** | `--auth token` | Single-use URL token | No | Quick tunnel access (default for `--tunnel`) |
| **pin** | `--auth pin` | URL token + 4-digit PIN | Yes | Shared networks, added protection |
| **paranoid** | `--auth paranoid` | URL token + TOTP (6-digit) | Yes | Long-lived tunnels, highest security |

Auth is **auto-enabled** when using `--tunnel`. For LAN or VPN deployments, you can enable it manually with `--auth <mode>`.

### How It Works

<p align="center">
  <img src="assets/auth.jpeg" alt="TOTP authentication page" width="300">
</p>

- **Token**: A `crypto.randomBytes(32)` base64url token is baked into the QR code URL. It is single-use — after the first scan, it is burned and cannot be reused.
- **PIN**: A 4-digit PIN is displayed in the terminal. After scanning the QR code, the phone must enter the PIN. After 3 failed attempts, a new PIN is generated.
- **TOTP**: Uses RFC 6238 TOTP with a persistent secret stored in `~/.config/polpo/totp.json`. On first run, the secret and `otpauth://` URI are displayed. Add it to any authenticator app.
- **Sessions**: After authentication, a session cookie (`polpo_session`, HttpOnly, SameSite) is set. Subsequent requests use the cookie.
- **Agents**: Agents and hooks use the raw token via `Authorization: Bearer <token>` header — the token is not burned for agent connections.

### Built-in Protections

- **CSRF (Cross-Site Request Forgery)**: Origin header validation on WebSocket and API endpoints. Cross-origin requests from malicious pages are rejected.
- **Command injection**: All CLI invocations use `execFile` (not `exec`). Arguments are passed as arrays, never shell-concatenated.
- **Path traversal**: File access endpoints validate resolved paths stay within expected directories.
- **XSS (Cross-Site Scripting)**: All user and agent content is escaped via `escapeHtml()` before rendering. SVG uploads are force-downloaded, not served inline.
- **Rate limiting**: Auth verification (10/min), session creation (10/min), and file uploads (30/min) are rate-limited per IP.
- **Timing-safe comparison**: Token and TOTP verification use `crypto.timingSafeEqual` to prevent timing attacks.

### Usage

```bash
# Tunnel with default auth (token-only, auto-generated)
polpo server --tunnel

# Tunnel with PIN
polpo server --tunnel --auth pin

# Tunnel with TOTP
polpo server --tunnel --auth paranoid

# LAN/VPN with manual auth
polpo server --auth token

# Agents pass the token
polpo session --server ws://host:7890 --token <token>
```

The token is printed in the terminal output for connecting agents and bridges.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `POLPO_TOKEN` | Auth token for agents/bridges (alternative to `--token` flag) |

## Tunnel Access (No VPN Required)

Add `--tunnel` to expose the hub over the internet. A public URL and QR code are printed for your phone to scan - no VPN or same-network requirement.

```bash
# Auto-detect best available provider
node bin/polpo.js server --tunnel

# Use a specific provider
node bin/polpo.js server --tunnel cloudflared
node bin/polpo.js server --tunnel localtunnel
node bin/polpo.js server --tunnel ngrok

# SSH reverse tunnel to your own server
node bin/polpo.js server --tunnel ssh --tunnel-host user@myserver.com
node bin/polpo.js server --tunnel ssh --tunnel-host user@myserver.com --tunnel-port 8080
```

### Provider Comparison

| Provider | Install | Signup | Auto-detect | Notes |
|----------|---------|--------|-------------|-------|
| **cloudflared** | [Download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | No | Yes (1st) | Best reliability, free quick tunnels |
| **localtunnel** | Bundled | No | Yes (2nd) | Always available fallback (npm dep) |
| **ngrok** | [Download](https://ngrok.com/download) | Yes | No | Requires auth token, stable URLs available |
| **ssh** | Built-in | No | No | Requires `--tunnel-host`, uses your own server |

Auto-detect tries cloudflared first, then falls back to localtunnel. ngrok and SSH require explicit `--tunnel <provider>` since they need configuration.

If the tunnel fails, the server still runs normally on LAN.

## Remote Sessions (Full Control)

The `session` command spawns a CLI process with JSON streaming and gives your phone full bidirectional control. Use `--agent` to select the agent type.

```bash
# Claude Code (default)
node bin/polpo.js session --cwd /path/to/project --name "My Task"

# OpenAI Codex
node bin/polpo.js session --agent codex --cwd /path/to/project --name "Codex Task"

# Google Gemini
node bin/polpo.js session --agent gemini --cwd /path/to/project --name "Gemini Task"

# Pi (75+ model providers)
node bin/polpo.js session --agent pi --cwd /path/to/project --name "Pi Task"
```

### Tool Approval

When a session runs in `default` permission mode, an MCP permission server handles tool approval. When Claude needs to run a tool that requires permission, the request appears on your phone as a banner with three options:

- **Approve** - allow this single tool use
- **Approve All** - enable auto-approve for the rest of the session (all future tool calls are approved instantly without involving the phone)
- **Reject** - deny this tool use

<p align="center">
  <img src="assets/tool-approval.jpg" alt="Tool approval dialog with Approve, Approve All, and Reject buttons" width="300">
</p>

When auto-approve is active, a green "Auto-approve ON" indicator appears with a "Stop" button to disable it.

**Plans and questions always require review**, even when auto-approve is on. When Claude proposes a plan (`ExitPlanMode`), the full plan content is rendered with markdown (headings, tables, code blocks, lists) in a collapsible panel. When Claude asks questions (`AskUserQuestion`), the options appear as tappable radio buttons or checkboxes with a free-text "Other" fallback.

To skip approval entirely (use with caution):

```bash
node bin/polpo.js session --cwd /path/to/project --permissions bypass
```

### Options

| Flag | Description |
|------|-------------|
| `--name <name>` | Display name for this session |
| `--cwd <dir>` | Project directory (default: current) |
| `--resume <id>` | Resume an existing session |
| `--model <model>` | Model to use (e.g. opus, sonnet for Claude; gpt-5-codex for Codex; flash, pro for Gemini; any provider model for OpenCode/Pi) |
| `--permissions <mode>` | `default` (phone approval via MCP) or `bypass` (skip all) |
| `--agent <type>` | Agent type: `claude` (default), `codex`, `gemini`, `opencode`, or `pi` |
| `--server <url>` | Hub WebSocket URL (default: `ws://127.0.0.1:7890`) |
| `--token <token>` | Auth token (or set `POLPO_TOKEN` env var) |

## Session Browser

The dashboard automatically discovers past sessions from `~/.claude/projects/` (Claude Code), `~/.codex/sessions/` (Codex), `~/.gemini/tmp/` (Gemini), `~/.local/share/opencode/opencode.db` (OpenCode), and `~/.pi/agent/sessions/` (Pi) and displays them as cards with the session's first prompt as the title. Each card shows an agent type badge (Claude, Codex, Gemini, OpenCode, or Pi). Tap a session to view its full conversation history, or resume it to continue working from your phone.

Sessions are loaded from JSONL/JSON files (or SQLite for OpenCode) and deduplicated to show clean conversation threads. Use the `?source=claude|codex|gemini|opencode|pi|all` query parameter on the `/api/sessions` endpoint to filter by agent type.

## Auto-Discovery

The Polpo server automatically discovers active sessions from Claude Code, Codex, Gemini, OpenCode, and Pi by watching their respective session directories:

- **Claude Code**: `~/.claude/projects/<project-slug>/*.jsonl`
- **Codex CLI**: `~/.codex/sessions/*.jsonl`
- **Gemini CLI**: `~/.gemini/tmp/<project-slug>/chats/session-*.json`
- **OpenCode**: `~/.local/share/opencode/opencode.db` (SQLite, polled every 5s)
- **Pi**: `~/.pi/agent/sessions/--<cwd-dashes>--/*.jsonl`

Claude, Codex, Gemini, and Pi use event-driven `fs.watch()`. OpenCode uses SQLite polling via `sqlite3` CLI (requires `sqlite3` to be installed).

When a session is detected:
1. An instance appears on the phone dashboard with the appropriate agent type badge
2. A JSONL watcher starts streaming the full conversation in real-time (using the correct adapter for each agent's JSONL format)
3. Status (busy/idle) is derived from the JSONL content — user messages set busy, turn completions set idle

Auto-discovery works with any interface that writes JSONL/JSON session files (terminal CLI, VS Code extension, web).

## Codex CLI Support

Polpo supports OpenAI Codex CLI with full parity:

- **Session spawning** — `polpo session --agent codex` spawns `codex exec --json` processes
- **Multi-turn** — each prompt spawns a new process using `codex exec resume <thread-id> --json "prompt"`, keeping the conversation context
- **Auto-discovery** — watches `~/.codex/sessions/` for active JSONL files
- **Session browser** — lists past Codex sessions alongside Claude Code sessions
- **Takeover** — take over a terminal Codex session from your phone
- **Event translation** — Codex's event format (`thread.started`, `item.*`, `turn.*`) is translated to Polpo's uniform message format

### Codex-Specific Notes

- Codex uses one-shot process invocation (`codex exec`) rather than stdin streaming. Multi-turn requires killing and respawning with `resume`, which adds ~1-2s between prompts.
- Permission handling uses `--full-auto` for bypass mode and `-a on-request` for default mode.
- Images are attached via `--image <path>` flag; other files are referenced in the prompt text.
- The dashboard shows a green "Codex" badge on Codex instances, and a purple "Claude" badge on Claude instances.

## Gemini CLI Support



Polpo supports Google Gemini CLI with full parity:

- **Session spawning** — `polpo session --agent gemini` spawns `gemini -p "..." --output-format stream-json` processes
- **Multi-turn** — each prompt spawns a new process using `gemini --resume <session-id> -p "..." --output-format stream-json`, keeping the conversation context
- **Auto-discovery** — watches `~/.gemini/tmp/<project>/chats/` for active JSON session files
- **Session browser** — lists past Gemini sessions alongside Claude Code and Codex sessions
- **Takeover** — take over a terminal Gemini session from your phone
- **Event translation** — Gemini's stream-json format (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`) is translated to Polpo's uniform message format

### Gemini-Specific Notes

- Gemini uses one-shot process invocation (like Codex) rather than stdin streaming. Multi-turn requires killing and respawning with `--resume`, which adds ~1-2s between prompts.
- Permission handling uses `--approval-mode=yolo` for bypass mode (Gemini does not support MCP).
- Images and files are attached via `@<path>` syntax appended to the prompt text.
- Session files are JSON (not JSONL) — the adapter re-reads the full JSON on file changes and diffs message counts.
- The dashboard shows a blue "Gemini" badge on Gemini instances.

### Requirements

```bash
npm install -g @google/gemini-cli
```

Gemini CLI must be authenticated (run `gemini` once to set up API key or Google account auth).

## OpenCode Support

Polpo supports [OpenCode](https://github.com/opencode-ai/opencode), a Go-based open-source coding agent with 75+ model providers (including Ollama for local models):

- **Session spawning** — `polpo session --agent opencode` spawns `opencode run -p "..." --format json -q` processes
- **Multi-turn** — each prompt spawns a new process using `opencode run --session <session-id> -p "..." --format json -q`
- **Auto-discovery** — polls `~/.local/share/opencode/opencode.db` for active sessions via `sqlite3` CLI
- **Session browser** — lists past OpenCode sessions alongside other agent types
- **Takeover** — take over a terminal OpenCode session from your phone
- **Model selection** — pass any provider model via `--model` (e.g. `ollama/llama3`, `openai/gpt-4o`, `anthropic/claude-sonnet`)

### OpenCode-Specific Notes

- OpenCode uses one-shot process invocation (like Codex/Gemini). Multi-turn requires `--session` flag.
- No MCP support — OpenCode does not use permission prompts.
- Sessions are stored in SQLite (not JSONL files) — auto-discovery polls the DB every 5 seconds.
- File attachments use `--file <path>` flag.
- The dashboard shows an orange "OpenCode" badge on OpenCode instances.

### Requirements

```bash
go install github.com/opencode-ai/opencode@latest
```

OpenCode must be configured with at least one provider (run `opencode` once to set up).

Auto-discovery requires `sqlite3` CLI (`apt install sqlite3` / `brew install sqlite3`).

## Pi Support

Polpo supports [Pi](https://github.com/mariozechner/pi-coding-agent), a coding agent with 75+ model providers that uses a long-running RPC mode:

- **Session spawning** — `polpo session --agent pi` spawns `pi --mode rpc` with persistent stdin/stdout JSON streaming (same pattern as Claude Code)
- **Multi-turn** — the Pi process stays alive across prompts (no respawning needed)
- **Auto-discovery** — watches `~/.pi/agent/sessions/` for active JSONL files
- **Session browser** — lists past Pi sessions alongside other agent types
- **Takeover** — take over a terminal Pi session from your phone
- **Model selection** — pass any provider model via `--model` (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet`, `ollama/llama3`)

### Pi-Specific Notes

- Pi uses long-running RPC mode (`pi --mode rpc`) — the process stays alive and accepts prompts via stdin JSON, similar to Claude Code's stream-json mode.
- Abort sends `{"type":"abort"}` via stdin first, then escalates to SIGINT/SIGKILL.
- No MCP support — Pi handles permissions internally.
- Images are attached via the `images` array in the prompt JSON; files use `@<path>` syntax.
- Session files use a tree structure (entries have `id`/`parentId` fields) at `~/.pi/agent/sessions/--<cwd-dashes>--/<timestamp>_<uuid>.jsonl`.
- The dashboard shows a pink "Pi" badge on Pi instances.

### Requirements

```bash
npm install -g @mariozechner/pi-coding-agent
```

Pi must be configured with at least one provider (run `pi` once to set up).

## Terminal Sync (Hooks)

Hooks are **optional** — auto-discovery handles session detection and conversation sync without them. Hooks add two capabilities:

- **Terminal prompt forwarding** — see what the terminal user types in real-time (via `UserPromptSubmit` hook)
- **Phone-based tool approval** — approve or reject tool calls from your phone (via `PreToolUse` hook with `POLPO_APPROVE=1`)

### Setup

```bash
# Print the hook config JSON
node bin/polpo.js hooks
```

Add the output to `~/.claude/settings.json`. The bridge daemon auto-discovers the server token from `~/.config/polpo/server.json` — no manual token passing needed.

> **Note**: Shell hooks from `settings.json` work with the `claude` CLI. The VS Code extension uses its own internal hook mechanism and does not execute shell hooks. For VS Code sessions, auto-discovery provides full conversation sync without hooks.

### Phone Takeover

Auto-discovered and hook instances are **read-only** — they mirror conversations from session files on disk, but have no backing agent process to accept prompts. Tap **Take Over** to spawn a real agent process (`claude --resume`, `codex exec resume`, `gemini --resume`, or `pi --session`) that resumes the session with full prompt capability. The existing conversation history is preserved in the new instance. This is the same resume mechanism used by the Claude Code VS Code extension when selecting a previous conversation — there is no long-lived process to reconnect to; the CLI replays context from transcript files on each resume.

<p align="center">
  <img src="assets/codex-takeover.jpg" alt="Codex session with Take Over button" width="300">
</p>

When you return to your terminal, run `claude --continue` (Claude) or start a new session (Codex/Gemini) to reload the conversation. In VS Code, reload the window (`Ctrl+Shift+P` → "Reload Window") to pick up messages sent from Polpo — the VS Code extension caches conversations in memory and only re-reads session files on reload.

### Approval Mode

To enable phone-based tool approval for hook instances, set `POLPO_APPROVE=1`:

```json
{
  "matcher": "",
  "command": "POLPO_APPROVE=1 node /path/to/polpo/src/hooks/pre-tool-use.js"
}
```

## File Attachments

Tap the paperclip icon to attach files from your phone. Supported types:

- **Images** - sent as base64 to Claude's vision (multimodal)
- **PDFs** - sent as native document content blocks
- **Text/code files** - small files (up to 100KB) are inlined directly in the prompt; larger files are saved to disk and Claude reads them with the Read tool
- **Any other file** - saved to disk and referenced by path for Claude to read

## Skills Management

The dashboard integrates with the [skills.sh](https://skills.sh) ecosystem, letting you manage agent skills directly from your phone.

- **Browse installed** — see all installed skills with name, description, tags, and rule file counts
- **Search registry** — search the skills.sh catalog with debounced live results
- **Install** — install any skill with a tap (runs `npx skills add <package> -g -y` on the server)
- **Remove** — remove installed skills with confirmation
- **Detail view** — tap any installed skill to see its full SKILL.md content rendered as markdown

Skills are stored at `~/.agents/skills/` and symlinked into `~/.claude/skills/` for use by coding agents.

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skills` | List installed skills (parsed from SKILL.md frontmatter) |
| GET | `/api/skills/search?q=<query>` | Search skills.sh registry (60s cache) |
| POST | `/api/skills/install` | Install a skill (`{ "package": "owner/repo@skill" }`) |
| DELETE | `/api/skills/:name` | Remove an installed skill |
| GET | `/api/skills/:name/content` | Get SKILL.md content for detail view |

## Mobile UI

- Dark theme optimized for OLED screens
- Full markdown rendering — headers, bold, italic, code blocks (with language labels), inline code, bullet/numbered lists, tables, blockquotes, links, horizontal rules, strikethrough
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
| GET | `/api/sessions` | List discovered sessions (`?source=claude\|codex\|gemini\|opencode\|pi\|all`) |
| GET | `/api/sessions/:id/history` | Get conversation history from JSONL |
| POST | `/api/sessions/:id/resume` | Resume a session (spawns wrapped agent) |
| POST | `/api/sessions/new` | Create a new session (`{ agentType, cwd, name?, model? }`) |
| GET | `/api/instances` | List all active instances |
| GET | `/api/instances/:id` | Get instance details |
| GET | `/api/instances/:id/conversation` | Get conversation history |
| POST | `/api/instances` | Register a new instance |
| DELETE | `/api/instances/:id` | Unregister an instance |
| POST | `/api/instances/:id/prompt` | Send a prompt |
| POST | `/api/instances/:id/approve` | Approve pending tool use |
| POST | `/api/instances/:id/reject` | Reject pending tool use |
| POST | `/api/instances/:id/auto-approve` | Toggle auto-approve for an instance |
| POST | `/api/instances/:id/answer` | Submit answers to pending questions |
| POST | `/api/instances/:id/takeover` | Take over a hook instance (spawns wrapped agent) |
| POST | `/api/instances/:id/abort` | Abort current task |
| POST | `/api/upload` | Upload a file attachment (base64) |
| POST | `/api/permission-request` | MCP permission server long-poll |
| GET | `/api/skills` | List installed skills |
| GET | `/api/skills/search?q=` | Search skills.sh registry |
| POST | `/api/skills/install` | Install a skill |
| DELETE | `/api/skills/:name` | Remove a skill |
| GET | `/api/skills/:name/content` | Get skill SKILL.md content |
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
| `POLPO_TOKEN` | (none) | Auth token for agents/bridges |
| `POLPO_NAME` | auto from directory | Display name for the instance |
| `POLPO_APPROVE` | `0` | Set to `1` for phone approval (hooks only) |
| `POLPO_TIMEOUT` | `300000` | Approval timeout in ms (default 5 min) |

## Testing

```bash
npm test
```

Runs unit tests with Node's built-in test runner. Tests cover authentication (token, PIN, TOTP, sessions, middleware), instance manager, tunnel provider logic, session JSONL/JSON parsing, JSONL/JSON file watcher (messages, status events, dedup), session scanner (Claude/Codex/Gemini/Pi auto-discovery, idle detection, project watching), Codex agent (event translation, hub messages, multi-turn), OpenCode agent (event translation, delta accumulation), Pi agent (RPC event handling, delta accumulation, tool call streaming), Codex scanner (Codex session discovery), Pi scanner (Pi session discovery, slug parsing), agent factory (agent type routing), and skills API (frontmatter parsing, search output parsing, input validation).

## System Overview

```mermaid
graph TD
    Phone["Phone (any network)"]
    Tunnel["Tunnel (optional)
    cloudflared / localtunnel / ngrok / SSH"]
    Hub["Polpo Hub :7890
    Express + WebSocket"]
    Factory["Agent Factory"]
    Scanner["Session Scanner
    (Claude + Codex + Gemini + Pi)"]
    Hooks["Hook Bridge
    (optional)"]
    Browser["Session Browser"]
    Claude["claude CLI
    (stream-json)"]
    Codex["codex exec --json"]
    Gemini["gemini -p ...
    (stream-json)"]
    Pi["pi --mode rpc
    (stdin/stdout JSON)"]
    VSCode["Claude Code / Codex / Gemini / Pi
    (VS Code / terminal)"]
    MCP["MCP Permission
    Server"]
    ClaudeJSONL["~/.claude/projects/
    JSONL files"]
    CodexJSONL["~/.codex/sessions/
    JSONL files"]
    GeminiJSON["~/.gemini/tmp/
    JSON files"]
    PiJSONL["~/.pi/agent/sessions/
    JSONL files"]

    Phone -->|"cellular / internet"| Tunnel
    Phone -->|"VPN / LAN"| Hub
    Tunnel --> Hub
    Hub --> Factory
    Hub --> Scanner
    Hub --> Hooks
    Hub --> Browser
    Factory -->|"claude agent"| Claude
    Factory -->|"codex agent"| Codex
    Factory -->|"gemini agent"| Gemini
    Factory -->|"pi agent"| Pi
    Scanner -->|"auto-discover"| ClaudeJSONL
    Scanner -->|"auto-discover"| CodexJSONL
    Scanner -->|"auto-discover"| GeminiJSON
    Scanner -->|"auto-discover"| PiJSONL
    Hooks -->|"approvals + prompts"| VSCode
    VSCode -->|"writes"| ClaudeJSONL
    VSCode -->|"writes"| CodexJSONL
    VSCode -->|"writes"| GeminiJSON
    VSCode -->|"writes"| PiJSONL
    Hub -->|"JSONL watcher"| ClaudeJSONL
    Hub -->|"Codex adapter"| CodexJSONL
    Hub -->|"Gemini adapter"| GeminiJSON
    Hub -->|"Pi adapter"| PiJSONL
    Claude --> MCP
    MCP -->|"phone approval"| Hub
    Browser -->|"reads"| ClaudeJSONL
    Browser -->|"reads"| CodexJSONL
    Browser -->|"reads"| GeminiJSON
    Browser -->|"reads"| PiJSONL
```

See [docs/diagrams.md](docs/diagrams.md) for auth, tunnel, session, auto-discovery, takeover, and hook flow diagrams.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS, COPYRIGHT HOLDERS, MARCO PENNELLI, OR PUGLIATECHS APS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Use this software at your own risk. The author and the organization assume no responsibility for any damages, data loss, security incidents, or other consequences resulting from the use or misuse of this software.

## Author

**Marco Pennelli** | [PugliaTechs APS](https://www.pugliatechs.com)

## License

MIT
