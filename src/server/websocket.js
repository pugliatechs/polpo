const WebSocket = require('ws');
const url = require('url');
const { validateWsAuth } = require('./auth');
const { JsonlWatcher } = require('./jsonl-watcher');
const { CodexJsonlAdapter } = require('./codex-jsonl-adapter');
const { GeminiJsonAdapter } = require('./gemini-json-adapter');
const { SessionScanner } = require('./session-scanner');
const { CodexScanner } = require('./codex-scanner');
const { GeminiScanner } = require('./gemini-scanner');
const { OpencodeScanner } = require('./opencode-scanner');
const { PiScanner } = require('./pi-scanner');
const { PiJsonlAdapter } = require('./pi-jsonl-adapter');
const { GooseScanner } = require('./goose-scanner');
const { CostTracker } = require('./cost-tracker');

function setupWebSocket(server, instanceManager, getAuthState, pushManager, outboxManager) {
  const wss = new WebSocket.Server({ server });

  // Track mobile/browser clients
  const dashboardClients = new Set();

  // Track JSONL file watchers: instanceId -> JsonlWatcher
  const activeWatchers = new Map();

  // Track session-to-instance mapping for auto-discovered sessions
  const sessionToInstance = new Map(); // sessionId -> instanceId

  // Cost tracking
  const costTracker = new CostTracker();

  // ---- Heartbeat: ping dashboard clients every 30s ----
  const HEARTBEAT_INTERVAL = 30000;
  const heartbeatTimer = setInterval(function () {
    for (const client of dashboardClients) {
      if (client._isAlive === false) {
        dashboardClients.delete(client);
        client.terminate();
        continue;
      }
      client._isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL);
  wss.on('close', function () { clearInterval(heartbeatTimer); });

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
        // Origin tag ('gateway:<client>', 'mind:<goalId-tail>', or null).
        // Required so the dashboard's sidebar grouping can identify
        // arms registered AFTER the dashboard connected (the snapshot
        // path already carries source via instanceManager.getAll()).
        source: instance.source,
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
    // Push notification on task completion
    if (pushManager && data.status === 'idle') {
      const inst = instanceManager.get(data.id);
      const name = inst ? (inst.name || 'Agent') : 'Agent';
      pushManager.sendToAll('Task Complete', name + ' finished.', 'done-' + data.id);
    }
    // Outbox: when an instance with outbox enabled goes idle, diff
    // the dir against the previous snapshot and broadcast any newly-
    // produced files so the dashboard can render download chips on
    // the most recent assistant message.
    if (outboxManager && data.status === 'idle' && outboxManager.isEnabled(data.id)) {
      const added = outboxManager.diffSinceLastIdle(data.id);
      if (added.length > 0) {
        broadcastToDashboards({
          type: 'outbox_update',
          instanceId: data.id,
          newFiles: added,
          files: outboxManager.list(data.id),
        });
      }
    }
  });

  instanceManager.on('instance:message', (data) => {
    broadcastToDashboards({ type: 'instance:message', ...data });

    // Persist cost data from turn_complete messages
    if (data.message && data.message.contentType === 'turn_complete') {
      try {
        const info = typeof data.message.content === 'string'
          ? JSON.parse(data.message.content) : data.message.content;
        if (info.cost_usd && info.cost_usd > 0) {
          const inst = instanceManager.get(data.id);
          costTracker.record({
            cost: info.cost_usd,
            model: info.model || null,
            instance: data.id,
            project: inst ? inst.project : null,
          });
          broadcastToDashboards({
            type: 'instance:cost',
            id: data.id,
            cost: info.cost_usd,
          });
        }
      } catch {
        // ignore parse errors
      }
    }
  });

  instanceManager.on('instance:approval', (data) => {
    broadcastToDashboards({ type: 'instance:approval', ...data });
    // Push notification for approval requests
    if (pushManager && data.approval) {
      const inst = instanceManager.get(data.id);
      const name = inst ? (inst.name || 'Agent') : 'Agent';
      const tool = data.approval.tool || 'action';
      pushManager.sendToAll('Approval Required', name + ' needs approval for ' + tool, 'approval-' + data.id);
    }
  });

  instanceManager.on('instance:autoApprove', (data) => {
    broadcastToDashboards({ type: 'instance:autoApprove', ...data });
  });

  instanceManager.on('instance:session_info', (data) => {
    broadcastToDashboards({ type: 'instance:session_info', ...data });

    // If the scanner already registered a duplicate for this sessionId
    // (race: scanner discovered the JSONL before agent's session_info arrived),
    // unregister the scanner's instance and replace it with the agent-owned one.
    if (data.sessionId && sessionToInstance.has(data.sessionId)) {
      const prevId = sessionToInstance.get(data.sessionId);
      if (prevId && prevId !== data.id) {
        instanceManager.unregister(prevId);
      }
    }

    // Record in sessionToInstance so the auto-discovery scanner
    // won't register a duplicate instance for the same session
    if (data.sessionId) {
      sessionToInstance.set(data.sessionId, data.id);
    }

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
    // OpenCode has no transcript file — data comes from SQLite or the spawned process
    if (!transcriptPath || activeWatchers.has(instanceId) || agentType === 'opencode') return;

    const watcher = agentType === 'codex'
      ? new CodexJsonlAdapter(transcriptPath)
      : agentType === 'gemini'
        ? new GeminiJsonAdapter(transcriptPath)
        : agentType === 'pi'
          ? new PiJsonlAdapter(transcriptPath)
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

  // --- OpenCode auto-discovery: poll SQLite for active sessions ---
  const opencodeScanner = new OpencodeScanner();

  opencodeScanner.on('session:discovered', (data) => {
    const { sessionId, cwd, projectName, firstPrompt } = data;

    if (sessionToInstance.has(sessionId)) return;

    const instance = instanceManager.register({
      name: firstPrompt || projectName || 'OpenCode',
      type: 'terminal',
      project: projectName || 'opencode',
      cwd,
      sessionId,
      transcriptPath: null,
      firstPrompt: firstPrompt || null,
      canReceivePrompts: false,
      agentType: 'opencode',
    });

    sessionToInstance.set(sessionId, instance.id);
    instanceManager.updateStatus(instance.id, 'busy');
    // No file watcher — OpenCode sessions are in SQLite, not transcript files
  });

  opencodeScanner.on('session:inactive', (data) => {
    const instanceId = sessionToInstance.get(data.sessionId);
    if (instanceId) {
      instanceManager.updateStatus(instanceId, 'disconnected');
      instanceManager.unregister(instanceId);
      sessionToInstance.delete(data.sessionId);
    }
  });

  opencodeScanner.start();

  // --- Pi auto-discovery: scan for active Pi sessions ---
  const piScanner = new PiScanner();

  piScanner.on('session:discovered', (data) => {
    const { sessionId, transcriptPath, cwd, projectName, firstPrompt } = data;

    if (sessionToInstance.has(sessionId)) return;

    const instance = instanceManager.register({
      name: firstPrompt || projectName || 'Pi',
      type: 'terminal',
      project: projectName || 'pi',
      cwd,
      sessionId,
      transcriptPath,
      firstPrompt: firstPrompt || null,
      canReceivePrompts: false,
      agentType: 'pi',
    });

    sessionToInstance.set(sessionId, instance.id);
    instanceManager.updateStatus(instance.id, 'busy');

    startWatcherForInstance(instance.id, transcriptPath, 'pi');
  });

  piScanner.on('session:inactive', (data) => {
    const instanceId = sessionToInstance.get(data.sessionId);
    if (instanceId) {
      instanceManager.updateStatus(instanceId, 'disconnected');
      instanceManager.unregister(instanceId);
      sessionToInstance.delete(data.sessionId);
    }
  });

  piScanner.start();

  // --- Goose auto-discovery: poll SQLite for active sessions ---
  const gooseScanner = new GooseScanner();

  gooseScanner.on('session:discovered', (data) => {
    const { sessionId, cwd, projectName, firstPrompt } = data;

    if (sessionToInstance.has(sessionId)) return;

    const instance = instanceManager.register({
      name: firstPrompt || projectName || 'Goose',
      type: 'terminal',
      project: projectName || 'goose',
      cwd,
      sessionId,
      transcriptPath: null, // Goose uses SQLite, not transcript files
      firstPrompt: firstPrompt || null,
      canReceivePrompts: false,
      agentType: 'goose',
    });

    sessionToInstance.set(sessionId, instance.id);
    instanceManager.updateStatus(instance.id, 'busy');
  });

  gooseScanner.on('session:inactive', (data) => {
    const instanceId = sessionToInstance.get(data.sessionId);
    if (instanceId) {
      instanceManager.updateStatus(instanceId, 'disconnected');
      instanceManager.unregister(instanceId);
      sessionToInstance.delete(data.sessionId);
    }
  });

  gooseScanner.start();

  wss.on('connection', (ws, req) => {
    // CSRF protection: validate Origin header for browser connections.
    // Browsers always send Origin on WebSocket upgrades. A malicious page
    // at https://evil.com opening ws://localhost:7890 will have Origin
    // "https://evil.com" which won't match Host "localhost:7890".
    // Non-browser clients (agents) don't send Origin, so they pass through.
    const origin = req.headers['origin'];
    if (origin) {
      const host = req.headers['host'];
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          ws.close(4003, 'Origin not allowed');
          return;
        }
      } catch {
        ws.close(4003, 'Invalid origin');
        return;
      }
    }

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
      ws._isAlive = true;
      ws.on('pong', function () { ws._isAlive = true; });
      dashboardClients.add(ws);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          // Application-level ping/pong for detecting dead connections on mobile
          if (msg.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            return;
          }
          handleDashboardMessage(msg, instanceManager, outboxManager);
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
  wss.opencodeScanner = opencodeScanner;
  wss.piScanner = piScanner;
  wss.gooseScanner = gooseScanner;
  wss.costTracker = costTracker;

  return wss;
}

function handleDashboardMessage(msg, instanceManager, outboxManager) {
  switch (msg.type) {
    case 'send_prompt': {
      // Send a user prompt to a specific Claude Code instance.
      // When the session has outbox enabled, prepend the
      // <polpo:outbox> directive so the agent knows where to drop any
      // files the user should be able to download later. The original
      // user text is what we mirror into the conversation log; the
      // directive is internal plumbing that the dashboard shouldn't show.
      //
      // `clientMsgId`, when present, is a UUID the dashboard generated
      // for its optimistic local render. We round-trip it back through
      // `addMessage` so the dashboard can match the broadcast against
      // its pending bubble and reconcile (vs. rendering a duplicate).
      const { instanceId, text, attachments, clientMsgId } = msg;
      const promptText = outboxManager
        ? outboxManager.injectDirective(instanceId, text)
        : text;
      instanceManager.sendToAgent(instanceId, {
        type: 'prompt',
        text: promptText,
        attachments: attachments || [],
      });
      instanceManager.addMessage(instanceId, {
        role: 'user',
        content: text,
        source: 'mobile',
        attachments: attachments || [],
        clientMsgId: typeof clientMsgId === 'string' ? clientMsgId : undefined,
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
