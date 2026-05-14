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

/**
 * @param {object} opts
 * @param {object} opts.taskManager - GatewayTaskManager instance
 * @param {() => string} opts.getKey - returns the current gateway API key
 * @param {object} [opts.uploadStore] - GatewayUploadStore (enables POST /v1/uploads)
 * @returns {import('express').Router}
 */
function createGatewayRouter(opts) {
  if (!opts || !opts.taskManager) throw new Error('taskManager is required');
  if (typeof opts.getKey !== 'function') throw new Error('getKey is required');

  const router = express.Router();
  const taskManager = opts.taskManager;
  const uploadStore = opts.uploadStore || null;

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
      const { taskId } = await taskManager.createTask(body, { tokenFingerprint: fp });
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

  return router;
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
