#!/usr/bin/env node

/**
 * Polpo MCP Permission Server
 *
 * Minimal MCP server that handles permission prompts from the claude CLI.
 * When claude needs to use a tool that requires approval, it calls this
 * server's `polpo_approve` tool. The server forwards the request to the
 * Polpo hub via a long-poll HTTP request, which blocks until the phone
 * user approves or rejects.
 *
 * Communication: stdio (newline-delimited JSON-RPC 2.0).
 *
 * Required environment variables:
 *   POLPO_INSTANCE_ID - The hub instance ID for this agent
 *   POLPO_HUB_URL     - The hub HTTP base URL (e.g., http://127.0.0.1:7890)
 */

const http = require('http');
const crypto = require('crypto');
const readline = require('readline');

const INSTANCE_ID = process.env.POLPO_INSTANCE_ID;
const HUB_URL = process.env.POLPO_HUB_URL || 'http://127.0.0.1:7890';
const AUTH_TOKEN = process.env.POLPO_AUTH_TOKEN || null;
// A browser session also gets polpo_request_browser_grant.
const BROWSER = process.env.POLPO_BROWSER === '1';

const APPROVE_TOOL = {
  name: 'polpo_approve',
  description: 'Handle permission requests for tool use',
  inputSchema: {
    type: 'object',
    properties: {
      tool_use_id: { type: 'string' },
      tool_name: { type: 'string' },
      input: { type: 'object' },
    },
    required: ['tool_use_id', 'tool_name', 'input'],
  },
};

const GRANT_TOOL = {
  name: 'polpo_request_browser_grant',
  description: 'Ask the user to approve a plan of browser actions on one site. Call it after filling the form and '
    + 'before the first click or key press that commits it. Attach a screenshot of the filled page, saved with '
    + 'computer {"action": "screenshot", "save_to_disk": true}. Approved, it lets the planned commits on that site '
    + 'through for the minutes granted, counted from the approval. Rejected, it says why.',
  inputSchema: {
    type: 'object',
    properties: {
      site: { type: 'string', description: 'The host name the plan runs on, one of the session\'s sites.' },
      purpose: { type: 'string', description: 'What the plan achieves for the user, in one or two sentences.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'The commits you will make, in order (at most 20).' },
      minutes: { type: 'integer', description: 'How long the grant should last.' },
      screenshotPath: { type: 'string', description: 'The path the screenshot tool reported ("Screenshot saved to: ...").' },
    },
    required: ['site', 'purpose', 'steps', 'minutes', 'screenshotPath'],
  },
};

function log(msg) {
  process.stderr.write(`[polpo-mcp] ${msg}\n`);
}

log(`Starting (instance: ${INSTANCE_ID}, hub: ${HUB_URL})`);

// ---- MCP stdio transport (newline-delimited JSON) ----

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleMessage(JSON.parse(trimmed));
  } catch (e) {
    log(`Parse error: ${e.message} — line: ${trimmed.slice(0, 200)}`);
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---- MCP message handlers ----

function handleMessage(msg) {
  log(`Received: ${msg.method || 'notification'} (id: ${msg.id})`);

  // Notifications (no id) don't need responses
  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'polpo-permissions', version: '1.0.0' },
        },
      });
      log('Sent initialize response');
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: BROWSER ? [APPROVE_TOOL, GRANT_TOOL] : [APPROVE_TOOL] },
      });
      log('Sent tools/list response');
      break;

    case 'tools/call': {
      if (BROWSER && msg.params && msg.params.name === GRANT_TOOL.name) {
        const a = (msg.params && msg.params.arguments) || {};
        // One id per call: the hub asks again with it while the user decides.
        const requestId = 'grant-' + crypto.randomBytes(12).toString('hex');
        requestGrant(requestId, a).then((out) => {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: out.message }], isError: !out.granted },
          });
        });
        break;
      }
      const args = (msg.params && msg.params.arguments) || {};
      const toolUseId = args.tool_use_id || '';
      const toolName = args.tool_name || 'unknown';
      const toolInput = args.input || {};

      log(`Tool call: ${toolName} (${toolUseId})`);

      requestApproval(toolUseId, toolName, toolInput)
        .then((decision) => {
          log(`Decision: ${decision.behavior}`);
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(decision) }],
            },
          });
        });
      break;
    }

    default:
      log(`Unknown method: ${msg.method}`);
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;
  }
}

// ---- Hub communication ----

/** POST to the hub and parse the JSON answer; null when unreachable. */
function postHub(pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const url = new URL(pathname, HUB_URL);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = http.request(url, { method: 'POST', headers, timeout: 10 * 60 * 1000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => { log(`Hub request error: ${err.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

/**
 * Ask the hub for a browser grant; it holds the request until the user
 * answers, telling us to ask again every few minutes.
 * @returns {Promise<{granted: boolean, message: string}>}
 */
async function requestGrant(requestId, args) {
  const body = {
    instanceId: INSTANCE_ID,
    requestId,
    site: args.site,
    purpose: args.purpose,
    steps: args.steps,
    minutes: args.minutes,
    screenshotPath: args.screenshotPath,
  };
  for (;;) {
    const out = await postHub('/api/browser-grant', body);
    if (out && out.retry === true) continue;
    if (!out || typeof out.message !== 'string') {
      return { granted: false, message: 'polpo could not be reached; no grant. Do not commit anything.' };
    }
    return { granted: out.granted === true, message: out.message };
  }
}

// When the hub cannot be reached or answers nonsense, the call is denied.
// It used to be allowed, so a polpo restart while an approval waited (for
// hours, in a campaign) approved whatever the agent had asked for.
const UNREACHABLE = { behavior: 'deny', message: 'polpo could not be reached; approval denied' };

function requestApproval(toolUseId, toolName, toolInput) {
  const payload = JSON.stringify({
    instanceId: INSTANCE_ID,
    toolUseId,
    toolName,
    toolInput,
  });

  return new Promise((resolve) => {
    const url = new URL('/api/permission-request', HUB_URL);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (AUTH_TOKEN) {
      headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    }
    const req = http.request(url, {
      method: 'POST',
      headers,
      // Long timeout: phone user might take a while
      timeout: 10 * 60 * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const decision = JSON.parse(data);
          // A campaign's approval waits for an answer however long it
          // takes; the hub answers {retry: true} every few minutes so no
          // request stays open for hours. Ask again with the same id.
          if (decision && decision.retry === true) {
            resolve(requestApproval(toolUseId, toolName, toolInput));
            return;
          }
          resolve(decision);
        } catch {
          resolve(UNREACHABLE);
        }
      });
    });

    req.on('error', (err) => {
      log(`Hub request error: ${err.message}`);
      resolve(UNREACHABLE);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ behavior: 'deny', message: 'Approval timed out' });
    });

    req.write(payload);
    req.end();
  });
}
