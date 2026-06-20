/**
 * GeminiAgent — Spawns and controls a Google Gemini CLI process.
 *
 * This mirrors CodexAgent but speaks the Gemini CLI protocol:
 *   Phone → Polpo Hub → GeminiAgent → gemini -p "..." --output-format stream-json → codebase
 *
 * Key differences from CodexAgent:
 *   - Invocation: `gemini -p "<prompt>" --output-format stream-json`
 *   - Resume: `gemini --resume <sessionId> -p "<prompt>" --output-format stream-json`
 *   - Permissions: --approval-mode=yolo for bypass
 *   - Attachments: @<path> syntax appended to prompt text
 *   - Stream-json events: init, message, tool_use, tool_result, error, result
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { logPrefix } = require('./log-prefix');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';
const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');

class GeminiAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.token = options.token || process.env.POLPO_TOKEN || null;
    this.name = options.name || `Gemini (${path.basename(options.cwd || process.cwd())})`;
    this.type = options.type || 'terminal';
    this.project = options.project || path.basename(options.cwd || process.cwd());
    this.cwd = options.cwd || process.cwd();
    this.resumeSessionId = options.resumeSessionId || null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || 'default';
    this.geminiBinary = options.geminiBinary || 'gemini';

    // Hub connection state
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;

    // Gemini process state
    this.gemini = null;
    this.sessionId = null;
    this.busy = false;

    // Delta accumulation for streaming assistant messages
    this.pendingText = '';
  }

  // --- Hub registration (identical to CodexAgent) ---

  async register() {
    const apiBase = this.serverUrl
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const body = JSON.stringify({
      name: this.name,
      type: this.type,
      project: this.project,
      cwd: this.cwd,
      agentType: 'gemini',
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

  // --- WebSocket connection to hub (identical to CodexAgent) ---

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

  // --- Gemini CLI process management ---

  spawnGemini(prompt, attachments) {
    const args = [];

    // Resume a previous session if we have a session ID
    if (this.sessionId || this.resumeSessionId) {
      args.push('--resume', this.sessionId || this.resumeSessionId);
    }

    // Output format
    args.push('--output-format', 'stream-json');

    if (this.model) {
      args.push('-m', this.model);
    }

    // Permission handling
    if (this.permissionMode === 'bypass') {
      args.push('--approval-mode', 'yolo');
    }

    // Build prompt text with attachments
    let fullPrompt = prompt || '';
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const resolvedPath = path.resolve(att.path || '');
        if (!resolvedPath.startsWith(UPLOAD_DIR + path.sep)) continue;
        // Gemini CLI uses @<path> syntax for file injection
        fullPrompt += `\n@${resolvedPath}`;
      }
    }

    // Pass prompt via -p flag
    args.push('-p', fullPrompt);

    this._log(`Spawning: ${this.geminiBinary} ${args.map(a => a.length > 80 ? a.slice(0, 80) + '...' : a).join(' ')}`);

    this.pendingText = '';

    this.gemini = spawn(this.geminiBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Parse stdout as JSONL (stream-json format)
    const rl = readline.createInterface({ input: this.gemini.stdout });
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        this._handleGeminiEvent(event);
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
    const stderrRl = readline.createInterface({ input: this.gemini.stderr });
    stderrRl.on('line', (line) => {
      if (line.trim()) {
        this._log(`[gemini stderr] ${line}`);
      }
    });

    this.gemini.on('exit', (code) => {
      this._log(`Gemini process exited (code ${code})`);
      // Flush any pending text
      this._flushPendingText();
      this.gemini = null;
      this.busy = false;
      this._sendToHub({ type: 'status', status: 'idle' });
    });

    this.gemini.on('error', (err) => {
      this._log(`Gemini process error: ${err.message}`);
      this._sendToHub({
        type: 'output',
        content: `[error: ${err.message}]`,
        contentType: 'text',
      });
    });
  }

  // --- Handle Gemini stream-json events ---

  _handleGeminiEvent(event) {
    switch (event.type) {
      case 'init': {
        this.sessionId = event.session_id;
        this._log(`Session: ${event.session_id} (model: ${event.model})`);
        this._sendToHub({
          type: 'message',
          message: {
            role: 'system',
            content: JSON.stringify({
              subtype: 'init',
              session_id: event.session_id,
              model: event.model,
              agent: 'gemini',
            }),
            contentType: 'json',
          },
        });
        break;
      }

      case 'message': {
        if (event.role === 'user') {
          // User message echo — skip (we already show the prompt)
          break;
        }

        if (event.role === 'assistant') {
          if (event.delta) {
            // Streaming delta — accumulate text
            this.pendingText += (event.content || '');
          } else {
            // Complete message (non-delta)
            this._flushPendingText();
            if (event.content) {
              this._sendToHub({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: event.content,
                  contentType: 'text',
                },
              });
            }
          }
        }
        break;
      }

      case 'tool_use': {
        // Flush any pending text before tool use
        this._flushPendingText();

        this.busy = true;
        this._sendToHub({ type: 'status', status: 'busy' });
        this._sendToHub({
          type: 'message',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: event.tool_name || 'unknown',
              input: event.parameters || {},
              id: event.tool_id,
            }),
            contentType: 'tool_use',
          },
        });
        break;
      }

      case 'tool_result': {
        const output = event.output || '';
        const isError = event.status === 'error';
        const errorMsg = event.error ? event.error.message || '' : '';
        const resultContent = isError ? (errorMsg || output || 'Tool execution failed') : output;
        const truncated = resultContent.length > 2000
          ? resultContent.slice(0, 2000) + `\n... (${resultContent.length} chars)`
          : resultContent;

        this._sendToHub({
          type: 'message',
          message: {
            role: 'tool',
            content: truncated,
            contentType: 'tool_result',
            toolUseId: event.tool_id,
            isError,
          },
        });
        break;
      }

      case 'result': {
        // Flush any remaining text
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
              status: event.status,
              stats: event.stats || {},
            }),
            contentType: 'turn_complete',
          },
        });
        break;
      }

      case 'error': {
        this._sendToHub({
          type: 'output',
          content: `[gemini ${event.severity || 'error'}: ${event.message || JSON.stringify(event)}]`,
          contentType: 'text',
        });
        break;
      }
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

  /**
   * Send a prompt to Gemini.
   * Each prompt spawns a new process. If a session_id exists from a previous turn,
   * the new process resumes that session.
   */
  sendPrompt(text, attachments) {
    // Kill any existing process before spawning a new one
    if (this.gemini) {
      this._log('Killing previous gemini process for new prompt');
      this.gemini.kill('SIGTERM');
      this.gemini = null;
    }

    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    this.spawnGemini(text, attachments);
  }

  /**
   * Abort the current task by killing the gemini process.
   */
  abort() {
    if (this.gemini) {
      this._log('Aborting...');
      this.gemini.kill('SIGINT');
      setTimeout(() => {
        if (this.gemini) {
          this.gemini.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  /**
   * Start the agent: register with hub, connect WebSocket.
   * Doesn't spawn gemini yet — waits for the first prompt from the phone.
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
    if (this.gemini) this.gemini.kill('SIGTERM');
    if (this.ws) this.ws.close();
  }

  _log(msg) {
    console.error(`${logPrefix('gemini-agent')} ${msg}`);
  }
}

/**
 * Run a Gemini agent from the CLI.
 */
async function runGemini(options = {}) {
  const agent = new GeminiAgent(options);
  await agent.start();

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (line.trim()) {
        agent.sendPrompt(line.trim());
      }
    });
    console.error(`${logPrefix('gemini-agent')} Local stdin active — type prompts here or use phone`);
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

module.exports = { GeminiAgent, runGemini };
