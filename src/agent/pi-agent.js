/**
 * PiAgent — Spawns and controls a Pi coding agent process.
 *
 * Pi (@mariozechner/pi-coding-agent) supports a long-running RPC mode
 * (`pi --mode rpc`) with bidirectional JSON over stdin/stdout — same
 * persistent-process pattern as WrappedAgent (Claude Code).
 *
 * Supports:
 *   - Long-running RPC mode (process stays alive across prompts)
 *   - Session resume via --session flag
 *   - Real-time streaming of text deltas, tool calls, and tool results
 *   - Abort via stdin JSON command + signal escalation
 *   - Image attachments via `images` array in prompt JSON
 *   - File attachments via @<path> syntax
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');
const readline = require('readline');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';

class PiAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.token = options.token || process.env.POLPO_TOKEN || null;
    this.name = options.name || `Pi (${path.basename(options.cwd || process.cwd())})`;
    this.type = options.type || 'terminal';
    this.project = options.project || path.basename(options.cwd || process.cwd());
    this.cwd = options.cwd || process.cwd();
    this.resumeSessionId = options.resumeSessionId || null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || 'default';
    this.piBinary = options.piBinary || 'pi';

    // Hub connection state
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;

    // Pi process state
    this.pi = null;
    this.piSessionId = null;
    this.busy = false;

    // Streaming accumulators
    this.pendingText = '';
    this.pendingToolName = '';
    this.pendingToolInput = '';
    this.pendingToolCallId = '';
  }

  // --- Hub registration (same as WrappedAgent) ---

  async register() {
    const apiBase = this.serverUrl
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const body = JSON.stringify({
      name: this.name,
      type: this.type,
      project: this.project,
      cwd: this.cwd,
      agentType: 'pi',
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
        { method: 'POST', headers },
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
    }
  }

  // --- Pi CLI process management ---

  spawnPi() {
    const args = ['--mode', 'rpc'];

    if (this.resumeSessionId) {
      args.push('--session', this.resumeSessionId);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    this._log(`Spawning: ${this.piBinary} ${args.join(' ')}`);

    this.pi = spawn(this.piBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse stdout as newline-delimited JSON
    const rl = readline.createInterface({ input: this.pi.stdout });
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        this._handlePiEvent(event);
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
    const stderrRl = readline.createInterface({ input: this.pi.stderr });
    stderrRl.on('line', (line) => {
      if (line.trim()) {
        this._log(`[pi stderr] ${line}`);
      }
    });

    this.pi.on('exit', (code) => {
      this._log(`Pi process exited (code ${code})`);
      this._flushPendingText();
      this.pi = null;
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
      this._sendToHub({
        type: 'output',
        content: `[session ended — code ${code}]`,
        contentType: 'text',
      });
    });

    this.pi.on('error', (err) => {
      this._log(`Pi process error: ${err.message}`);
      this._sendToHub({
        type: 'output',
        content: `[error: ${err.message}]`,
        contentType: 'text',
      });
    });
  }

  // --- Handle events from Pi RPC stdout ---

  _handlePiEvent(event) {
    switch (event.type) {
      case 'agent_start':
        this.busy = true;
        this._sendToHub({ type: 'status', status: 'busy' });
        break;

      case 'agent_end':
        this._flushAll();
        this.busy = false;
        this._sendToHub({ type: 'status', status: 'idle' });
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              type: 'turn_complete',
              agent: 'pi',
              usage: event.usage || null,
            }),
            contentType: 'turn_complete',
          },
        });
        break;

      case 'message_update':
        this._handleMessageUpdate(event);
        break;

      case 'tool_execution_start':
        this._flushPendingText();
        this._sendToHub({
          type: 'message',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: event.tool || 'unknown',
              input: event.input || {},
              id: event.id || '',
            }),
            contentType: 'tool_use',
          },
        });
        break;

      case 'tool_execution_update':
        // Partial output from running tool — skip (too noisy)
        break;

      case 'tool_execution_end': {
        const output = typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output || '');
        const truncated = output.length > 2000
          ? output.slice(0, 2000) + `\n... (${output.length} chars)`
          : output;
        this._sendToHub({
          type: 'message',
          message: {
            role: 'tool',
            content: truncated,
            contentType: 'tool_result',
            toolUseId: event.id || '',
            isError: event.isError || false,
          },
        });
        break;
      }

      case 'session_start':
        if (event.sessionId) {
          this.piSessionId = event.sessionId;
        }
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              subtype: 'init',
              session_id: event.sessionId || '',
              agent: 'pi',
              model: event.model || null,
            }),
            contentType: 'json',
          },
        });
        break;

      // Lifecycle events — no-op
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'message_end':
      case 'auto_compact':
      case 'auto_model_switch':
        break;

      case 'error':
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: `[Pi error: ${event.message || event.error || 'unknown'}]`,
            contentType: 'text',
            isError: true,
          },
        });
        break;

      default:
        // Unknown event — ignore
        break;
    }
  }

  // --- Handle message_update sub-events ---

  _handleMessageUpdate(event) {
    const sub = event.assistantMessageEvent || event.event || {};
    const subType = sub.type || event.subtype || '';

    switch (subType) {
      case 'text_delta':
        this.pendingText += (sub.delta || sub.text || '');
        break;

      case 'text_end':
        this._flushPendingText();
        break;

      case 'toolcall_start':
        this._flushPendingText();
        this.pendingToolName = sub.name || sub.toolName || '';
        this.pendingToolInput = '';
        this.pendingToolCallId = sub.id || sub.toolCallId || '';
        break;

      case 'toolcall_delta':
        this.pendingToolInput += (sub.delta || sub.input || '');
        break;

      case 'toolcall_end':
        this._flushPendingToolCall();
        break;

      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
        // Internal reasoning — skip
        break;

      case 'done':
        this._flushAll();
        break;

      case 'error':
        this._flushAll();
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: `[Pi error: ${sub.message || sub.error || 'unknown'}]`,
            contentType: 'text',
            isError: true,
          },
        });
        break;
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

  _flushPendingToolCall() {
    if (this.pendingToolName) {
      let input = {};
      if (this.pendingToolInput) {
        try {
          input = JSON.parse(this.pendingToolInput);
        } catch {
          input = { raw: this.pendingToolInput };
        }
      }
      this._sendToHub({
        type: 'message',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_use',
            name: this.pendingToolName,
            input,
            id: this.pendingToolCallId,
          }),
          contentType: 'tool_use',
        },
      });
      this.pendingToolName = '';
      this.pendingToolInput = '';
      this.pendingToolCallId = '';
    }
  }

  _flushAll() {
    this._flushPendingText();
    this._flushPendingToolCall();
  }

  // --- Public API ---

  /**
   * Send a prompt to the Pi process.
   * If no process is running, spawns one (resuming if a session ID is available).
   */
  sendPrompt(text, attachments) {
    if (!this.pi) {
      // Auto-resume if we have a session ID from a previous turn
      if (this.piSessionId && !this.resumeSessionId) {
        this.resumeSessionId = this.piSessionId;
      }
      this.spawnPi();
    }

    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    // Build prompt message
    let message = text || '';
    const images = [];

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (!att.path) continue;
        const resolvedPath = path.resolve(att.path);
        if (!resolvedPath.startsWith(UPLOAD_DIR + path.sep)) {
          this._log(`Skipping attachment outside upload dir: ${att.path}`);
          continue;
        }
        const isImage = att.mediaType && att.mediaType.startsWith('image/');
        if (isImage) {
          // Pi accepts images via the images array
          try {
            const data = fs.readFileSync(resolvedPath).toString('base64');
            images.push({
              mediaType: att.mediaType,
              data,
            });
          } catch (err) {
            this._log(`Failed to read image ${resolvedPath}: ${err.message}`);
          }
        } else {
          // Non-image files: use @<path> syntax
          message += `\n@${resolvedPath}`;
        }
      }
    }

    // Write to Pi's stdin
    const promptMsg = { type: 'prompt', message };
    if (images.length > 0) {
      promptMsg.images = images;
    }

    const input = JSON.stringify(promptMsg) + '\n';
    if (this.pi && this.pi.stdin.writable) {
      this.pi.stdin.write(input);
    }
  }

  /**
   * Abort the current task.
   * Sends graceful abort via stdin, then escalates to SIGINT/SIGKILL.
   */
  abort() {
    if (!this.pi) return;
    this._log('Aborting...');

    // Try graceful abort via stdin first
    if (this.pi.stdin.writable) {
      this.pi.stdin.write(JSON.stringify({ type: 'abort' }) + '\n');
    }

    // Escalate: SIGINT after 500ms
    const sigintTimer = setTimeout(() => {
      if (this.pi) {
        this.pi.kill('SIGINT');
      }
    }, 500);

    // Force kill after 3s
    setTimeout(() => {
      clearTimeout(sigintTimer);
      if (this.pi) {
        this.pi.kill('SIGKILL');
      }
    }, 3000);
  }

  /**
   * Start the agent: register with hub, connect WebSocket.
   */
  async start() {
    await this.register();
    this.connectToHub();
    this._log(`Registered as "${this.name}" (${this.instanceId})`);
    this._log('Waiting for prompts from phone...');
    // Don't spawn Pi yet — wait for the first prompt
  }

  /**
   * Stop the agent.
   */
  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.pi) this.pi.kill('SIGTERM');
    if (this.ws) this.ws.close();
  }

  _log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[pi-agent ${ts}] ${msg}`);
  }
}

module.exports = { PiAgent };
