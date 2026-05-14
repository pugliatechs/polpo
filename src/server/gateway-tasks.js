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
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, UPLOAD_ID_REGEX } = require('./upload-constants');

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
    // Optional stores for bidirectional file transfer. Both omitted by
    // default so legacy text-only tasks work unchanged.
    this.uploadStore = opts.uploadStore || null;
    this.artifactStore = opts.artifactStore || null;
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
  async createTask(input, ctx) {
    const args = validateInput(input, this.maxTimeoutMs);
    const requesterFingerprint = ctx && ctx.tokenFingerprint
      ? String(ctx.tokenFingerprint).slice(0, 64)
      : null;

    // Validate captureArtifacts requires the artifact store
    if (args.captureArtifacts && !this.artifactStore) {
      const err = new Error('artifacts_not_supported');
      err.code = 'artifacts_not_supported';
      throw err;
    }
    if (args.attachments.length > 0 && !this.uploadStore) {
      const err = new Error('uploads_not_supported');
      err.code = 'uploads_not_supported';
      throw err;
    }

    const activeCount = this._activeTaskCount();
    if (activeCount >= this.maxConcurrent) {
      const err = new Error('max_concurrent_reached');
      err.code = 'max_concurrent_reached';
      err.activeCount = activeCount;
      err.limit = this.maxConcurrent;
      throw err;
    }

    // Resolve attachments BEFORE assigning a taskId so we fail fast
    // on bad uploadIds and don't leave half-spawned state.
    let resolvedAttachments = [];
    if (args.attachments.length > 0) {
      for (const ref of args.attachments) {
        let resolved;
        try {
          resolved = this.uploadStore.get(ref.uploadId, requesterFingerprint);
        } catch (storeErr) {
          // Re-throw with a deterministic public code.
          const code = storeErr.code || 'upload_not_found';
          const err = new Error(code);
          err.code = code;
          err.uploadId = ref.uploadId;
          throw err;
        }
        resolvedAttachments.push({ ref, resolved });
      }
    }

    const taskId = 'gtask-' + uuidv4().slice(0, 8);
    const task = {
      id: taskId,
      client: args.client,
      agentType: args.agentType,
      cwd: args.cwd,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      captureArtifacts: args.captureArtifacts,
      requesterFingerprint: requesterFingerprint,
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
      // File transfer extensions:
      attachments: resolvedAttachments,            // [{ ref, resolved }]
      copiedAttachmentPaths: [],                   // task-scoped UPLOAD_DIR paths to clean
      artifactsDir: null,                          // write/ dir given to the agent
      artifacts: [],                               // sealed artifact descriptors
    };
    this._tasks.set(taskId, task);

    // Pin uploads to the task so GC doesn't reclaim them mid-use
    for (const a of resolvedAttachments) {
      try { this.uploadStore.pinToTask(a.ref.uploadId, taskId); } catch {}
    }

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

    // 1. Stage attachments: copy each upload into UPLOAD_DIR with a
    //    task-scoped name so WrappedAgent's existing trust boundary
    //    (paths-under-UPLOAD_DIR) accepts them without modification.
    //    Originals stay pinned in the upload store until finalize.
    const attachmentsForAgent = [];
    if (task.attachments.length > 0) {
      try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
      for (const a of task.attachments) {
        const safeBase = `${task.id}-${a.ref.uploadId}-${a.resolved.meta.filename}`;
        // Resolve & prefix-check defensively — safeBase contains only
        // sanitized chars by construction, but never trust by construction.
        const dest = path.resolve(UPLOAD_DIR, safeBase);
        if (!dest.startsWith(UPLOAD_DIR + path.sep)) {
          throw new Error('attachment_path_invalid');
        }
        // Use copyFile (not link) so a later TTL deletion of the
        // upload-store original doesn't surprise the agent.
        fs.copyFileSync(a.resolved.dataPath, dest, fs.constants.COPYFILE_EXCL);
        try { fs.chmodSync(dest, 0o600); } catch {}
        task.copiedAttachmentPaths.push(dest);
        attachmentsForAgent.push({
          path: dest,
          mediaType: a.resolved.meta.mediaType,
          filename: a.resolved.meta.filename,
        });
      }
    }

    // 2. Create artifacts dir if requested. Path is polpo-generated, so
    //    safe to interpolate into the prompt directive below.
    let artifactsBlock = '';
    if (task.captureArtifacts && this.artifactStore) {
      task.artifactsDir = this.artifactStore.createDir(task.id);
      artifactsBlock = buildArtifactsDirective(task.artifactsDir);
    }

    // 3. Compose the final prompt. The <polpo:artifacts> directive is
    //    emitted as a leading block separated by blank lines so caller
    //    text further down can't subvert its parsing.
    const finalPrompt = artifactsBlock
      ? artifactsBlock + '\n\n' + task.prompt
      : task.prompt;

    // 4. Spawn the agent
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
      text: finalPrompt,
      attachments: attachmentsForAgent.length > 0 ? attachmentsForAgent : undefined,
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
    if (task.timeoutHandle) { clearTimeout(task.timeoutHandle); task.timeoutHandle = null; }

    // Stop and unregister the agent BEFORE sealing — the seal pass
    // relies on the agent subprocess being gone so write/ is quiescent.
    if (task.agentInstanceId) {
      const agent = this._agents.get(task.agentInstanceId);
      if (agent) {
        try { agent.stop(); } catch {}
        this._agents.delete(task.agentInstanceId);
      }
      try { this.instanceManager.unregister(task.agentInstanceId); } catch {}
    }

    // Seal artifacts (regardless of completed/failed — the caller may
    // still want partial output even from a failed run)
    if (task.artifactsDir && this.artifactStore) {
      try {
        const { artifacts } = this.artifactStore.sealOnFinalize(task.id);
        task.artifacts = artifacts;
      } catch (sealErr) {
        // Sealing must not block reporting back to the caller; record
        // and continue with no artifacts. Don't leak filesystem details.
        task.artifacts = [];
      }
    }

    if (status === 'completed') {
      task.result = { success: true, summary: task.output.slice(-2000) };
    }

    // Fanout: artifacts event (if any) BEFORE done/error, so consumers
    // can list before the terminal event closes the stream.
    if (task.artifacts && task.artifacts.length > 0) {
      this._fanout(task, 'artifacts', task.artifacts);
    }

    if (status === 'completed') {
      this._fanout(task, 'done', {
        result: task.result,
        output: task.output,
        durationMs: task.completedAt - task.startedAt,
        artifacts: task.artifacts || [],
      });
    } else {
      this._fanout(task, 'error', { message: task.error || status });
    }
    task.subscribers.clear();

    // Clean up the task-scoped UPLOAD_DIR copies (originals stay in
    // the upload store until their own TTL fires)
    for (const p of task.copiedAttachmentPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
    task.copiedAttachmentPaths = [];

    // Release pins so the upload store can GC the originals if expired
    if (this.uploadStore && task.attachments && task.attachments.length > 0) {
      for (const a of task.attachments) {
        try { this.uploadStore.releaseFromTask(a.ref.uploadId, task.id); } catch {}
      }
    }

    // Schedule TTL cleanup so GET /v1/tasks/:id still works for a window,
    // then remove both the task record AND its sealed artifact directory.
    task.ttlHandle = setTimeout(() => {
      if (this.artifactStore) {
        try { this.artifactStore.destroyTask(task.id); } catch {}
      }
      this._tasks.delete(task.id);
    }, TASK_TTL_MS);
  }

  /**
   * Open a sealed artifact for streaming. Enforces:
   *   - task must exist and be terminal
   *   - requesting token must match the task's requester (when known)
   *   - delegates name validation to ArtifactStore.openSealed
   *
   * @returns {{ stream, size, mediaType, isInlineSafe, filename }}
   * @throws  error with .code in:
   *   task_not_found | task_not_terminal | task_forbidden |
   *   artifacts_not_supported | invalid_artifact_name | artifact_not_found
   */
  openArtifact(taskId, name, tokenFingerprint) {
    const t = this._tasks.get(taskId);
    if (!t) {
      const err = new Error('task_not_found'); err.code = 'task_not_found'; throw err;
    }
    if (t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled') {
      const err = new Error('task_not_terminal'); err.code = 'task_not_terminal'; throw err;
    }
    if (t.requesterFingerprint && tokenFingerprint && t.requesterFingerprint !== tokenFingerprint) {
      const err = new Error('task_forbidden'); err.code = 'task_forbidden'; throw err;
    }
    if (!this.artifactStore || !t.artifactsDir) {
      const err = new Error('artifacts_not_supported'); err.code = 'artifacts_not_supported'; throw err;
    }
    const opened = this.artifactStore.openSealed(taskId, name);
    return Object.assign({ filename: name }, opened);
  }

  /**
   * List sealed artifacts for a finished task.
   * @returns {Array<{name,size,mediaType}>}
   */
  listArtifacts(taskId, tokenFingerprint) {
    const t = this._tasks.get(taskId);
    if (!t) {
      const err = new Error('task_not_found'); err.code = 'task_not_found'; throw err;
    }
    if (t.requesterFingerprint && tokenFingerprint && t.requesterFingerprint !== tokenFingerprint) {
      const err = new Error('task_forbidden'); err.code = 'task_forbidden'; throw err;
    }
    return Array.isArray(t.artifacts) ? t.artifacts.slice() : [];
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
      // Clean up any task-scoped attachment copies we left behind
      for (const p of (t.copiedAttachmentPaths || [])) {
        try { fs.unlinkSync(p); } catch {}
      }
      // Release pins and tear down artifact dir
      if (this.uploadStore && t.attachments) {
        for (const a of t.attachments) {
          try { this.uploadStore.releaseFromTask(a.ref.uploadId, t.id); } catch {}
        }
      }
      if (this.artifactStore && t.artifactsDir) {
        try { this.artifactStore.destroyTask(t.id); } catch {}
      }
    }
    this._tasks.clear();
    this._agents.clear();
  }
}

/**
 * Build the `<polpo:artifacts>` system block injected into the prompt.
 * The tag/attribute names are a stable contract with the agent; the
 * caller can never alter this block because it's prepended verbatim,
 * separated from the caller's text by blank lines.
 *
 * The directive deliberately uses an XML-ish form (uncommon in prose)
 * so it's visually distinct, and lists the constraints explicitly so
 * the agent doesn't need to guess.
 */
function buildArtifactsDirective(dir) {
  return [
    `<polpo:artifacts dir="${dir}" max-files="${require('./upload-constants').GATEWAY_TASK_ARTIFACT_MAX_FILES}" max-bytes="${require('./upload-constants').GATEWAY_TASK_AGGREGATE_BYTES}">`,
    'You are running inside polpo\'s gateway. If you produce output files',
    'for the caller, save them into the directory above.',
    'Only regular files written directly into that directory will be',
    'returned. Symlinks, subdirectories, and oversized files are ignored.',
    'Filenames must match [A-Za-z0-9._-] and be at most 200 chars.',
    '</polpo:artifacts>',
  ].join('\n');
}

function validateInput(input, maxTimeoutMs) {
  if (!input || typeof input !== 'object') {
    const err = new Error('invalid_body');
    err.code = 'invalid_body';
    throw err;
  }
  const { agentType, cwd, prompt, timeoutMs, client, attachments, captureArtifacts } = input;

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
  // Verify cwd exists on the host. Node's spawn() raises a misleading
  // ENOENT on the binary when cwd is missing, which has burned us once.
  const trimmedCwd = cwd.trim();
  if (!path.isAbsolute(trimmedCwd)) {
    const err = new Error('cwd_must_be_absolute');
    err.code = 'cwd_must_be_absolute';
    throw err;
  }
  try {
    const st = fs.statSync(trimmedCwd);
    if (!st.isDirectory()) {
      const err = new Error('cwd_not_a_directory');
      err.code = 'cwd_not_a_directory';
      throw err;
    }
  } catch (statErr) {
    if (statErr.code === 'ENOENT') {
      const err = new Error('cwd_does_not_exist');
      err.code = 'cwd_does_not_exist';
      err.detail = trimmedCwd;
      throw err;
    }
    if (statErr.code === 'EACCES') {
      const err = new Error('cwd_not_accessible');
      err.code = 'cwd_not_accessible';
      err.detail = trimmedCwd;
      throw err;
    }
    if (statErr.code === 'cwd_not_a_directory') throw statErr;
    // Unknown stat error — surface it
    throw statErr;
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

  // attachments: optional array of { uploadId }
  let resolvedAttachments = [];
  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) {
      const err = new Error('invalid_attachments');
      err.code = 'invalid_attachments';
      throw err;
    }
    if (attachments.length > 20) {
      // Hard cap on attachment count per task so a caller can't
      // exhaust the in-flight upload pin map.
      const err = new Error('too_many_attachments');
      err.code = 'too_many_attachments';
      err.limit = 20;
      throw err;
    }
    const seen = new Set();
    for (const a of attachments) {
      if (!a || typeof a !== 'object' || typeof a.uploadId !== 'string'
          || !UPLOAD_ID_REGEX.test(a.uploadId)) {
        const err = new Error('invalid_upload_id');
        err.code = 'invalid_upload_id';
        throw err;
      }
      if (seen.has(a.uploadId)) {
        const err = new Error('duplicate_attachment');
        err.code = 'duplicate_attachment';
        throw err;
      }
      seen.add(a.uploadId);
      resolvedAttachments.push({ uploadId: a.uploadId });
    }
  }

  // captureArtifacts: optional boolean
  if (captureArtifacts !== undefined && typeof captureArtifacts !== 'boolean') {
    const err = new Error('invalid_capture_artifacts');
    err.code = 'invalid_capture_artifacts';
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
    attachments: resolvedAttachments,
    captureArtifacts: !!captureArtifacts,
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
