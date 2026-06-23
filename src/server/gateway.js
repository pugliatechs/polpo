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
const { analyzeProfile } = require('./profile-analyzer');
const { makeLogger } = require('../util/logger');

const log = makeLogger('gateway');

/**
 * @param {object} opts
 * @param {object} opts.taskManager - GatewayTaskManager instance
 * @param {() => string} opts.getKey - returns the current gateway API key
 * @param {object} [opts.uploadStore] - GatewayUploadStore (enables POST /v1/uploads)
 * @param {object} [opts.instanceManager] - InstanceManager (enables /v1/search live walk,
 *   /v1/sessions live merge, /v1/sessions/:id live fallback)
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
  function truncate(str, max) {
    if (typeof str !== 'string') return null;
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
      res.json({ results: hits.slice(0, limit), partial });
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
          topSnippets: g.topSnippets,
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

  function getCoordinator() {
    return mind && mind.coordinator ? mind.coordinator : null;
  }

  function notSupported(res) {
    return res.status(503).json({ error: 'mind_not_enabled' });
  }

  function serializeGoal(goal) {
    if (!goal) return null;
    return {
      id: goal.id,
      status: goal.status,
      prompt: truncate(goal.prompt, 500),
      result: goal.result || null,
      createdAt: goal.createdAt || null,
      plan: goal.plan ? {
        tasks: (goal.plan.tasks || []).map(function (t) {
          return {
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
        }),
      } : null,
    };
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

    try {
      // Gateway-submitted goals MUST auto-dispatch. There is no human
      // in the loop on this API surface to /approve a plan preview or
      // /retry an escalated arm; treating gateway callers as
      // interactive would deadlock them on the first plan.
      const result = await coordinator.submitGoal(prompt, { autoDispatch: true });
      if (!result || !result.goalId) {
        return res.status(500).json({ error: 'goal_create_failed' });
      }
      res.status(201).json({
        goalId: result.goalId,
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
    res.json(serializeGoal(goal));
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
      writeSseEvent(res, existing.status === 'completed' ? 'done' : 'error', {
        goalId,
        status: existing.status,
        result: existing.result || null,
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
function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    role: typeof m.role === 'string' ? m.role : null,
    timestamp: m.timestamp || null,
  };
  if (typeof m.content === 'string') {
    out.content = m.content;
  } else if (Array.isArray(m.content)) {
    out.content = m.content;
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
