/**
 * WrappedAgent — Spawns and controls a claude CLI process.
 *
 * This is the core of the "work from your phone" workflow:
 *   Phone → Polpo Hub → WrappedAgent → claude CLI → codebase
 *
 * The agent spawns `claude` with --input-format stream-json --output-format stream-json,
 * giving full bidirectional control over the conversation. Prompts from the phone
 * are written to claude's stdin; claude's responses stream back to the phone in real-time.
 *
 * Supports:
 *   - Starting new sessions in any project directory
 *   - Resuming existing sessions (--resume <session-id>)
 *   - Multi-turn conversations (process stays alive between prompts)
 *   - Real-time streaming of text, tool calls, and tool results
 *   - Abort (kill the claude process)
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';

class WrappedAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.name = options.name || `Session (${path.basename(options.cwd || process.cwd())})`;
    this.type = options.type || 'terminal';
    this.project = options.project || path.basename(options.cwd || process.cwd());
    this.cwd = options.cwd || process.cwd();
    this.resumeSessionId = options.resumeSessionId || null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || 'default';
    this.claudeBinary = options.claudeBinary || 'claude';

    // Hub connection state
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;

    // Claude process state
    this.claude = null;
    this.claudeSessionId = null;
    this.busy = false;
    this.outputBuffer = '';

    // Permission server path for MCP-based approval
    this.permissionServerPath = path.join(__dirname, 'permission-server.js');
  }

  // --- Hub registration ---

  async register() {
    const apiBase = this.serverUrl
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const body = JSON.stringify({
      name: this.name,
      type: this.type,
      project: this.project,
      cwd: this.cwd,
    });

    return new Promise((resolve, reject) => {
      const reqUrl = new URL('/api/instances', apiBase);
      const req = http.request(
        reqUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
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

  // --- WebSocket connection to hub ---

  connectToHub() {
    if (!this.instanceId) throw new Error('Must register before connecting');

    const wsUrl = `${this.serverUrl}?role=agent&instanceId=${this.instanceId}`;
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
        this.sendPrompt(msg.text);
        break;
      case 'abort':
        this.abort();
        break;
      case 'approve':
        // Permissions are now handled by the MCP permission server
        // via the hub's /api/permission-request endpoint. No action needed here.
        break;
      case 'reject':
        break;
    }
  }

  // --- Claude CLI process management ---

  spawnClaude() {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    if (this.resumeSessionId) {
      args.push('--resume', this.resumeSessionId);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.permissionMode === 'bypass') {
      args.push('--dangerously-skip-permissions');
    } else {
      // Use the MCP permission server for interactive approval from the phone.
      // Write config to a temp file so there are no inline-JSON parsing issues.
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
            },
          },
        },
      };
      const mcpConfigPath = path.join(os.tmpdir(), `polpo-mcp-${this.instanceId}.json`);
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigObj, null, 2));
      this._log(`MCP config written to ${mcpConfigPath}`);
      args.push('--permission-prompt-tool', 'mcp__polpo__polpo_approve');
      args.push('--mcp-config', mcpConfigPath);
    }

    this._log(`Spawning: ${this.claudeBinary} ${args.join(' ')}`);

    // Ensure claude uses the same node version as the server process
    // to avoid compatibility issues with newer system node versions.
    const nodeDir = path.dirname(process.execPath);
    const env = { ...process.env };
    if (!env.PATH || !env.PATH.startsWith(nodeDir)) {
      env.PATH = nodeDir + ':' + (env.PATH || '');
    }

    this.claude = spawn(this.claudeBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Parse stdout as newline-delimited JSON
    const rl = readline.createInterface({ input: this.claude.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        this._handleClaudeMessage(msg);
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
    const stderrRl = readline.createInterface({ input: this.claude.stderr });
    stderrRl.on('line', (line) => {
      if (line.trim()) {
        this._log(`[claude stderr] ${line}`);
      }
    });

    this.claude.on('exit', (code) => {
      this._log(`Claude process exited (code ${code})`);
      this.claude = null;
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
      this._sendToHub({
        type: 'output',
        content: `[session ended — code ${code}]`,
        contentType: 'text',
      });
    });

    this.claude.on('error', (err) => {
      this._log(`Claude process error: ${err.message}`);
      this._sendToHub({
        type: 'output',
        content: `[error: ${err.message}]`,
        contentType: 'text',
      });
    });
  }

  // --- Handle messages from claude CLI ---

  _handleClaudeMessage(msg) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.claudeSessionId = msg.session_id;
          this._log(`Session: ${msg.session_id} (model: ${msg.model})`);
          this._sendToHub({
            type: 'message',
            message: {
              role: 'system',
              content: JSON.stringify({
                subtype: 'init',
                session_id: msg.session_id,
                model: msg.model,
                tools: msg.tools,
              }),
              contentType: 'json',
            },
          });
        }
        break;
      }

      case 'assistant': {
        const content = msg.message && msg.message.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text') {
            this._sendToHub({
              type: 'message',
              message: {
                role: 'assistant',
                content: block.text,
                contentType: 'text',
              },
            });
          } else if (block.type === 'tool_use') {
            this.busy = true;
            this._sendToHub({ type: 'status', status: 'busy' });
            this._sendToHub({
              type: 'message',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  type: 'tool_use',
                  name: block.name,
                  input: block.input,
                  id: block.id,
                }),
                contentType: 'tool_use',
              },
            });
          }
        }
        break;
      }

      case 'user': {
        // Tool results from claude's internal tool execution
        const content = msg.message && msg.message.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            // Truncate long tool results for the phone
            const truncated = resultText.length > 2000
              ? resultText.slice(0, 2000) + `\n... (${resultText.length} chars)`
              : resultText;
            this._sendToHub({
              type: 'message',
              message: {
                role: 'tool',
                content: truncated,
                contentType: 'tool_result',
                toolUseId: block.tool_use_id,
                isError: block.is_error || false,
              },
            });
          }
        }
        break;
      }

      case 'result': {
        this.busy = false;
        this._sendToHub({ type: 'status', status: 'idle' });
        if (msg.result) {
          this._sendToHub({
            type: 'message',
            message: {
              role: 'system',
              content: JSON.stringify({
                type: 'turn_complete',
                result: msg.result,
                cost_usd: msg.total_cost_usd,
                num_turns: msg.num_turns,
                session_id: msg.session_id,
              }),
              contentType: 'turn_complete',
            },
          });
        }
        break;
      }

    }
  }

  // --- Public API ---

  /**
   * Send a prompt to the claude process.
   * If no process is running, spawns one (resuming if a session ID is available).
   */
  sendPrompt(text) {
    if (!this.claude) {
      // Auto-resume if we have a session ID from a previous turn
      if (this.claudeSessionId && !this.resumeSessionId) {
        this.resumeSessionId = this.claudeSessionId;
      }
      this.spawnClaude();
    }

    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    // Note: user message is already recorded by the hub's send_prompt handler.
    // Don't echo it back here to avoid duplicates.

    // Write to claude's stdin
    const input = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n';

    if (this.claude && this.claude.stdin.writable) {
      this.claude.stdin.write(input);
    }
  }

  /**
   * Abort the current task by killing the claude process.
   */
  abort() {
    if (this.claude) {
      this._log('Aborting...');
      this.claude.kill('SIGINT');
      // If still alive after 3s, force kill
      setTimeout(() => {
        if (this.claude) {
          this.claude.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  /**
   * Start the agent: register with hub, connect WebSocket, spawn claude.
   */
  async start() {
    await this.register();
    this.connectToHub();
    this._log(`Registered as "${this.name}" (${this.instanceId})`);
    this._log('Waiting for prompts from phone...');
    // Don't spawn claude yet — wait for the first prompt from the phone
  }

  /**
   * Stop the agent.
   */
  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.claude) this.claude.kill('SIGTERM');
    if (this.ws) this.ws.close();
  }

  _log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[wrapped-agent ${ts}] ${msg}`);
  }
}

/**
 * Run a wrapped agent from the CLI.
 */
async function runWrapped(options = {}) {
  const agent = new WrappedAgent(options);
  await agent.start();

  // Also allow local stdin for testing
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (line.trim()) {
        agent.sendPrompt(line.trim());
      }
    });
    console.error('[wrapped-agent] Local stdin active — type prompts here or use phone');
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

module.exports = { WrappedAgent, runWrapped };
