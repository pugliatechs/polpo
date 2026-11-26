/**
 * Gateway HTTP router — /v1/* routes for programmatic agent execution.
 *
 * Auth: every request must present `Authorization: Bearer <POLPO_GATEWAY_KEY>`.
 * Streaming: GET /v1/tasks/:id/stream returns Server-Sent Events.
 *
 * File-transfer surface (v1.2.0):
 *   POST   /v1/uploads                       caller → host
 *   GET    /v1/tasks/:id/artifacts           list sealed artifacts
 *   GET    /v1/tasks/:id/artifacts/:name     stream a sealed artifact
 *
 * Security defences specific to file routes (see plan for full list):
 *   - per-token rate limiting (60/min) on uploads and artifact GET
 *   - body cap (34 MB) on POST /v1/uploads only — does NOT widen the
 *     limit for other JSON routes
 *   - ownership scoping by sha256(bearer-token) so a future second key
 *     can't read another caller's uploads or artifacts
 *   - download responses always carry
 *       Content-Disposition: attachment
 *       X-Content-Type-Options: nosniff
 *     and use application/octet-stream unless the file is an
 *     inline-safe image in the dashboard whitelist.
 */

const express = require('express');
const {
  createGatewayAuthMiddleware,
  createPerTokenRateLimit,
  extractBearerToken,
  tokenFingerprint,
} = require('./gateway-auth');
const {
  GATEWAY_UPLOAD_BODY_LIMIT,
  isUnsafeFilename,
} = require('./upload-constants');
const convSearch = require('./conversation-search');
const { scanSessions, loadHistory } = require('./sessions');
const { redact, redactDeep } = require('./redact');
const { analyzeProfile } = require('./profile-analyzer');
const { makeLogger } = require('../util/logger');
const { resolveClientLabel, VALID_AGENT_TYPES, checkCwd, checkTitle, checkModel } = require('./gateway-tasks');
const { parseSites } = require('./browser-guard');
const InstanceManager = require('./instances');
const sessionControl = require('./session-control');
const { capTail, goalFinalOutput } = require('../mind/goal-output');
const { campaignErrorStatus } = require('../campaign');
const { checkRelay, DECISION_ID_RE, MAX_ANSWER_TEXT } = require('../campaign/decisions');
const { ID_RE: CAMPAIGN_ID_RE } = require('../campaign/definition');

const log = makeLogger('gateway');

/**
 * @param {object} opts
 * @param {object} opts.taskManager - GatewayTaskManager instance
 * @param {() => string} opts.getKey - returns the current gateway API key
 * @param {object} [opts.uploadStore] - GatewayUploadStore (enables POST /v1/uploads)
 * @param {object} [opts.instanceManager] - InstanceManager (enables /v1/search live walk,
 *   /v1/sessions live merge, /v1/sessions/:id live fallback)
 * @param {object} [opts.campaigns] - CampaignManager (enables /v1/campaigns, /v1/decisions)
 * @param {boolean} [opts.campaignControl] - allow acting on campaigns, not just reading them
 * @param {Set<string>} [opts.allowedPermissionModes] - permission modes a caller may
 *   choose for a session it drives
 * @param {object} [opts.approvals] - shared PendingApprovals
 * @param {boolean} [opts.approvalControl] - let a caller answer, with the user's words,
 *   the approvals of the sessions it drives
 * @param {object} [opts.mind] - Alien Mind handle (enables /v1/goals).
 *   Shape: { coordinator } — coordinator must implement submitGoal,
 *   getActiveGoals, cancelGoal, and emit 'goal:event' for SSE relay.
 * @returns {import('express').Router}
 */
function createGatewayRouter(opts) {
  if (!opts || !opts.taskManager) throw new Error('taskManager is required');
  if (typeof opts.getKey !== 'function') throw new Error('getKey is required');

  const router = express.Router();
  const taskManager = opts.taskManager;
  const uploadStore = opts.uploadStore || null;
  const instanceManager = opts.instanceManager || null;
  // SessionController, present only when POLPO_GATEWAY_SESSION_CONTROL=1.
  const sessionControlCtl = opts.sessionControl || null;
  // Whether a session the gateway takes over keeps the permission mode it
  // had at the desk ('auto', say). Off by default: the caller then gets
  // the same automatic approvals you have at your desk.
  const inheritPermissionMode = opts.inheritPermissionMode === true;
  // The permission modes a caller may choose for a session it drives
  // (POLPO_GATEWAY_ALLOWED_PERMISSION_MODES). Empty: it chooses none.
  const allowedPermissionModes = opts.allowedPermissionModes instanceof Set ? opts.allowedPermissionModes : new Set();
  // Approvals of the sessions a caller drives, which it may relay to you
  // and answer with your words (POLPO_GATEWAY_APPROVALS=1).
  const approvals = opts.approvals || null;
  const approvalControl = opts.approvalControl === true && !!approvals;
  // Browser sessions (POLPO_GATEWAY_BROWSER=1, which also needs session
  // control and approvals): the guard that decides on every browser tool
  // call. Null when the host does not run them.
  const browserGuard = (opts.browserGuard && sessionControlCtl && approvalControl) ? opts.browserGuard : null;

  /**
   * Who is calling, by the same ladder as /v1/tasks: explicit client
   * (X-Polpo-Client header over the body field), then the User-Agent's
   * first token, then a pseudonym of the bearer token.
   */
  function clientLabelFor(req, body) {
    const clientHeader = req.headers['x-polpo-client'];
    const uaHeader = req.headers['user-agent'];
    return resolveClientLabel({
      client: (typeof clientHeader === 'string' && clientHeader.trim())
        ? clientHeader.trim()
        : (body && typeof body.client === 'string' ? body.client : undefined),
      userAgent: typeof uaHeader === 'string' ? uaHeader.slice(0, 200) : null,
      requesterFingerprint: tokenFingerprint(extractBearerToken(req)),
    });
  }
  const mind = opts.mind || null;

  // Default JSON parser used by /tasks, /health, etc.
  const smallJson = express.json({ limit: '256kb' });
  // Larger parser scoped to the upload route only (base64 + JSON
  // overhead ~ 1.37x decoded). Per-route only — never global.
  const uploadJson = express.json({ limit: GATEWAY_UPLOAD_BODY_LIMIT });

  // Per-token rate limiters. Bucket by sha256(bearer-token) so a
  // single shared key today and per-caller keys tomorrow share the
  // same enforcement code.
  const uploadLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 60 });
  const artifactLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 60 });
  // Search is materially more expensive than catalogue lookups, so it
  // gets a tighter cap.
  const searchLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 30 });
  const catalogueLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 60 });
  // Goals fan out across multiple arms; one goal can spawn N agents.
  // Cap aggressively (10/min per token) so a caller can't flood the
  // host with parallel mind invocations.
  const goalLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 10 });
  // Profile analysis scans every session on the host — very expensive.
  // 6/min per token + per-host in-flight lock + 60s cache (below) keep
  // disk pressure bounded even if a caller hammers the endpoint.
  const profileLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 6 });

  // A single in-flight global search lock matching /api/search's
  // existing behaviour. The scan is fs-heavy enough that letting many
  // run concurrently per host is asking for trouble.
  let searchInProgress = false;

  // Profile cache: 60 s TTL, keyed by (days, agent). Mirrors what
  // /api/profile does on the dashboard side. Independent caches are
  // fine because the profile is small (KB-scale JSON) and identical
  // input always produces identical output.
  let profileCache = null;
  let profileInProgress = false;
  const PROFILE_CACHE_TTL_MS = 60_000;

  // Auth applies to ALL routes. Bearer middleware short-circuits with
  // 401 before parsing/rate-limiting if the token is missing/wrong.
  router.use(createGatewayAuthMiddleware(opts.getKey));

  router.get('/health', smallJson, (req, res) => {
    res.json({
      status: 'ok',
      version: require('../../package.json').version,
      activeTasks: taskManager._activeTaskCount(),
      // What a caller driving a session may do, so it can tell the user
      // before it is refused.
      sessionControl: {
        enabled: !!opts.sessionControl,
        permissionModes: [...allowedPermissionModes],
        approvals: approvalControl,
        browser: {
          enabled: !!browserGuard,
          grantMaxMinutes: browserGuard ? browserGuard.grantMaxMinutes : null,
        },
      },
    });
  });

  // POST /v1/uploads — caller pushes a file (JSON body, base64-encoded).
  router.post('/uploads', uploadLimiter, uploadJson, (req, res) => {
    if (!uploadStore) {
      return res.status(503).json({ error: 'uploads_not_supported' });
    }
    const body = req.body || {};
    const { filename, mediaType, dataBase64 } = body;

    // Defence in depth: reject early before touching disk.
    if (typeof filename !== 'string' || isUnsafeFilename(filename)) {
      return res.status(400).json({ error: 'invalid_filename' });
    }
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (mediaType !== undefined && typeof mediaType !== 'string') {
      return res.status(400).json({ error: 'invalid_body' });
    }

    let buffer;
    try {
      // Node's Buffer.from accepts base64 leniently (ignores whitespace,
      // silently drops invalid chars). For our purposes that's
      // acceptable — the store applies the size cap on the decoded bytes.
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'invalid_body' });
    }

    const token = extractBearerToken(req);
    const fp = tokenFingerprint(token);

    try {
      const result = uploadStore.put({
        buffer,
        filename,
        mediaType: mediaType || 'application/octet-stream',
        tokenFingerprint: fp,
      });
      return res.status(201).json(result);
    } catch (err) {
      const code = err.code || 'upload_failed';
      const status = mapErrorStatus(code);
      const out = { error: code };
      if (err.limit !== undefined) out.limit = err.limit;
      if (err.actual !== undefined) out.actual = err.actual;
      return res.status(status).json(out);
    }
  });

  // POST /v1/tasks — supports attachments + captureArtifacts.
  router.post('/tasks', smallJson, async (req, res) => {
    try {
      // Allow X-Polpo-Client to override the body 'client' field
      const clientHeader = req.headers['x-polpo-client'];
      const body = req.body || {};
      if (typeof clientHeader === 'string' && clientHeader.trim()) {
        body.client = clientHeader.trim();
      }
      const token = extractBearerToken(req);
      const fp = tokenFingerprint(token);
      // First token of UA gives a useful fallback label when the caller
      // didn't set X-Polpo-Client (e.g. raw curl/openclaw integrations).
      const uaHeader = req.headers['user-agent'];
      const userAgent = typeof uaHeader === 'string' ? uaHeader.slice(0, 200) : null;
      const { taskId } = await taskManager.createTask(body, {
        tokenFingerprint: fp,
        userAgent,
      });
      res.status(201).json({
        taskId,
        streamUrl: '/v1/tasks/' + taskId + '/stream',
      });
    } catch (err) {
      const code = err.code || 'task_create_failed';
      const status = mapErrorStatus(code);
      const body = { error: code };
      if (err.validTypes) body.validTypes = err.validTypes;
      if (err.limit) body.limit = err.limit;
      if (err.activeCount !== undefined) body.activeCount = err.activeCount;
      if (err.detail) body.detail = err.detail;
      if (err.uploadId) body.uploadId = err.uploadId;
      res.status(status).json(body);
    }
  });

  router.get('/tasks/:id', smallJson, (req, res) => {
    const snap = taskManager.getTask(req.params.id);
    if (!snap) return res.status(404).json({ error: 'task_not_found' });
    res.json(snap);
  });

  router.delete('/tasks/:id', (req, res) => {
    const cancelled = taskManager.cancelTask(req.params.id);
    if (!cancelled) {
      const snap = taskManager.getTask(req.params.id);
      if (!snap) return res.status(404).json({ error: 'task_not_found' });
      return res.status(409).json({ error: 'task_already_terminal', status: snap.status });
    }
    res.status(204).end();
  });

  router.get('/tasks/:id/stream', (req, res) => {
    const taskId = req.params.id;
    const snap = taskManager.getTask(taskId);
    if (!snap) return res.status(404).json({ error: 'task_not_found' });

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const writeEvent = (type, data) => {
      try {
        res.write('event: ' + type + '\n');
        res.write('data: ' + JSON.stringify(data) + '\n\n');
      } catch (err) {
        // Client disconnected; the unsubscribe below will fire from 'close'
      }
    };

    const unsubscribe = taskManager.subscribe(taskId, (event) => {
      writeEvent(event.type, event.data || {});
      if (event.type === 'done' || event.type === 'error') {
        try { res.end(); } catch {}
      }
    });

    // Periodic heartbeat so proxies don't kill the connection
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (typeof unsubscribe === 'function') unsubscribe();
    });
  });

  // GET /v1/tasks/:id/artifacts — list sealed artifacts for a finished task
  router.get('/tasks/:id/artifacts', artifactLimiter, (req, res) => {
    const token = extractBearerToken(req);
    const fp = tokenFingerprint(token);
    try {
      const list = taskManager.listArtifacts(req.params.id, fp);
      res.json({ artifacts: list });
    } catch (err) {
      const code = err.code || 'artifact_list_failed';
      res.status(mapErrorStatus(code)).json({ error: code });
    }
  });

  // GET /v1/tasks/:id/artifacts/:name — stream a sealed artifact
  router.get('/tasks/:id/artifacts/:name', artifactLimiter, (req, res) => {
    const token = extractBearerToken(req);
    const fp = tokenFingerprint(token);
    let opened;
    try {
      opened = taskManager.openArtifact(req.params.id, req.params.name, fp);
    } catch (err) {
      const code = err.code || 'artifact_open_failed';
      return res.status(mapErrorStatus(code)).json({ error: code });
    }

    // Defensive response headers: never let the browser sniff or
    // render the response as HTML. Inline only for images that are
    // explicitly safe (whitelist shared with dashboard).
    res.setHeader('Content-Type', opened.isInlineSafe
      ? opened.mediaType
      : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // RFC 6266 / 5987 — keep ASCII fallback for the disposition.
    // We sanitize filename twice here defensively (regex already ran).
    const safeName = String(opened.filename).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition',
      opened.isInlineSafe
        ? `inline; filename="${safeName}"`
        : `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(opened.size));

    opened.stream.on('error', () => { try { res.destroy(); } catch {} });
    opened.stream.pipe(res);
  });

  // ---- Session discovery (v1.2.1) ----------------------------------
  // Four read-only endpoints that let an external chatbot find which
  // session on which polpo node holds the context for a given topic.
  // The /v1/tasks pathway remains the only execute path.

  // Helpers shared by the routes below
  function parseQuery(req, res) {
    const raw = req.query && req.query.q;
    if (typeof raw !== 'string' || raw.trim().length < convSearch.MIN_QUERY_LENGTH) {
      res.status(400).json({ error: 'invalid_query' });
      return null;
    }
    if (raw.length > convSearch.MAX_QUERY_LENGTH) {
      res.status(400).json({ error: 'invalid_query' });
      return null;
    }
    return raw.trim();
  }

  function clampPositiveInt(raw, def, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(n, max);
  }

  function clampNonNegativeInt(raw, def, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return def;
    return Math.min(n, max);
  }

  const KNOWN_SOURCES = new Set(['claude', 'codex', 'gemini', 'opencode', 'pi', 'goose', 'gateway', 'mind', 'all']);

  // Truncate a free-form string before it goes out on the wire so a
  // single huge firstPrompt can't blow up the response.
  // Redacts secrets first: every string this truncates is session text
  // on its way to the caller (first prompts).
  function truncate(str, max) {
    if (typeof str !== 'string') return null;
    str = redact(str);
    if (str.length <= max) return str;
    return str.slice(0, max - 3) + '...';
  }

  // Whitelist the public fields we serialize from an InstanceManager
  // instance. Drops agentSocket and any future internal fields.
  function serializeLiveInstance(inst) {
    if (!inst) return null;
    return {
      sessionId: inst.sessionId || null,
      instanceId: inst.id,
      project: inst.project || null,
      cwd: inst.cwd || null,
      agentType: inst.agentType || null,
      firstPrompt: truncate(inst.firstPrompt, 200),
      lastActivity: inst.lastActivity || null,
      isLive: true,
      source: inst.source || null,
    };
  }

  // ---- Live instances ----
  //
  // What is running on this machine right now: sessions polpo started,
  // sessions it only watches (VSCode, a terminal), gateway tasks and the
  // mind. Lets an external agent (a PA on Telegram, say) see what the
  // coding agents are doing and follow a session as it progresses.
  // Read-only: driving a session goes through the control endpoints.

  /** A visible live instance by id, or null. Internal ones stay hidden. */
  function findInstance(id) {
    if (!instanceManager || !sessionControl.INSTANCE_ID_RE.test(String(id || ''))) return null;
    const inst = instanceManager.get(id);
    if (!inst || InstanceManager.isInternalInstance(inst)) return null;
    return inst;
  }

  // GET /v1/instances: every live instance, newest activity first.
  router.get('/instances', catalogueLimiter, (req, res) => {
    if (!instanceManager) return res.status(503).json({ error: 'instances_not_supported' });
    const list = (instanceManager.getAll() || [])
      .map((summary) => findInstance(summary.id))
      .filter(Boolean)
      .map(sessionControl.describeInstance)
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    res.json({ instances: list });
  });

  // GET /v1/instances/:id: one live instance.
  router.get('/instances/:id', catalogueLimiter, (req, res) => {
    if (!instanceManager) return res.status(503).json({ error: 'instances_not_supported' });
    if (!sessionControl.INSTANCE_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_instance_id' });
    }
    const inst = findInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance_not_found' });
    res.json(sessionControl.describeInstance(inst));
  });

  // GET /v1/instances/:id/conversation?since=<seq>&limit=<n>: messages
  // newer than `since`. Poll with the returned lastSeq to follow a
  // session; polling also works over Cloudflare quick tunnels, which do
  // not support Server-Sent Events.
  router.get('/instances/:id/conversation', catalogueLimiter, (req, res) => {
    if (!instanceManager) return res.status(503).json({ error: 'instances_not_supported' });
    if (!sessionControl.INSTANCE_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_instance_id' });
    }
    const inst = findInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance_not_found' });
    const since = clampNonNegativeInt(req.query && req.query.since, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampPositiveInt(req.query && req.query.limit, 50, sessionControl.MAX_CONVERSATION_LIMIT);
    res.json(sessionControl.conversationSince(inst, since, limit));
  });

  // ---- Driving live sessions (opt-in) ----
  //
  // Lets an external agent continue a coding session, under the same
  // one-writer rule as the dashboard: a busy session can only be read; an
  // idle one can be taken over and continued; and a session polpo drives
  // is handed back the moment someone picks it up again in VSCode or a
  // terminal. Off unless the host sets POLPO_GATEWAY_SESSION_CONTROL=1,
  // because it reaches into the sessions you are working in.

  const controlLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 30 });
  const MAX_PROMPT_CHARS = 50_000;
  // Instances that are not coding sessions a caller may drive: the mind
  // has its own chat, its arms and gateway tasks their own lifecycles.
  const NOT_DRIVABLE = new Set(['mind', 'mind-arm', 'gateway']);

  function controlStatus(code) {
    switch (code) {
      case 'instance_not_found': return 404;
      case 'session_busy':
      case 'takeover_required':
      case 'session_resumed_elsewhere': return 409;
      case 'no_session':
      case 'invalid_permission_mode':
      case 'permission_mode_unsupported':
      case 'browser_unsupported':
      case 'browser_auto_mode': return 400;
      case 'browser_not_enabled': return 403;
      case 'agent_not_connected': return 502;
      default: return 500;
    }
  }

  function sendControlFailure(res, out) {
    const body = { error: out.error, message: out.message };
    if (out.status) body.status = out.status;
    if (out.writer) body.writer = out.writer;
    return res.status(controlStatus(out.error)).json(body);
  }

  /**
   * The permission mode a caller asked for, checked against what the host
   * allows. undefined when it asked for none; null after responding.
   */
  function requestedPermissionMode(res, body) {
    if (body.permissionMode === undefined) return undefined;
    if (!allowedPermissionModes.size) {
      res.status(403).json({
        error: 'permission_mode_not_enabled',
        message: 'This host does not let gateway callers choose a permission mode.',
      });
      return null;
    }
    if (typeof body.permissionMode !== 'string' || !allowedPermissionModes.has(body.permissionMode)) {
      res.status(400).json({
        error: 'permission_mode_not_allowed',
        message: 'permissionMode must be one of the modes this host allows.',
        allowed: [...allowedPermissionModes],
      });
      return null;
    }
    return body.permissionMode;
  }

  /**
   * AskUserQuestion answers: question text to the chosen answer. A copy
   * with only plain string pairs, or null when malformed.
   */
  function checkAnswers(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (!keys.length || keys.length > 20) return null;
    const out = {};
    for (const k of keys) {
      const v = raw[k];
      // Merged into the tool's input: no key that could reach a prototype.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return null;
      if (k.length > 1000 || typeof v !== 'string' || v.length > MAX_ANSWER_TEXT) return null;
      out[k] = v;
    }
    return out;
  }

  function capChars(text, max) {
    const t = String(text == null ? '' : text);
    return t.length > max ? t.slice(0, max - 3) + '...' : t;
  }

  /** Whether a gateway caller drives this session (not you, not a campaign). */
  function heldByGateway(inst) {
    return typeof inst.heldBy === 'string' && inst.heldBy.indexOf('gateway:') === 0 && inst.canReceivePrompts !== false;
  }

  /** Common checks; returns the instance, or null after responding. */
  function drivableInstance(req, res) {
    if (!sessionControlCtl) {
      res.status(503).json({ error: 'session_control_not_enabled' });
      return null;
    }
    if (!sessionControl.INSTANCE_ID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'invalid_instance_id' });
      return null;
    }
    const inst = findInstance(req.params.id);
    if (!inst) {
      res.status(404).json({ error: 'instance_not_found' });
      return null;
    }
    if (NOT_DRIVABLE.has(sessionControl.originOf(inst))) {
      res.status(400).json({ error: 'not_a_coding_session', origin: sessionControl.originOf(inst) });
      return null;
    }
    return inst;
  }

  // POST /v1/instances/:id/takeover: start driving an idle session.
  // { permissionMode? }: one of the modes the host allows; without it the
  // session runs as POLPO_GATEWAY_INHERIT_PERMISSION_MODE says.
  router.post('/instances/:id/takeover', controlLimiter, smallJson, async (req, res) => {
    const inst = drivableInstance(req, res);
    if (!inst) return;
    const permissionMode = requestedPermissionMode(res, req.body || {});
    if (permissionMode === null) return;
    try {
      const out = await sessionControlCtl.takeover(inst.id, {
        heldBy: 'gateway:' + clientLabelFor(req, req.body),
        inheritPermissionMode,
        permissionMode,
        serverUrl: 'ws://127.0.0.1:' + req.socket.localPort,
      });
      if (!out.ok) return sendControlFailure(res, out);
      const after = findInstance(out.instanceId);
      res.json({ instanceId: out.instanceId, instance: after ? sessionControl.describeInstance(after) : null });
    } catch (err) {
      log.error('/v1/instances/:id/takeover failed:', err && err.message);
      res.status(500).json({ error: 'takeover_failed' });
    }
  });

  // POST /v1/instances: start a new session the caller drives, held by it
  // from the start, under the same rules as a takeover.
  // { agentType?, cwd, prompt?, model?, permissionMode?, title?, browser? }
  // browser: { sites: ["portal.example.it", "*.example.it"] } runs it with
  // Claude in Chrome under polpo's browser guard (POLPO_GATEWAY_BROWSER=1).
  router.post('/instances', controlLimiter, smallJson, async (req, res) => {
    if (!sessionControlCtl) return res.status(503).json({ error: 'session_control_not_enabled' });
    const body = req.body || {};
    const agentType = body.agentType === undefined ? 'claude' : body.agentType;
    if (typeof agentType !== 'string' || !VALID_AGENT_TYPES.has(agentType)) {
      return res.status(400).json({ error: 'invalid_agentType', validTypes: [...VALID_AGENT_TYPES] });
    }
    let cwd;
    try {
      cwd = checkCwd(body.cwd);
      checkTitle(body.title);
      checkModel(body.model);
    } catch (err) {
      const out = { error: err.code || 'invalid_body' };
      if (err.limit) out.limit = err.limit;
      return res.status(mapErrorStatus(err.code)).json(out);
    }
    let prompt = null;
    if (body.prompt !== undefined && body.prompt !== null) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_CHARS) {
        return res.status(400).json({ error: 'invalid_prompt' });
      }
      prompt = body.prompt;
    }
    const permissionMode = requestedPermissionMode(res, body);
    if (permissionMode === null) return;
    let browser;
    if (body.browser !== undefined) {
      if (!browserGuard) {
        return res.status(403).json({
          error: 'browser_not_enabled',
          message: 'This host does not run browser sessions (POLPO_GATEWAY_BROWSER=1, with session control and approvals).',
        });
      }
      const b = body.browser;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'sites')) {
        return res.status(400).json({ error: 'invalid_browser', message: 'browser is { sites: [host names] }.' });
      }
      const parsed = parseSites(b.sites);
      if (!parsed.ok) return res.status(400).json({ error: 'invalid_browser_sites', message: parsed.message });
      browser = { sites: parsed.sites };
    }
    const label = clientLabelFor(req, body);
    try {
      const out = await sessionControlCtl.start({
        agentType,
        cwd,
        model: body.model || undefined,
        name: body.title ? body.title.trim() : undefined,
        heldBy: 'gateway:' + label,
        permissionMode,
        browser,
        serverUrl: 'ws://127.0.0.1:' + req.socket.localPort,
      });
      if (!out.ok) return sendControlFailure(res, out);
      if (body.title && instanceManager && typeof instanceManager.setTitle === 'function') {
        instanceManager.setTitle(out.instanceId, body.title.trim());
      }
      if (browser) log.info(`Browser session ${out.instanceId} started for gateway:${label} on ${browser.sites.join(', ')}`);
      let queued = null;
      if (prompt) {
        const sent = sessionControlCtl.sendPrompt(out.instanceId, prompt, { source: 'gateway:' + label, requireDelivery: true });
        if (!sent.ok) {
          return res.status(502).json({ error: sent.error, message: sent.message, instanceId: out.instanceId });
        }
        queued = sent.queued;
      }
      const after = findInstance(out.instanceId);
      res.status(201).json({
        instanceId: out.instanceId,
        queued,
        instance: after ? sessionControl.describeInstance(after) : null,
      });
    } catch (err) {
      log.error('POST /v1/instances failed:', err && err.message);
      res.status(500).json({ error: 'start_failed' });
    }
  });

  // GET /v1/instances/:id/approval/screenshot: the screenshot attached to
  // the browser plan the session waits on (approvalType 'browser_plan').
  // Only that one: nothing else on the machine is reachable here.
  router.get('/instances/:id/approval/screenshot', controlLimiter, (req, res) => {
    if (!approvalControl) return res.status(403).json({ error: 'approval_control_not_enabled' });
    const inst = drivableInstance(req, res);
    if (!inst) return;
    if (!heldByGateway(inst)) return res.status(409).json({ error: 'not_held_by_gateway' });
    const plan = browserGuard ? browserGuard.pendingPlan(inst.id) : null;
    const pending = approvals.current(inst.id);
    if (!plan || !pending || pending.toolUseId !== plan.toolUseId) {
      return res.status(404).json({ error: 'no_pending_screenshot' });
    }
    res.set('Content-Type', plan.mime);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
    res.send(plan.buffer);
  });

  // POST /v1/instances/:id/prompt { text }: send a prompt into a session
  // polpo drives. Follow the reply with GET /conversation?since=.
  router.post('/instances/:id/prompt', controlLimiter, smallJson, (req, res) => {
    const inst = drivableInstance(req, res);
    if (!inst) return;
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim() || text.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: 'invalid_text' });
    }
    if (inst.canReceivePrompts === false) {
      return res.status(409).json({
        error: 'takeover_required',
        message: 'polpo is only watching this session. Take it over first, once it is idle.',
        status: inst.status || null,
      });
    }
    const out = sessionControlCtl.sendPrompt(inst.id, text, {
      source: 'gateway:' + clientLabelFor(req, body),
      requireDelivery: true,
    });
    if (!out.ok) return sendControlFailure(res, out);
    const lastSeq = sessionControl.describeInstance(findInstance(inst.id) || inst).lastSeq;
    res.json({ ok: true, queued: out.queued, lastSeq });
  });

  // POST /v1/instances/:id/abort: stop the turn in progress.
  router.post('/instances/:id/abort', controlLimiter, (req, res) => {
    const inst = drivableInstance(req, res);
    if (!inst) return;
    if (inst.canReceivePrompts === false) {
      return res.status(409).json({ error: 'takeover_required' });
    }
    const sent = instanceManager.sendToAgent(inst.id, { type: 'abort' });
    // An abort ends any browser grant, whether or not the agent heard it.
    if (browserGuard) browserGuard.revokeGrants(inst.id);
    if (!sent) return res.status(502).json({ error: 'agent_not_connected' });
    instanceManager.updateStatus(inst.id, 'idle');
    res.json({ ok: true });
  });

  // POST /v1/instances/:id/permission-mode { permissionMode }: change the
  // mode of a session the caller drives, between turns. Only modes the
  // host lists in POLPO_GATEWAY_ALLOWED_PERMISSION_MODES.
  router.post('/instances/:id/permission-mode', controlLimiter, smallJson, (req, res) => {
    const inst = drivableInstance(req, res);
    if (!inst) return;
    const body = req.body || {};
    if (body.permissionMode === undefined) return res.status(400).json({ error: 'permission_mode_required' });
    const mode = requestedPermissionMode(res, body);
    if (mode === null) return;
    if (!heldByGateway(inst)) {
      return res.status(409).json({
        error: inst.heldBy ? 'held_elsewhere' : 'takeover_required',
        message: inst.heldBy
          ? 'This session is driven by ' + inst.heldBy + ', not through the gateway.'
          : 'polpo is only watching this session. Take it over first, once it is idle.',
      });
    }
    const label = clientLabelFor(req, body);
    const out = sessionControlCtl.setPermissionMode(inst.id, mode, { by: 'gateway:' + label });
    if (!out.ok) return sendControlFailure(res, out);
    log.info('Permission mode of ' + inst.id + ' set to ' + mode + ' by gateway:' + label);
    res.json({ ok: true, permissionMode: out.permissionMode });
  });

  // ---- Answering approvals (opt-in) ----
  //
  // When the only way to reach you is the agent driving a session (a PA
  // on Telegram), it puts the session's pending approval to you and
  // brings your answer back, with your words verbatim. Only for sessions
  // a gateway caller drives, and only you decide: an agent may not
  // approve on its own. Off unless the host sets POLPO_GATEWAY_APPROVALS=1.
  // A campaign's approvals are campaign decisions, answered there.

  // POST /v1/instances/:id/approval
  //   { toolUseId, answer: approve|reject|answer, text?, answers?, relay: { decidedBy, userMessage } }
  router.post('/instances/:id/approval', controlLimiter, smallJson, (req, res) => {
    if (!approvalControl) return res.status(403).json({ error: 'approval_control_not_enabled' });
    const inst = drivableInstance(req, res);
    if (!inst) return;
    if (!heldByGateway(inst)) {
      return res.status(409).json({
        error: 'not_held_by_gateway',
        message: 'Only the approvals of a session a gateway caller drives can be answered here.',
        heldBy: inst.heldBy || null,
      });
    }
    const body = req.body || {};
    const relay = checkRelay(body.relay);
    if (!relay.ok) return res.status(400).json({ error: relay.error, message: relay.message });
    if (relay.decidedBy !== 'user') {
      return res.status(403).json({ error: 'agent_may_not_decide', message: 'An approval must be decided by the user.' });
    }
    if (typeof body.toolUseId !== 'string' || !body.toolUseId || body.toolUseId.length > 200) {
      return res.status(400).json({ error: 'invalid_tool_use_id' });
    }
    const pending = approvals.current(inst.id);
    if (!pending) return res.status(409).json({ error: 'no_pending_approval' });
    if (pending.toolUseId !== body.toolUseId) {
      return res.status(409).json({
        error: 'approval_superseded',
        message: 'The session is waiting on a different approval now; put that one to the user.',
        pendingApproval: sessionControl.describeApproval(inst.pendingApproval),
      });
    }
    const isQuestion = pending.approvalType === 'question';
    const valid = isQuestion ? ['answer', 'reject'] : ['approve', 'reject'];
    if (!valid.includes(body.answer)) {
      return res.status(400).json({ error: 'invalid_answer', message: 'answer must be one of: ' + valid.join(', ') + '.' });
    }
    if (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > MAX_ANSWER_TEXT)) {
      return res.status(400).json({ error: 'invalid_text' });
    }
    let answers = null;
    if (body.answer === 'answer') {
      answers = checkAnswers(body.answers);
      if (!answers) return res.status(400).json({ error: 'invalid_answers', message: 'answers maps each question to the chosen answer.' });
    }

    const channel = 'gateway:' + clientLabelFor(req, body);
    const meta = { channel, decidedBy: relay.decidedBy, userMessage: relay.userMessage };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const tool = (inst.pendingApproval && inst.pendingApproval.tool) || 'a tool call';
    let settled;
    if (body.answer === 'approve') settled = approvals.approve(inst.id, meta);
    else if (body.answer === 'answer') settled = approvals.answer(inst.id, answers, meta);
    else settled = approvals.reject(inst.id, text ? 'Rejected by the user: ' + text : 'Rejected via Polpo', meta);
    if (!settled) return res.status(409).json({ error: 'no_pending_approval' });

    const verb = body.answer === 'approve' ? 'Approved' : (body.answer === 'answer' ? 'Answered' : 'Rejected');
    log.info(verb + ' ' + tool + ' on ' + inst.id + ' through ' + channel + ', relayed from the user');
    instanceManager.addMessage(inst.id, {
      role: 'system',
      content: verb + ' ' + tool + ' through ' + channel + '. The user said: "' + capChars(redact(relay.userMessage), 500) + '"',
      source: 'polpo',
    });
    res.json({ ok: true });
  });

  // POST /v1/sessions/:id/resume: continue a session from the catalogue,
  // including one that is not live right now.
  router.post('/sessions/:id/resume', controlLimiter, smallJson, async (req, res) => {
    if (!sessionControlCtl) return res.status(503).json({ error: 'session_control_not_enabled' });
    if (!convSearch.isValidSessionId(req.params.id)) {
      return res.status(400).json({ error: 'invalid_session_id' });
    }
    const body = req.body || {};
    const agentType = body.agentType === undefined ? 'claude' : body.agentType;
    if (!['claude', 'codex', 'gemini', 'opencode', 'pi', 'goose'].includes(agentType)) {
      return res.status(400).json({ error: 'invalid_agent_type' });
    }
    const permissionMode = requestedPermissionMode(res, body);
    if (permissionMode === null) return;
    try {
      const out = await sessionControlCtl.resume(req.params.id, {
        agentType,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        heldBy: 'gateway:' + clientLabelFor(req, body),
        inheritPermissionMode,
        permissionMode,
        serverUrl: 'ws://127.0.0.1:' + req.socket.localPort,
      });
      if (!out.ok) return sendControlFailure(res, out);
      res.json({ instanceId: out.instanceId, alreadyRunning: !!out.alreadyRunning });
    } catch (err) {
      log.error('/v1/sessions/:id/resume failed:', err && err.message);
      res.status(500).json({ error: 'resume_failed' });
    }
  });

  // ---- Campaigns ----
  //
  // A PA (Telegram, Slack, anything) can carry every decision of a
  // campaign between you and polpo: it is told when one is pending, puts
  // it to you, and brings your answer back with an attestation of who
  // decided. Reading needs the gateway key; acting needs
  // POLPO_GATEWAY_CAMPAIGN_CONTROL=1. See docs/campaigns.md, 4.10.

  const campaigns = opts.campaigns || null;
  const campaignControl = opts.campaignControl === true;
  const campaignLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 60 });
  const campaignControlLimiter = createPerTokenRateLimit({ windowMs: 60_000, max: 30 });

  function sendCampaignFailure(res, out) {
    const body = { error: out.error, message: out.message };
    for (const k of ['errors', 'decided', 'reason', 'hash', 'status', 'decisions']) {
      if (out[k] !== undefined) body[k] = out[k];
    }
    return res.status(campaignErrorStatus(out.error)).json(body);
  }

  /** The campaign of :id, or null after responding. */
  function campaignOf(req, res, control) {
    if (!campaigns) {
      res.status(503).json({ error: 'campaigns_not_enabled' });
      return null;
    }
    if (control && !campaignControl) {
      res.status(403).json({ error: 'campaign_control_not_enabled' });
      return null;
    }
    if (!CAMPAIGN_ID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'invalid_campaign_id' });
      return null;
    }
    const c = campaigns.get(req.params.id);
    if (!c) {
      res.status(404).json({ error: 'campaign_not_found' });
      return null;
    }
    return c;
  }

  /** Relay attestation, or null after responding. `required` for answers and stop. */
  function relayOf(req, res, required) {
    const body = req.body || {};
    if (body.relay === undefined && !required) return { decidedBy: 'user', userMessage: null };
    const r = checkRelay(body.relay);
    if (!r.ok) {
      res.status(400).json({ error: r.error, message: r.message });
      return null;
    }
    return r;
  }

  // GET /v1/campaigns
  router.get('/campaigns', campaignLimiter, (req, res) => {
    if (!campaigns) return res.status(503).json({ error: 'campaigns_not_enabled' });
    res.json({ campaigns: campaigns.list(), control: campaignControl });
  });

  // GET /v1/campaigns/:id: the ladder, gate history, pending decisions.
  router.get('/campaigns/:id', campaignLimiter, (req, res) => {
    const c = campaignOf(req, res, false);
    if (!c) return;
    res.json(campaigns.describe(c, { full: true }));
  });

  // GET /v1/campaigns/:id/ledger?since=<seq>&limit=<n>
  router.get('/campaigns/:id/ledger', campaignLimiter, (req, res) => {
    const c = campaignOf(req, res, false);
    if (!c) return;
    const since = clampNonNegativeInt(req.query && req.query.since, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampPositiveInt(req.query && req.query.limit, 100, 500);
    res.json(campaigns.ledgerSince(c.id, since, limit));
  });

  // GET /v1/decisions?since=<cursor>: pending decisions across campaigns.
  // Poll with the returned cursor; `closed` lists the ones settled since.
  router.get('/decisions', campaignLimiter, (req, res) => {
    if (!campaigns) return res.status(503).json({ error: 'campaigns_not_enabled' });
    const since = clampNonNegativeInt(req.query && req.query.since, 0, Number.MAX_SAFE_INTEGER);
    res.json(campaigns.decisionsSince(since));
  });

  // GET /v1/campaigns/:id/decisions/:decisionId
  router.get('/campaigns/:id/decisions/:decisionId', campaignLimiter, (req, res) => {
    const c = campaignOf(req, res, false);
    if (!c) return;
    const d = DECISION_ID_RE.test(req.params.decisionId) ? campaigns.getDecision(c.id, req.params.decisionId) : null;
    if (!d) return res.status(404).json({ error: 'decision_not_found' });
    res.json(d);
  });

  // POST /v1/campaigns { cwd, file?, sessionId? }: propose a campaign from
  // a repository's campaign file. Nothing runs until its definition
  // decision is answered by you.
  router.post('/campaigns', campaignControlLimiter, smallJson, (req, res) => {
    if (!campaigns) return res.status(503).json({ error: 'campaigns_not_enabled' });
    if (!campaignControl) return res.status(403).json({ error: 'campaign_control_not_enabled' });
    const body = req.body || {};
    if (body.file !== undefined && typeof body.file !== 'string') return res.status(400).json({ error: 'invalid_file' });
    const out = campaigns.create({
      cwd: body.cwd,
      file: body.file,
      sessionId: body.sessionId,
      channel: 'gateway:' + clientLabelFor(req, body),
    });
    if (!out.ok) return sendCampaignFailure(res, out);
    res.status(201).json({ campaign: out.campaign, decision: out.decision });
  });

  // POST /v1/campaigns/:id/decisions/:decisionId
  //   { answer, text?, hash?, relay: { decidedBy, userMessage } }
  router.post('/campaigns/:id/decisions/:decisionId', campaignControlLimiter, smallJson, async (req, res) => {
    const c = campaignOf(req, res, true);
    if (!c) return;
    if (!DECISION_ID_RE.test(req.params.decisionId)) return res.status(400).json({ error: 'invalid_decision_id' });
    const relay = relayOf(req, res, true);
    if (!relay) return;
    const body = req.body || {};
    try {
      const out = await campaigns.answer(c.id, req.params.decisionId, {
        answer: body.answer,
        text: body.text,
        hash: body.hash,
        channel: 'gateway:' + clientLabelFor(req, body),
        decidedBy: relay.decidedBy,
        userMessage: relay.userMessage,
      });
      if (!out.ok) return sendCampaignFailure(res, out);
      res.json({ decision: out.decision, campaign: out.campaign });
    } catch (err) {
      log.error('/v1/campaigns/:id/decisions failed:', err && err.message);
      res.status(500).json({ error: 'answer_failed' });
    }
  });

  // POST /v1/campaigns/:id/pause | resume | stop { text?, relay? }
  // Stopping a campaign is yours alone: it needs relay.decidedBy "user".
  for (const action of ['pause', 'resume', 'stop']) {
    router.post('/campaigns/:id/' + action, campaignControlLimiter, smallJson, async (req, res) => {
      const c = campaignOf(req, res, true);
      if (!c) return;
      const relay = relayOf(req, res, action === 'stop');
      if (!relay) return;
      if (action === 'stop' && relay.decidedBy !== 'user') {
        return res.status(403).json({ error: 'agent_may_not_decide', message: 'Only the user can stop a campaign.' });
      }
      const body = req.body || {};
      if (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 4000)) {
        return res.status(400).json({ error: 'invalid_text' });
      }
      try {
        const out = await campaigns[action](c.id, {
          channel: 'gateway:' + clientLabelFor(req, body),
          text: body.text,
          decidedBy: relay.decidedBy,
          userMessage: relay.userMessage,
        });
        if (!out.ok) return sendCampaignFailure(res, out);
        res.json({ campaign: out.campaign });
      } catch (err) {
        log.error('/v1/campaigns/:id/' + action + ' failed:', err && err.message);
        res.status(500).json({ error: action + '_failed' });
      }
    });
  }

  // POST /v1/campaigns/:id/prompt { text }: steer the campaign's session.
  router.post('/campaigns/:id/prompt', campaignControlLimiter, smallJson, (req, res) => {
    const c = campaignOf(req, res, true);
    if (!c) return;
    const body = req.body || {};
    const out = campaigns.prompt(c.id, typeof body.text === 'string' ? body.text : '', {
      channel: 'gateway:' + clientLabelFor(req, body),
    });
    if (!out.ok) return sendCampaignFailure(res, out);
    res.json({ ok: true, instanceId: c.instanceId });
  });

  // POST /v1/campaigns/:id/gate { milestone? }: run a gate now.
  router.post('/campaigns/:id/gate', campaignControlLimiter, smallJson, (req, res) => {
    const c = campaignOf(req, res, true);
    if (!c) return;
    const body = req.body || {};
    if (body.milestone !== undefined && typeof body.milestone !== 'string') {
      return res.status(400).json({ error: 'invalid_milestone' });
    }
    const out = campaigns.runGate(c.id, { milestone: body.milestone }, { channel: 'gateway:' + clientLabelFor(req, body) });
    if (!out.ok) return sendCampaignFailure(res, out);
    res.status(202).json({ run: out.run });
  });

  // GET /v1/search — merged disk + memory hits (chronological).
  router.get('/search', searchLimiter, async (req, res) => {
    const query = parseQuery(req, res);
    if (!query) return;
    const include = String((req.query && req.query.include) || 'all').toLowerCase();
    if (!['disk', 'memory', 'all'].includes(include)) {
      return res.status(400).json({ error: 'invalid_include' });
    }
    const limit = clampPositiveInt(req.query && req.query.limit, convSearch.DEFAULT_LIMIT, convSearch.MAX_LIMIT);
    const candidatePool = Math.min(Math.max(limit * 3, 60), 300);

    if (searchInProgress) {
      return res.status(429).json({ error: 'search_in_progress' });
    }
    searchInProgress = true;
    try {
      const hits = [];
      let partial = false;
      if (include !== 'memory') {
        const disk = await convSearch.searchOnDisk(query, { limit: candidatePool });
        hits.push(...disk.results);
        partial = partial || disk.partial;
      }
      if (include !== 'disk' && instanceManager) {
        const mem = convSearch.searchInMemory(query, instanceManager, { limit: candidatePool });
        hits.push(...mem.results);
      }
      // Merge sort by normalized timestamp (newest first)
      hits.sort((a, b) => {
        const ta = a.timestamp ? (typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp) || 0) : 0;
        const tb = b.timestamp ? (typeof b.timestamp === 'number' ? b.timestamp : Date.parse(b.timestamp) || 0) : 0;
        return tb - ta;
      });
      res.json({ results: hits.slice(0, limit).map(redactHit), partial });
    } catch (err) {
      log.error('/v1/search failed:', err && err.message);
      res.status(500).json({ error: 'search_failed' });
    } finally {
      searchInProgress = false;
    }
  });

  // GET /v1/sessions/search — session-grouped + ranked for routing.
  router.get('/sessions/search', searchLimiter, async (req, res) => {
    const query = parseQuery(req, res);
    if (!query) return;
    const limit = clampPositiveInt(req.query && req.query.limit, 10, 50);
    const snippets = clampNonNegativeInt(req.query && req.query.snippets, 3, 5);
    const candidatePool = Math.min(Math.max(limit * 6, 60), 300);

    if (searchInProgress) {
      return res.status(429).json({ error: 'search_in_progress' });
    }
    searchInProgress = true;
    try {
      const disk = await convSearch.searchOnDisk(query, { limit: candidatePool });
      const mem = instanceManager
        ? convSearch.searchInMemory(query, instanceManager, { limit: candidatePool })
        : { results: [] };
      const grouped = convSearch.groupBySession(disk.results.concat(mem.results), { snippets });

      // Enrich each session with metadata we can fetch cheaply
      const liveByInstanceId = new Map();
      const liveBySessionId = new Map();
      if (instanceManager && typeof instanceManager.getAll === 'function') {
        for (const inst of instanceManager.getAll()) {
          if (!inst) continue;
          liveByInstanceId.set(inst.id, inst);
          if (inst.sessionId) liveBySessionId.set(inst.sessionId, inst);
        }
      }

      // Pull disk-side session metadata in one cheap pass. Limit so a host
      // with thousands of past sessions doesn't slow the response down.
      let diskCatalogue = [];
      try {
        diskCatalogue = await scanSessions({
          maxAge: 365 * 24 * 60 * 60 * 1000,
          limit: 500,
        });
      } catch (err) {
        // Don't fail the whole search if metadata enrichment fails
      }
      const catalogueById = new Map();
      for (const s of diskCatalogue) {
        if (s && s.sessionId) catalogueById.set(s.sessionId, s);
      }

      const enriched = grouped.slice(0, limit).map((g) => {
        const live = (g.instanceId && liveByInstanceId.get(g.instanceId))
          || liveBySessionId.get(g.sessionId)
          || null;
        const meta = catalogueById.get(g.sessionId) || null;
        return {
          sessionId: g.sessionId,
          instanceId: live ? live.id : null,
          project: (live && live.project) || (meta && meta.project) || null,
          cwd: (live && live.cwd) || (meta && meta.cwd) || null,
          agentType: (live && live.agentType) || (meta && meta.agentType) || null,
          firstPrompt: truncate((live && live.firstPrompt) || (meta && meta.firstPrompt), 200),
          lastActivity: (live && live.lastActivity) || (meta && meta.lastActivity) || g.lastMatchTs || null,
          matchCount: g.matchCount,
          score: g.score,
          topSnippets: Array.isArray(g.topSnippets) ? g.topSnippets.map(redactHit) : g.topSnippets,
        };
      });

      res.json({ sessions: enriched, partial: disk.partial });
    } catch (err) {
      log.error('/v1/sessions/search failed:', err && err.message);
      res.status(500).json({ error: 'search_failed' });
    } finally {
      searchInProgress = false;
    }
  });

  // GET /v1/sessions — catalogue across disk + live instances.
  // GET /v1/profile — Builder Profile (Paxel-style). Computes a
  // dimension-scored snapshot of how the operator works with AI agents,
  // entirely from local transcript metadata + a bounded content sample.
  // No transcript content leaves the machine; the response is
  // statistics + an archetype label.
  router.get('/profile', profileLimiter, async (req, res) => {
    const VALID_SOURCES = ['all', 'claude', 'codex', 'gemini', 'opencode', 'pi', 'goose'];
    const days = clampPositiveInt(req.query && req.query.days, 90, 365);
    const source = String((req.query && (req.query.agent || req.query.source)) || 'all').toLowerCase();
    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: 'invalid_source' });
    }
    const cacheKey = days + ':' + source;
    if (profileCache && profileCache.key === cacheKey
        && Date.now() - profileCache.at < PROFILE_CACHE_TTL_MS) {
      return res.json(profileCache.data);
    }
    if (profileInProgress) {
      return res.status(429).json({ error: 'profile_in_progress' });
    }
    profileInProgress = true;
    try {
      const data = await analyzeProfile({ days, source });
      profileCache = { key: cacheKey, at: Date.now(), data };
      res.json(data);
    } catch (err) {
      log.error('/v1/profile failed:', err && err.message);
      res.status(500).json({ error: 'profile_failed' });
    } finally {
      profileInProgress = false;
    }
  });

  router.get('/sessions', catalogueLimiter, async (req, res) => {
    const sourceRaw = String((req.query && req.query.source) || 'all').toLowerCase();
    if (!KNOWN_SOURCES.has(sourceRaw)) {
      return res.status(400).json({ error: 'invalid_source' });
    }
    const days = clampPositiveInt(req.query && req.query.days, 30, 365);
    const limit = clampPositiveInt(req.query && req.query.limit, 50, 200);

    try {
      // Live instances first — they're cheap, in-memory.
      const liveInstances = (instanceManager && typeof instanceManager.getAll === 'function')
        ? instanceManager.getAll()
        : [];

      // Apply source filter to live
      let live = liveInstances.map(serializeLiveInstance).filter(Boolean);
      if (sourceRaw === 'gateway') {
        live = live.filter(i => typeof i.source === 'string' && i.source.startsWith('gateway:'));
      } else if (sourceRaw === 'mind') {
        // Alien Mind arms are tagged 'mind:<goalId-tail>' at spawn time
        // by the coordinator. The mind instance itself (agentType 'mind')
        // is excluded; we only want its dispatched arms here.
        live = live.filter(i => typeof i.source === 'string' && i.source.startsWith('mind:'));
      } else if (sourceRaw !== 'all') {
        // For agent-type sources, match against agentType
        live = live.filter(i => i.agentType === sourceRaw);
      }

      // Disk catalogue
      let disk = [];
      // 'gateway' and 'mind' tags only exist on live instances (they're
      // attached at spawn time, never persisted to the on-disk
      // transcript). When the caller filters by those tags, skip the
      // disk scan entirely.
      if (sourceRaw !== 'gateway' && sourceRaw !== 'mind') {
        try {
          const opts = {
            maxAge: days * 24 * 60 * 60 * 1000,
            limit,
          };
          if (sourceRaw !== 'all') opts.source = sourceRaw;
          const raw = await scanSessions(opts);
          disk = raw.map(s => ({
            sessionId: s.sessionId,
            instanceId: null,
            project: s.project || null,
            cwd: s.cwd || null,
            agentType: s.agentType || null,
            firstPrompt: truncate(s.firstPrompt, 200),
            lastActivity: s.lastActivity || null,
            isLive: false,
            source: null,
          }));
        } catch (err) {
          log.error('/v1/sessions disk scan failed:', err && err.message);
        }
      }

      // Merge live + disk, deduping by sessionId (live wins).
      const seen = new Set();
      const merged = [];
      for (const s of live.concat(disk)) {
        const key = s.sessionId || s.instanceId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(s);
      }
      // Sort by lastActivity desc (null → bottom)
      merged.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));

      res.json({ sessions: merged.slice(0, limit) });
    } catch (err) {
      log.error('/v1/sessions failed:', err && err.message);
      res.status(500).json({ error: 'sessions_failed' });
    }
  });

  // GET /v1/sessions/:id — read one session's history.
  router.get('/sessions/:id', catalogueLimiter, async (req, res) => {
    const id = req.params.id;
    if (!convSearch.isValidSessionId(id)) {
      return res.status(400).json({ error: 'invalid_session_id' });
    }
    const tail = clampPositiveInt(req.query && req.query.tail, 100, 500);
    const offset = clampNonNegativeInt(req.query && req.query.offset, 0, 100_000);
    const useOffset = (req.query && req.query.offset !== undefined);
    const limit = useOffset ? clampPositiveInt(req.query && req.query.limit, 100, 500) : null;

    try {
      // Live instance first
      const live = instanceManager && typeof instanceManager.getAll === 'function'
        ? instanceManager.getAll().find(i => i && i.sessionId === id)
        : null;
      if (live) {
        const wholeConv = (typeof instanceManager.getConversation === 'function')
          ? instanceManager.getConversation(live.id, 500)
          : [];
        // Whitelist message fields we serialize
        const safeConv = (Array.isArray(wholeConv) ? wholeConv : []).map(sanitizeMessage);
        const total = safeConv.length;
        let messages;
        let hasMore = false;
        if (useOffset) {
          messages = safeConv.slice(offset, offset + limit);
          hasMore = offset + limit < total;
        } else {
          messages = safeConv.slice(-tail);
        }
        return res.json({
          messages,
          total,
          hasMore,
          isLive: true,
          instanceId: live.id,
        });
      }

      // Disk fallback
      let history;
      try {
        history = await loadHistory(id);
      } catch (err) {
        return res.status(404).json({ error: 'session_not_found' });
      }
      // loadHistory returns [] for unknown ids — treat that as not-found
      // so callers can distinguish "no such session" from "session with
      // no messages yet" (the latter would only ever happen for a live
      // session that has no on-disk record).
      if (!Array.isArray(history) || history.length === 0) {
        return res.status(404).json({ error: 'session_not_found' });
      }
      const safeHistory = history.map(sanitizeMessage);
      const total = safeHistory.length;
      let messages;
      let hasMore = false;
      if (useOffset) {
        messages = safeHistory.slice(offset, offset + limit);
        hasMore = offset + limit < total;
      } else {
        messages = safeHistory.slice(-tail);
      }
      res.json({ messages, total, hasMore, isLive: false, instanceId: null });
    } catch (err) {
      log.error('/v1/sessions/:id failed:', err && err.message);
      res.status(500).json({ error: 'session_read_failed' });
    }
  });

  // ---- Alien Mind goals (v1.2.1, experimental) --------------------------
  // Lets an external orchestrator submit a goal to the host's Alien Mind:
  // the mind decomposes it into tasks, fans them out across one or more
  // arms, and streams progress events back. Mind is opt-in (POLPO_MIND=1
  // on the host); if not enabled, these routes return 503.

  const MAX_GOAL_PROMPT = 50_000;
  const MAX_GOAL_QUESTION = 2_000;
  const GOAL_ID_RE = /^goal-[a-z0-9-]{4,32}$/;

  /**
   * A retained goal by id, or null. Finished goals are kept for an hour
   * (or up to the newest 50), so a parent or a goal being asked about
   * has to be recent.
   */
  function findGoal(coordinator, goalId) {
    const goals = coordinator.getActiveGoals() || [];
    return goals.find(function (g) { return g && g.id === goalId; }) || null;
  }

  function isFinished(goal) {
    return goal && (goal.status === 'completed' || goal.status === 'failed');
  }

  function getCoordinator() {
    return mind && mind.coordinator ? mind.coordinator : null;
  }

  function notSupported(res) {
    return res.status(503).json({ error: 'mind_not_enabled' });
  }

  /**
   * @param {object} goal
   * @param {{withOutput?: boolean}} [opts] - include what the arms
   *   produced. On for a single goal, off for the list, where up to the
   *   retention limit of goals times their tasks' output would make one
   *   response enormous.
   */
  function serializeGoal(goal, opts) {
    if (!goal) return null;
    const withOutput = !!(opts && opts.withOutput);
    const out = {
      id: goal.id,
      status: goal.status,
      prompt: truncate(goal.prompt, 500),
      result: goal.result || null,
      client: goal.client || null,
      createdAt: goal.createdAt || null,
      finishedAt: goal.finishedAt || null,
      plan: goal.plan ? {
        tasks: (goal.plan.tasks || []).map(function (t) {
          const task = {
            id: t.id,
            description: t.description,
            agentType: t.agentType,
            status: t.status,
            dependsOn: (t.dependsOn || []).slice(),
            startedAt: t.startedAt || null,
            completedAt: t.completedAt || null,
            durationMs: (t.startedAt && t.completedAt) ? (t.completedAt - t.startedAt) : null,
            summary: (t.result && t.result.summary) ? String(t.result.summary).slice(0, 1000) : null,
          };
          if (withOutput) {
            const capped = capTail(t.output || '');
            task.output = capped.output || null;
            task.outputTruncated = capped.outputTruncated;
          }
          return task;
        }),
      } : null,
    };
    if (withOutput) {
      // The deliverable: what the tasks nothing else consumed produced.
      // Before this, a caller that asked the mind for a report had no
      // field anywhere that contained the report.
      const deliverable = goalFinalOutput(goal);
      out.finalOutput = deliverable.finalOutput;
      out.finalOutputTruncated = deliverable.finalOutputTruncated;
    }
    return out;
  }

  // POST /v1/goals — submit a goal for the mind to decompose + fan out.
  router.post('/goals', goalLimiter, smallJson, async (req, res) => {
    const coordinator = getCoordinator();
    if (!coordinator) return notSupported(res);

    const body = req.body || {};
    const prompt = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (!prompt || prompt.length > MAX_GOAL_PROMPT) {
      return res.status(400).json({ error: 'invalid_goal' });
    }
    if (body.client !== undefined && body.client !== null && typeof body.client !== 'string') {
      return res.status(400).json({ error: 'invalid_client' });
    }

    // A follow-up to an earlier goal: the planner and the first tasks get
    // that goal's result. Unlike the chat, which quietly falls back to a
    // memory summary, an API caller gets an explicit error when the parent
    // is not usable, so it never mistakes a plan made without context for
    // a real follow-up.
    let parentGoalId = null;
    if (body.parentGoalId !== undefined && body.parentGoalId !== null) {
      if (typeof body.parentGoalId !== 'string' || !GOAL_ID_RE.test(body.parentGoalId)) {
        return res.status(400).json({ error: 'invalid_parent_goal_id' });
      }
      const parent = findGoal(coordinator, body.parentGoalId);
      if (!parent) {
        return res.status(404).json({ error: 'parent_goal_not_found' });
      }
      if (!isFinished(parent)) {
        return res.status(409).json({ error: 'parent_goal_not_finished', status: parent.status });
      }
      parentGoalId = parent.id;
    }

    // Same label ladder as /v1/tasks: explicit client (header wins over
    // body), then the User-Agent's first token, then a pseudonym of the
    // bearer token. It used to be validated here and then dropped, so a
    // goal never said which system had submitted it.
    const client = clientLabelFor(req, body);

    try {
      // Gateway-submitted goals MUST auto-dispatch. There is no human
      // in the loop on this API surface to /approve a plan preview or
      // /retry an escalated arm; treating gateway callers as
      // interactive would deadlock them on the first plan.
      const result = await coordinator.submitGoal(prompt, {
        autoDispatch: true,
        client: client,
        parentGoalId: parentGoalId,
      });
      if (!result || !result.goalId) {
        return res.status(500).json({ error: 'goal_create_failed' });
      }
      res.status(201).json({
        goalId: result.goalId,
        parentGoalId: parentGoalId,
        streamUrl: '/v1/goals/' + result.goalId + '/stream',
      });
    } catch (err) {
      log.error('/v1/goals failed:', err && err.message);
      res.status(500).json({ error: 'goal_create_failed' });
    }
  });

  // GET /v1/goals — list active goals on this host.
  router.get('/goals', goalLimiter, (req, res) => {
    const coordinator = getCoordinator();
    if (!coordinator) return notSupported(res);
    const goals = (coordinator.getActiveGoals() || []).map(serializeGoal).filter(Boolean);
    res.json({ goals });
  });

  // GET /v1/goals/:id — snapshot.
  router.get('/goals/:id', goalLimiter, (req, res) => {
    const coordinator = getCoordinator();
    if (!coordinator) return notSupported(res);
    if (!/^goal-[a-z0-9-]{4,32}$/.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_goal_id' });
    }
    const goals = coordinator.getActiveGoals() || [];
    const goal = goals.find(function (g) { return g && g.id === req.params.id; });
    if (!goal) return res.status(404).json({ error: 'goal_not_found' });
    res.json(serializeGoal(goal, { withOutput: true }));
  });

  // POST /v1/goals/:id/ask: answer a question about a finished goal's
  // result. One reasoning call over the stored result: no plan, no arms,
  // and nothing written to the host's mind chat. Synchronous; bounded by
  // the reasoner's deadline (POLPO_MIND_TIMEOUT_MS, 120 s by default).
  router.post('/goals/:id/ask', goalLimiter, smallJson, async (req, res) => {
    const coordinator = getCoordinator();
    if (!coordinator) return notSupported(res);
    if (!GOAL_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_goal_id' });
    }
    const body = req.body || {};
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > MAX_GOAL_QUESTION) {
      return res.status(400).json({ error: 'invalid_question' });
    }
    if (typeof coordinator.answerQuestion !== 'function') return notSupported(res);

    const goal = findGoal(coordinator, req.params.id);
    if (!goal) return res.status(404).json({ error: 'goal_not_found' });
    if (!isFinished(goal)) {
      return res.status(409).json({ error: 'goal_not_finished', status: goal.status });
    }

    try {
      const out = await coordinator.answerQuestion(goal.id, question);
      if (out.ok) {
        return res.json({ goalId: goal.id, question, answer: out.answer });
      }
      const status = out.error === 'goal_not_found' ? 404
        : out.error === 'goal_not_finished' ? 409
        : out.error === 'invalid_question' ? 400
        : out.error === 'not_supported' ? 503
        : 502;
      return res.status(status).json({ error: out.error });
    } catch (err) {
      log.error('/v1/goals/:id/ask failed:', err && err.message);
      return res.status(502).json({ error: 'answer_failed' });
    }
  });

  // DELETE /v1/goals/:id — cancel.
  router.delete('/goals/:id', goalLimiter, (req, res) => {
    const coordinator = getCoordinator();
    if (!coordinator) return notSupported(res);
    if (!/^goal-[a-z0-9-]{4,32}$/.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_goal_id' });
    }
    const goals = coordinator.getActiveGoals() || [];
    const goal = goals.find(function (g) { return g && g.id === req.params.id; });
    if (!goal) return res.status(404).json({ error: 'goal_not_found' });
    if (goal.status === 'completed' || goal.status === 'failed') {
      return res.status(409).json({ error: 'goal_already_terminal', status: goal.status });
    }
    try { coordinator.cancelGoal(req.params.id); }
    catch (err) {
      log.error('cancelGoal failed:', err && err.message);
      return res.status(500).json({ error: 'goal_cancel_failed' });
    }
    res.status(204).end();
  });

  // GET /v1/goals/:id/stream — SSE relay of goal:event from Coordinator.
  router.get('/goals/:id/stream', (req, res) => {
    const coordinator = getCoordinator();
    if (!coordinator) return notSupported(res);
    if (!/^goal-[a-z0-9-]{4,32}$/.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_goal_id' });
    }
    const goals = coordinator.getActiveGoals() || [];
    const existing = goals.find(function (g) { return g && g.id === req.params.id; });
    if (!existing) return res.status(404).json({ error: 'goal_not_found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const goalId = req.params.id;

    // If the goal is already in a terminal state, replay a synthetic done
    // event so a late subscriber doesn't hang waiting forever.
    if (existing.status === 'completed' || existing.status === 'failed') {
      const deliverable = goalFinalOutput(existing);
      writeSseEvent(res, existing.status === 'completed' ? 'done' : 'error', {
        goalId,
        status: existing.status,
        result: existing.result || null,
        client: existing.client || null,
        finalOutput: deliverable.finalOutput,
        finalOutputTruncated: deliverable.finalOutputTruncated,
        replayed: true,
      });
      try { res.end(); } catch {}
      return;
    }

    // For a still-running goal, send a snapshot of where it is right now
    // so a late subscriber (e.g. when POST /v1/goals returned, but the
    // stream-GET landed AFTER planning/plan_ready already fired on the
    // EventEmitter) doesn't miss the early state. Includes the plan and
    // the current per-task status. Subsequent live events follow.
    writeSseEvent(res, 'snapshot', {
      goalId,
      status: existing.status,
      prompt: typeof existing.prompt === 'string' ? existing.prompt.slice(0, 500) : null,
      plan: existing.plan ? {
        tasks: (existing.plan.tasks || []).map(function (t) {
          return {
            id: t.id,
            description: t.description,
            agentType: t.agentType,
            status: t.status,
            dependsOn: (t.dependsOn || []).slice(),
          };
        }),
      } : null,
      replayed: true,
    });
    const onEvent = (ev) => {
      if (!ev || ev.goalId !== goalId) return;
      writeSseEvent(res, ev.type, ev);
      if (ev.type === 'done' || ev.type === 'cancelled' || ev.type === 'error') {
        cleanup();
        try { res.end(); } catch {}
      }
    };
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15_000);
    function cleanup() {
      clearInterval(heartbeat);
      try { coordinator.removeListener('goal:event', onEvent); } catch {}
    }
    coordinator.on('goal:event', onEvent);
    req.on('close', cleanup);
  });

  return router;
}

function writeSseEvent(res, type, data) {
  try {
    res.write('event: ' + type + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch {
    // client likely disconnected; the route's req.on('close') will clean up
  }
}

// Strip a message to the public field set so nothing internal leaks via
// /v1/sessions/:id. Limits content size defensively too.
/** A search hit with secrets removed from its snippet. */
function redactHit(h) {
  if (!h || typeof h !== 'object' || typeof h.snippet !== 'string') return h;
  const snippet = redact(h.snippet);
  if (snippet === h.snippet) return h;
  const out = Object.assign({}, h, { snippet });
  // Redaction can shift the match, or remove it when the match was part
  // of the secret; keep matchIndex pointing at the matched text.
  if (typeof h.matchIndex === 'number' && typeof h.matchLength === 'number') {
    const at = snippet.indexOf(h.snippet.substr(h.matchIndex, h.matchLength));
    out.matchIndex = at === -1 ? 0 : at;
    if (at === -1) out.matchLength = 0;
  }
  return out;
}

function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    role: typeof m.role === 'string' ? m.role : null,
    timestamp: m.timestamp || null,
  };
  if (typeof m.content === 'string') {
    out.content = redact(m.content);
  } else if (Array.isArray(m.content)) {
    out.content = redactDeep(m.content);
  } else if (m.content !== undefined) {
    out.content = null;
  }
  if (typeof m.type === 'string') out.type = m.type;
  if (typeof m.contentType === 'string') out.contentType = m.contentType;
  if (typeof m.toolUseId === 'string') out.toolUseId = m.toolUseId;
  return out;
}

function mapErrorStatus(code) {
  switch (code) {
    // Generic + task-create errors
    case 'invalid_body':
    case 'invalid_agentType':
    case 'invalid_cwd':
    case 'invalid_prompt':
    case 'invalid_client':
    case 'invalid_title':
    case 'invalid_model':
    case 'prompt_too_long':
    case 'cwd_must_be_absolute':
    case 'cwd_does_not_exist':
    case 'cwd_not_a_directory':
    case 'cwd_not_accessible':
    case 'invalid_attachments':
    case 'duplicate_attachment':
    case 'too_many_attachments':
    case 'invalid_capture_artifacts':
    case 'invalid_upload_id':
    case 'invalid_filename':
    case 'invalid_artifact_name':
      return 400;

    case 'upload_too_large':
      return 413;

    case 'rate_limited':
      return 429;
    case 'max_concurrent_reached':
      return 429;

    case 'upload_not_found':
    case 'task_not_found':
    case 'artifact_not_found':
      return 404;

    case 'upload_forbidden':
    case 'task_forbidden':
      return 403;

    case 'upload_expired':
      return 410;

    case 'task_not_terminal':
      return 409;

    case 'agent_ws_timeout':
    case 'agent_send_failed':
    case 'uploads_not_supported':
    case 'artifacts_not_supported':
      return 503;

    default:
      return 500;
  }
}

module.exports = { createGatewayRouter };
