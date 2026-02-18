#!/usr/bin/env node

/**
 * Polpo Bridge Daemon
 *
 * Persistent process that maintains a WebSocket connection to the Polpo hub
 * and listens on a Unix socket for hook script connections.
 *
 * Started automatically by hook scripts or manually via `polpo bridge`.
 * Exits after 30 minutes of inactivity.
 */

const net = require('net');
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 min

// --- Parse CLI args ---

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const config = {
  serverUrl: getArg('server') || process.env.POLPO_SERVER || 'ws://127.0.0.1:7890',
  token: getArg('token') || process.env.POLPO_TOKEN || null,
  name: getArg('name') || process.env.POLPO_NAME || null,
  type: getArg('type') || 'vscode',
  project: getArg('project') || null,
  cwd: getArg('cwd') || process.cwd(),
  socketPath: getArg('socket') || null,
};

// Derive defaults from cwd
if (!config.name) config.name = `Claude Code (${path.basename(config.cwd)})`;
if (!config.project) config.project = path.basename(config.cwd);
if (!config.socketPath) {
  const hash = crypto.createHash('md5').update(config.cwd).digest('hex').slice(0, 12);
  config.socketPath = `/tmp/polpo-${hash}.sock`;
}

// --- State ---

let instanceId = null;
let ws = null;
let unixServer = null;
let reconnectTimer = null;
let inactivityTimer = null;
const pendingApprovals = new Map(); // requestId -> { socket, timer }
const hookClients = new Set();

// --- Inactivity timer ---

function resetInactivity() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    log('Shutting down due to inactivity');
    shutdown();
  }, INACTIVITY_TIMEOUT);
}

// --- Logging ---

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[bridge ${ts}] ${msg}`);
}

// --- Register with Polpo hub via HTTP ---

async function register() {
  const apiBase = config.serverUrl
    .replace('ws://', 'http://')
    .replace('wss://', 'https://');
  const body = JSON.stringify({
    name: config.name,
    type: config.type,
    project: config.project,
    cwd: config.cwd,
  });

  return new Promise((resolve, reject) => {
    const reqUrl = new URL('/api/instances', apiBase);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`;
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
          try {
            const result = JSON.parse(data);
            instanceId = result.id;
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

function connectWebSocket() {
  if (!instanceId) return;

  let wsUrl = `${config.serverUrl}?role=agent&instanceId=${instanceId}`;
  if (config.token) {
    wsUrl += `&token=${encodeURIComponent(config.token)}`;
  }
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log(`Connected to hub (instance ${instanceId})`);
    sendToHub({ type: 'status', status: 'idle' });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleHubMessage(msg);
    } catch (e) {
      // ignore malformed
    }
  });

  ws.on('close', () => {
    log('Disconnected from hub, reconnecting in 3s...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  });

  ws.on('error', () => {
    // close event fires after this
  });
}

function sendToHub(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Handle messages from hub (phone actions) ---

function handleHubMessage(msg) {
  resetInactivity();

  switch (msg.type) {
    case 'approve':
    case 'reject': {
      // Resolve the oldest pending approval request
      const iter = pendingApprovals.entries().next();
      if (!iter.done) {
        const [requestId, pending] = iter.value;
        pendingApprovals.delete(requestId);
        clearTimeout(pending.timer);
        const decision = msg.type === 'approve' ? 'allow' : 'block';
        const response = JSON.stringify({
          type: 'approval_response',
          requestId,
          decision,
        }) + '\n';
        try {
          pending.socket.write(response);
        } catch (e) {
          // socket may have closed
        }
      }
      break;
    }
    // prompt, abort, pause, resume are forwarded to hook clients
    // but in the hooks model these aren't directly actionable
    // (Claude Code manages its own lifecycle)
    default:
      break;
  }
}

// --- Unix socket server for hook scripts ---

function startUnixServer() {
  // Remove stale socket file
  try {
    fs.unlinkSync(config.socketPath);
  } catch (e) {
    // doesn't exist, fine
  }

  unixServer = net.createServer((socket) => {
    hookClients.add(socket);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line);
          handleHookMessage(msg, socket);
        } catch (e) {
          // ignore malformed
        }
      }
    });

    socket.on('close', () => {
      hookClients.delete(socket);
      // Clean up pending approvals for this socket
      for (const [reqId, pending] of pendingApprovals) {
        if (pending.socket === socket) {
          clearTimeout(pending.timer);
          pendingApprovals.delete(reqId);
        }
      }
    });

    socket.on('error', () => {});
  });

  unixServer.listen(config.socketPath, () => {
    log(`Listening on ${config.socketPath}`);
  });

  unixServer.on('error', (err) => {
    log(`Unix socket error: ${err.message}`);
    process.exit(1);
  });
}

// --- Handle messages from hook scripts ---

function handleHookMessage(msg, socket) {
  resetInactivity();

  switch (msg.type) {
    case 'approval_request': {
      // Store the hook socket to relay the hub's response back
      const timeoutMs = msg.timeout || 5 * 60 * 1000;
      const timer = setTimeout(() => {
        // Timeout — let the tool proceed
        pendingApprovals.delete(msg.requestId);
        const response = JSON.stringify({
          type: 'approval_response',
          requestId: msg.requestId,
          decision: 'allow',
          reason: 'timeout',
        }) + '\n';
        try {
          socket.write(response);
        } catch (e) {}
      }, timeoutMs);

      pendingApprovals.set(msg.requestId, { socket, timer });

      sendToHub({
        type: 'approval_request',
        tool: msg.tool,
        description: msg.description,
        command: msg.command,
      });
      sendToHub({ type: 'status', status: 'waiting' });
      break;
    }

    case 'status': {
      sendToHub({ type: 'status', status: msg.status });
      break;
    }

    case 'output': {
      sendToHub({
        type: 'output',
        content: msg.content,
        contentType: msg.contentType || 'text',
      });
      break;
    }

    case 'message': {
      sendToHub({ type: 'message', message: msg.message });
      break;
    }

    case 'tool_start': {
      sendToHub({
        type: 'output',
        content: `[tool] ${msg.tool}: ${msg.description || ''}`,
        contentType: 'text',
      });
      sendToHub({ type: 'status', status: 'busy' });
      break;
    }

    case 'tool_result': {
      sendToHub({
        type: 'output',
        content: msg.content,
        contentType: 'text',
      });
      break;
    }

    case 'notification': {
      sendToHub({
        type: 'output',
        content: `[notification] ${msg.content}`,
        contentType: 'text',
      });
      break;
    }

    case 'ping': {
      try {
        socket.write(JSON.stringify({ type: 'pong' }) + '\n');
      } catch (e) {}
      break;
    }
  }
}

// --- Shutdown ---

function shutdown() {
  clearTimeout(reconnectTimer);
  clearTimeout(inactivityTimer);

  // Resolve all pending approvals with allow (don't block Claude Code)
  for (const [reqId, pending] of pendingApprovals) {
    clearTimeout(pending.timer);
    try {
      pending.socket.write(
        JSON.stringify({
          type: 'approval_response',
          requestId: reqId,
          decision: 'allow',
          reason: 'bridge_shutdown',
        }) + '\n'
      );
    } catch (e) {}
  }
  pendingApprovals.clear();

  if (ws) ws.close();
  if (unixServer) unixServer.close();

  // Clean up socket and state files
  try { fs.unlinkSync(config.socketPath); } catch (e) {}
  try { fs.unlinkSync(config.socketPath.replace('.sock', '.json')); } catch (e) {}

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Main ---

(async () => {
  try {
    await register();
    connectWebSocket();
    startUnixServer();
    resetInactivity();

    // Write state file so hooks can find us
    const stateFile = config.socketPath.replace('.sock', '.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        instanceId,
        socketPath: config.socketPath,
        pid: process.pid,
        name: config.name,
        project: config.project,
        cwd: config.cwd,
        startedAt: Date.now(),
      })
    );

    log(`Bridge ready — ${config.name} (${config.project})`);
    log(`Instance ID: ${instanceId}`);
  } catch (err) {
    log(`Failed to start: ${err.message}`);
    process.exit(1);
  }
})();
