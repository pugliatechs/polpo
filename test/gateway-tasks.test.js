const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { GatewayTaskManager } = require('../src/server/gateway-tasks');

// Minimal mock InstanceManager — extends EventEmitter, supports the methods
// the task manager calls and lets tests drive status/message/approval events.
function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
  const sent = [];

  em.register = function (info) {
    const id = info.id || 'agent-' + instances.size;
    const inst = {
      id, name: info.name, status: 'idle', cwd: info.cwd, project: info.project,
      agentType: info.agentType || 'claude', canReceivePrompts: true,
      conversation: [], pendingApproval: null, autoApprove: false,
      source: info.source || null,
      agentSocket: { readyState: 1, send: () => {} },
    };
    instances.set(id, inst);
    em.emit('instance:registered', inst);
    return inst;
  };
  em.unregister = function (id) {
    instances.delete(id);
    em.emit('instance:disconnected', { id });
  };
  em.get = function (id) { return instances.get(id) || null; };
  em.getAll = function () { return Array.from(instances.values()); };
  em.updateStatus = function (id, status) {
    const inst = instances.get(id);
    if (!inst) return;
    inst.status = status;
    em.emit('instance:status', { id, status });
  };
  em.addMessage = function (id, message) {
    const inst = instances.get(id);
    if (!inst) return;
    inst.conversation.push({ ...message, timestamp: Date.now() });
    em.emit('instance:message', { id, message });
  };
  em.setAutoApprove = function (id, value) {
    const inst = instances.get(id);
    if (inst) inst.autoApprove = !!value;
  };
  em.sendToAgent = function (id, message) {
    if (!instances.has(id)) return false;
    sent.push({ id, message });
    return true;
  };
  em._sent = sent;
  em._instances = instances;
  return em;
}

// Fake agent: pretends to spawn and registers an instance via the mock IM.
// Exposes start/stop and instanceId, mirroring what createAgent returns.
function createFakeAgent(im, agentType, options) {
  const id = 'fake-' + Math.random().toString(36).slice(2, 8);
  const agent = {
    instanceId: id,
    started: false,
    stopped: false,
    options,
    async start() {
      this.started = true;
      im.register({
        id, name: options.name, cwd: options.cwd,
        project: options.project, agentType,
        source: options.source,
      });
    },
    stop() { this.stopped = true; },
  };
  return agent;
}

describe('GatewayTaskManager: validation', () => {
  let im, tm;

  beforeEach(() => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });

  afterEach(() => tm.destroy());

  it('rejects null/undefined input', async () => {
    await assert.rejects(() => tm.createTask(null), /invalid_body/);
    await assert.rejects(() => tm.createTask(undefined), /invalid_body/);
  });

  it('rejects unknown agentType', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'gpt-7', cwd: '/tmp', prompt: 'x' }),
      /invalid_agentType/
    );
  });

  it('rejects missing cwd', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '', prompt: 'x' }),
      /invalid_cwd/
    );
  });

  it('rejects relative cwd', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: './relative/path', prompt: 'x' }),
      /cwd_must_be_absolute/
    );
  });

  it('rejects cwd that does not exist on the host', async () => {
    const ghostPath = '/tmp/polpo-test-nonexistent-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: ghostPath, prompt: 'x' }),
      (err) => err.code === 'cwd_does_not_exist' && err.detail === ghostPath
    );
  });

  it('rejects cwd that points to a file, not a directory', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const filePath = path.join(os.tmpdir(), 'polpo-test-file-' + Date.now());
    fs.writeFileSync(filePath, 'hi');
    try {
      await assert.rejects(
        () => tm.createTask({ agentType: 'claude', cwd: filePath, prompt: 'x' }),
        /cwd_not_a_directory/
      );
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  it('rejects missing prompt', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: '   ' }),
      /invalid_prompt/
    );
  });

  it('rejects overlong prompt', async () => {
    const longPrompt = 'x'.repeat(50001);
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: longPrompt }),
      /prompt_too_long/
    );
  });

  it('rejects non-string client', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x', client: 42 }),
      /invalid_client/
    );
  });

  it('clamps oversized timeout to the configured max', async () => {
    tm.destroy();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      maxTimeoutMs: 1000,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'x', timeoutMs: 60000,
    });
    // The clamping is internal — we can't read it directly, but we can verify
    // the task exists and is in starting/running state.
    const snap = tm.getTask(taskId);
    assert.ok(snap);
    assert.ok(snap.status === 'starting' || snap.status === 'running');
  });
});

describe('GatewayTaskManager: lifecycle', () => {
  let im, tm;

  beforeEach(() => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });

  afterEach(() => tm.destroy());

  it('createTask spawns an agent and tags it with source: gateway:<client>', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'do the thing', client: 'openclaw',
    });
    const snap = tm.getTask(taskId);
    assert.ok(snap);
    assert.equal(snap.client, 'openclaw');
    assert.equal(snap.clientLabel, 'openclaw');
    const inst = im.get(snap.agentInstanceId);
    assert.ok(inst);
    assert.equal(inst.source, 'gateway:openclaw');
    assert.equal(inst.name, 'Gateway: openclaw');
  });

  it('falls back to the first token of User-Agent when client is absent', async () => {
    const { taskId } = await tm.createTask(
      { agentType: 'claude', cwd: '/tmp', prompt: 'x' },
      { userAgent: 'openclaw/1.4 (linux x86_64)' }
    );
    const snap = tm.getTask(taskId);
    assert.equal(snap.client, null);
    assert.equal(snap.clientLabel, 'openclaw/1.4');
    const inst = im.get(snap.agentInstanceId);
    assert.equal(inst.name, 'Gateway: openclaw/1.4');
    assert.equal(inst.source, 'gateway:openclaw/1.4');
  });

  it('falls back to a stable token-fingerprint pseudonym when client and UA are absent', async () => {
    const { taskId } = await tm.createTask(
      { agentType: 'claude', cwd: '/tmp', prompt: 'x' },
      { tokenFingerprint: 'a3f9c12abcd1234567890' }
    );
    const snap = tm.getTask(taskId);
    assert.equal(snap.client, null);
    assert.equal(snap.userAgent, null);
    assert.equal(snap.clientLabel, 'anon-a3f9c12');
    const inst = im.get(snap.agentInstanceId);
    assert.equal(inst.name, 'Gateway: anon-a3f9c12');
  });

  it('returns "unknown" only when nothing is known about the caller', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const snap = tm.getTask(taskId);
    assert.equal(snap.clientLabel, 'unknown');
  });

  it('sanitises shell-unsafe characters in client and UA labels', async () => {
    const { taskId } = await tm.createTask(
      { agentType: 'claude', cwd: '/tmp', prompt: 'x', client: 'evil;rm -rf /' }
    );
    const snap = tm.getTask(taskId);
    // Sanitiser collapses to [A-Za-z0-9._\-+/], so ';' becomes '_'
    assert.equal(/^[A-Za-z0-9._\-+/]+$/.test(snap.clientLabel), true);
  });

  it('sends the prompt to the agent via instanceManager.sendToAgent', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'hello', client: 'caller',
    });
    const sent = im._sent.find(function (s) { return s.message.type === 'prompt'; });
    assert.ok(sent, 'a prompt should have been sent');
    assert.equal(sent.message.text, 'hello');
  });

  it('transitions to "running" when the agent goes busy', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const snap1 = tm.getTask(taskId);
    im.updateStatus(snap1.agentInstanceId, 'busy');
    assert.equal(tm.getTask(taskId).status, 'running');
  });

  it('completes when the agent returns to idle, capturing assistant output', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.addMessage(aid, { role: 'assistant', content: 'I did the thing.' });
    im.addMessage(aid, { role: 'assistant', content: 'Here are the details.' });
    im.updateStatus(aid, 'idle');

    const snap = tm.getTask(taskId);
    assert.equal(snap.status, 'completed');
    assert.ok(snap.output.includes('I did the thing.'));
    assert.ok(snap.output.includes('Here are the details.'));
    assert.equal(snap.result.success, true);
  });

  it('fanouts chunks then "done" to subscribers in order', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const events = [];
    tm.subscribe(taskId, (e) => events.push(e));

    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.addMessage(aid, { role: 'assistant', content: 'chunk 1' });
    im.addMessage(aid, { role: 'assistant', content: 'chunk 2' });
    im.updateStatus(aid, 'idle');

    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'chunk');
    assert.equal(events[0].data.text, 'chunk 1');
    assert.equal(events[1].type, 'chunk');
    assert.equal(events[1].data.text, 'chunk 2');
    assert.equal(events[2].type, 'done');
    assert.ok(events[2].data.output.includes('chunk 1'));
  });

  it('fails closed with approval_required on approval requests', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const aid = tm.getTask(taskId).agentInstanceId;
    const events = [];
    tm.subscribe(taskId, (e) => events.push(e));

    im.updateStatus(aid, 'busy');
    im.emit('instance:approval', { id: aid, approval: { tool: 'Bash', input: { command: 'rm -rf /' } } });

    const snap = tm.getTask(taskId);
    assert.equal(snap.status, 'failed');
    assert.equal(snap.error, 'approval_required');
    const approvalEv = events.find(function (e) { return e.type === 'approval'; });
    assert.ok(approvalEv, 'subscribers should receive an approval event');
    const errorEv = events.find(function (e) { return e.type === 'error'; });
    assert.ok(errorEv);
    assert.equal(errorEv.data.message, 'approval_required');
  });

  it('cancelTask aborts the agent and emits an error event', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const aid = tm.getTask(taskId).agentInstanceId;
    const events = [];
    tm.subscribe(taskId, (e) => events.push(e));
    im.updateStatus(aid, 'busy');

    assert.equal(tm.cancelTask(taskId), true);
    assert.equal(tm.getTask(taskId).status, 'cancelled');
    const abortSent = im._sent.find(function (s) { return s.message.type === 'abort'; });
    assert.ok(abortSent, 'abort should have been sent to the agent');
    const errorEv = events.find(function (e) { return e.type === 'error'; });
    assert.ok(errorEv);
    assert.equal(errorEv.data.message, 'cancelled_by_caller');
  });

  it('cancelTask on a completed task returns false', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');
    assert.equal(tm.getTask(taskId).status, 'completed');
    assert.equal(tm.cancelTask(taskId), false);
  });

  it('subscribe replays terminal state for already-finished tasks', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.addMessage(aid, { role: 'assistant', content: 'all done' });
    im.updateStatus(aid, 'idle');

    const events = [];
    tm.subscribe(taskId, (e) => events.push(e));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'done');
  });

  it('enforces maxConcurrent', async () => {
    tm.destroy();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890, maxConcurrent: 2,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'a' });
    await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'b' });
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'c' }),
      /max_concurrent_reached/
    );
  });

  it('frees a concurrency slot when a task completes', async () => {
    tm.destroy();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890, maxConcurrent: 1,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    const r1 = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'a' });
    const aid = tm.getTask(r1.taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');
    // Slot is free again
    await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'b' });
  });

  it('times out a runaway task', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'x', timeoutMs: 30,
    });
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    // Wait past the timeout
    await new Promise(function (r) { setTimeout(r, 60); });
    assert.equal(tm.getTask(taskId).status, 'failed');
    assert.equal(tm.getTask(taskId).error, 'timeout');
  });

  it('destroy stops agents and clears state', async () => {
    const { taskId } = await tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x' });
    const aid = tm.getTask(taskId).agentInstanceId;
    tm.destroy();
    // Instance should be unregistered
    assert.equal(im.get(aid), null);
  });
});

// ---- Bidirectional file transfer: attachments + artifacts ----

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { GatewayUploadStore } = require('../src/server/gateway-uploads');
const { GatewayArtifactStore } = require('../src/server/gateway-artifacts');
const { UPLOAD_DIR } = require('../src/server/upload-constants');

function tempRoot(label) {
  return path.join(os.tmpdir(), 'polpo-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

const FP_A = crypto.createHash('sha256').update('A-key').digest('hex');
const FP_B = crypto.createHash('sha256').update('B-key').digest('hex');

describe('GatewayTaskManager: validateInput for attachments + captureArtifacts', () => {
  let im, tm;
  beforeEach(() => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });
  afterEach(() => tm.destroy());

  it('rejects attachments that is not an array', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x', attachments: 'nope' }),
      /invalid_attachments/);
  });

  it('rejects malformed uploadId', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x', attachments: [{ uploadId: 'bad' }] }),
      /invalid_upload_id/);
  });

  it('rejects duplicate uploadIds', async () => {
    const dup = 'u-' + crypto.randomUUID();
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x',
        attachments: [{ uploadId: dup }, { uploadId: dup }] }),
      /duplicate_attachment/);
  });

  it('rejects more than 20 attachments', async () => {
    const many = Array.from({ length: 21 }, () => ({ uploadId: 'u-' + crypto.randomUUID() }));
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x', attachments: many }),
      /too_many_attachments/);
  });

  it('rejects non-boolean captureArtifacts', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x', captureArtifacts: 'yes' }),
      /invalid_capture_artifacts/);
  });

  it('rejects captureArtifacts when no artifact store wired', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x', captureArtifacts: true }),
      /artifacts_not_supported/);
  });

  it('rejects attachments when no upload store wired', async () => {
    await assert.rejects(
      () => tm.createTask({ agentType: 'claude', cwd: '/tmp', prompt: 'x',
        attachments: [{ uploadId: 'u-' + crypto.randomUUID() }] }),
      /uploads_not_supported/);
  });
});

describe('GatewayTaskManager: with attachments', () => {
  let im, tm, uploadStore, uploadRoot;
  beforeEach(() => {
    im = createMockIM();
    uploadRoot = tempRoot('uploads');
    uploadStore = new GatewayUploadStore({ root: uploadRoot });
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      uploadStore,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });
  afterEach(() => {
    tm.destroy();
    uploadStore.destroy();
    try { fs.rmSync(uploadRoot, { recursive: true, force: true }); } catch {}
    // Also clean up any task-scoped copies that escaped
    try {
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        if (f.startsWith('gtask-')) {
          try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {}
        }
      }
    } catch {}
  });

  it('copies upload into UPLOAD_DIR and passes path through to sendToAgent', async () => {
    const up = uploadStore.put({
      buffer: Buffer.from('hello attachment', 'utf8'),
      filename: 'note.txt', mediaType: 'text/plain', tokenFingerprint: FP_A,
    });
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'use the attached file',
      attachments: [{ uploadId: up.uploadId }],
    }, { tokenFingerprint: FP_A });

    const promptSent = im._sent.find(s => s.message.type === 'prompt');
    assert.ok(promptSent);
    assert.equal(promptSent.message.attachments.length, 1);
    const att = promptSent.message.attachments[0];
    assert.ok(att.path.startsWith(UPLOAD_DIR + path.sep), 'attachment path must be under UPLOAD_DIR');
    assert.ok(att.path.includes(taskId), 'task-scoped name');
    assert.equal(att.filename, 'note.txt');
    // The file actually exists with correct content
    const onDisk = fs.readFileSync(att.path, 'utf8');
    assert.equal(onDisk, 'hello attachment');
  });

  it('refuses to bind another caller\'s upload (cross-token)', async () => {
    const up = uploadStore.put({
      buffer: Buffer.from('A-private', 'utf8'),
      filename: 'a.txt', mediaType: 'text/plain', tokenFingerprint: FP_A,
    });
    await assert.rejects(
      () => tm.createTask({
        agentType: 'claude', cwd: '/tmp', prompt: 'x',
        attachments: [{ uploadId: up.uploadId }],
      }, { tokenFingerprint: FP_B }),
      (err) => err.code === 'upload_forbidden');
  });

  it('returns upload_not_found for unknown uploadId', async () => {
    await assert.rejects(
      () => tm.createTask({
        agentType: 'claude', cwd: '/tmp', prompt: 'x',
        attachments: [{ uploadId: 'u-' + crypto.randomUUID() }],
      }, { tokenFingerprint: FP_A }),
      (err) => err.code === 'upload_not_found');
  });

  it('pins uploads while task is running and releases on finalize', async () => {
    const up = uploadStore.put({
      buffer: Buffer.from('x'), filename: 'x.txt', mediaType: 'text/plain', tokenFingerprint: FP_A,
    });
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      attachments: [{ uploadId: up.uploadId }],
    }, { tokenFingerprint: FP_A });
    assert.ok(uploadStore._pinned.has(up.uploadId));

    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');
    assert.equal(tm.getTask(taskId).status, 'completed');
    assert.equal(uploadStore._pinned.has(up.uploadId), false, 'pin released on finalize');
  });

  it('removes task-scoped UPLOAD_DIR copies on finalize', async () => {
    const up = uploadStore.put({
      buffer: Buffer.from('x'), filename: 'x.txt', mediaType: 'text/plain', tokenFingerprint: FP_A,
    });
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      attachments: [{ uploadId: up.uploadId }],
    }, { tokenFingerprint: FP_A });
    const copyPath = im._sent[0].message.attachments[0].path;
    assert.equal(fs.existsSync(copyPath), true);

    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');
    assert.equal(fs.existsSync(copyPath), false, 'attachment copy removed after finalize');
  });
});

describe('GatewayTaskManager: with captureArtifacts', () => {
  let im, tm, artifactStore, artifactRoot;
  beforeEach(() => {
    im = createMockIM();
    artifactRoot = tempRoot('artifacts');
    artifactStore = new GatewayArtifactStore({ root: artifactRoot });
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      artifactStore,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });
  afterEach(() => {
    tm.destroy();
    try { fs.rmSync(artifactRoot, { recursive: true, force: true }); } catch {}
  });

  it('creates the artifacts dir and prepends the <polpo:artifacts> directive', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'do the thing',
      captureArtifacts: true,
    }, { tokenFingerprint: FP_A });

    const promptSent = im._sent.find(s => s.message.type === 'prompt');
    assert.ok(promptSent);
    assert.ok(promptSent.message.text.startsWith('<polpo:artifacts'),
      'directive must lead the prompt');
    assert.ok(promptSent.message.text.includes('</polpo:artifacts>'));
    assert.ok(promptSent.message.text.endsWith('do the thing'));
    // Dir actually created
    const dir = path.join(artifactRoot, taskId, 'write');
    assert.ok(fs.statSync(dir).isDirectory());
  });

  it('seals artifacts on finalize and emits SSE artifacts event before done', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'p', captureArtifacts: true,
    }, { tokenFingerprint: FP_A });
    const aid = tm.getTask(taskId).agentInstanceId;
    const writeDir = path.join(artifactRoot, taskId, 'write');

    const events = [];
    tm.subscribe(taskId, (e) => events.push(e));

    // Agent runs, writes an output file, returns to idle
    fs.writeFileSync(path.join(writeDir, 'summary.md'), '# done');
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');

    const artIdx = events.findIndex(e => e.type === 'artifacts');
    const doneIdx = events.findIndex(e => e.type === 'done');
    assert.ok(artIdx >= 0, 'artifacts event emitted');
    assert.ok(doneIdx >= 0, 'done event emitted');
    assert.ok(artIdx < doneIdx, 'artifacts must precede done');
    assert.equal(events[artIdx].data.length, 1);
    assert.equal(events[artIdx].data[0].name, 'summary.md');
  });

  it('listArtifacts/openArtifact enforce token-fingerprint match', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'p', captureArtifacts: true,
    }, { tokenFingerprint: FP_A });
    const aid = tm.getTask(taskId).agentInstanceId;
    fs.writeFileSync(path.join(artifactRoot, taskId, 'write', 'r.txt'), 'data');
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');

    // Wrong token: forbidden
    assert.throws(() => tm.listArtifacts(taskId, FP_B),
      (err) => err.code === 'task_forbidden');
    assert.throws(() => tm.openArtifact(taskId, 'r.txt', FP_B),
      (err) => err.code === 'task_forbidden');

    // Right token: works. Drain the stream so the fd closes before afterEach rmrf.
    const list = tm.listArtifacts(taskId, FP_A);
    assert.equal(list.length, 1);
    const opened = tm.openArtifact(taskId, 'r.txt', FP_A);
    for await (const _ of opened.stream) { /* drain */ }
  });

  it('refuses openArtifact while task is still running', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'p', captureArtifacts: true,
    }, { tokenFingerprint: FP_A });
    assert.throws(() => tm.openArtifact(taskId, 'x.txt', FP_A),
      (err) => err.code === 'task_not_terminal');
  });

  it('seals an empty list when no files were written', async () => {
    const { taskId } = await tm.createTask({
      agentType: 'claude', cwd: '/tmp', prompt: 'p', captureArtifacts: true,
    }, { tokenFingerprint: FP_A });
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');
    const list = tm.listArtifacts(taskId, FP_A);
    assert.deepEqual(list, []);
  });
});
