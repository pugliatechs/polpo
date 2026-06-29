const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { scanSessions, loadHistory } = require('./sessions');
const { createAgent } = require('../agent/agent-factory');
const {
  UPLOAD_DIR,
  DASHBOARD_MAX_UPLOAD_SIZE,
  SAFE_INLINE_IMAGE_EXTS,
} = require('./upload-constants');
const convSearch = require('./conversation-search');
const { analyzeProfile } = require('./profile-analyzer');
const { makeLogger } = require('../util/logger');
const { isLocalhost, buildTotpUri } = require('./auth');
const qrcode = require('qrcode');

const log = makeLogger('api');
const skillsLog = makeLogger('api:skills');

const MAX_UPLOAD_SIZE = DASHBOARD_MAX_UPLOAD_SIZE; // back-compat local alias
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

// Re-exported from a tiny helper module so other server modules can
// depend on it without importing the heavyweight router. The behaviour
// is unchanged — see src/server/normalize-timestamp.js.
const { normalizeTimestamp } = require('./normalize-timestamp');

function createApiRouter(instanceManager, getAuthState, pushManager, outboxManager, getTunnelInfo) {
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
    // Prevent stored XSS: only serve images inline, force-download everything else.
    // The inline-safe whitelist is shared with the gateway via upload-constants.js
    // so adding a format (e.g. .avif) updates both surfaces at once.
    const ext = path.extname(filePath).toLowerCase();
    if (!SAFE_INLINE_IMAGE_EXTS.includes(ext)) {
      res.set('Content-Disposition', 'attachment');
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  });

  // ---- Mobile setup QR codes (localhost-only, trust-localhost-gated) ----
  //
  // When an operator runs polpo with `--trust-localhost`, they're saying
  // "the local machine is trusted; let me open the dashboard at
  // http://localhost:7890 without auth." Combined with `--auth paranoid`
  // (TOTP) and/or a tunnel, the dashboard ends up being the only place
  // where the two QR codes the user needs to scan from their phone
  // (authenticator app + phone-browser tunnel URL) can be re-rendered
  // on demand. Otherwise the user only sees them once at startup and
  // loses them when terminal scrollback (e.g. `screen`) eats the output.
  //
  // The endpoint returns 200 with `{available, qrs: []}` always; the
  // dashboard renders the panel only when qrs is non-empty.
  //
  // Why gated by trust-localhost AND localhost-only request:
  //   - The QR for the tunnel contains the dashboard token in the URL.
  //     Anyone who reads this response holds the same secret as anyone
  //     watching the terminal — i.e. the operator themselves.
  //   - Restricting to trust-localhost ensures the operator has
  //     explicitly opted into "this machine is trusted" before we
  //     surface the QR.
  //   - Restricting to localhost-only requests prevents a remote
  //     caller with the token from also receiving the QR (a small
  //     defence-in-depth measure).
  router.get('/qr-codes', async (req, res) => {
    const authState = typeof getAuthState === 'function' ? getAuthState() : null;
    const localhostOk = isLocalhost(req);
    const trustOk = !!(authState && authState.trustLocalhost);
    if (!localhostOk || !trustOk) {
      return res.json({ available: false, qrs: [] });
    }

    const qrs = [];

    // TOTP / authenticator QR (paranoid mode only)
    if (authState.totpSecret && authState.mfaEnabled) {
      const uri = buildTotpUri(authState.totpSecret, 'Polpo');
      try {
        const svg = await qrcode.toString(uri, { type: 'svg', margin: 1, width: 240 });
        qrs.push({
          kind: 'totp',
          label: 'Authenticator',
          hint: 'Scan with Google Authenticator, Authy, or similar.',
          svg: svg,
        });
      } catch (err) {
        log.error('TOTP QR render failed:', err && err.message);
      }
    }

    // Tunnel QR (any tunnel provider, when active). The URL carries the
    // dashboard token in a query string so the phone browser auto-auths.
    const tunnelInfo = typeof getTunnelInfo === 'function' ? getTunnelInfo() : null;
    if (tunnelInfo && tunnelInfo.url) {
      const token = authState.token || null;
      const url = token ? `${tunnelInfo.url}?token=${encodeURIComponent(token)}` : tunnelInfo.url;
      try {
        const svg = await qrcode.toString(url, { type: 'svg', margin: 1, width: 240 });
        qrs.push({
          kind: 'tunnel',
          label: 'Tunnel',
          hint: 'Open this on your phone to use polpo remotely.',
          provider: tunnelInfo.provider || null,
          svg: svg,
          url: url, // localhost-only response — safe to include for "tap to copy"
        });
      } catch (err) {
        log.error('Tunnel QR render failed:', err && err.message);
      }
    }

    res.json({ available: qrs.length > 0, qrs: qrs });
  });

  // List discovered Claude Code sessions
  // Sessions catalogue with pagination + a short-lived in-memory cache.
  //
  // scanSessions walks every transcript file under the agent root dirs
  // (~/.claude, ~/.codex, ...) — cost is roughly linear in total
  // session count, regardless of the `limit` param. To make
  // infinite-scroll in the dashboard cheap, the full scan is cached
  // for SESSIONS_CACHE_TTL_MS (30s by default) per
  // (days, source) tuple, and the route serves slices from the cached
  // ordered list using offset+limit.
  //
  // The response shape grows backwards-compatibly: the body is still
  // an array (legacy clients work unchanged); pagination metadata is
  // returned via response headers so it's invisible to anyone who
  // doesn't ask.
  const SESSIONS_CACHE_TTL_MS = 30 * 1000;
  const sessionsCache = new Map();    // key -> { at, list }

  router.get('/sessions', async (req, res) => {
    try {
      const maxDays = Math.min(parseInt(req.query.days) || 7, 365);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const source = req.query.source || 'all'; // 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'all'

      const cacheKey = maxDays + ':' + source;
      let entry = sessionsCache.get(cacheKey);
      if (!entry || (Date.now() - entry.at) > SESSIONS_CACHE_TTL_MS) {
        // Pull a generous page so the cache covers several scroll-down
        // requests before re-scanning. The scanner internally caps at
        // its own bound, so this isn't unbounded.
        const list = await scanSessions({
          maxAge: maxDays * 24 * 60 * 60 * 1000,
          limit: 1000,
          source,
        });
        entry = { at: Date.now(), list };
        sessionsCache.set(cacheKey, entry);
        // Bound the cache so a fuzzing client can't pin unbounded memory
        if (sessionsCache.size > 50) {
          const oldest = [...sessionsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) sessionsCache.delete(oldest[0]);
        }
      }

      const total = entry.list.length;
      const page = entry.list.slice(offset, offset + limit);
      res.setHeader('X-Total-Count', String(total));
      res.setHeader('X-Offset', String(offset));
      res.setHeader('X-Limit', String(limit));
      res.setHeader('X-Has-More', (offset + page.length < total) ? '1' : '0');
      res.json(page);
    } catch (err) {
      log.error('error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get conversation history for a session from the JSONL file
  // Supports pagination: ?tail=N (last N messages), ?offset=N&limit=N (slice)
  router.get('/sessions/:sessionId/history', async (req, res) => {
    if (!isValidSessionId(req.params.sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    try {
      const history = await loadHistory(req.params.sessionId);
      const total = history.length;
      const tail = parseInt(req.query.tail);
      const offset = parseInt(req.query.offset);
      const limit = parseInt(req.query.limit);

      // Paginated response
      if (tail > 0 || (offset >= 0 && limit > 0)) {
        let slice;
        if (tail > 0) {
          // Return last N messages
          slice = history.slice(Math.max(0, total - tail));
        } else {
          // Return messages from offset, up to limit
          slice = history.slice(offset, offset + limit);
        }
        return res.json({ messages: slice, total, hasMore: slice.length < total });
      }

      // Legacy: return flat array for backward compatibility
      res.json(history);
    } catch (err) {
      log.error('error:', err);
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

    // Don't spawn duplicates — but verify the existing agent is still alive
    if (wrappedAgents.has(sessionId)) {
      const existing = wrappedAgents.get(sessionId);
      const existingInst = instanceManager.get(existing.instanceId);
      const wsAlive = existing.ws && existing.ws.readyState === 1;
      if (existingInst && wsAlive) {
        return res.json({ instanceId: existing.instanceId, alreadyRunning: true });
      }
      if (existing.instanceId) instanceManager.unregister(existing.instanceId);
      wrappedAgents.delete(sessionId);
      if (existing.ws) try { existing.ws.close(); } catch {}
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
      const cleanup = () => {
        wrappedAgents.delete(sessionId);
        instanceManager.unregister(agent.instanceId);
      };
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({ instanceId: agent.instanceId });
    } catch (err) {
      log.error('error:', err);
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
      const cleanup = () => {
        wrappedAgents.delete(agent.instanceId);
        instanceManager.unregister(agent.instanceId);
      };
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({ instanceId: agent.instanceId });
    } catch (err) {
      log.error('error:', err);
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

  // ----- Outbox (agent → phone file transfer) -----
  //
  // When outbox is enabled for an instance, the websocket layer
  // prepends a <polpo:outbox dir=...> directive to every send_prompt,
  // telling the agent where to drop output files. The dashboard then
  // pulls the list and downloads files via these routes. The agent has
  // write access to a per-instance dir; the dashboard side enforces
  // filename safety + prefix-check at every read.
  //
  // These routes share the dashboard's Bearer/session auth middleware
  // applied at /api mount time, so no separate token is required.

  router.post('/instances/:id/outbox/enable', (req, res) => {
    if (!outboxManager) return res.status(503).json({ error: 'outbox_not_available' });
    if (!instanceManager.get(req.params.id)) {
      return res.status(404).json({ error: 'instance_not_found' });
    }
    try {
      outboxManager.enable(req.params.id);
      res.json({ enabled: true });
    } catch (err) {
      log.error('outbox enable failed:', err.message);
      res.status(500).json({ error: 'outbox_enable_failed' });
    }
  });

  router.post('/instances/:id/outbox/disable', (req, res) => {
    if (!outboxManager) return res.status(503).json({ error: 'outbox_not_available' });
    outboxManager.disable(req.params.id);
    res.json({ enabled: false });
  });

  router.get('/instances/:id/outbox', (req, res) => {
    if (!outboxManager) return res.status(503).json({ error: 'outbox_not_available' });
    res.json({
      enabled: outboxManager.isEnabled(req.params.id),
      files: outboxManager.list(req.params.id),
    });
  });

  router.get('/instances/:id/outbox/:name', (req, res) => {
    if (!outboxManager) return res.status(503).json({ error: 'outbox_not_available' });
    let opened;
    try {
      opened = outboxManager.open(req.params.id, req.params.name);
    } catch (err) {
      const code = err.code || 'outbox_failed';
      const status = code === 'outbox_not_enabled' ? 409
        : code === 'invalid_name' ? 400
        : code === 'file_not_found' ? 404
        : 500;
      return res.status(status).json({ error: code });
    }
    // Mirror the gateway's signed-attachment + nosniff defence.
    // Inline-safe images keep their media type so the dashboard can
    // render thumbnails; everything else is force-downloaded.
    if (opened.isInlineSafe) {
      res.setHeader('Content-Type', opened.mediaType);
      res.setHeader('Content-Disposition', 'inline; filename="' + opened.filename + '"');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + opened.filename + '"');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(opened.size));
    opened.stream.pipe(res);
    opened.stream.on('error', (streamErr) => {
      log.error('outbox stream error:', streamErr.message);
      if (!res.headersSent) res.status(500).end();
    });
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

    // Don't spawn duplicates — but verify the existing agent is still alive
    if (wrappedAgents.has(inst.sessionId)) {
      const existing = wrappedAgents.get(inst.sessionId);
      const existingInst = instanceManager.get(existing.instanceId);
      const wsAlive = existing.ws && existing.ws.readyState === 1; // WebSocket.OPEN
      if (existingInst && wsAlive) {
        return res.json({ instanceId: existing.instanceId, alreadyRunning: true });
      }
      // Stale entry — clean up instance and proceed with fresh takeover
      if (existing.instanceId) instanceManager.unregister(existing.instanceId);
      wrappedAgents.delete(inst.sessionId);
      if (existing.ws) try { existing.ws.close(); } catch {}
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

      // Copy session metadata and conversation history to the new takeover instance
      const newInst = instanceManager.get(agent.instanceId);
      if (newInst) {
        newInst.sessionId = inst.sessionId;
        newInst.transcriptPath = inst.transcriptPath;
        if (inst.conversation && inst.conversation.length > 0) {
          newInst.conversation = [...inst.conversation];
        }
      }

      // Remove the old auto-discovered instance (replaced by the takeover)
      instanceManager.unregister(id);

      const cleanup = () => {
        wrappedAgents.delete(inst.sessionId);
        instanceManager.unregister(agent.instanceId);
      };
      if (agent.ws) agent.ws.on('close', cleanup);

      res.json({
        instanceId: agent.instanceId,
        warning: 'Session taken over. You can now send prompts from your phone.',
      });
    } catch (err) {
      log.error('takeover failed:', err);
      res.status(500).json({ error: 'Takeover failed. Check server logs for details.' });
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

  // ---- Git Changes ----

  // Discover all unique git repo roots reachable from cwd:
  // 1. cwd itself (or its parent repo)
  // 2. immediate subdirectories that are separate repos
  function discoverGitRoots(cwd, cb) {
    const roots = new Set();
    let pending = 1; // start with cwd itself

    function tryResolve(dir) {
      execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 3000 }, (err, stdout) => {
        if (!err && stdout.trim()) roots.add(stdout.trim());
        if (--pending === 0) cb([...roots]);
      });
    }

    // Check cwd itself
    tryResolve(cwd);

    // Also scan immediate subdirs for separate repos (VS Code multi-root workspaces)
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
      pending += dirs.length;
      for (const d of dirs) {
        tryResolve(path.join(cwd, d.name));
      }
    } catch (_) {
      // If we can't read subdirs, just rely on cwd
    }
  }

  // Get status + diff for a single git root
  function getRepoChanges(gitRoot, cb) {
    execFile('git', ['status', '--porcelain', '-u'], { cwd: gitRoot, timeout: 5000 }, (err, stdout) => {
      if (err) return cb({ root: gitRoot, files: [], diff: null });

      const files = stdout.trim().split('\n').filter(Boolean).map(line => {
        const status = line.substring(0, 2).trim();
        const filePath = line.substring(3);
        return { status, path: filePath };
      });

      if (files.length === 0) return cb({ root: gitRoot, files: [], diff: null });

      execFile('git', ['diff', 'HEAD', '--no-color', '--stat=120', '-p'], {
        cwd: gitRoot, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
      }, (diffErr, diffOut) => {
        if (diffErr) {
          return execFile('git', ['diff', '--no-color', '--stat=120', '-p'], {
            cwd: gitRoot, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
          }, (diffErr2, diffOut2) => {
            cb({ root: gitRoot, files, diff: diffErr2 ? null : diffOut2 });
          });
        }
        cb({ root: gitRoot, files, diff: diffOut });
      });
    });
  }

  // Get uncommitted changes across all repos in the workspace
  router.get('/instances/:id/changes', (req, res) => {
    const inst = instanceManager.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    if (!inst.cwd) return res.status(400).json({ error: 'No working directory' });

    discoverGitRoots(inst.cwd, (roots) => {
      if (roots.length === 0) {
        return res.json({ repos: [], error: 'No git repositories found' });
      }

      let pending = roots.length;
      const repos = [];
      roots.forEach((root) => {
        getRepoChanges(root, (result) => {
          repos.push(result);
          if (--pending === 0) {
            // Sort: repos with changes first, then alphabetically by root
            repos.sort((a, b) => (b.files.length - a.files.length) || a.root.localeCompare(b.root));
            res.json({ repos });
          }
        });
      });
    });
  });

  // Get diff for a specific file (requires root query param for multi-repo)
  router.get('/instances/:id/changes/:filePath(*)', (req, res) => {
    const inst = instanceManager.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    if (!inst.cwd) return res.status(400).json({ error: 'No working directory' });

    const gitRoot = req.query.root;
    if (!gitRoot || !path.isAbsolute(gitRoot)) {
      return res.status(400).json({ error: 'Missing or invalid root parameter' });
    }

    // Validate gitRoot is within the instance's working directory
    const normalizedRoot = path.resolve(gitRoot);
    const normalizedCwd = path.resolve(inst.cwd);
    if (normalizedRoot !== normalizedCwd && !normalizedRoot.startsWith(normalizedCwd + path.sep)) {
      return res.status(403).json({ error: 'Root outside instance working directory' });
    }

    const filePath = req.params.filePath;
    // Prevent path traversal
    const resolved = path.resolve(gitRoot, filePath);
    if (!resolved.startsWith(gitRoot + path.sep) && resolved !== gitRoot) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    execFile('git', ['diff', 'HEAD', '--no-color', '-p', '--', filePath], {
      cwd: gitRoot, timeout: 5000, maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        return execFile('git', ['diff', '--no-color', '-p', '--', filePath], {
          cwd: gitRoot, timeout: 5000, maxBuffer: 1024 * 1024,
        }, (err2, stdout2) => {
          res.json({ path: filePath, diff: err2 ? null : stdout2 });
        });
      }
      res.json({ path: filePath, diff: stdout });
    });
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
      skillsLog.error('error:', err);
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
        skillsLog.error('search failed:', err.message);
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
        skillsLog.error('install failed:', err.message, stderr);
        return res.status(500).json({ error: 'Install failed. Check server logs for details.' });
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
        skillsLog.error('remove failed:', err.message, stderr);
        return res.status(500).json({ error: 'Remove failed. Check server logs for details.' });
      }
      res.json({ ok: true });
    });
  });

  // (Cost-aggregation /api/costs removed in v1.2.2 — see
  // src/server/cost-tracker.js comment for rationale. Only Claude API
  // ever populated it and the value was misleading for every other
  // agent. Users' existing ~/.config/polpo/costs.jsonl on disk is
  // left intact for archeology; nothing reads it anymore.)

  // ---- Builder Profile ----
  // Paxel-style "how you work with AI agents" report, computed locally
  // from the same transcripts Polpo already reads. Expensive (scans +
  // loads session histories), so guarded against concurrent runs and
  // cached briefly to keep repeated dashboard opens cheap.
  let profileInProgress = false;
  let profileCache = null; // { key, at, data }
  const PROFILE_CACHE_TTL_MS = 60_000;

  router.get('/profile', async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
    const source = ['all', 'claude', 'codex', 'gemini', 'opencode', 'pi', 'goose'].includes(req.query.agent)
      ? req.query.agent : 'all';
    const cacheKey = days + ':' + source;

    if (profileCache && profileCache.key === cacheKey && Date.now() - profileCache.at < PROFILE_CACHE_TTL_MS) {
      return res.json(profileCache.data);
    }
    if (profileInProgress) {
      return res.status(429).json({ error: 'Profile analysis already in progress' });
    }
    profileInProgress = true;
    try {
      const data = await analyzeProfile({ days, source });
      profileCache = { key: cacheKey, at: Date.now(), data };
      res.json(data);
    } catch (err) {
      log.error('/profile failed:', err && err.message);
      res.status(500).json({ error: 'Profile analysis failed' });
    } finally {
      profileInProgress = false;
    }
  });

  // ---- Conversation Search ----
  // Implementation moved to src/server/conversation-search.js so the
  // gateway (/v1/search, /v1/sessions/search) can reuse the same engine.
  // This route preserves its original response shape — UI tests still pass.
  let searchInProgress = false;

  router.get('/search', async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query || query.length > 200) {
      return res.json({ results: [] });
    }
    if (searchInProgress) {
      return res.status(429).json({ error: 'Search already in progress' });
    }
    searchInProgress = true;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const candidatePool = Math.min(Math.max(limit * 3, 60), 300);

    try {
      const out = await convSearch.searchOnDisk(query, { limit: candidatePool });
      searchInProgress = false;
      res.json({ results: out.results.slice(0, limit), partial: out.partial });
    } catch (err) {
      // Don't surface internal error messages — only generic codes.
      log.error('/search failed:', err && err.message);
      searchInProgress = false;
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ---- Push Notifications ----
  router.get('/push/vapid-key', (req, res) => {
    if (!pushManager || !pushManager.available) {
      return res.status(503).json({ error: 'Push notifications not available' });
    }
    res.json({ publicKey: pushManager.vapidPublicKey });
  });

  router.post('/push/subscribe', (req, res) => {
    if (!pushManager || !pushManager.available) {
      return res.status(503).json({ error: 'Push notifications not available' });
    }
    const sub = req.body;
    if (!sub || typeof sub !== 'object' || !sub.endpoint || typeof sub.endpoint !== 'string') {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Missing encryption keys' });
    }
    const added = pushManager.addSubscription(sub);
    if (!added) return res.status(400).json({ error: 'Invalid subscription endpoint' });
    res.json({ ok: true });
  });

  router.post('/push/unsubscribe', (req, res) => {
    if (!pushManager || !pushManager.available) {
      return res.status(503).json({ error: 'Push notifications not available' });
    }
    const { endpoint } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushManager.removeSubscription(endpoint);
    res.json({ ok: true });
  });

  // ---- System Stats ----
  let lastCpuInfo = os.cpus();
  let lastCpuTime = Date.now();

  router.get('/stats', async (req, res) => {
    const cpus = os.cpus();
    const now = Date.now();

    // Calculate CPU usage since last sample
    let totalIdle = 0;
    let totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
      const prev = lastCpuInfo[i] ? lastCpuInfo[i].times : cpus[i].times;
      const curr = cpus[i].times;
      const idle = curr.idle - prev.idle;
      const tick = (curr.user - prev.user) + (curr.nice - prev.nice) +
                   (curr.sys - prev.sys) + (curr.irq - prev.irq) + idle;
      totalIdle += idle;
      totalTick += tick;
    }
    const cpuUsage = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100) : 0;
    lastCpuInfo = cpus;
    lastCpuTime = now;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const proc = process.memoryUsage();

    // Per-instance details. v1.2.2 removed the cost column; the
    // stats modal continues to show project, status, agent, uptime,
    // and message count without a misleading $ figure attached.
    const allInstances = instanceManager.getAll();
    const sessions = allInstances.map(function (inst) {
      return {
        id: inst.id,
        name: inst.firstPrompt ? inst.firstPrompt.slice(0, 60) : inst.name,
        project: inst.project,
        status: inst.status,
        agentType: inst.agentType,
        uptime: Math.round((now - inst.registeredAt) / 1000),
        messages: inst.conversationLength,
      };
    });

    res.json({
      cpu: {
        usage: cpuUsage,
        cores: cpus.length,
        model: cpus[0] ? cpus[0].model : '',
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usage: Math.round((usedMem / totalMem) * 100),
      },
      process: {
        rss: proc.rss,
        heapUsed: proc.heapUsed,
        heapTotal: proc.heapTotal,
        uptime: Math.round(process.uptime()),
      },
      system: {
        platform: os.platform(),
        hostname: os.hostname(),
        uptime: Math.round(os.uptime()),
      },
      sessions: sessions,
    });
  });

  return router;
}

module.exports = { createApiRouter, parseSkillFrontmatter, parseSkillsSearchOutput, normalizeTimestamp };
