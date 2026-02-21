const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { scanSessions, loadHistory } = require('./sessions');
const { WrappedAgent } = require('../agent/wrapped');

const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB decoded

// Session IDs are UUIDs — reject anything else to prevent path traversal / arg injection
function isValidSessionId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function createApiRouter(instanceManager, getAuthState) {
  const router = express.Router();

  // Track spawned wrapped agents so we can clean them up
  const wrappedAgents = new Map();

  // Pending permission decisions: instanceId -> { resolve, timeout }
  // Used by the MCP permission server long-poll endpoint.
  const pendingDecisions = new Map();

  // Upload a file attachment from the phone
  router.post('/upload', (req, res) => {
    const { filename, mediaType, data } = req.body;
    if (!filename || !data) {
      return res.status(400).json({ error: 'filename and data are required' });
    }

    // Decode base64
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return res.status(413).json({ error: 'File too large (max 10MB)' });
    }

    // Sanitize filename: keep only alphanumeric, dots, hyphens, underscores
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const id = crypto.randomUUID();
    const savedName = `${id}-${safeName}`;

    // Ensure upload dir exists
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const filePath = path.join(UPLOAD_DIR, savedName);
    fs.writeFileSync(filePath, buffer);

    res.json({
      id,
      path: filePath,
      filename: safeName,
      mediaType: mediaType || 'application/octet-stream',
      size: buffer.length,
    });
  });

  // Serve uploaded files for thumbnail previews
  router.get('/uploads/:filename', (req, res) => {
    const filePath = path.resolve(UPLOAD_DIR, req.params.filename);
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.sendFile(filePath);
  });

  // List discovered Claude Code sessions
  router.get('/sessions', async (req, res) => {
    try {
      const maxDays = Math.min(parseInt(req.query.days) || 7, 365);
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
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
    if (!isValidSessionId(req.params.sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
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
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    const { name, cwd } = req.body;

    // Don't spawn duplicates
    if (wrappedAgents.has(sessionId)) {
      const existing = wrappedAgents.get(sessionId);
      return res.json({ instanceId: existing.instanceId, alreadyRunning: true });
    }

    // Validate cwd: must be an absolute path to an existing directory
    let resolvedCwd = process.cwd();
    if (cwd && typeof cwd === 'string' && path.isAbsolute(cwd)) {
      try {
        if (fs.statSync(cwd).isDirectory()) {
          resolvedCwd = cwd;
        }
      } catch {
        // Directory doesn't exist, use default
      }
    }

    // Pass auth token so the spawned agent can register with the hub
    const authState = typeof getAuthState === 'function' ? getAuthState() : null;
    const authToken = authState && authState.enabled ? authState.token : undefined;

    try {
      const agent = new WrappedAgent({
        name: name || `Resumed (${sessionId.slice(0, 8)})`,
        cwd: resolvedCwd,
        resumeSessionId: sessionId,
        serverUrl: `ws://127.0.0.1:${req.socket.localPort}`,
        token: authToken,
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

    // Auto-approve: return immediately without involving the phone
    // Plans and questions are always shown for review, even with auto-approve on
    const isPlan = toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode';
    const isQuestion = toolName === 'AskUserQuestion';
    const inst = instanceManager.get(instanceId);
    if (inst && inst.autoApprove && !isPlan && !isQuestion) {
      return res.json({ behavior: 'allow', updatedInput: toolInput });
    }

    // Build description and metadata for the phone UI
    let description = toolName || 'unknown';
    let command = '';
    let approvalType = 'tool'; // 'tool' | 'plan' | 'question'
    let planFile = null;
    let questions = null;
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
    } else if (isPlan) {
      approvalType = 'plan';
      description = toolName === 'ExitPlanMode' ? 'Plan ready for review' : 'Entering plan mode';
      // Read plan file content if available (restrict to ~/.claude/plans/)
      if (toolInput && toolInput.planFile) {
        const claudePlansDir = path.join(os.homedir(), '.claude', 'plans');
        const resolvedPlan = path.resolve(toolInput.planFile);
        if (resolvedPlan.startsWith(claudePlansDir + path.sep)) {
          planFile = resolvedPlan;
          try {
            const planContent = fs.readFileSync(resolvedPlan, 'utf8');
            command = planContent;
          } catch (e) {
            command = '';
          }
        }
      }
    } else if (isQuestion) {
      approvalType = 'question';
      questions = (toolInput && toolInput.questions) || [];
      description = questions.length === 1
        ? questions[0].question
        : `${questions.length} questions to answer`;
    }

    // Show approval banner on phone
    instanceManager.setPendingApproval(instanceId, {
      tool: toolName, description, command, approvalType, questions, planFile,
    });

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

  // Answer questions (AskUserQuestion)
  router.post('/instances/:id/answer', (req, res) => {
    const id = req.params.id;
    const pending = pendingDecisions.get(id);
    if (!pending) return res.status(502).json({ error: 'No pending question' });

    clearTimeout(pending.timeout);
    pendingDecisions.delete(id);
    instanceManager.clearPendingApproval(id);

    // Merge answers into the tool input
    const updatedInput = { ...pending.toolInput, answers: req.body.answers || {} };
    pending.resolve({ behavior: 'allow', updatedInput });
    res.json({ ok: true });
  });

  // Toggle auto-approve for an instance
  router.post('/instances/:id/auto-approve', (req, res) => {
    const id = req.params.id;
    const inst = instanceManager.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    const value = req.body.value !== undefined ? req.body.value : !inst.autoApprove;
    instanceManager.setAutoApprove(id, value);

    // If enabling and there's a pending decision, approve it now
    // (but not plans or questions - those always need explicit review)
    if (value) {
      const pending = pendingDecisions.get(id);
      if (pending) {
        const approval = inst.pendingApproval;
        const isProtected = approval && (approval.approvalType === 'plan' || approval.approvalType === 'question');
        if (!isProtected) {
          clearTimeout(pending.timeout);
          pendingDecisions.delete(id);
          instanceManager.clearPendingApproval(id);
          pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
        }
      }
    }

    res.json({ ok: true, autoApprove: !!value });
  });

  // Take over a hook bridge instance (spawn WrappedAgent to enable prompts)
  router.post('/instances/:id/takeover', async (req, res) => {
    const id = req.params.id;
    const inst = instanceManager.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    if (!inst.sessionId) return res.status(400).json({ error: 'Instance has no sessionId' });

    // Don't spawn duplicates
    if (wrappedAgents.has(inst.sessionId)) {
      const existing = wrappedAgents.get(inst.sessionId);
      return res.json({ instanceId: existing.instanceId, alreadyRunning: true });
    }

    const authState = typeof getAuthState === 'function' ? getAuthState() : null;
    const authToken = authState && authState.enabled ? authState.token : undefined;

    try {
      const agent = new WrappedAgent({
        name: `Takeover (${inst.name})`,
        cwd: inst.cwd,
        resumeSessionId: inst.sessionId,
        serverUrl: `ws://127.0.0.1:${req.socket.localPort}`,
        token: authToken,
      });

      await agent.start();
      wrappedAgents.set(inst.sessionId, agent);

      const cleanup = () => wrappedAgents.delete(inst.sessionId);
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({
        instanceId: agent.instanceId,
        warning: 'A second Claude process is now running. When done, return to terminal and run: claude --continue',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
