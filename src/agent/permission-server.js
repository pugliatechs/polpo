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
const readline = require('readline');

const INSTANCE_ID = process.env.POLPO_INSTANCE_ID;
const HUB_URL = process.env.POLPO_HUB_URL || 'http://127.0.0.1:7890';

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
        result: {
          tools: [{
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
          }],
        },
      });
      log('Sent tools/list response (1 tool)');
      break;

    case 'tools/call': {
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

function requestApproval(toolUseId, toolName, toolInput) {
  const payload = JSON.stringify({
    instanceId: INSTANCE_ID,
    toolUseId,
    toolName,
    toolInput,
  });

  return new Promise((resolve) => {
    const url = new URL('/api/permission-request', HUB_URL);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      // Long timeout: phone user might take a while
      timeout: 10 * 60 * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          // On parse error, allow the tool (fail open)
          resolve({ behavior: 'allow', updatedInput: toolInput });
        }
      });
    });

    req.on('error', (err) => {
      log(`Hub request error: ${err.message}`);
      // On network error, allow the tool (fail open)
      resolve({ behavior: 'allow', updatedInput: toolInput });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ behavior: 'deny', message: 'Approval timed out' });
    });

    req.write(payload);
    req.end();
  });
}
