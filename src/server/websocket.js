const WebSocket = require('ws');
const url = require('url');
const { validateWsAuth } = require('./auth');
const { JsonlWatcher } = require('./jsonl-watcher');

function setupWebSocket(server, instanceManager, getAuthState) {
  const wss = new WebSocket.Server({ server });

  // Track mobile/browser clients
  const dashboardClients = new Set();

  // Track JSONL file watchers: instanceId -> JsonlWatcher
  const activeWatchers = new Map();

  function broadcastToDashboards(message) {
    const data = JSON.stringify(message);
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // Forward all instance events to dashboard clients
  instanceManager.on('instance:registered', (instance) => {
    broadcastToDashboards({
      type: 'instance:registered',
      instance: {
        id: instance.id,
        name: instance.name,
        type: instance.type,
        project: instance.project,
        cwd: instance.cwd,
        status: instance.status,
        registeredAt: instance.registeredAt,
      },
    });
  });

  instanceManager.on('instance:disconnected', (instance) => {
    broadcastToDashboards({
      type: 'instance:disconnected',
      instanceId: instance.id,
    });

    // Clean up JSONL watcher
    const watcher = activeWatchers.get(instance.id);
    if (watcher) {
      watcher.close();
      activeWatchers.delete(instance.id);
    }
  });

  instanceManager.on('instance:status', (data) => {
    broadcastToDashboards({ type: 'instance:status', ...data });
  });

  instanceManager.on('instance:message', (data) => {
    broadcastToDashboards({ type: 'instance:message', ...data });
  });

  instanceManager.on('instance:approval', (data) => {
    broadcastToDashboards({ type: 'instance:approval', ...data });
  });

  instanceManager.on('instance:autoApprove', (data) => {
    broadcastToDashboards({ type: 'instance:autoApprove', ...data });
  });

  instanceManager.on('instance:session_info', (data) => {
    broadcastToDashboards({ type: 'instance:session_info', ...data });

    // Start watching the JSONL file for this instance
    if (data.transcriptPath && !activeWatchers.has(data.id)) {
      const watcher = new JsonlWatcher(data.transcriptPath);
      activeWatchers.set(data.id, watcher);

      watcher.on('message', (msg) => {
        instanceManager.addMessage(data.id, msg);
      });

      watcher.on('message_update', (update) => {
        broadcastToDashboards({
          type: 'instance:message_update',
          id: data.id,
          ...update,
        });
      });

      watcher.on('error', () => {});

      // Skip to end — phone loads history via API when opening the instance
      watcher.start({ catchUp: false });
    }
  });

  wss.on('connection', (ws, req) => {
    const authState = typeof getAuthState === 'function' ? getAuthState() : getAuthState;
    if (!validateWsAuth(authState, req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const params = url.parse(req.url, true).query;
    const role = params.role; // 'dashboard' or 'agent'
    const instanceId = params.instanceId;

    if (role === 'dashboard') {
      // Mobile/browser dashboard client
      dashboardClients.add(ws);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          handleDashboardMessage(msg, instanceManager);
        } catch (e) {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        dashboardClients.delete(ws);
      });

      // Send current state snapshot
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          instances: instanceManager.getAll(),
        })
      );
    } else if (role === 'agent' && instanceId) {
      // Agent running alongside a Claude Code instance
      instanceManager.setAgentSocket(instanceId, ws);
      instanceManager.updateStatus(instanceId, 'idle');

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          handleAgentMessage(instanceId, msg, instanceManager, activeWatchers);
        } catch (e) {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        instanceManager.updateStatus(instanceId, 'disconnected');
        instanceManager.setAgentSocket(instanceId, null);
      });
    } else {
      ws.close(4000, 'Missing role or instanceId parameter');
    }
  });

  return wss;
}

function handleDashboardMessage(msg, instanceManager) {
  switch (msg.type) {
    case 'send_prompt': {
      // Send a user prompt to a specific Claude Code instance
      const { instanceId, text, attachments } = msg;
      instanceManager.sendToAgent(instanceId, {
        type: 'prompt',
        text,
        attachments: attachments || [],
      });
      instanceManager.addMessage(instanceId, {
        role: 'user',
        content: text,
        source: 'mobile',
        attachments: attachments || [],
      });
      break;
    }
    case 'approve': {
      // Approve a pending tool/action
      const { instanceId } = msg;
      instanceManager.sendToAgent(instanceId, { type: 'approve' });
      instanceManager.clearPendingApproval(instanceId);
      break;
    }
    case 'reject': {
      const { instanceId } = msg;
      instanceManager.sendToAgent(instanceId, { type: 'reject' });
      instanceManager.clearPendingApproval(instanceId);
      break;
    }
    case 'abort': {
      const { instanceId } = msg;
      instanceManager.sendToAgent(instanceId, { type: 'abort' });
      instanceManager.updateStatus(instanceId, 'idle');
      break;
    }
    case 'pause': {
      const { instanceId } = msg;
      instanceManager.sendToAgent(instanceId, { type: 'pause' });
      instanceManager.updateStatus(instanceId, 'paused');
      break;
    }
    case 'resume': {
      const { instanceId } = msg;
      instanceManager.sendToAgent(instanceId, { type: 'resume' });
      instanceManager.updateStatus(instanceId, 'busy');
      break;
    }
  }
}

function handleAgentMessage(instanceId, msg, instanceManager, activeWatchers) {
  switch (msg.type) {
    case 'status':
      instanceManager.updateStatus(instanceId, msg.status);
      break;
    case 'message':
      instanceManager.addMessage(instanceId, msg.message);
      break;
    case 'approval_request':
      instanceManager.setPendingApproval(instanceId, {
        tool: msg.tool,
        description: msg.description,
        command: msg.command,
      });
      break;
    case 'session_info':
      instanceManager.setSessionInfo(instanceId, msg.sessionId, msg.transcriptPath);
      break;
    case 'output':
      // If JSONL watcher is active, skip hook-based output (JSONL provides full content)
      if (!activeWatchers.has(instanceId)) {
        instanceManager.addMessage(instanceId, {
          role: 'assistant',
          content: msg.content,
          contentType: msg.contentType || 'text',
        });
      }
      break;
  }
}

module.exports = { setupWebSocket };
