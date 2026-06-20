/**
 * OpencodeAgent — Spawns and controls an OpenCode CLI process.
 *
 * This mirrors GeminiAgent but speaks the OpenCode protocol:
 *   Phone → Polpo Hub → OpencodeAgent → opencode run -p "..." --format json -q → codebase
 *
 * Key differences from GeminiAgent:
 *   - Invocation: `opencode run -p "<prompt>" --format json -q`
 *   - Resume: `opencode run --session <sessionId> -p "<prompt>" --format json -q`
 *   - Events: message.part.updated, session.created, session.idle, session.error, etc.
 *   - Session storage: SQLite (not JSON/JSONL files)
 *   - No MCP support — no permission mode flags
 *   - Attachments: --file <path> flag
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { logPrefix } = require('./log-prefix');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';
const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');

class OpencodeAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.token = options.token || process.env.POLPO_TOKEN || null;
    this.name = options.name || `OpenCode (${path.basename(options.cwd || process.cwd())})`;
    this.type = options.type || 'terminal';
    this.project = options.project || path.basename(options.cwd || process.cwd());
    this.cwd = options.cwd || process.cwd();
    this.resumeSessionId = options.resumeSessionId || null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || 'default';
    this.opencodeBinary = options.opencodeBinary || 'opencode';

    // Hub connection state
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;

    // OpenCode process state
    this.opencode = null;
    this.sessionId = null;
    this.busy = false;

    // Delta accumulation for streaming assistant messages
    this.pendingText = '';
    // Track whether we received any JSONL events (for fallback detection)
    this.receivedEvents = false;
    this.fullStdout = '';
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
      agentType: 'opencode',
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

  // --- WebSocket connection to hub ---

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
        break;
    }
  }

  // --- OpenCode CLI process management ---

  spawnOpencode(prompt, attachments) {
    const args = ['run'];

    // Resume a previous session if we have a session ID
    if (this.sessionId || this.resumeSessionId) {
      args.push('--session', this.sessionId || this.resumeSessionId);
    }

    // JSON output format + quiet mode
    args.push('--format', 'json');
    args.push('-q');

    if (this.model) {
      args.push('-m', this.model);
    }

    // Attach files via --file flag
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const resolvedPath = path.resolve(att.path || '');
        if (!resolvedPath.startsWith(UPLOAD_DIR + path.sep)) continue;
        args.push('--file', resolvedPath);
      }
    }

    // Prompt via -p flag
    args.push('-p', prompt || '');

    this._log(`Spawning: ${this.opencodeBinary} ${args.map(a => a.length > 80 ? a.slice(0, 80) + '...' : a).join(' ')}`);

    this.pendingText = '';
    this.receivedEvents = false;
    this.fullStdout = '';

    this.opencode = spawn(this.opencodeBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Parse stdout as JSONL
    const rl = readline.createInterface({ input: this.opencode.stdout });
    rl.on('line', (line) => {
      this.fullStdout += line + '\n';
      try {
        const event = JSON.parse(line);
        this.receivedEvents = true;
        this._handleOpencodeEvent(event);
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
    const stderrRl = readline.createInterface({ input: this.opencode.stderr });
    stderrRl.on('line', (line) => {
      if (line.trim()) {
        this._log(`[opencode stderr] ${line}`);
      }
    });

    this.opencode.on('exit', (code) => {
      this._log(`OpenCode process exited (code ${code})`);
      // Flush any pending text
      this._flushPendingText();
      // If no JSONL events were received, try fallback JSON parsing
      if (!this.receivedEvents && this.fullStdout.trim()) {
        this._handleFallbackResponse(this.fullStdout.trim());
      }
      this.opencode = null;
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
    });

    this.opencode.on('error', (err) => {
      this._log(`OpenCode process error: ${err.message}`);
      this._sendToHub({
        type: 'output',
        content: `[error: ${err.message}]`,
        contentType: 'text',
      });
    });
  }

  // --- Handle OpenCode JSON events ---

  _handleOpencodeEvent(event) {
    const type = event.type || '';

    switch (type) {
      case 'session.created': {
        const sid = event.session_id || event.sessionID || event.properties?.sessionID;
        if (sid) this.sessionId = sid;
        this._log(`Session: ${this.sessionId}`);
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              subtype: 'init',
              session_id: this.sessionId,
              agent: 'opencode',
            }),
            contentType: 'json',
          },
        });
        break;
      }

      case 'message.part.updated': {
        const part = event.part || event.properties?.part || {};
        const partType = part.type || '';

        if (partType === 'text') {
          // Accumulate streaming text deltas
          this.pendingText += (part.text || part.content || '');
        } else if (partType === 'tool') {
          // Tool execution — flush text first
          this._flushPendingText();
          const state = part.state || 'running';
          if (state === 'running' || state === 'pending') {
            this._sendToHub({
              type: 'message',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  type: 'tool_use',
                  name: part.name || part.toolName || 'unknown',
                  input: part.input || part.args || {},
                  id: part.id || part.toolCallId || `tool_${Date.now()}`,
                }),
                contentType: 'tool_use',
              },
            });
          } else if (state === 'completed' || state === 'error') {
            const output = part.output || part.result || '';
            const truncated = output.length > 2000
              ? output.slice(0, 2000) + `\n... (${output.length} chars)`
              : output;
            this._sendToHub({
              type: 'message',
              message: {
                role: 'tool',
                content: truncated,
                contentType: 'tool_result',
                toolUseId: part.id || part.toolCallId || '',
                isError: state === 'error',
              },
            });
          }
        }
        // Skip thinking/reasoning parts (internal)
        break;
      }

      case 'message.updated':
      case 'message.created': {
        // Full message — extract session ID if present
        const sid = event.session_id || event.sessionID;
        if (sid && !this.sessionId) this.sessionId = sid;

        // Extract content if available
        const msg = event.message || event.properties?.message || {};
        if (msg.content && msg.role !== 'user') {
          this._flushPendingText();
          this._sendToHub({
            type: 'message',
            message: {
              role: 'assistant',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              contentType: 'text',
            },
          });
        }
        break;
      }

      case 'tool.execute.before':
      case 'tool.execute': {
        this._flushPendingText();
        this._sendToHub({
          type: 'message',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: event.tool || event.name || event.properties?.tool || 'unknown',
              input: event.input || event.args || event.properties?.input || {},
              id: event.id || event.properties?.id || `tool_${Date.now()}`,
            }),
            contentType: 'tool_use',
          },
        });
        break;
      }

      case 'tool.execute.after':
      case 'tool.result': {
        const output = event.output || event.result || event.properties?.output || '';
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
        const truncated = outputStr.length > 2000
          ? outputStr.slice(0, 2000) + `\n... (${outputStr.length} chars)`
          : outputStr;
        this._sendToHub({
          type: 'message',
          message: {
            role: 'tool',
            content: truncated,
            contentType: 'tool_result',
            toolUseId: event.id || event.properties?.id || '',
            isError: !!event.error || event.properties?.error,
          },
        });
        break;
      }

      case 'session.idle': {
        this._flushPendingText();
        this.busy = false;
        this._sendToHub({ type: 'status', status: 'idle' });
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              type: 'turn_complete',
              session_id: this.sessionId,
            }),
            contentType: 'turn_complete',
          },
        });
        break;
      }

      case 'session.error': {
        this._sendToHub({
          type: 'output',
          content: `[opencode error: ${event.message || event.error || JSON.stringify(event)}]`,
          contentType: 'text',
        });
        break;
      }

      default: {
        // Log unrecognized events for debugging
        this._log(`[unhandled event] ${type}: ${JSON.stringify(event).slice(0, 200)}`);
        break;
      }
    }
  }

  /**
   * Fallback: if stdout produced a single JSON object with {"response":"content"}
   * instead of JSONL events, send it as a single assistant message.
   */
  _handleFallbackResponse(fullStdout) {
    try {
      const obj = JSON.parse(fullStdout);
      if (obj.response) {
        this._sendToHub({
          type: 'message',
          message: {
            role: 'assistant',
            content: obj.response,
            contentType: 'text',
          },
        });
      }
    } catch (e) {
      // Not valid JSON — already forwarded as raw output
    }
  }

  /**
   * Flush accumulated delta text as a single assistant message.
   */
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

  sendPrompt(text, attachments) {
    if (this.opencode) {
      this._log('Killing previous opencode process for new prompt');
      this.opencode.kill('SIGTERM');
      this.opencode = null;
    }

    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    this.spawnOpencode(text, attachments);
  }

  abort() {
    if (this.opencode) {
      this._log('Aborting...');
      this.opencode.kill('SIGINT');
      setTimeout(() => {
        if (this.opencode) {
          this.opencode.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  async start() {
    await this.register();
    this.connectToHub();
    this._log(`Registered as "${this.name}" (${this.instanceId})`);
    this._log('Waiting for prompts from phone...');
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.opencode) this.opencode.kill('SIGTERM');
    if (this.ws) this.ws.close();
  }

  _log(msg) {
    console.error(`${logPrefix('opencode-agent')} ${msg}`);
  }
}

async function runOpencode(options = {}) {
  const agent = new OpencodeAgent(options);
  await agent.start();

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (line.trim()) {
        agent.sendPrompt(line.trim());
      }
    });
    console.error(`${logPrefix('opencode-agent')} Local stdin active — type prompts here or use phone`);
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

module.exports = { OpencodeAgent, runOpencode };
