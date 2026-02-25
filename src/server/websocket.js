const WebSocket = require('ws');
const url = require('url');
const { validateWsAuth } = require('./auth');
const { JsonlWatcher } = require('./jsonl-watcher');
const { CodexJsonlAdapter } = require('./codex-jsonl-adapter');
const { GeminiJsonAdapter } = require('./gemini-json-adapter');
const { SessionScanner } = require('./session-scanner');
const { CodexScanner } = require('./codex-scanner');
const { GeminiScanner } = require('./gemini-scanner');

function setupWebSocket(server, instanceManager, getAuthState) {
  const wss = new WebSocket.Server({ server });

  // Track mobile/browser clients
  const dashboardClients = new Set();

  // Track JSONL file watchers: instanceId -> JsonlWatcher
  const activeWatchers = new Map();

  // Track session-to-instance mapping for auto-discovered sessions
  const sessionToInstance = new Map(); // sessionId -> instanceId

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
        sessionId: instance.sessionId,
        canReceivePrompts: instance.canReceivePrompts,
        firstPrompt: instance.firstPrompt,
        agentType: instance.agentType,
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
    const inst = instanceManager.get(data.id);
    const agentType = inst ? inst.agentType : 'claude';
    startWatcherForInstance(data.id, data.transcriptPath, agentType);
  });

  /**
   * Start a file watcher for an instance (shared by hook-bridge and auto-discovery).
   * Uses CodexJsonlAdapter for Codex, GeminiJsonAdapter for Gemini, JsonlWatcher for Claude.
   */
  function startWatcherForInstance(instanceId, transcriptPath, agentType) {
    if (!transcriptPath || activeWatchers.has(instanceId)) return;

    const watcher = agentType === 'codex'
      ? new CodexJsonlAdapter(transcriptPath)
      : agentType === 'gemini'
        ? new GeminiJsonAdapter(transcriptPath)
        : new JsonlWatcher(transcriptPath);
    activeWatchers.set(instanceId, watcher);

    watcher.on('message', (msg) => {
      instanceManager.addMessage(instanceId, msg);
    });

    watcher.on('message_update', (update) => {
      broadcastToDashboards({
        type: 'instance:message_update',
        id: instanceId,
        ...update,
      });
    });

    watcher.on('status', (status) => {
      instanceManager.updateStatus(instanceId, status);
    });

    watcher.on('error', () => {});

    // Gemini sessions are short-lived (one-shot) — the JSON file may already
    // contain the full conversation by the time the watcher starts.
    // For Claude/Codex, catchUp is false because the phone loads history via
    // the session history API and JSONL files can be very large.
    const shouldCatchUp = agentType === 'gemini';
    watcher.start({ catchUp: shouldCatchUp });
  }

  // --- Auto-discovery: scan for active JSONL sessions ---
  const scanner = new SessionScanner();

  scanner.on('session:discovered', (data) => {
    const { sessionId, transcriptPath, cwd, projectName, firstPrompt } = data;

    // Don't duplicate if a bridge already registered this session
    if (sessionToInstance.has(sessionId)) return;

    const instance = instanceManager.register({
      name: firstPrompt || projectName,
      type: 'vscode',
      project: projectName,
      cwd,
      sessionId,
      transcriptPath,
      firstPrompt: firstPrompt || null,
      canReceivePrompts: false, // auto-discovered, no agent socket
    });

    sessionToInstance.set(sessionId, instance.id);
    instanceManager.updateStatus(instance.id, 'busy');

    // Start watching the JSONL file
    startWatcherForInstance(instance.id, transcriptPath, 'claude');
  });

  scanner.on('session:inactive', (data) => {
    const instanceId = sessionToInstance.get(data.sessionId);
    if (instanceId) {
      instanceManager.updateStatus(instanceId, 'disconnected');
      instanceManager.unregister(instanceId);
      sessionToInstance.delete(data.sessionId);
    }
  });

  scanner.start();

  // --- Codex auto-discovery: scan for active Codex sessions ---
  const codexScanner = new CodexScanner();

  codexScanner.on('session:discovered', (data) => {
    const { sessionId, transcriptPath, cwd, projectName, firstPrompt } = data;

    if (sessionToInstance.has(sessionId)) return;

    const instance = instanceManager.register({
      name: firstPrompt || projectName || 'Codex',
      type: 'terminal',
      project: projectName || 'codex',
      cwd,
      sessionId,
      transcriptPath,
      firstPrompt: firstPrompt || null,
      canReceivePrompts: false,
      agentType: 'codex',
    });

    sessionToInstance.set(sessionId, instance.id);
    instanceManager.updateStatus(instance.id, 'busy');

    startWatcherForInstance(instance.id, transcriptPath, 'codex');
  });

  codexScanner.on('session:inactive', (data) => {
    const instanceId = sessionToInstance.get(data.sessionId);
    if (instanceId) {
      instanceManager.updateStatus(instanceId, 'disconnected');
      instanceManager.unregister(instanceId);
      sessionToInstance.delete(data.sessionId);
    }
  });

  codexScanner.start();

  // --- Gemini auto-discovery: scan for active Gemini sessions ---
  const geminiScanner = new GeminiScanner();

  geminiScanner.on('session:discovered', (data) => {
    const { sessionId, transcriptPath, cwd, projectName, firstPrompt } = data;

    if (sessionToInstance.has(sessionId)) return;

    const instance = instanceManager.register({
      name: firstPrompt || projectName || 'Gemini',
      type: 'terminal',
      project: projectName || 'gemini',
      cwd,
      sessionId,
      transcriptPath,
      firstPrompt: firstPrompt || null,
      canReceivePrompts: false,
      agentType: 'gemini',
    });

    sessionToInstance.set(sessionId, instance.id);
    instanceManager.updateStatus(instance.id, 'busy');

    startWatcherForInstance(instance.id, transcriptPath, 'gemini');
  });

  geminiScanner.on('session:inactive', (data) => {
    const instanceId = sessionToInstance.get(data.sessionId);
    if (instanceId) {
      instanceManager.updateStatus(instanceId, 'disconnected');
      instanceManager.unregister(instanceId);
      sessionToInstance.delete(data.sessionId);
    }
  });

  geminiScanner.start();

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

  // Expose scanners for cleanup
  wss.scanner = scanner;
  wss.codexScanner = codexScanner;
  wss.geminiScanner = geminiScanner;

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
      // If JSONL watcher is active, it provides status via stop_reason detection
      if (!activeWatchers.has(instanceId)) {
        instanceManager.updateStatus(instanceId, msg.status);
      }
      break;
    case 'message':
      // If JSONL watcher is active, skip hook-delivered messages (watcher provides them)
      if (!activeWatchers.has(instanceId)) {
        instanceManager.addMessage(instanceId, msg.message);
      }
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
