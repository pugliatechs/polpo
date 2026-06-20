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
const { OneShotAgentRunner } = require('../agent/one-shot-runner');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, UPLOAD_ID_REGEX } = require('./upload-constants');
const { makeLogger } = require('../util/logger');

const log = makeLogger('gateway');

const VALID_AGENT_TYPES = new Set(['claude', 'codex', 'gemini', 'opencode', 'pi', 'goose']);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min
const MAX_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;  // 30 min
const TASK_TTL_MS = 5 * 60 * 1000;              // keep completed tasks for 5 min

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

    // All spawn-and-lifecycle work is delegated to the shared runner —
    // the gateway is now ~purely concerned with HTTP-side concerns
    // (validation, rate limiting, attachments, artifact sealing, SSE
    // fanout, TTL of completed tasks). The runner is also consumed by
    // the Alien Mind coordinator so both call sites share hardening.
    this._runner = opts.runner || new OneShotAgentRunner({
      instanceManager: this.instanceManager,
      hubPort: this.hubPort,
      hubToken: this.hubToken,
      autoApprove: this.autoApprove,
      createAgent: opts.createAgent,        // injectable in tests
      waitForSocket: opts.waitForSocket,    // injectable in tests
    });
    // When opts.runner is provided we don't own it — caller manages
    // destroy(). Otherwise we own the runner we created here.
    this._ownsRunner = !opts.runner;

    this._tasks = new Map();      // taskId -> task record
    this._agentToTask = new Map(); // agentInstanceId -> taskId
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
    const userAgent = ctx && typeof ctx.userAgent === 'string'
      ? ctx.userAgent.slice(0, 200)
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
      userAgent: userAgent,
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
      clientLabel: t.clientLabel || resolveClientLabel(t),
      userAgent: t.userAgent || null,
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
   * Cancel a running task. The runner takes care of aborting the agent
   * and resolving the in-flight run; our runPromise.then() callback
   * above then calls _finalize with status 'cancelled'.
   */
  cancelTask(taskId) {
    const t = this._tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
      return false;
    }
    if (t.agentInstanceId) {
      // Synchronously finalize so callers can observe 'cancelled' on the
      // next getTask() — runner.cancel resolves the run promise but our
      // .then() callback isn't yet scheduled.
      this._runner.cancel(t.agentInstanceId);
    }
    if (!(t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) {
      this._finalize(t, 'cancelled', { error: 'cancelled_by_caller' });
    }
    return true;
  }

  /**
   * Emit one structured, grep-friendly log line per task spawn.
   *
   * Carries the resolved client label, token fingerprint (the sha256
   * already used for rate limiting -- safe to log), agent type, cwd,
   * prompt length, attachment count, and whether auto-approve is on.
   * Caller content (prompt text, header values beyond UA, attachment
   * bytes) is NOT logged.
   */
  _logTaskSpawn(task, clientLabel) {
    const fp = task.requesterFingerprint
      ? task.requesterFingerprint.slice(0, 8)
      : '-';
    const ua = task.userAgent
      ? '"' + task.userAgent.replace(/"/g, '\\"') + '"'
      : '-';
    const parts = [
      'task=' + task.id,
      'client=' + clientLabel,
      'token-fp=' + fp,
      'agent=' + task.agentType,
      'ua=' + ua,
      'cwd=' + task.cwd,
      'prompt-len=' + (task.prompt ? task.prompt.length : 0),
      'attachments=' + (task.attachments ? task.attachments.length : 0),
      'capture-artifacts=' + !!task.captureArtifacts,
      'auto-approve=' + !!this.autoApprove,
    ];
    log.info(parts.join(' '));
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
   * Look up the gateway task that owns a given agent instance id.
   * Used by the runner callbacks below to route per-task fanout.
   */
  _findTaskByAgent(agentInstanceId) {
    if (!agentInstanceId) return null;
    const taskId = this._agentToTask.get(agentInstanceId);
    if (!taskId) return null;
    return this._tasks.get(taskId) || null;
  }

  async _spawnAndStart(task) {
    const clientLabel = resolveClientLabel(task);
    // Stash the resolved label so the API surfaces it consistently
    // (instead of recomputing the ladder in every consumer).
    task.clientLabel = clientLabel;
    this._logTaskSpawn(task, clientLabel);

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

    // 4. Hand off to the shared one-shot runner. The runner owns the
    //    spawn, WS handshake, timeout arming, prompt send, status/
    //    message/approval routing, and agent teardown. We only translate
    //    its callbacks into task state + SSE fanout, and gateway-specific
    //    finalize work (artifact sealing, TTL, upload pin release).
    const runPromise = this._runner.run({
      agentType: task.agentType,
      cwd: task.cwd,
      prompt: finalPrompt,
      name: 'Gateway: ' + clientLabel,
      source: 'gateway:' + clientLabel,
      project: path.basename(task.cwd),
      timeoutMs: task.timeoutMs,
      attachments: attachmentsForAgent.length > 0 ? attachmentsForAgent : undefined,

      onSpawn: (agentInstanceId) => {
        task.agentInstanceId = agentInstanceId;
        this._agentToTask.set(agentInstanceId, task.id);
      },
      onStatus: (next) => {
        // Only forward the 'running' transition. Terminal states arrive
        // via the awaited run result below so the gateway can do its
        // sealing/fanout in one place.
        if (task.status === 'starting' && next === 'running') {
          task.status = 'running';
        }
      },
      onChunk: (text) => {
        // Mirror chunk into the task's output buffer and broadcast to SSE
        // subscribers. The runner already keeps its own copy, but the
        // gateway needs an authoritative buffer for the final result snapshot.
        task.output += (task.output ? '\n' : '') + text;
        this._fanout(task, 'chunk', { text });
      },
      onApproval: (approvalReq) => {
        // Surface to subscribers before the runner finalises with
        // approval_required, so SSE consumers see the request payload.
        this._fanout(task, 'approval', { request: approvalReq });
      },
      onTerminal: (result) => {
        // Synchronous with the triggering event so callers (and tests)
        // observe the terminal task.status without waiting a tick.
        if (task.agentInstanceId) this._agentToTask.delete(task.agentInstanceId);
        if (result.status === 'completed') {
          this._finalize(task, 'completed', null);
        } else if (result.status === 'cancelled') {
          this._finalize(task, 'cancelled', { error: result.error || 'cancelled' });
        } else {
          this._finalize(task, 'failed', { error: result.error || 'failed' });
        }
      },
    });

    // Even though onTerminal does the work, we still attach a catch so
    // a programmer error in start-up doesn't surface as an unhandled
    // rejection. Real failures show up as `status: 'failed'` in onTerminal.
    runPromise.catch((err) => {
      if (task.agentInstanceId) this._agentToTask.delete(task.agentInstanceId);
      this._finalize(task, 'failed', { error: (err && err.message) || 'run_failed' });
    });
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
    // Agent stop + unregister happen inside the runner before we get
    // here; nothing for the gateway to clean up on that front. The
    // task-side agentInstanceId is kept on the task record so callers
    // can still correlate (it's the same id used for the source tag).

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
    // Tear down the runner first — that aborts in-flight runs, which
    // resolves their promises with status 'cancelled' and triggers the
    // .then() in _spawnAndStart that finalises each task. Skip when the
    // runner was injected by an outer owner.
    if (this._ownsRunner && this._runner) {
      try { this._runner.destroy(); } catch {}
    }
    for (const t of this._tasks.values()) {
      if (t.ttlHandle) clearTimeout(t.ttlHandle);
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
    this._agentToTask.clear();
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
/**
 * Pick the most informative human-readable label for a gateway caller.
 * Order of preference:
 *   1. Explicit `client` from body or X-Polpo-Client header
 *   2. First whitespace-delimited token of the User-Agent header
 *      (e.g. "openclaw/1.4 (linux)" -> "openclaw/1.4")
 *   3. Stable per-token pseudonym derived from the bearer fingerprint
 *      ("anon-<7 chars>"), which is the sha256 hash already used for
 *      rate limiting -- not the secret itself.
 *   4. "unknown" only when the caller is literally unidentifiable
 *      (no auth, no UA, no client field), which should be impossible
 *      in production because auth is required.
 *
 * The result is sanitised so it can be safely composed into strings
 * like "Gateway: <label>" or "gateway:<label>".
 */
function resolveClientLabel(task) {
  const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._\-+/]/g, '_').slice(0, 32);
  if (task && typeof task.client === 'string' && task.client.trim()) {
    return sanitize(task.client.trim());
  }
  if (task && typeof task.userAgent === 'string' && task.userAgent.trim()) {
    const firstToken = task.userAgent.trim().split(/\s+/)[0];
    if (firstToken) return sanitize(firstToken);
  }
  if (task && typeof task.requesterFingerprint === 'string' && task.requesterFingerprint) {
    return 'anon-' + task.requesterFingerprint.slice(0, 7);
  }
  return 'unknown';
}

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

module.exports = {
  GatewayTaskManager,
  VALID_AGENT_TYPES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS_DEFAULT,
  TASK_TTL_MS,
};
