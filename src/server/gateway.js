/**
 * Gateway HTTP router — /v1/* routes for programmatic agent execution.
 *
 * Auth: every request must present `Authorization: Bearer <POLPO_GATEWAY_KEY>`.
 * Streaming: GET /v1/tasks/:id/stream returns Server-Sent Events.
 */

const express = require('express');
const { createGatewayAuthMiddleware } = require('./gateway-auth');

/**
 * @param {object} opts
 * @param {object} opts.taskManager - GatewayTaskManager instance
 * @param {() => string} opts.getKey - returns the current gateway API key
 * @returns {import('express').Router}
 */
function createGatewayRouter(opts) {
  if (!opts || !opts.taskManager) throw new Error('taskManager is required');
  if (typeof opts.getKey !== 'function') throw new Error('getKey is required');

  const router = express.Router();
  const taskManager = opts.taskManager;

  router.use(express.json({ limit: '256kb' }));
  router.use(createGatewayAuthMiddleware(opts.getKey));

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      version: require('../../package.json').version,
      activeTasks: taskManager._activeTaskCount(),
    });
  });

  router.post('/tasks', async (req, res) => {
    try {
      // Allow X-Polpo-Client to override the body 'client' field
      const clientHeader = req.headers['x-polpo-client'];
      const body = req.body || {};
      if (typeof clientHeader === 'string' && clientHeader.trim()) {
        body.client = clientHeader.trim();
      }
      const { taskId } = await taskManager.createTask(body);
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
      res.status(status).json(body);
    }
  });

  router.get('/tasks/:id', (req, res) => {
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

  return router;
}

function mapErrorStatus(code) {
  switch (code) {
    case 'invalid_body':
    case 'invalid_agentType':
    case 'invalid_cwd':
    case 'invalid_prompt':
    case 'invalid_client':
    case 'prompt_too_long':
      return 400;
    case 'max_concurrent_reached':
      return 429;
    case 'agent_ws_timeout':
    case 'agent_send_failed':
      return 503;
    default:
      return 500;
  }
}

module.exports = { createGatewayRouter };
