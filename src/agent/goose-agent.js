/**
 * GooseAgent — Spawns and controls a Goose AI agent via ACP (Agent Communication Protocol).
 *
 * Goose (github.com/block/goose) is an open-source AI agent by Block that supports
 * any LLM provider. It communicates via JSON-RPC 2.0 over stdin/stdout in ACP mode.
 *
 * Supports:
 *   - Long-running ACP mode (process stays alive across prompts)
 *   - Session resume via session/load
 *   - Real-time streaming of text, tool calls, and tool results
 *   - Permission requests (maps to polpo's approval flow)
 *   - Abort via session/cancel
 *   - Multi-provider: OpenAI, Anthropic, Google, Bedrock, Ollama, etc.
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const path = require('path');
const { logPrefix } = require('./log-prefix');
const readline = require('readline');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';

class GooseAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.token = options.token || process.env.POLPO_TOKEN || null;
    this.name = options.name || `Goose (${path.basename(options.cwd || process.cwd())})`;
    this.type = options.type || 'terminal';
    this.project = options.project || path.basename(options.cwd || process.cwd());
    this.cwd = options.cwd || process.cwd();
    this.resumeSessionId = options.resumeSessionId || null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || 'default';
    this.gooseBinary = options.gooseBinary || 'goose';

    // Hub connection state
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;

    // Goose process state
    this.goose = null;
    this.gooseSessionId = null;
    this.busy = false;
    this._rpcId = 0;
    this._pendingRpc = new Map(); // id -> { resolve, reject }

    // Streaming accumulators
    this.pendingText = '';
  }

  // --- Hub registration (same pattern as other agents) ---

  async register() {
    const apiBase = this.serverUrl
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const body = JSON.stringify({
      name: this.name,
      type: this.type,
      project: this.project,
      cwd: this.cwd,
      agentType: 'goose',
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
      const req = http.request(reqUrl, { method: 'POST', headers }, (res) => {
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
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  connect() {
    if (!this.instanceId) throw new Error('Must register before connecting');

    const wsUrl = `${this.serverUrl}?role=agent&instanceId=${this.instanceId}`;
    const wsHeaders = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    this.ws = new WebSocket(wsUrl, { headers: wsHeaders });

    this.ws.on('open', () => {
      this._log('Connected to hub');
      this._sendToHub({ type: 'status', status: this.busy ? 'busy' : 'idle' });
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleHubMessage(msg);
      } catch {}
    });

    this.ws.on('close', () => {
      this._log('Disconnected from hub, reconnecting in 3s...');
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', () => {});
  }

  _handleHubMessage(msg) {
    switch (msg.type) {
      case 'prompt':
        this.sendPrompt(msg.text, msg.attachments);
        break;
      case 'abort':
        this.abort();
        break;
      case 'approve':
        this._respondToPermission('allowOnce');
        break;
      case 'reject':
        this._respondToPermission('rejectOnce');
        break;
    }
  }

  // --- Goose ACP process management ---

  spawnGoose() {
    const args = ['acp'];

    // Add built-in extensions
    args.push('--with-builtin', 'developer');

    this._log(`Spawning: ${this.gooseBinary} ${args.join(' ')}`);

    const env = { ...process.env };
    // Set provider/model via env vars if configured
    if (this.model) {
      // Model format: "provider/model" or just "model"
      if (this.model.includes('/')) {
        const parts = this.model.split('/');
        env.GOOSE_PROVIDER = parts[0];
        env.GOOSE_MODEL = parts.slice(1).join('/');
      } else {
        env.GOOSE_MODEL = this.model;
      }
    }

    this.goose = spawn(this.gooseBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Parse stdout as newline-delimited JSON-RPC
    const rl = readline.createInterface({ input: this.goose.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        this._handleGooseMessage(msg);
      } catch {
        this._log(`[goose stdout] ${line}`);
      }
    });

    // Capture stderr
    const stderrRl = readline.createInterface({ input: this.goose.stderr });
    stderrRl.on('line', (line) => {
      if (line.trim()) {
        this._log(`[goose stderr] ${line}`);
      }
    });

    this.goose.on('exit', (code) => {
      this._log(`Goose process exited (code ${code})`);
      this._flushPendingText();
      this.goose = null;
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
    });

    this.goose.on('error', (err) => {
      this._log(`Goose process error: ${err.message}`);
    });

    // Initialize the ACP connection
    this._sendRpc('initialize', {
      protocolVersion: '2025-03-26',
      clientCapabilities: {},
      clientInfo: { name: 'polpo', version: '1.0.0' },
    }).then(() => {
      // Create or load session
      if (this.resumeSessionId) {
        return this._sendRpc('session/load', {
          sessionId: this.resumeSessionId,
          cwd: this.cwd,
        });
      } else {
        return this._sendRpc('session/new', {
          cwd: this.cwd,
        });
      }
    }).then((result) => {
      if (result && result.sessionId) {
        this.gooseSessionId = result.sessionId;
        this._log(`Session: ${result.sessionId}`);

        this._sendToHub({
          type: 'session_info',
          sessionId: result.sessionId,
        });

        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              subtype: 'init',
              session_id: result.sessionId,
              agent: 'goose',
              model: result.model || this.model || null,
            }),
            contentType: 'json',
          },
        });
      }
    }).catch((err) => {
      this._log(`ACP init failed: ${err.message}`);
    });
  }

  // --- JSON-RPC communication ---

  _sendRpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.goose || !this.goose.stdin.writable) {
        reject(new Error('Goose process not running'));
        return;
      }
      const id = ++this._rpcId;
      this._pendingRpc.set(id, { resolve, reject });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: method,
        id: id,
        params: params || {},
      }) + '\n';

      this.goose.stdin.write(msg);
    });
  }

  _sendNotification(method, params) {
    if (!this.goose || !this.goose.stdin.writable) return;
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: method,
      params: params || {},
    }) + '\n';
    this.goose.stdin.write(msg);
  }

  // --- Handle ACP messages from Goose ---

  _handleGooseMessage(msg) {
    // JSON-RPC response (has id)
    if (msg.id !== undefined && msg.id !== null && this._pendingRpc.has(msg.id)) {
      const pending = this._pendingRpc.get(msg.id);
      this._pendingRpc.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notification (no id)
    if (msg.method) {
      this._handleNotification(msg);
      return;
    }
  }

  _handleNotification(msg) {
    const params = msg.params || {};

    switch (msg.method) {
      case 'session/notification': {
        const update = params.sessionUpdate || params;
        this._handleSessionUpdate(update, params);
        break;
      }

      case 'requestPermission': {
        // Goose is asking for user approval
        this._pendingPermissionId = msg.id || params.id;
        const toolUpdate = params.toolCallUpdate || {};
        this._sendToHub({
          type: 'approval_request',
          tool: toolUpdate.title || 'action',
          description: this._extractToolDescription(toolUpdate),
          command: '',
        });
        break;
      }
    }
  }

  _handleSessionUpdate(update, params) {
    const type = update.type || update;

    if (typeof type === 'string') {
      switch (type) {
        case 'agentMessageChunk': {
          // Streaming text from agent
          const chunk = update.chunk || params.chunk || {};
          const content = chunk.content || '';
          if (content) {
            this.pendingText += content;
          }
          break;
        }

        case 'toolCall': {
          // Tool invocation started
          this._flushPendingText();
          this.busy = true;
          this._sendToHub({ type: 'status', status: 'busy' });
          this._sendToHub({
            type: 'message',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_use',
                name: update.title || 'unknown',
                input: {},
                id: update.id || '',
              }),
              contentType: 'tool_use',
            },
          });
          break;
        }

        case 'toolCallUpdate': {
          // Tool completed/failed
          const output = this._extractToolOutput(update);
          const truncated = output.length > 2000
            ? output.slice(0, 2000) + `\n... (${output.length} chars)`
            : output;
          this._sendToHub({
            type: 'message',
            message: {
              role: 'tool',
              content: truncated,
              contentType: 'tool_result',
              toolUseId: update.id || '',
              isError: update.status === 'failed',
            },
          });
          break;
        }

        case 'agentThoughtChunk':
          // Internal reasoning, skip
          break;
      }
    }

    // Check for stop reason in prompt response
    if (params.stopReason === 'endTurn' || type === 'endTurn') {
      this._flushPendingText();
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
    }
  }

  _extractToolDescription(toolUpdate) {
    if (!toolUpdate) return '';
    const content = toolUpdate.content || [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        return block.text.slice(0, 200);
      }
    }
    return toolUpdate.title || '';
  }

  _extractToolOutput(update) {
    const content = update.content || [];
    const parts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      }
    }
    return parts.join('\n') || update.status || '';
  }

  // --- Permission handling ---

  _respondToPermission(optionId) {
    if (this._pendingPermissionId) {
      // Respond to the requestPermission JSON-RPC call
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: this._pendingPermissionId,
        result: { optionId: optionId },
      }) + '\n';
      if (this.goose && this.goose.stdin.writable) {
        this.goose.stdin.write(response);
      }
      this._pendingPermissionId = null;
    }
  }

  // --- Flush accumulators ---

  _flushPendingText() {
    if (this.pendingText) {
      this._sendToHub({
        type: 'message',
        message: {
          role: 'assistant',
          content: this.pendingText,
          contentType: 'text',
        },
      });
      this.pendingText = '';
    }
  }

  // --- Public API ---

  sendPrompt(text) {
    if (!this.goose) {
      if (this.gooseSessionId && !this.resumeSessionId) {
        this.resumeSessionId = this.gooseSessionId;
      }
      this.spawnGoose();
      // Wait for init before sending prompt
      setTimeout(() => this._sendPromptInternal(text), 2000);
      return;
    }
    this._sendPromptInternal(text);
  }

  _sendPromptInternal(text) {
    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    if (!this.gooseSessionId) {
      this._log('No session ID, cannot send prompt');
      return;
    }

    this._sendRpc('session/prompt', {
      sessionId: this.gooseSessionId,
      prompt: [{ type: 'text', text: text }],
    }).then((result) => {
      // Prompt completed
      this._flushPendingText();
      if (result && result.stopReason === 'endTurn') {
        this.busy = false;
        this._sendToHub({ type: 'status', status: 'idle' });
      }
    }).catch((err) => {
      this._log(`Prompt error: ${err.message}`);
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
    });
  }

  abort() {
    if (this.gooseSessionId) {
      this._sendNotification('session/cancel', {
        sessionId: this.gooseSessionId,
      });
    }
    this._flushPendingText();
    this.busy = false;
    this._sendToHub({ type: 'status', status: 'idle' });
  }

  async start() {
    await this.register();
    this.connect();
    this.spawnGoose();
    this._sendToHub({ type: 'status', status: 'idle' });
    this._log('Waiting for prompts from phone...');
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.goose) {
      try { this.goose.kill('SIGTERM'); } catch {}
      this.goose = null;
    }
    if (this.ws) this.ws.close();
    this._pendingRpc.clear();
  }

  // --- Utilities ---

  _sendToHub(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _log(msg) {
    console.error(`${logPrefix('goose-agent')} ${msg}`);
  }
}

module.exports = { GooseAgent };
