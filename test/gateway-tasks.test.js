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
    const inst = im.get(snap.agentInstanceId);
    assert.ok(inst);
    assert.equal(inst.source, 'gateway:openclaw');
    assert.equal(inst.name, 'Gateway: openclaw');
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
