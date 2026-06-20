# Polpo Diagrams

## Auth Flow

```mermaid
sequenceDiagram
    participant Term as Terminal
    participant Hub as Polpo Hub
    participant Phone as Phone

    Term->>Hub: polpo server --tunnel --auth pin
    Hub->>Hub: Generate token + PIN
    Hub->>Term: Print QR code (URL with token baked in)
    Term->>Term: Display PIN: 4821
    Phone->>Hub: Scan QR → GET /?token=abc123
    Hub->>Hub: Burn token (single-use)
    Hub->>Phone: Redirect to /auth.html?mode=pin
    Phone->>Hub: POST /api/auth/verify-pin {code: "4821"}
    Hub->>Phone: Set session cookie → dashboard
```

## Tunnel Flow

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Polpo as Polpo Server
    participant Tunnel as Tunnel Provider
    participant Phone as Phone Browser

    Dev->>Polpo: polpo server --tunnel
    Polpo->>Polpo: Start Express + WS on :7890
    Polpo->>Tunnel: Start tunnel (auto-detect or explicit)
    Tunnel-->>Polpo: Public URL
    Polpo->>Dev: Print QR code + URL
    Dev->>Phone: Scan QR code
    Phone->>Tunnel: HTTPS request
    Tunnel->>Polpo: Forward to localhost:7890
    Polpo-->>Phone: Dashboard + WebSocket
```

## Session Flow (Claude)

```mermaid
sequenceDiagram
    participant Phone
    participant Hub as Polpo Hub
    participant Agent as Session Agent
    participant CLI as claude CLI
    participant MCP as MCP Permission Server

    Agent->>Hub: Register + WebSocket connect
    Phone->>Hub: Send prompt
    Hub->>Agent: Forward prompt
    Agent->>CLI: Spawn claude --stream-json
    CLI->>Agent: Streaming response (text, tool calls)
    Agent->>Hub: Relay messages
    Hub->>Phone: Real-time updates

    Note over CLI,MCP: Tool requires approval
    CLI->>MCP: permission_prompt_tool call
    MCP->>Hub: POST /api/permission-request (long-poll)
    Hub->>Phone: Show approval banner
    Phone->>Hub: Approve / Reject
    Hub->>MCP: Return decision
    MCP->>CLI: allow / deny
```

## Session Flow (Codex / Gemini / OpenCode)

Codex, Gemini, and OpenCode use one-shot process invocation instead of long-running stdin streaming. Each prompt spawns a new process; multi-turn uses resume flags.

```mermaid
sequenceDiagram
    participant Phone
    participant Hub as Polpo Hub
    participant Agent as Session Agent
    participant CLI as codex / gemini / opencode CLI

    Agent->>Hub: Register + WebSocket connect
    Phone->>Hub: Send prompt
    Hub->>Agent: Forward prompt
    Agent->>CLI: Spawn process (codex exec / gemini -p / opencode run -p)
    CLI->>Agent: Streaming JSONL events (init, message deltas, tool_use, result)
    Agent->>Hub: Relay messages
    Hub->>Phone: Real-time updates
    CLI->>Agent: Process exits on completion

    Note over Phone,CLI: Follow-up prompt (multi-turn)
    Phone->>Hub: Send next prompt
    Hub->>Agent: Forward prompt
    Agent->>CLI: Spawn new process with resume flag (--resume / --session)
    CLI->>Agent: Streaming response
    Agent->>Hub: Relay messages
    Hub->>Phone: Real-time updates
```

## Session Flow (Pi)

Pi uses a long-running RPC mode (`pi --mode rpc`) — persistent stdin/stdout JSON, same pattern as Claude Code. The process stays alive across prompts.

```mermaid
sequenceDiagram
    participant Phone
    participant Hub as Polpo Hub
    participant Agent as Pi Agent
    participant CLI as pi --mode rpc

    Agent->>Hub: Register + WebSocket connect
    Phone->>Hub: Send prompt
    Hub->>Agent: Forward prompt
    Agent->>CLI: Spawn pi --mode rpc
    Agent->>CLI: Write {"type":"prompt","message":"..."} to stdin
    CLI->>Agent: Streaming events (agent_start, message_update, tool_execution_*, agent_end)
    Agent->>Hub: Relay messages
    Hub->>Phone: Real-time updates

    Note over Phone,CLI: Follow-up prompt (same process)
    Phone->>Hub: Send next prompt
    Hub->>Agent: Forward prompt
    Agent->>CLI: Write prompt to stdin (process still running)
    CLI->>Agent: Streaming response
    Agent->>Hub: Relay messages
    Hub->>Phone: Real-time updates
```

## Session Flow (Goose)

Goose uses ACP mode (`goose acp`) with JSON-RPC 2.0 over stdin/stdout. The process stays alive across prompts, similar to Pi's RPC mode.

```mermaid
sequenceDiagram
    participant Phone
    participant Hub as Polpo Hub
    participant Agent as GooseAgent
    participant CLI as goose acp

    Phone->>Hub: Create session (agent: goose)
    Hub->>Agent: Create GooseAgent
    Agent->>CLI: Spawn goose acp
    Agent->>CLI: initialize (JSON-RPC)
    CLI->>Agent: capabilities + agentInfo
    Agent->>CLI: session/new {cwd}
    CLI->>Agent: {sessionId, models}
    Agent->>Hub: session_info + init message

    Phone->>Hub: Send prompt
    Hub->>Agent: Forward prompt
    Agent->>CLI: session/prompt {sessionId, prompt}
    CLI->>Agent: session/notification agentMessageChunk (streaming)
    CLI->>Agent: session/notification toolCall (pending)
    CLI->>Agent: session/notification toolCallUpdate (completed)
    CLI->>Agent: requestPermission (tool approval)
    Agent->>Hub: approval_request
    Hub->>Phone: Inline buttons (Approve / Reject)
    Phone->>Hub: Approve
    Hub->>Agent: approve
    Agent->>CLI: {optionId: "allowOnce"}
    CLI->>Agent: Continue processing
    CLI->>Agent: session/notification agentMessageChunk (final)
    Agent->>Hub: Relay messages
    Hub->>Phone: Real-time updates
```

## Auto-Discovery & Takeover Flow

```mermaid
sequenceDiagram
    participant Dev as Developer Terminal
    participant FS as Session Files
    participant Scanner as Session Scanner
    participant Hub as Polpo Hub
    participant Phone
    participant Agent as Takeover Agent
    participant CLI as CLI (claude / codex / gemini / opencode / pi / goose)

    Dev->>FS: Run CLI (writes session files / SQLite)
    Scanner->>FS: fs.watch() or SQLite polling detects sessions
    Scanner->>Hub: session:discovered (sessionId, transcriptPath, agentType)
    Hub->>Hub: Register read-only instance (canReceivePrompts: false)
    Hub->>Phone: New instance card on dashboard

    Note over Hub,FS: File watcher streams conversation
    FS->>Hub: JSONL/JSON file changes (debounced)
    Hub->>Phone: Real-time conversation sync

    Note over Phone,CLI: Phone Takeover
    Phone->>Hub: POST /instances/:id/takeover
    Hub->>Hub: Copy conversation from old instance
    Hub->>Agent: Spawn agent with --resume <sessionId>
    Agent->>CLI: Start CLI process
    Agent->>Hub: Register new instance (canReceivePrompts: true)
    Hub->>Phone: Switch to new instance with full prompt capability
```

## Hook Flow

```mermaid
sequenceDiagram
    participant CC as Claude Code (VS Code)
    participant Hook as Hook Script
    participant Bridge as Bridge Daemon
    participant Hub as Polpo Hub
    participant Phone

    CC->>Hook: PreToolUse / PostToolUse / Notification
    Hook->>Bridge: Unix socket message
    Bridge->>Hub: WebSocket relay
    Hub->>Phone: Real-time update

    Note over Hook,Bridge: With POLPO_APPROVE=1
    CC->>Hook: PreToolUse (approval mode)
    Hook->>Bridge: approval_request
    Bridge->>Hub: Forward to dashboard
    Hub->>Phone: Show approval banner
    Phone->>Hub: Approve / Reject
    Hub->>Bridge: Decision
    Bridge->>Hook: approval_response
    Hook->>CC: allow / block
```

## Gateway Flow (Bidirectional File Transfer)

```mermaid
sequenceDiagram
    participant Caller as External Caller<br/>(script, bot, agent)
    participant GW as Polpo Gateway<br/>/v1/*
    participant US as UploadStore
    participant AS as ArtifactStore
    participant Arm as Spawned Agent
    participant Phone as Phone Dashboard

    Note over Caller,Phone: Bearer POLPO_GATEWAY_KEY on every request

    Caller->>GW: POST /v1/uploads
    GW->>US: put(buffer, tokenFingerprint)
    US-->>GW: uploadId + sha256 + expiresAt
    GW-->>Caller: 201

    Caller->>GW: POST /v1/tasks { attachments, captureArtifacts:true }
    GW->>US: get(uploadId, fingerprint)
    Note over GW: Copies upload into UPLOAD_DIR<br/>(reuses dashboard trust boundary)
    GW->>AS: createDir(taskId)
    GW->>Arm: spawn + inject <polpo:artifacts> directive
    GW-->>Caller: 201 taskId

    Caller->>GW: GET /v1/tasks/:id/stream
    Arm-->>GW: assistant output
    GW-->>Caller: event: chunk

    Note over Arm: Arm writes files<br/>into artifacts dir
    Arm-->>GW: status: idle
    GW->>AS: sealOnFinalize(taskId)
    Note over AS: lstat + size caps + hardlink to sealed/<br/>+ chmod 0o400 (TOCTOU defence)
    GW-->>Caller: event: artifacts
    GW-->>Caller: event: done

    Caller->>GW: GET /v1/tasks/:id/artifacts/:name
    GW->>AS: openSealed(taskId, name, fingerprint)
    GW-->>Caller: 200 + attachment + nosniff

    Note over Phone: Phone sees the arm as<br/>"Gateway: &lt;client&gt;" — can<br/>observe or abort live
```

## Alien Mind Flow (Multi-Agent Coordination)

Every mind-spawned arm goes through the same `OneShotAgentRunner` primitive the HTTP gateway uses. Each task = one fresh agent + one prompt + one captured result + terminate. No pool, no reuse.

```mermaid
sequenceDiagram
    participant User
    participant Mind as Alien Mind<br/>(instance)
    participant Reasoner as Reasoner<br/>(Claude subprocess)
    participant Store as Memory + GoalStore
    participant Runner as OneShotAgentRunner<br/>(shared with gateway)
    participant ArmA as Arm A<br/>(spawn → run → terminate)
    participant ArmB as Arm B<br/>(spawn → run → terminate)

    User->>Mind: Goal
    Mind->>Store: snapshot (planning) + search past goals
    Store-->>Mind: relevant memory
    Mind->>Reasoner: plan(worldSummary + memory, goal)
    Reasoner-->>Mind: { tasks: [A,B], deps: B→A }
    Mind->>Store: snapshot (running)

    Mind->>Runner: run({ prompt: A, source: "mind:<goalId>" })
    Runner-->>ArmA: spawn + arm timeout + send prompt
    ArmA-->>Runner: busy → output chunks → idle
    Runner-->>Mind: onTerminal({ status: completed, output })
    Runner-->>ArmA: stop + unregister

    Note over Mind: Inter-arm context:<br/>capture A's output for B's prompt

    Mind->>Runner: run({ prompt: <previous_task_results>A</...> + B,<br/>source: "mind:<goalId>" })
    Runner-->>ArmB: spawn + arm timeout + send prompt
    ArmB-->>Runner: busy → output chunks → idle
    Runner-->>Mind: onTerminal({ status: completed, output })
    Runner-->>ArmB: stop + unregister

    alt task fails (timeout, approval_required, run error)
        Runner-->>Mind: onTerminal({ status: failed, error })
        Mind->>Reasoner: replan(task, reason, partial)
        Reasoner-->>Mind: retry | split | abandon
    end

    Mind->>Store: save completed goal + remove in-flight
    Mind-->>User: result + summaries

    Note over Mind: Watcher (30s) alerts on stuck arms.<br/>If policy.autoActOnStuck, calls<br/>coordinator.failAgentTask() which<br/>cancels via Runner.cancel(agentId).
```
