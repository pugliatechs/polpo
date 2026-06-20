const WebSocket = require('ws');
const http = require('http');
const readline = require('readline');
const { makeLogger } = require('../util/logger');

const log = makeLogger('polpo-agent');
const mobile = makeLogger('mobile');

const DEFAULT_SERVER = 'ws://127.0.0.1:7890';

class PolpoAgent {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.POLPO_SERVER || DEFAULT_SERVER;
    this.instanceId = null;
    this.ws = null;
    this.reconnectTimer = null;
    this.name = options.name || `Claude Code (${options.type || 'terminal'})`;
    this.type = options.type || 'terminal';
    this.project = options.project || process.cwd().split('/').pop();
    this.cwd = options.cwd || process.cwd();
    this.onPrompt = options.onPrompt || null;
    this.onApprove = options.onApprove || null;
    this.onReject = options.onReject || null;
    this.onAbort = options.onAbort || null;
    this.onPause = options.onPause || null;
    this.onResume = options.onResume || null;
  }

  async register() {
    const apiBase = this.serverUrl.replace('ws://', 'http://').replace('wss://', 'https://');
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

  connect() {
    if (!this.instanceId) {
      throw new Error('Must register before connecting');
    }

    const wsUrl = `${this.serverUrl}?role=agent&instanceId=${this.instanceId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      log.info(`Connected to hub as "${this.name}" (${this.instanceId})`);
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleMessage(msg);
      } catch (e) {
        // ignore
      }
    });

    this.ws.on('close', () => {
      log.info('Disconnected from hub, reconnecting in 3s...');
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', () => {
      // close event will fire after this
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'prompt':
        if (this.onPrompt) this.onPrompt(msg.text);
        break;
      case 'approve':
        if (this.onApprove) this.onApprove();
        break;
      case 'reject':
        if (this.onReject) this.onReject();
        break;
      case 'abort':
        if (this.onAbort) this.onAbort();
        break;
      case 'pause':
        if (this.onPause) this.onPause();
        break;
      case 'resume':
        if (this.onResume) this.onResume();
        break;
    }
  }

  sendStatus(status) {
    this._send({ type: 'status', status });
  }

  sendOutput(content, contentType = 'text') {
    this._send({ type: 'output', content, contentType });
  }

  sendMessage(role, content) {
    this._send({ type: 'message', message: { role, content } });
  }

  requestApproval(tool, description, command) {
    this._send({ type: 'approval_request', tool, description, command });
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async start() {
    await this.register();
    this.connect();
    return this.instanceId;
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

/**
 * Standalone mode: run the agent as an interactive bridge.
 * It reads stdin lines and relays them to the hub as assistant output,
 * while printing prompts received from the hub to stdout.
 */
async function runStandalone(options = {}) {
  const agent = new PolpoAgent({
    ...options,
    onPrompt: (text) => {
      mobile.info(`>>> ${text}`);
    },
    onAbort: () => {
      mobile.info('Task aborted by remote user');
    },
    onPause: () => {
      mobile.info('Paused by remote user');
    },
    onResume: () => {
      mobile.info('Resumed by remote user');
    },
  });

  await agent.start();

  // Read stdin and forward to hub as output
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    agent.sendOutput(line);
  });

  process.on('SIGINT', () => {
    agent.stop();
    process.exit(0);
  });

  return agent;
}

module.exports = { PolpoAgent, runStandalone };
