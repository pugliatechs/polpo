const express = require('express');
const { scanSessions, loadHistory } = require('./sessions');
const { WrappedAgent } = require('../agent/wrapped');

function createApiRouter(instanceManager) {
  const router = express.Router();

  // Track spawned wrapped agents so we can clean them up
  const wrappedAgents = new Map();

  // Pending permission decisions: instanceId -> { resolve, timeout }
  // Used by the MCP permission server long-poll endpoint.
  const pendingDecisions = new Map();

  // List discovered Claude Code sessions
  router.get('/sessions', async (req, res) => {
    try {
      const maxDays = parseInt(req.query.days) || 7;
      const limit = parseInt(req.query.limit) || 50;
      const sessions = await scanSessions({
        maxAge: maxDays * 24 * 60 * 60 * 1000,
        limit,
      });
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get conversation history for a session from the JSONL file
  router.get('/sessions/:sessionId/history', async (req, res) => {
    try {
      const history = await loadHistory(req.params.sessionId);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resume a discovered session by spawning a WrappedAgent
  router.post('/sessions/:sessionId/resume', async (req, res) => {
    const { sessionId } = req.params;
    const { name, cwd } = req.body;

    // Don't spawn duplicates
    if (wrappedAgents.has(sessionId)) {
      const existing = wrappedAgents.get(sessionId);
      return res.json({ instanceId: existing.instanceId, alreadyRunning: true });
    }

    try {
      const agent = new WrappedAgent({
        name: name || `Resumed (${sessionId.slice(0, 8)})`,
        cwd: cwd || process.cwd(),
        resumeSessionId: sessionId,
        serverUrl: `ws://127.0.0.1:${req.socket.localPort}`,
      });

      await agent.start();
      wrappedAgents.set(sessionId, agent);

      // Clean up when agent disconnects
      const cleanup = () => wrappedAgents.delete(sessionId);
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({ instanceId: agent.instanceId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all instances
  router.get('/instances', (req, res) => {
    res.json(instanceManager.getAll());
  });

  // Get a specific instance
  router.get('/instances/:id', (req, res) => {
    const instance = instanceManager.get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    res.json({
      id: instance.id,
      name: instance.name,
      type: instance.type,
      project: instance.project,
      cwd: instance.cwd,
      status: instance.status,
      lastActivity: instance.lastActivity,
      registeredAt: instance.registeredAt,
      conversationLength: instance.conversation.length,
      pendingApproval: instance.pendingApproval,
    });
  });

  // Get conversation history for an instance
  router.get('/instances/:id/conversation', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const conversation = instanceManager.getConversation(req.params.id, limit);
    res.json(conversation);
  });

  // Register a new instance (used by agent)
  router.post('/instances', (req, res) => {
    const instance = instanceManager.register(req.body);
    res.status(201).json({ id: instance.id, name: instance.name });
  });

  // Unregister an instance
  router.delete('/instances/:id', (req, res) => {
    instanceManager.unregister(req.params.id);
    res.status(204).end();
  });

  // Send a prompt to an instance
  router.post('/instances/:id/prompt', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const sent = instanceManager.sendToAgent(req.params.id, {
      type: 'prompt',
      text,
    });
    if (sent) {
      instanceManager.addMessage(req.params.id, {
        role: 'user',
        content: text,
        source: 'mobile',
      });
      res.json({ ok: true });
    } else {
      res.status(502).json({ error: 'Agent not connected' });
    }
  });

  // Permission request from MCP server (long-poll).
  // Blocks until the phone user approves or rejects, then returns the decision.
  router.post('/permission-request', (req, res) => {
    const { instanceId, toolUseId, toolName, toolInput } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'instanceId required' });

    // Build description for the phone UI
    let description = toolName || 'unknown';
    let command = '';
    if (toolName === 'Bash' || toolName === 'bash') {
      command = (toolInput && toolInput.command) || '';
      description = command
        ? `Run: ${command.length > 120 ? command.slice(0, 120) + '...' : command}`
        : 'Run shell command';
    } else if (toolName === 'Write' || toolName === 'write') {
      description = `Write file: ${(toolInput && toolInput.file_path) || ''}`;
    } else if (toolName === 'Edit' || toolName === 'edit') {
      description = `Edit file: ${(toolInput && toolInput.file_path) || ''}`;
    } else if (toolName === 'WebFetch') {
      description = `Fetch URL: ${(toolInput && toolInput.url) || ''}`;
    } else if (toolName === 'Task') {
      description = `Spawn agent: ${(toolInput && toolInput.description) || ''}`;
    } else if (toolName === 'NotebookEdit') {
      description = `Edit notebook: ${(toolInput && toolInput.notebook_path) || ''}`;
    }

    // Show approval banner on phone
    instanceManager.setPendingApproval(instanceId, { tool: toolName, description, command });

    // Cancel any previous pending decision for this instance
    const existing = pendingDecisions.get(instanceId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.resolve({ behavior: 'allow', updatedInput: toolInput });
    }

    // Wait for phone decision (up to 5 minutes)
    const promise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingDecisions.delete(instanceId);
        instanceManager.clearPendingApproval(instanceId);
        resolve({ behavior: 'deny', message: 'Approval timed out' });
      }, 5 * 60 * 1000);

      pendingDecisions.set(instanceId, { resolve, timeout, toolInput });
    });

    promise.then((decision) => res.json(decision));
  });

  // Approve pending action
  router.post('/instances/:id/approve', (req, res) => {
    const id = req.params.id;
    const pending = pendingDecisions.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingDecisions.delete(id);
      instanceManager.clearPendingApproval(id);
      pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
      res.json({ ok: true });
    } else {
      // Fallback: try sending via WebSocket (hook-based approval)
      const sent = instanceManager.sendToAgent(id, { type: 'approve' });
      if (sent) {
        instanceManager.clearPendingApproval(id);
        res.json({ ok: true });
      } else {
        res.status(502).json({ error: 'No pending approval' });
      }
    }
  });

  // Reject pending action
  router.post('/instances/:id/reject', (req, res) => {
    const id = req.params.id;
    const pending = pendingDecisions.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingDecisions.delete(id);
      instanceManager.clearPendingApproval(id);
      pending.resolve({ behavior: 'deny', message: 'Rejected via Polpo' });
      res.json({ ok: true });
    } else {
      const sent = instanceManager.sendToAgent(id, { type: 'reject' });
      if (sent) {
        instanceManager.clearPendingApproval(id);
        res.json({ ok: true });
      } else {
        res.status(502).json({ error: 'No pending approval' });
      }
    }
  });

  // Abort current task
  router.post('/instances/:id/abort', (req, res) => {
    const sent = instanceManager.sendToAgent(req.params.id, { type: 'abort' });
    if (sent) {
      instanceManager.updateStatus(req.params.id, 'idle');
      res.json({ ok: true });
    } else {
      res.status(502).json({ error: 'Agent not connected' });
    }
  });

  return router;
}

module.exports = { createApiRouter };
