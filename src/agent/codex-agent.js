/**
 * CodexAgent — Spawns and controls an OpenAI Codex CLI process.
 *
 * This mirrors WrappedAgent but speaks the Codex protocol:
 *   Phone → Polpo Hub → CodexAgent → codex exec --json → codebase
 *
 * Key differences from WrappedAgent:
 *   - No stdin streaming: each prompt spawns a new `codex exec` process
 *   - Multi-turn: subsequent prompts use `codex exec resume <threadId> --json "prompt"`
 *   - Different JSON event schema (thread.started, item.*, turn.*)
 *   - Permissions via --sandbox/--full-auto flags + MCP for phone approval
 *   - Attachments: images via --image flag, others referenced in prompt text
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';
const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');

class CodexAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.token = options.token || process.env.POLPO_TOKEN || null;
    this.name = options.name || `Codex (${path.basename(options.cwd || process.cwd())})`;
    this.type = options.type || 'terminal';
    this.project = options.project || path.basename(options.cwd || process.cwd());
    this.cwd = options.cwd || process.cwd();
    this.resumeSessionId = options.resumeSessionId || null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || 'default';
    this.codexBinary = options.codexBinary || 'codex';

    // Hub connection state
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;

    // Codex process state
    this.codex = null;
    this.threadId = null; // Codex's thread_id (equivalent to Claude's session_id)
    this.busy = false;
  }

  // --- Hub registration (identical to WrappedAgent) ---

  async register() {
    const apiBase = this.serverUrl
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const body = JSON.stringify({
      name: this.name,
      type: this.type,
      project: this.project,
      cwd: this.cwd,
      agentType: 'codex',
    });

    return new Promise((resolve, reject) => {
      const reqUrl = new URL('/api/instances', apiBase);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }
      const req = http.request(
        reqUrl,
        {
          method: 'POST',
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`Registration failed (${res.statusCode}): ${data}`));
              return;
            }
            try {
              const result = JSON.parse(data);
              if (!result.id) {
                reject(new Error('Registration response missing instance id'));
                return;
              }
              this.instanceId = result.id;
              resolve(result);
            } catch (e) {
              reject(new Error('Failed to parse registration response'));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // --- WebSocket connection to hub (identical to WrappedAgent) ---

  connectToHub() {
    if (!this.instanceId) throw new Error('Must register before connecting');

    let wsUrl = `${this.serverUrl}?role=agent&instanceId=${this.instanceId}`;
    if (this.token) {
      wsUrl += `&token=${encodeURIComponent(this.token)}`;
    }
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this._log('Connected to hub');
      this._sendToHub({ type: 'status', status: this.busy ? 'busy' : 'idle' });
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleHubMessage(msg);
      } catch (e) {}
    });

    this.ws.on('close', () => {
      this._log('Disconnected from hub, reconnecting...');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectToHub(), 3000);
    });

    this.ws.on('error', () => {});
  }

  _sendToHub(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // --- Handle messages from phone (via hub) ---

  _handleHubMessage(msg) {
    switch (msg.type) {
      case 'prompt':
        this.sendPrompt(msg.text, msg.attachments);
        break;
      case 'abort':
        this.abort();
        break;
      case 'approve':
      case 'reject':
        // Handled by MCP permission server if configured
        break;
    }
  }

  // --- Codex CLI process management ---

  spawnCodex(prompt, attachments) {
    const args = ['exec'];

    // If resuming a previous thread, use resume subcommand
    if (this.threadId || this.resumeSessionId) {
      args.push('resume', this.threadId || this.resumeSessionId);
    }

    args.push('--json');

    if (this.cwd) {
      args.push('--cd', this.cwd);
    }

    if (this.model) {
      args.push('-m', this.model);
    }

    // Permission handling
    if (this.permissionMode === 'bypass') {
      args.push('--full-auto');
    } else {
      // Default: use on-request approval
      args.push('-a', 'on-request');

      // Register Polpo's MCP permission server for phone-based approval
      const permissionServerPath = path.join(__dirname, 'permission-server.js');
      const mcpConfigObj = {
        mcpServers: {
          polpo: {
            command: process.execPath,
            args: [permissionServerPath],
            env: {
              POLPO_INSTANCE_ID: this.instanceId,
              POLPO_HUB_URL: this.serverUrl
                .replace('ws://', 'http://')
                .replace('wss://', 'https://'),
              ...(this.token ? { POLPO_AUTH_TOKEN: this.token } : {}),
            },
          },
        },
      };
      const mcpConfigPath = path.join(os.tmpdir(), `polpo-codex-mcp-${this.instanceId}.json`);
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigObj, null, 2), { mode: 0o600 });
      this._log(`MCP config written to ${mcpConfigPath}`);
      // Codex doesn't support --permission-prompt-tool yet, but the MCP server
      // will still be available for tool-based approval if/when Codex adds support.
      // For now, rely on -a on-request for sandbox-level permissions.
    }

    // Attach images via --image flag
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const resolvedPath = path.resolve(att.path || '');
        if (!resolvedPath.startsWith(UPLOAD_DIR + path.sep)) continue;
        const isImage = att.mediaType && att.mediaType.startsWith('image/');
        if (isImage) {
          args.push('--image', resolvedPath);
        }
      }
    }

    // Build prompt text (include non-image attachments as references)
    let fullPrompt = prompt || '';
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const resolvedPath = path.resolve(att.path || '');
        if (!resolvedPath.startsWith(UPLOAD_DIR + path.sep)) continue;
        const isImage = att.mediaType && att.mediaType.startsWith('image/');
        if (!isImage) {
          fullPrompt += `\n[Attached file: ${resolvedPath}]`;
        }
      }
    }

    args.push(fullPrompt);

    this._log(`Spawning: ${this.codexBinary} ${args.join(' ')}`);

    this.codex = spawn(this.codexBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Parse stdout as JSONL
    const rl = readline.createInterface({ input: this.codex.stdout });
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        this._handleCodexEvent(event);
      } catch (e) {
        // Not JSON — forward as raw output
        this._sendToHub({
          type: 'output',
          content: line,
          contentType: 'text',
        });
      }
    });

    // Capture stderr for debugging
    const stderrRl = readline.createInterface({ input: this.codex.stderr });
    stderrRl.on('line', (line) => {
      if (line.trim()) {
        this._log(`[codex stderr] ${line}`);
      }
    });

    this.codex.on('exit', (code) => {
      this._log(`Codex process exited (code ${code})`);
      this.codex = null;
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
    });

    this.codex.on('error', (err) => {
      this._log(`Codex process error: ${err.message}`);
      this._sendToHub({
        type: 'output',
        content: `[error: ${err.message}]`,
        contentType: 'text',
      });
    });
  }

  // --- Handle Codex JSON events ---

  _handleCodexEvent(event) {
    switch (event.type) {
      case 'thread.started': {
        this.threadId = event.thread_id;
        this._log(`Thread: ${event.thread_id}`);
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              subtype: 'init',
              session_id: event.thread_id,
              agent: 'codex',
            }),
            contentType: 'json',
          },
        });
        break;
      }

      case 'turn.started': {
        this.busy = true;
        this._sendToHub({ type: 'status', status: 'busy' });
        break;
      }

      case 'item.started': {
        const item = event.item || {};
        if (item.type === 'command_execution') {
          this._sendToHub({
            type: 'message',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_use',
                name: 'Bash',
                input: { command: item.command || '' },
                id: item.id,
              }),
              contentType: 'tool_use',
            },
          });
        } else if (item.type === 'file_change') {
          const toolName = item.action === 'create' ? 'Write' : 'Edit';
          this._sendToHub({
            type: 'message',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_use',
                name: toolName,
                input: { file_path: item.file || item.path || '' },
                id: item.id,
              }),
              contentType: 'tool_use',
            },
          });
        } else if (item.type === 'mcp_tool_call') {
          this._sendToHub({
            type: 'message',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_use',
                name: item.tool_name || item.name || 'mcp_tool',
                input: item.arguments || item.input || {},
                id: item.id,
              }),
              contentType: 'tool_use',
            },
          });
        }
        // Skip: reasoning, web_search (started), plan_update — wait for completed
        break;
      }

      case 'item.completed': {
        const item = event.item || {};
        if (item.type === 'agent_message') {
          this._sendToHub({
            type: 'message',
            message: {
              role: 'assistant',
              content: item.text || '',
              contentType: 'text',
            },
          });
        } else if (item.type === 'command_execution') {
          const output = item.output || item.stdout || '';
          const truncated = output.length > 2000
            ? output.slice(0, 2000) + `\n... (${output.length} chars)`
            : output;
          this._sendToHub({
            type: 'message',
            message: {
              role: 'tool',
              content: truncated,
              contentType: 'tool_result',
              toolUseId: item.id,
              isError: item.exit_code !== 0,
            },
          });
        } else if (item.type === 'file_change') {
          this._sendToHub({
            type: 'message',
            message: {
              role: 'tool',
              content: `${item.action || 'modified'}: ${item.file || item.path || ''}`,
              contentType: 'tool_result',
              toolUseId: item.id,
            },
          });
        } else if (item.type === 'mcp_tool_call') {
          const result = typeof item.result === 'string'
            ? item.result
            : JSON.stringify(item.result || '');
          const truncated = result.length > 2000
            ? result.slice(0, 2000) + `\n... (${result.length} chars)`
            : result;
          this._sendToHub({
            type: 'message',
            message: {
              role: 'tool',
              content: truncated,
              contentType: 'tool_result',
              toolUseId: item.id,
              isError: !!item.error,
            },
          });
        }
        // Skip: reasoning (internal), web_search (internal), plan_update
        break;
      }

      case 'turn.completed': {
        this.busy = false;
        this._sendToHub({ type: 'status', status: 'idle' });
        const usage = event.usage || {};
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              type: 'turn_complete',
              session_id: this.threadId,
              usage,
            }),
            contentType: 'turn_complete',
          },
        });
        break;
      }

      case 'turn.failed': {
        this.busy = false;
        this._sendToHub({ type: 'status', status: 'idle' });
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: `[turn failed: ${event.error || event.message || 'unknown error'}]`,
            contentType: 'text',
          },
        });
        break;
      }

      case 'error': {
        this._sendToHub({
          type: 'output',
          content: `[codex error: ${event.message || JSON.stringify(event)}]`,
          contentType: 'text',
        });
        break;
      }
    }
  }

  // --- Public API ---

  /**
   * Send a prompt to Codex.
   * Each prompt spawns a new process. If a thread_id exists from a previous turn,
   * the new process resumes that thread.
   */
  sendPrompt(text, attachments) {
    // Kill any existing process before spawning a new one
    if (this.codex) {
      this._log('Killing previous codex process for new prompt');
      this.codex.kill('SIGTERM');
      this.codex = null;
    }

    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    this.spawnCodex(text, attachments);
  }

  /**
   * Abort the current task by killing the codex process.
   */
  abort() {
    if (this.codex) {
      this._log('Aborting...');
      this.codex.kill('SIGINT');
      setTimeout(() => {
        if (this.codex) {
          this.codex.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  /**
   * Start the agent: register with hub, connect WebSocket.
   * Doesn't spawn codex yet — waits for the first prompt from the phone.
   */
  async start() {
    await this.register();
    this.connectToHub();
    this._log(`Registered as "${this.name}" (${this.instanceId})`);
    this._log('Waiting for prompts from phone...');
  }

  /**
   * Stop the agent.
   */
  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.codex) this.codex.kill('SIGTERM');
    if (this.ws) this.ws.close();
  }

  _log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[codex-agent ${ts}] ${msg}`);
  }
}

/**
 * Run a Codex agent from the CLI.
 */
async function runCodex(options = {}) {
  const agent = new CodexAgent(options);
  await agent.start();

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (line.trim()) {
        agent.sendPrompt(line.trim());
      }
    });
    console.error('[codex-agent] Local stdin active — type prompts here or use phone');
  }

  process.on('SIGINT', () => {
    agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    agent.stop();
    process.exit(0);
  });

  return agent;
}

module.exports = { CodexAgent, runCodex };
