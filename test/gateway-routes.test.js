const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const express = require('express');
const { createGatewayRouter } = require('../src/server/gateway');
const { GatewayTaskManager } = require('../src/server/gateway-tasks');

// --- Reusable mocks (mirrors gateway-tasks.test.js) ---

function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
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
  em.unregister = function (id) { instances.delete(id); };
  em.get = function (id) { return instances.get(id) || null; };
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
  em.setAutoApprove = function () {};
  em.sendToAgent = function (id) { return instances.has(id); };
  em._instances = instances;
  return em;
}

function createFakeAgent(im, agentType, options) {
  const id = 'fake-' + Math.random().toString(36).slice(2, 8);
  return {
    instanceId: id,
    options,
    async start() {
      im.register({
        id, name: options.name, cwd: options.cwd,
        project: options.project, agentType,
        source: options.source,
      });
    },
    stop() {},
  };
}

// --- HTTP harness ---

function startServer(routerOpts) {
  const app = express();
  app.use('/v1', createGatewayRouter(routerOpts));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: 'http://127.0.0.1:' + port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const VALID_KEY = 'test-api-key-12345';
const AUTH = { Authorization: 'Bearer ' + VALID_KEY };

describe('Gateway routes: auth', () => {
  let im, tm, harness;

  beforeEach(async () => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    harness = await startServer({ taskManager: tm, getKey: () => VALID_KEY });
  });

  afterEach(async () => {
    tm.destroy();
    await closeServer(harness.server);
  });

  it('rejects requests without Authorization', async () => {
    const r = await fetch(harness.url + '/v1/health');
    assert.equal(r.status, 401);
  });

  it('rejects wrong bearer token', async () => {
    const r = await fetch(harness.url + '/v1/health', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    assert.equal(r.status, 401);
  });

  it('accepts the correct bearer token', async () => {
    const r = await fetch(harness.url + '/v1/health', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.version === 'string');
  });
});

describe('Gateway routes: POST /v1/tasks', () => {
  let im, tm, harness;

  beforeEach(async () => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    harness = await startServer({ taskManager: tm, getKey: () => VALID_KEY });
  });

  afterEach(async () => {
    tm.destroy();
    await closeServer(harness.server);
  });

  it('creates a task and returns 201 with taskId + streamUrl', async () => {
    const r = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'hello' }),
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(typeof body.taskId === 'string');
    assert.equal(body.streamUrl, '/v1/tasks/' + body.taskId + '/stream');
  });

  it('400 on missing agentType', async () => {
    const r = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', prompt: 'hi' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'invalid_agentType');
    assert.ok(Array.isArray(body.validTypes));
  });

  it('400 on missing cwd', async () => {
    const r = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', prompt: 'hi' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_cwd');
  });

  it('honors X-Polpo-Client header for source tagging', async () => {
    const r = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json', 'X-Polpo-Client': 'openclaw' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'x' }),
    });
    const body = await r.json();
    const snap = tm.getTask(body.taskId);
    assert.equal(snap.client, 'openclaw');
    const inst = im.get(snap.agentInstanceId);
    assert.equal(inst.source, 'gateway:openclaw');
  });

  it('429 when max_concurrent_reached', async () => {
    tm.destroy();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890, maxConcurrent: 1,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    await closeServer(harness.server);
    harness = await startServer({ taskManager: tm, getKey: () => VALID_KEY });

    await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'a' }),
    });
    const r2 = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'b' }),
    });
    assert.equal(r2.status, 429);
    const body = await r2.json();
    assert.equal(body.error, 'max_concurrent_reached');
    assert.equal(body.limit, 1);
  });
});

describe('Gateway routes: GET /v1/tasks/:id', () => {
  let im, tm, harness;

  beforeEach(async () => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    harness = await startServer({ taskManager: tm, getKey: () => VALID_KEY });
  });

  afterEach(async () => {
    tm.destroy();
    await closeServer(harness.server);
  });

  it('returns a task snapshot', async () => {
    const create = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'x' }),
    });
    const { taskId } = await create.json();
    const r = await fetch(harness.url + '/v1/tasks/' + taskId, { headers: AUTH });
    assert.equal(r.status, 200);
    const snap = await r.json();
    assert.equal(snap.id, taskId);
    assert.ok(snap.status === 'starting' || snap.status === 'running');
  });

  it('404 for unknown id', async () => {
    const r = await fetch(harness.url + '/v1/tasks/nope', { headers: AUTH });
    assert.equal(r.status, 404);
  });
});

describe('Gateway routes: DELETE /v1/tasks/:id', () => {
  let im, tm, harness;

  beforeEach(async () => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    harness = await startServer({ taskManager: tm, getKey: () => VALID_KEY });
  });

  afterEach(async () => {
    tm.destroy();
    await closeServer(harness.server);
  });

  it('cancels a running task with 204', async () => {
    const create = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'x' }),
    });
    const { taskId } = await create.json();
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');

    const r = await fetch(harness.url + '/v1/tasks/' + taskId, { method: 'DELETE', headers: AUTH });
    assert.equal(r.status, 204);
    assert.equal(tm.getTask(taskId).status, 'cancelled');
  });

  it('409 if task already completed', async () => {
    const create = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'x' }),
    });
    const { taskId } = await create.json();
    const aid = tm.getTask(taskId).agentInstanceId;
    im.updateStatus(aid, 'busy');
    im.updateStatus(aid, 'idle');

    const r = await fetch(harness.url + '/v1/tasks/' + taskId, { method: 'DELETE', headers: AUTH });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error, 'task_already_terminal');
    assert.equal(body.status, 'completed');
  });

  it('404 for unknown id', async () => {
    const r = await fetch(harness.url + '/v1/tasks/nope', { method: 'DELETE', headers: AUTH });
    assert.equal(r.status, 404);
  });
});

describe('Gateway routes: GET /v1/tasks/:id/stream (SSE)', () => {
  let im, tm, harness;

  beforeEach(async () => {
    im = createMockIM();
    tm = new GatewayTaskManager({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
    harness = await startServer({ taskManager: tm, getKey: () => VALID_KEY });
  });

  afterEach(async () => {
    tm.destroy();
    await closeServer(harness.server);
  });

  it('streams chunks then done as SSE events', async () => {
    const create = await fetch(harness.url + '/v1/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude', cwd: '/tmp', prompt: 'x' }),
    });
    const { taskId } = await create.json();
    const aid = tm.getTask(taskId).agentInstanceId;

    const streamResp = await fetch(harness.url + '/v1/tasks/' + taskId + '/stream', { headers: AUTH });
    assert.equal(streamResp.status, 200);
    assert.equal(streamResp.headers.get('content-type'), 'text/event-stream');

    // Drive the task in the background, then read the stream
    setTimeout(() => {
      im.updateStatus(aid, 'busy');
      im.addMessage(aid, { role: 'assistant', content: 'partial output' });
      im.updateStatus(aid, 'idle');
    }, 20);

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    while (events.findIndex(function (e) { return e.type === 'done' || e.type === 'error'; }) === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();
      for (const block of blocks) {
        const lines = block.split('\n');
        let type = null, data = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) type = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (type) {
          events.push({ type, data: data ? JSON.parse(data) : null });
        }
      }
    }

    const chunkEv = events.find(function (e) { return e.type === 'chunk'; });
    assert.ok(chunkEv);
    assert.equal(chunkEv.data.text, 'partial output');
    const doneEv = events.find(function (e) { return e.type === 'done'; });
    assert.ok(doneEv);
    assert.ok(doneEv.data.output.includes('partial output'));
  });

  it('404 SSE for unknown task id', async () => {
    const r = await fetch(harness.url + '/v1/tasks/nope/stream', { headers: AUTH });
    assert.equal(r.status, 404);
  });
});
