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
const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');

class WrappedAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.token = options.token || process.env.POLPO_TOKEN || null;
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
              ...(this.token ? { POLPO_AUTH_TOKEN: this.token } : {}),
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
  sendPrompt(text, attachments) {
    if (!this.claude) {
      // Auto-resume if we have a session ID from a previous turn
      if (this.claudeSessionId && !this.resumeSessionId) {
        this.resumeSessionId = this.claudeSessionId;
      }
      this.spawnClaude();
    }

    this.busy = true;
    this._sendToHub({ type: 'status', status: 'busy' });

    // Build content: plain string or multimodal content array
    const content = this._buildContent(text, attachments);

    // Write to claude's stdin
    const input = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    }) + '\n';

    if (this.claude && this.claude.stdin.writable) {
      this.claude.stdin.write(input);
    }
  }

  _buildContent(text, attachments) {
    if (!attachments || attachments.length === 0) return text;

    const blocks = [];
    const TEXT_INLINE_LIMIT = 100 * 1024; // inline text files up to 100KB

    for (const att of attachments) {
      // Validate attachment path is within the upload directory
      const resolvedPath = path.resolve(att.path || '');
      if (!resolvedPath.startsWith(UPLOAD_DIR + path.sep)) {
        this._log(`Rejected attachment with path outside upload dir: ${att.path}`);
        blocks.push({ type: 'text', text: `[Rejected attachment: invalid path]` });
        continue;
      }

      const isImage = att.mediaType && att.mediaType.startsWith('image/');
      const isPdf = att.mediaType === 'application/pdf'
        || (att.filename || '').toLowerCase().endsWith('.pdf');
      const isText = this._isTextFile(att.filename, att.mediaType);

      if (isImage) {
        try {
          const data = fs.readFileSync(att.path).toString('base64');
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mediaType,
              data,
            },
          });
        } catch (err) {
          this._log(`Failed to read attachment ${att.path}: ${err.message}`);
          blocks.push({ type: 'text', text: `[Failed to attach image: ${att.filename}]` });
        }
      } else if (isPdf) {
        try {
          const data = fs.readFileSync(att.path).toString('base64');
          blocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data,
            },
          });
        } catch (err) {
          this._log(`Failed to read PDF ${att.path}: ${err.message}`);
          blocks.push({ type: 'text', text: `[Failed to attach PDF: ${att.filename}]` });
        }
      } else if (isText) {
        // Inline small text files so Claude sees them without a tool call
        try {
          const stat = fs.statSync(att.path);
          if (stat.size <= TEXT_INLINE_LIMIT) {
            const content = fs.readFileSync(att.path, 'utf8');
            blocks.push({
              type: 'text',
              text: `--- ${att.filename} ---\n${content}\n--- end ${att.filename} ---`,
            });
          } else {
            blocks.push({
              type: 'text',
              text: `[Attached file: ${att.path} (${(stat.size / 1024).toFixed(0)}KB)] — use the Read tool to view its contents`,
            });
          }
        } catch (err) {
          this._log(`Failed to read attachment ${att.path}: ${err.message}`);
          blocks.push({ type: 'text', text: `[Failed to read file: ${att.filename}]` });
        }
      } else {
        // Binary / large files: reference by path
        blocks.push({
          type: 'text',
          text: `[Attached file: ${att.path}] — use the Read tool to view its contents`,
        });
      }
    }

    // Add the user's text prompt
    if (text) {
      blocks.push({ type: 'text', text });
    }

    return blocks;
  }

  _isTextFile(filename, mediaType) {
    if (mediaType && mediaType.startsWith('text/')) return true;
    if (mediaType === 'application/json' || mediaType === 'application/xml') return true;
    const ext = (filename || '').split('.').pop().toLowerCase();
    const textExts = new Set([
      'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'log',
      'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
      'xml', 'html', 'htm', 'css', 'svg',
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
      'py', 'rb', 'go', 'rs', 'java', 'kt', 'scala', 'clj',
      'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'm',
      'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
      'sql', 'graphql', 'gql', 'proto',
      'dockerfile', 'makefile', 'cmake',
      'gitignore', 'dockerignore', 'editorconfig',
      'lock', 'sum', 'mod',
    ]);
    return textExts.has(ext);
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
