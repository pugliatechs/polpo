const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { scanSessions, loadHistory } = require('./sessions');
const { createAgent } = require('../agent/agent-factory');

const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB decoded
const GEMINI_TMP_DIR = path.join(os.homedir(), '.gemini', 'tmp');

/**
 * Resolve a Gemini filename-derived session ID to the real UUID
 * from the JSON file, since `gemini --resume` expects a UUID.
 */
function resolveGeminiSessionId(sessionId, transcriptPath) {
  // If we have the transcript path, read it directly
  if (transcriptPath && transcriptPath.endsWith('.json')) {
    try {
      const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      if (data.sessionId) return data.sessionId;
    } catch {}
  }

  // Search Gemini tmp directories for the session file
  try {
    const slugDirs = fs.readdirSync(GEMINI_TMP_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const slug of slugDirs) {
      const candidate = path.join(GEMINI_TMP_DIR, slug, 'chats', `session-${sessionId}.json`);
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (data.sessionId) return data.sessionId;
      }
    }
  } catch {}

  return sessionId; // fallback to original
}

// Session IDs can be UUIDs, Codex rollout IDs, or Gemini filename-derived IDs
function isValidSessionId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false;
  // Allow UUIDs, Codex rollout IDs (rollout-<uuid>), Gemini filename-derived IDs
  // (2026-02-25T15-00-<hex>), and other alphanumeric session identifiers.
  // Block path traversal and injection characters.
  return /^[a-zA-Z0-9._-]+$/.test(id);
}

function parseSkillFrontmatter(content) {
  const result = { name: '', description: '', tags: [] };
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();
  if (descMatch) result.description = descMatch[1].trim();
  const tagsMatch = fm.match(/^(?:tags|metadata\.tags):\s*(.+)$/m);
  if (tagsMatch) {
    const raw = tagsMatch[1].replace(/^\[|\]$/g, '');
    result.tags = raw.split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean);
  }
  return result;
}

function parseSkillsSearchOutput(stdout) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const results = [];
  const lines = clean.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(\S+\/\S+@\S+)\s+([\d.]+K?)\s+installs?/);
    if (match) {
      const pkg = match[1].trim();
      const installs = match[2].trim();
      let url = '';
      if (i + 1 < lines.length) {
        const urlMatch = lines[i + 1].match(/(https:\/\/skills\.sh\/\S+)/);
        if (urlMatch) url = urlMatch[1];
      }
      const atIdx = pkg.lastIndexOf('@');
      const skillName = atIdx > 0 ? pkg.slice(atIdx + 1) : pkg;
      results.push({ package: pkg, name: skillName, installs, url });
    }
  }
  return results;
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
    // Prevent stored XSS: only serve images inline, force-download everything else
    const ext = path.extname(filePath).toLowerCase();
    const safeImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    if (!safeImageExts.includes(ext)) {
      res.set('Content-Disposition', 'attachment');
    }
    res.sendFile(filePath);
  });

  // List discovered Claude Code sessions
  router.get('/sessions', async (req, res) => {
    try {
      const maxDays = Math.min(parseInt(req.query.days) || 7, 365);
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const source = req.query.source || 'all'; // 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'all'
      const sessions = await scanSessions({
        maxAge: maxDays * 24 * 60 * 60 * 1000,
        limit,
        source,
      });
      res.json(sessions);
    } catch (err) {
      console.error('[api]', err);
      res.status(500).json({ error: 'Internal server error' });
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
      console.error('[api]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Resume a discovered session by spawning a WrappedAgent
  router.post('/sessions/:sessionId/resume', async (req, res) => {
    const { sessionId } = req.params;
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    const { name, cwd, agentType } = req.body;

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
      const resumeId = agentType === 'gemini'
        ? resolveGeminiSessionId(sessionId)
        : sessionId;

      const agent = createAgent(agentType || 'claude', {
        name: name || `Resumed (${sessionId.slice(0, 8)})`,
        cwd: resolvedCwd,
        resumeSessionId: resumeId,
        serverUrl: `ws://127.0.0.1:${req.socket.localPort}`,
        token: authToken,
      });

      await agent.start();
      wrappedAgents.set(sessionId, agent);

      // Set sessionId on the instance immediately so the dashboard can dedup
      instanceManager.setSessionInfo(agent.instanceId, resumeId, null);

      // Clean up when agent disconnects
      const cleanup = () => wrappedAgents.delete(sessionId);
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({ instanceId: agent.instanceId });
    } catch (err) {
      console.error('[api]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a brand-new session (no resume)
  router.post('/sessions/new', async (req, res) => {
    const { agentType, cwd, name, model } = req.body;
    const type = agentType || 'claude';

    const validTypes = ['claude', 'codex', 'gemini', 'opencode', 'pi'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid agentType. Must be one of: ${validTypes.join(', ')}` });
    }

    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return res.status(400).json({ error: 'cwd is required and must be an absolute path' });
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'cwd does not exist' });
    }

    const authState = typeof getAuthState === 'function' ? getAuthState() : null;
    const authToken = authState && authState.enabled ? authState.token : undefined;

    try {
      const agent = createAgent(type, {
        name: name || `Session (${path.basename(cwd)})`,
        cwd,
        model: model || undefined,
        serverUrl: `ws://127.0.0.1:${req.socket.localPort}`,
        token: authToken,
      });

      await agent.start();

      wrappedAgents.set(agent.instanceId, agent);
      const cleanup = () => wrappedAgents.delete(agent.instanceId);
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({ instanceId: agent.instanceId });
    } catch (err) {
      console.error('[api]', err);
      res.status(500).json({ error: 'Internal server error' });
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
      const claudePlansDir = path.join(os.homedir(), '.claude', 'plans');
      if (toolInput && toolInput.planFile) {
        const resolvedPlan = path.resolve(toolInput.planFile);
        if (resolvedPlan.startsWith(claudePlansDir + path.sep)) {
          planFile = resolvedPlan;
          try {
            command = fs.readFileSync(resolvedPlan, 'utf8');
          } catch (e) {
            command = '';
          }
        }
      }
      // ExitPlanMode doesn't include planFile in its input — the plan was
      // written to ~/.claude/plans/ by a preceding Write tool call.
      // Look backwards through this instance's conversation for the Write
      // that targeted ~/.claude/plans/ to find the correct plan file.
      if (!command && toolName === 'ExitPlanMode' && inst) {
        const planPrefix = claudePlansDir + path.sep;
        for (let i = inst.conversation.length - 1; i >= 0; i--) {
          const m = inst.conversation[i];
          if (m.contentType !== 'tool_use') continue;
          try {
            const tool = JSON.parse(m.content);
            if (tool.name === 'Write' && tool.input && tool.input.file_path) {
              const resolved = path.resolve(tool.input.file_path);
              if (resolved.startsWith(planPrefix)) {
                planFile = resolved;
                command = fs.readFileSync(resolved, 'utf8');
                break;
              }
            }
          } catch (e) { continue; }
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
      const resumeId = inst.agentType === 'gemini'
        ? resolveGeminiSessionId(inst.sessionId, inst.transcriptPath)
        : inst.sessionId;

      const agent = createAgent(inst.agentType || 'claude', {
        name: `Takeover (${inst.name})`,
        cwd: inst.cwd,
        resumeSessionId: resumeId,
        serverUrl: `ws://127.0.0.1:${req.socket.localPort}`,
        token: authToken,
      });

      await agent.start();
      wrappedAgents.set(inst.sessionId, agent);

      // Copy conversation history from the old instance to the new takeover instance
      const newInst = instanceManager.get(agent.instanceId);
      if (newInst && inst.conversation && inst.conversation.length > 0) {
        newInst.conversation = [...inst.conversation];
        newInst.sessionId = inst.sessionId;
        newInst.transcriptPath = inst.transcriptPath;
      }

      const cleanup = () => wrappedAgents.delete(inst.sessionId);
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({
        instanceId: agent.instanceId,
        warning: 'Session taken over. You can now send prompts from your phone.',
      });
    } catch (err) {
      console.error('[api]', err);
      res.status(500).json({ error: 'Internal server error' });
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

  // ---- Skills Management ----

  const SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');
  const skillsSearchCache = new Map();
  const SKILLS_CACHE_TTL = 60 * 1000;

  // List installed skills
  router.get('/skills', (req, res) => {
    try {
      if (!fs.existsSync(SKILLS_DIR)) return res.json([]);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      const skills = [];
      for (const entry of entries) {
        const skillMdPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
        const result = { name: entry.name, description: '', tags: [], ruleFiles: 0 };
        try {
          const content = fs.readFileSync(skillMdPath, 'utf8');
          const fm = parseSkillFrontmatter(content);
          if (fm.name) result.name = fm.name;
          result.description = fm.description;
          result.tags = fm.tags;
          const files = fs.readdirSync(path.join(SKILLS_DIR, entry.name));
          result.ruleFiles = files.filter(f => f !== 'SKILL.md').length;
        } catch {}
        skills.push(result);
      }
      res.json(skills);
    } catch (err) {
      console.error('[api:skills]', err);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  // Search skills.sh registry
  router.get('/skills/search', (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query || query.length > 100) {
      return res.status(400).json({ error: 'Invalid query' });
    }
    if (!/^[a-zA-Z0-9\s._-]+$/.test(query)) {
      return res.status(400).json({ error: 'Invalid characters in query' });
    }
    const cached = skillsSearchCache.get(query);
    if (cached && Date.now() - cached.timestamp < SKILLS_CACHE_TTL) {
      return res.json(cached.results);
    }
    execFile('npx', ['skills', 'find', query], {
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: '0' },
    }, (err, stdout) => {
      if (err) {
        console.error('[api:skills:search]', err.message);
        return res.status(500).json({ error: 'Search failed' });
      }
      const results = parseSkillsSearchOutput(stdout);
      skillsSearchCache.set(query, { results, timestamp: Date.now() });
      res.json(results);
    });
  });

  // Install a skill
  router.post('/skills/install', express.json(), (req, res) => {
    const pkg = req.body && req.body.package;
    if (!pkg || typeof pkg !== 'string') {
      return res.status(400).json({ error: 'package is required' });
    }
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+@[a-zA-Z0-9_:.-]+$/.test(pkg)) {
      return res.status(400).json({ error: 'Invalid package identifier' });
    }
    execFile('npx', ['skills', 'add', pkg, '-g', '-y'], {
      timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('[api:skills:install]', err.message);
        return res.status(500).json({ error: 'Install failed: ' + (stderr || err.message) });
      }
      res.json({ ok: true });
    });
  });

  // Get skill content
  router.get('/skills/:name/content', (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }
    const resolved = path.resolve(path.join(SKILLS_DIR, name, 'SKILL.md'));
    if (!resolved.startsWith(SKILLS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }
    try {
      const content = fs.readFileSync(resolved, 'utf8');
      res.json({ content });
    } catch {
      res.status(404).json({ error: 'Skill not found' });
    }
  });

  // Remove a skill
  router.delete('/skills/:name', (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }
    execFile('npx', ['skills', 'remove', name, '-g', '-y'], {
      timeout: 15000,
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('[api:skills:remove]', err.message);
        return res.status(500).json({ error: 'Remove failed: ' + (stderr || err.message) });
      }
      res.json({ ok: true });
    });
  });

  return router;
}

module.exports = { createApiRouter, parseSkillFrontmatter, parseSkillsSearchOutput };
