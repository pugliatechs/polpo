const express = require('express');
const { scanSessions, loadHistory } = require('./sessions');
const { WrappedAgent } = require('../agent/wrapped');

function createApiRouter(instanceManager) {
  const router = express.Router();

  // Track spawned wrapped agents so we can clean them up
  const wrappedAgents = new Map();

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

  // Approve pending action
  router.post('/instances/:id/approve', (req, res) => {
    const sent = instanceManager.sendToAgent(req.params.id, { type: 'approve' });
    if (sent) {
      instanceManager.clearPendingApproval(req.params.id);
      res.json({ ok: true });
    } else {
      res.status(502).json({ error: 'Agent not connected' });
    }
  });

  // Reject pending action
  router.post('/instances/:id/reject', (req, res) => {
    const sent = instanceManager.sendToAgent(req.params.id, { type: 'reject' });
    if (sent) {
      instanceManager.clearPendingApproval(req.params.id);
      res.json({ ok: true });
    } else {
      res.status(502).json({ error: 'Agent not connected' });
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
