/**
 * Polpo Hook Client
 *
 * Shared library used by hook scripts to communicate with the bridge daemon.
 * Auto-starts the bridge if it's not running.
 */

const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BRIDGE_PATH = path.join(__dirname, 'bridge.js');
const BRIDGE_START_TIMEOUT = 5000; // 5s to start
const BRIDGE_START_POLL = 200; // poll interval

/**
 * Compute the Unix socket path for a given working directory.
 */
function getSocketPath(cwd) {
  const hash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  return `/tmp/polpo-${hash}.sock`;
}

/**
 * Check if the bridge is running by attempting a ping on the Unix socket.
 */
function isBridgeRunning(socketPath) {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    const timeout = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 1000);

    client.on('connect', () => {
      client.write(JSON.stringify({ type: 'ping' }) + '\n');
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n')) {
          clearTimeout(timeout);
          client.end();
          resolve(true);
        }
      });
    });

    client.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Start the bridge daemon in the background.
 */
function startBridge(options = {}) {
  const args = [BRIDGE_PATH];
  if (options.name) args.push('--name', options.name);
  if (options.type) args.push('--type', options.type);
  if (options.project) args.push('--project', options.project);
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.serverUrl) args.push('--server', options.serverUrl);
  if (options.socketPath) args.push('--socket', options.socketPath);
  if (options.token) args.push('--token', options.token);

  const logFile = (options.socketPath || '/tmp/polpo-bridge').replace('.sock', '.log');
  const out = fs.openSync(logFile, 'a');

  const env = { ...process.env };
  if (options.token) {
    env.POLPO_TOKEN = options.token;
  }

  const child = spawn('node', args, {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  child.unref();
  return child.pid;
}

/**
 * Ensure the bridge is running, starting it if needed.
 * Returns the Unix socket path.
 */
async function ensureBridge(options = {}) {
  const cwd = options.cwd || process.cwd();
  const socketPath = options.socketPath || getSocketPath(cwd);

  if (await isBridgeRunning(socketPath)) {
    return socketPath;
  }

  // Start bridge
  startBridge({
    ...options,
    cwd,
    socketPath,
    serverUrl: options.serverUrl || process.env.POLPO_SERVER,
  });

  // Wait for it to come up
  const deadline = Date.now() + BRIDGE_START_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BRIDGE_START_POLL));
    if (await isBridgeRunning(socketPath)) {
      return socketPath;
    }
  }

  throw new Error('Bridge failed to start within timeout');
}

/**
 * Connect to the bridge Unix socket.
 */
function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    client.on('connect', () => resolve(client));
    client.on('error', reject);
  });
}

/**
 * Send a fire-and-forget message to the bridge.
 */
async function send(socketPath, msg) {
  const client = await connect(socketPath);
  client.write(JSON.stringify(msg) + '\n');
  // Give the socket a moment to flush before closing
  await new Promise((r) => setTimeout(r, 50));
  client.end();
}

/**
 * Send a message and wait for a response (used for approval flow).
 */
async function request(socketPath, msg, timeoutMs = 5 * 60 * 1000) {
  const client = await connect(socketPath);

  return new Promise((resolve, reject) => {
    let buffer = '';

    const timer = setTimeout(() => {
      client.end();
      // On timeout, allow the tool to proceed
      resolve({ type: 'approval_response', decision: 'allow', reason: 'timeout' });
    }, timeoutMs);

    client.write(JSON.stringify(msg) + '\n');

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timer);
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          client.end();
          resolve(response);
        } catch (e) {
          client.end();
          resolve({ type: 'approval_response', decision: 'allow', reason: 'parse_error' });
        }
      }
    });

    client.on('error', () => {
      clearTimeout(timer);
      resolve({ type: 'approval_response', decision: 'allow', reason: 'error' });
    });

    client.on('close', () => {
      clearTimeout(timer);
      // If we haven't resolved yet, allow
      resolve({ type: 'approval_response', decision: 'allow', reason: 'closed' });
    });
  });
}

/**
 * Read all of stdin and parse as JSON.
 * Returns the parsed object, or null if stdin is empty/invalid.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : null);
      } catch (e) {
        resolve(null);
      }
    });
    // If stdin is already closed or a TTY, resolve quickly
    if (process.stdin.isTTY) {
      resolve(null);
    }
  });
}

module.exports = {
  getSocketPath,
  isBridgeRunning,
  startBridge,
  ensureBridge,
  connect,
  send,
  request,
  readStdin,
};
