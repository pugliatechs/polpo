/**
 * GatewayTaskManager — one-shot agent execution for programmatic callers.
 *
 * Each task spawns a fresh agent (via the existing agent-factory), runs the
 * prompt, captures the result, and terminates. Agents register normally in
 * InstanceManager with source: 'gateway:<client>' so the dashboard can show
 * them. Output streams to subscribers via a callback fanout that the HTTP
 * router translates into SSE events.
 *
 * Design notes
 *   - No persistence across restart: tasks are in-memory. v1 scope, since
 *     gateway callers are expected to retry on transport errors anyway.
 *   - Approval requests fail the task with reason 'approval_required'. There
 *     is no human in the loop to approve; the caller must adjust the prompt
 *     or grant permissions explicitly.
 *   - Each task carries its own timeout. Hitting it cancels the agent and
 *     marks the task 'failed' with reason 'timeout'.
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { createAgent } = require('../agent/agent-factory');
const path = require('path');

const VALID_AGENT_TYPES = new Set(['claude', 'codex', 'gemini', 'opencode', 'pi', 'goose']);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min
const MAX_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;  // 30 min
const TASK_TTL_MS = 5 * 60 * 1000;              // keep completed tasks for 5 min
const WS_READY_TIMEOUT_MS = 5000;

class GatewayTaskManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {number} opts.hubPort - WS port for the agent to dial back into
   * @param {string} [opts.hubToken] - Polpo auth token the agent uses to register
   * @param {number} [opts.maxConcurrent=4]
   * @param {number} [opts.maxTimeoutMs] - upper bound on per-task timeout
   * @param {boolean} [opts.autoApprove=true] - bypass permissions for gateway agents
   */
  constructor(opts) {
    super();
    if (!opts || !opts.instanceManager) throw new Error('instanceManager is required');
    if (!opts.hubPort) throw new Error('hubPort is required');

    this.instanceManager = opts.instanceManager;
    this.hubPort = opts.hubPort;
    this.hubToken = opts.hubToken || null;
    this.maxConcurrent = opts.maxConcurrent || 4;
    this.maxTimeoutMs = opts.maxTimeoutMs || MAX_TIMEOUT_MS_DEFAULT;
    this.autoApprove = opts.autoApprove !== false;
    // Injectable for tests so we don't actually spawn agent subprocesses.
    this._createAgent = opts.createAgent || createAgent;
    this._waitForSocket = opts.waitForSocket || waitForAgentSocket;

    this._tasks = new Map();      // taskId -> task record
    this._agents = new Map();     // agentInstanceId -> agent object (so we can stop())
    this._listenersByAgent = new Map(); // agentInstanceId -> bound handlers (for cleanup)
    this._wired = false;
    this._wire();
  }

  /**
   * Validate inputs and start a task.
   * @returns {Promise<{ taskId: string }>}
   */
  async createTask(input) {
    const args = validateInput(input, this.maxTimeoutMs);
    const activeCount = this._activeTaskCount();
    if (activeCount >= this.maxConcurrent) {
      const err = new Error('max_concurrent_reached');
      err.code = 'max_concurrent_reached';
      err.activeCount = activeCount;
      err.limit = this.maxConcurrent;
      throw err;
    }

    const taskId = 'gtask-' + uuidv4().slice(0, 8);
    const task = {
      id: taskId,
      client: args.client,
      agentType: args.agentType,
      cwd: args.cwd,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      status: 'starting',
      output: '',
      result: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      agentInstanceId: null,
      timeoutHandle: null,
      ttlHandle: null,
      subscribers: new Set(),
    };
    this._tasks.set(taskId, task);

    try {
      await this._spawnAndStart(task);
    } catch (err) {
      this._finalize(task, 'failed', { error: err.message || 'spawn_failed' });
      throw err;
    }

    return { taskId };
  }

  /**
   * Serializable snapshot of a task (no internal refs).
   */
  getTask(taskId) {
    const t = this._tasks.get(taskId);
    if (!t) return null;
    return {
      id: t.id,
      client: t.client,
      agentType: t.agentType,
      cwd: t.cwd,
      prompt: t.prompt,
      status: t.status,
      output: t.output,
      result: t.result,
      error: t.error,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      agentInstanceId: t.agentInstanceId,
      durationMs: t.completedAt ? t.completedAt - t.startedAt : Date.now() - t.startedAt,
    };
  }

  /**
   * Subscribe to live events for a task. Returns an unsubscribe function.
   * Callback receives { type, data } where type is one of:
   *   - 'chunk'    : { text }
   *   - 'approval' : { request }  (always followed by task failure)
   *   - 'done'     : { result, output, durationMs }
   *   - 'error'    : { message }
   * If the task already terminated, the callback is invoked once with a
   * 'done' or 'error' replaying the terminal state, then the unsubscribe
   * is returned as a no-op.
   */
  subscribe(taskId, callback) {
    const t = this._tasks.get(taskId);
    if (!t) return null;
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
      // Replay terminal state once
      if (t.status === 'completed') {
        callback({ type: 'done', data: { result: t.result, output: t.output, durationMs: t.completedAt - t.startedAt } });
      } else {
        callback({ type: 'error', data: { message: t.error || t.status } });
      }
      return function noop() {};
    }
    t.subscribers.add(callback);
    return () => t.subscribers.delete(callback);
  }

  /**
   * Cancel a running task. Aborts the agent, marks failed/cancelled, fanouts.
   */
  cancelTask(taskId) {
    const t = this._tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
      return false;
    }
    if (t.agentInstanceId) {
      try { this.instanceManager.sendToAgent(t.agentInstanceId, { type: 'abort' }); } catch {}
    }
    this._finalize(t, 'cancelled', { error: 'cancelled_by_caller' });
    return true;
  }

  /**
   * Active task count (used for concurrency cap).
   */
  _activeTaskCount() {
    let n = 0;
    for (const t of this._tasks.values()) {
      if (t.status === 'starting' || t.status === 'running') n++;
    }
    return n;
  }

  /**
   * Wire up InstanceManager listeners that route events to tasks.
   */
  _wire() {
    if (this._wired) return;
    this._wired = true;
    this._onStatus = (data) => this._routeStatusEvent(data);
    this._onMessage = (data) => this._routeMessageEvent(data);
    this._onApproval = (data) => this._routeApprovalEvent(data);
    this.instanceManager.on('instance:status', this._onStatus);
    this.instanceManager.on('instance:message', this._onMessage);
    this.instanceManager.on('instance:approval', this._onApproval);
  }

  _findTaskByAgent(agentInstanceId) {
    if (!agentInstanceId) return null;
    for (const t of this._tasks.values()) {
      if (t.agentInstanceId === agentInstanceId) return t;
    }
    return null;
  }

  _routeStatusEvent(data) {
    const task = this._findTaskByAgent(data.id);
    if (!task) return;
    if (task.status === 'starting' && data.status === 'busy') {
      task.status = 'running';
    } else if (task.status === 'running' && data.status === 'idle') {
      // Agent completed the prompt — capture trailing assistant text as result
      this._finalize(task, 'completed', null);
    }
  }

  _routeMessageEvent(data) {
    const task = this._findTaskByAgent(data.id);
    if (!task) return;
    const msg = data.message;
    if (!msg || msg.role !== 'assistant') return;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text) return;
    task.output += (task.output ? '\n' : '') + text;
    this._fanout(task, 'chunk', { text });
  }

  _routeApprovalEvent(data) {
    const task = this._findTaskByAgent(data.id);
    if (!task || !data.approval) return;
    // Gateway tasks fail closed on approvals — no human to confirm.
    this._fanout(task, 'approval', { request: data.approval });
    if (task.agentInstanceId) {
      try { this.instanceManager.sendToAgent(task.agentInstanceId, { type: 'abort' }); } catch {}
    }
    this._finalize(task, 'failed', { error: 'approval_required' });
  }

  async _spawnAndStart(task) {
    const clientLabel = task.client || 'unknown';
    const agent = this._createAgent(task.agentType, {
      name: 'Gateway: ' + clientLabel,
      cwd: task.cwd,
      serverUrl: 'ws://127.0.0.1:' + this.hubPort,
      token: this.hubToken,
      type: 'terminal',
      project: path.basename(task.cwd),
      source: 'gateway:' + clientLabel,
      permissionMode: this.autoApprove ? 'bypass' : 'default',
    });

    await agent.start();
    task.agentInstanceId = agent.instanceId;
    this._agents.set(agent.instanceId, agent);

    if (this.autoApprove) {
      try { this.instanceManager.setAutoApprove(agent.instanceId, true); } catch {}
    }

    // Tag the registered instance with the source string (createAgent may not
    // forward all fields uniformly across agent types).
    const inst = this.instanceManager.get(agent.instanceId);
    if (inst && !inst.source) inst.source = 'gateway:' + clientLabel;

    await this._waitForSocket(this.instanceManager, agent.instanceId, WS_READY_TIMEOUT_MS);

    // Arm the timeout BEFORE sending the prompt so a hung start still trips it
    task.timeoutHandle = setTimeout(() => {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;
      if (task.agentInstanceId) {
        try { this.instanceManager.sendToAgent(task.agentInstanceId, { type: 'abort' }); } catch {}
      }
      this._finalize(task, 'failed', { error: 'timeout' });
    }, task.timeoutMs);

    const sent = this.instanceManager.sendToAgent(agent.instanceId, {
      type: 'prompt',
      text: task.prompt,
    });
    if (!sent) {
      throw new Error('agent_send_failed');
    }
  }

  _fanout(task, type, data) {
    for (const cb of task.subscribers) {
      try { cb({ type, data }); } catch (err) {
        // A bad subscriber shouldn't take down the task
      }
    }
  }

  _finalize(task, status, extra) {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;
    task.status = status;
    task.completedAt = Date.now();
    if (extra && extra.error) task.error = extra.error;
    if (status === 'completed') {
      task.result = { success: true, summary: task.output.slice(-2000) };
    }
    if (task.timeoutHandle) { clearTimeout(task.timeoutHandle); task.timeoutHandle = null; }

    // Stop and unregister the agent
    if (task.agentInstanceId) {
      const agent = this._agents.get(task.agentInstanceId);
      if (agent) {
        try { agent.stop(); } catch {}
        this._agents.delete(task.agentInstanceId);
      }
      try { this.instanceManager.unregister(task.agentInstanceId); } catch {}
    }

    // Fanout terminal event
    if (status === 'completed') {
      this._fanout(task, 'done', {
        result: task.result,
        output: task.output,
        durationMs: task.completedAt - task.startedAt,
      });
    } else {
      this._fanout(task, 'error', { message: task.error || status });
    }
    task.subscribers.clear();

    // Schedule TTL cleanup so GET /v1/tasks/:id still works for a window
    task.ttlHandle = setTimeout(() => {
      this._tasks.delete(task.id);
    }, TASK_TTL_MS);
  }

  destroy() {
    this.instanceManager.removeListener('instance:status', this._onStatus);
    this.instanceManager.removeListener('instance:message', this._onMessage);
    this.instanceManager.removeListener('instance:approval', this._onApproval);
    for (const t of this._tasks.values()) {
      if (t.timeoutHandle) clearTimeout(t.timeoutHandle);
      if (t.ttlHandle) clearTimeout(t.ttlHandle);
      if (t.agentInstanceId) {
        const agent = this._agents.get(t.agentInstanceId);
        if (agent) { try { agent.stop(); } catch {} }
        try { this.instanceManager.unregister(t.agentInstanceId); } catch {}
      }
    }
    this._tasks.clear();
    this._agents.clear();
  }
}

function validateInput(input, maxTimeoutMs) {
  if (!input || typeof input !== 'object') {
    const err = new Error('invalid_body');
    err.code = 'invalid_body';
    throw err;
  }
  const { agentType, cwd, prompt, timeoutMs, client } = input;

  if (typeof agentType !== 'string' || !VALID_AGENT_TYPES.has(agentType)) {
    const err = new Error('invalid_agentType');
    err.code = 'invalid_agentType';
    err.validTypes = Array.from(VALID_AGENT_TYPES);
    throw err;
  }
  if (typeof cwd !== 'string' || !cwd.trim()) {
    const err = new Error('invalid_cwd');
    err.code = 'invalid_cwd';
    throw err;
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    const err = new Error('invalid_prompt');
    err.code = 'invalid_prompt';
    throw err;
  }
  if (prompt.length > 50000) {
    const err = new Error('prompt_too_long');
    err.code = 'prompt_too_long';
    throw err;
  }
  if (client !== undefined && client !== null && typeof client !== 'string') {
    const err = new Error('invalid_client');
    err.code = 'invalid_client';
    throw err;
  }
  const resolvedTimeout = (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? Math.min(timeoutMs, maxTimeoutMs)
    : DEFAULT_TIMEOUT_MS;

  return {
    agentType,
    cwd: cwd.trim(),
    prompt: prompt.trim(),
    timeoutMs: resolvedTimeout,
    client: client ? client.slice(0, 64) : null,
  };
}

function waitForAgentSocket(instanceManager, agentId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const inst = instanceManager.get(agentId);
      if (inst && inst.agentSocket && inst.agentSocket.readyState === 1) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('agent_ws_timeout'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

module.exports = {
  GatewayTaskManager,
  VALID_AGENT_TYPES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS_DEFAULT,
  TASK_TTL_MS,
};
