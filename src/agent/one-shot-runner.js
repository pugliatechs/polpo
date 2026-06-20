/**
 * OneShotAgentRunner — the shared spawn → prompt → terminate lifecycle
 * primitive consumed by GatewayTaskManager (HTTP /v1/tasks) AND by the
 * Alien Mind coordinator (internal goal decomposition).
 *
 * One run = one agent instance + one prompt + one captured result.
 * Agents always terminate at the end of a run; there is no pool, no
 * reuse, no multi-turn conversation. Higher-level orchestration (a
 * gateway task, a mind goal) composes runs.
 *
 * Why this shape:
 *   - Single execution mechanism makes hardening (timeout, approval
 *     fail-closed, structured logs, source tags) apply uniformly.
 *   - Stateless agents make every "thought" auditable and isolated,
 *     and let the caller hold the only durable state.
 *   - Eliminates duplicated spawn lifecycles previously living in
 *     gateway-tasks.js and mind/agent-pool.js.
 *
 * Threading model:
 *   - The runner installs ONE set of listeners on the instanceManager
 *     ('instance:status', 'instance:message', 'instance:approval') and
 *     dispatches each event to the matching run via an internal map.
 *   - Concurrent runs are isolated — they only share the runner's
 *     listener subscriptions, not their state.
 *
 * What the runner does NOT do (intentionally — caller concerns):
 *   - File staging (upload→UPLOAD_DIR copy lives in the gateway)
 *   - Artifact directory creation/sealing (gateway artifactStore)
 *   - HTTP / SSE fanout
 *   - Rate limiting, auth, request validation
 *   - Goal-level replanning, dependency graphs (mind coordinator)
 *
 * The caller pre-composes the prompt string, pre-stages attachment
 * paths, and chooses the `name`/`source` tags.
 */

'use strict';

const { EventEmitter } = require('events');
const { createAgent } = require('./agent-factory');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min — same as gateway
const WS_READY_TIMEOUT_MS = 5000;

class OneShotAgentRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {number} opts.hubPort         WS port the agent dials back into
   * @param {string} [opts.hubToken]      auth token for agent registration
   * @param {boolean} [opts.autoApprove=true]  bypass permissions by default
   * @param {function} [opts.createAgent] injectable agent factory (for tests)
   * @param {function} [opts.waitForSocket] injectable socket-ready waiter (for tests)
   */
  constructor(opts) {
    super();
    if (!opts || !opts.instanceManager) throw new Error('instanceManager is required');
    if (!opts.hubPort) throw new Error('hubPort is required');

    this.instanceManager = opts.instanceManager;
    this.hubPort = opts.hubPort;
    this.hubToken = opts.hubToken || null;
    this.autoApprove = opts.autoApprove !== false;

    this._createAgent = opts.createAgent || createAgent;
    this._waitForSocket = opts.waitForSocket || waitForAgentSocket;

    // agentInstanceId -> RunRecord
    this._runs = new Map();
    this._wired = false;
    this._wire();
  }

  /**
   * Run an agent on a single prompt, resolve with the captured result
   * when it terminates (idle / timeout / approval / external cancel).
   *
   * The returned promise NEVER rejects on a normal agent failure — it
   * resolves with `{ status: 'failed', error }`. It rejects only on
   * programmer errors (bad args, spawn failure before lifecycle starts).
   *
   * @param {object} opts
   * @param {string} opts.agentType       'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'goose'
   * @param {string} opts.cwd             absolute cwd for the agent process
   * @param {string} opts.prompt          fully-composed prompt text
   * @param {string} opts.name            instance display name ("Gateway: openclaw")
   * @param {string} opts.source          origin tag ("gateway:openclaw", "mind:goal-42")
   * @param {string} [opts.project]       project label; defaults to basename(cwd)
   * @param {number} [opts.timeoutMs]     per-run deadline (default 5 min)
   * @param {Array}  [opts.attachments]   [{ path, mediaType, filename }] pre-staged
   * @param {string} [opts.permissionMode] 'bypass' | 'default' (overrides autoApprove)
   * @param {string} [opts.model]         optional model override
   * @param {function(string)} [opts.onSpawn]   called once with the agent instance id
   * @param {function(string)} [opts.onStatus]  called on status transitions
   *                                            (`'running'` on first busy)
   * @param {function(string)} [opts.onChunk]   called for each assistant chunk
   * @param {function(object)} [opts.onApproval] called when the agent requests approval
   * @param {function(object)} [opts.onTerminal] called SYNCHRONOUSLY inside the
   *   terminal-state transition, immediately before the run promise resolves.
   *   The argument has the same shape as the promise's resolved value
   *   (`{status, output, error, durationMs, agentInstanceId}`). Use this
   *   when a caller needs to commit terminal state in the same tick as
   *   the triggering event (e.g. the gateway needs `task.status` to be
   *   `'completed'` the instant the agent goes idle, not on the next
   *   microtask). The promise still resolves with the same value.
   * @returns {Promise<{status:'completed'|'failed'|'cancelled', output:string,
   *                    error:?string, durationMs:number, agentInstanceId:string}>}
   */
  async run(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('run(opts) requires an options object');
    }
    if (!opts.agentType || !opts.cwd || !opts.prompt || !opts.name || !opts.source) {
      throw new TypeError('run(opts) requires agentType, cwd, prompt, name, source');
    }

    const startedAt = Date.now();
    const timeoutMs = (opts.timeoutMs && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const permissionMode = opts.permissionMode
      || (this.autoApprove ? 'bypass' : 'default');
    const project = opts.project
      || require('path').basename(opts.cwd);

    // 1. Spawn the agent. createAgent throws synchronously on bad args
    //    (unknown type). agent.start() is async and may reject — let it
    //    propagate as a programmer-visible error.
    const agentSpawnOpts = {
      name: opts.name,
      cwd: opts.cwd,
      serverUrl: 'ws://127.0.0.1:' + this.hubPort,
      token: this.hubToken,
      type: 'terminal',
      project: project,
      source: opts.source,
      permissionMode: permissionMode,
    };
    if (opts.model) agentSpawnOpts.model = opts.model;
    const agent = this._createAgent(opts.agentType, agentSpawnOpts);

    await agent.start();
    const agentInstanceId = agent.instanceId;

    if (this.autoApprove) {
      try { this.instanceManager.setAutoApprove(agentInstanceId, true); } catch {}
    }

    // Force the source tag in case the agent type's register() didn't
    // forward it (the factory's contract here is loose).
    const inst = this.instanceManager.get(agentInstanceId);
    if (inst && !inst.source) inst.source = opts.source;

    if (typeof opts.onSpawn === 'function') {
      try { opts.onSpawn(agentInstanceId); } catch {}
    }

    // 2. Build the run record. Held in the map BEFORE the prompt is
    //    sent so any event arriving during the await is routed correctly.
    const record = {
      agentInstanceId: agentInstanceId,
      agent: agent,
      startedAt: startedAt,
      status: 'starting',
      output: '',
      error: null,
      timeoutHandle: null,
      onChunk: typeof opts.onChunk === 'function' ? opts.onChunk : null,
      onApproval: typeof opts.onApproval === 'function' ? opts.onApproval : null,
      onStatus: typeof opts.onStatus === 'function' ? opts.onStatus : null,
      onTerminal: typeof opts.onTerminal === 'function' ? opts.onTerminal : null,
      resolve: null,   // set just below
    };
    this._runs.set(agentInstanceId, record);

    return new Promise((resolve) => {
      record.resolve = resolve;

      const finalize = (status, errorMsg) => this._finalize(record, status, errorMsg);

      // 3. Wait for the agent's WS to be ready, then arm the timeout
      //    BEFORE sending the prompt so a hung start still trips it.
      this._waitForSocket(this.instanceManager, agentInstanceId, WS_READY_TIMEOUT_MS)
        .then(() => {
          if (record.status !== 'starting') return; // already finalized (cancel)
          record.timeoutHandle = setTimeout(() => {
            this._abort(agentInstanceId);
            finalize('failed', 'timeout');
          }, timeoutMs);

          const attachments = Array.isArray(opts.attachments) && opts.attachments.length > 0
            ? opts.attachments
            : undefined;

          const sent = this.instanceManager.sendToAgent(agentInstanceId, {
            type: 'prompt',
            text: opts.prompt,
            attachments: attachments,
          });
          if (!sent) {
            finalize('failed', 'agent_send_failed');
          }
        })
        .catch((err) => {
          finalize('failed', (err && err.message) || 'agent_ws_timeout');
        });
    });
  }

  /**
   * Cancel a run from the outside. The run resolves with status 'cancelled'.
   * No-op if the agent already finished.
   */
  cancel(agentInstanceId) {
    const r = this._runs.get(agentInstanceId);
    if (!r) return false;
    if (this._isTerminal(r.status)) return false;
    this._abort(agentInstanceId);
    this._finalize(r, 'cancelled', 'cancelled_by_caller');
    return true;
  }

  /**
   * Tear down the runner: detach listeners and abort any in-flight runs.
   */
  destroy() {
    this.instanceManager.removeListener('instance:status', this._onStatus);
    this.instanceManager.removeListener('instance:message', this._onMessage);
    this.instanceManager.removeListener('instance:approval', this._onApproval);
    for (const r of this._runs.values()) {
      if (r.timeoutHandle) clearTimeout(r.timeoutHandle);
      if (r.agent) { try { r.agent.stop(); } catch {} }
      try { this.instanceManager.unregister(r.agentInstanceId); } catch {}
    }
    this._runs.clear();
  }

  // --- internals ---------------------------------------------------------

  _wire() {
    if (this._wired) return;
    this._wired = true;
    this._onStatus = (data) => this._routeStatus(data);
    this._onMessage = (data) => this._routeMessage(data);
    this._onApproval = (data) => this._routeApproval(data);
    this.instanceManager.on('instance:status', this._onStatus);
    this.instanceManager.on('instance:message', this._onMessage);
    this.instanceManager.on('instance:approval', this._onApproval);
  }

  _routeStatus(data) {
    const r = this._runs.get(data && data.id);
    if (!r) return;
    if (r.status === 'starting' && data.status === 'busy') {
      r.status = 'running';
      if (r.onStatus) { try { r.onStatus('running'); } catch {} }
    } else if (r.status === 'running' && data.status === 'idle') {
      this._finalize(r, 'completed', null);
    }
  }

  _routeMessage(data) {
    const r = this._runs.get(data && data.id);
    if (!r) return;
    const msg = data.message;
    if (!msg || msg.role !== 'assistant') return;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text) return;
    r.output += (r.output ? '\n' : '') + text;
    if (r.onChunk) {
      try { r.onChunk(text); } catch {}
    }
  }

  _routeApproval(data) {
    const r = this._runs.get(data && data.id);
    if (!r || !data.approval) return;
    // One-shot runs fail closed on approvals: there is no human in the
    // loop. Callers wanting interactive approvals must drive an
    // instance directly, not through the runner.
    if (r.onApproval) {
      try { r.onApproval(data.approval); } catch {}
    }
    this._abort(data.id);
    this._finalize(r, 'failed', 'approval_required');
  }

  _isTerminal(status) {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  _abort(agentInstanceId) {
    try { this.instanceManager.sendToAgent(agentInstanceId, { type: 'abort' }); } catch {}
  }

  /**
   * Move a run to a terminal state exactly once. Cleans up the timeout,
   * stops the agent, resolves the promise. Subsequent calls are no-ops.
   */
  _finalize(record, status, errorMsg) {
    if (this._isTerminal(record.status)) return;
    record.status = status;
    if (errorMsg) record.error = errorMsg;
    if (record.timeoutHandle) {
      clearTimeout(record.timeoutHandle);
      record.timeoutHandle = null;
    }

    // Stop the agent subprocess and unregister BEFORE resolving so
    // the caller sees a fully torn-down world.
    if (record.agent) {
      try { record.agent.stop(); } catch {}
      record.agent = null;
    }
    try { this.instanceManager.unregister(record.agentInstanceId); } catch {}

    const durationMs = Date.now() - record.startedAt;
    const result = {
      status: status,
      output: record.output,
      error: record.error,
      durationMs: durationMs,
      agentInstanceId: record.agentInstanceId,
    };

    // Drop the record from the live map; further events for this agent
    // id are ignored. The caller still has `result` for record-keeping.
    this._runs.delete(record.agentInstanceId);

    // Synchronous terminal hook fires BEFORE the promise resolves so
    // callers like the gateway can commit task state in the same tick
    // as the triggering event.
    if (record.onTerminal) { try { record.onTerminal(result); } catch {} }

    if (typeof record.resolve === 'function') {
      const r = record.resolve;
      record.resolve = null;
      r(result);
    }
    this.emit('run:done', result);
  }
}

/**
 * Default WS-ready waiter — polls instanceManager every 100 ms until the
 * agent's WebSocket reports OPEN, or the deadline expires.
 */
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
  OneShotAgentRunner,
  DEFAULT_TIMEOUT_MS,
  WS_READY_TIMEOUT_MS,
  waitForAgentSocket,
};
