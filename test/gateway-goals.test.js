const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const express = require('express');
const { createGatewayRouter } = require('../src/server/gateway');

// --- Stub task manager (existing /v1/tasks routes need it; not used here) ---

function createStubTaskManager() {
  return {
    _activeTaskCount() { return 0; },
    createTask: async () => { throw new Error('not used'); },
    getTask: () => null,
    cancelTask: () => false,
    subscribe: () => function unsub() {},
    listArtifacts: () => [],
    openArtifact: () => { throw new Error('not used'); },
  };
}

// --- Stub coordinator that emits goal:event so we can drive SSE in tests ---

function createStubCoordinator() {
  const coordinator = new EventEmitter();
  coordinator._goals = new Map();

  coordinator.submitGoal = async function (prompt) {
    const goalId = 'goal-' + Math.random().toString(36).slice(2, 10);
    const goal = {
      id: goalId,
      prompt,
      status: 'running',
      result: null,
      createdAt: Date.now(),
      plan: {
        tasks: [
          { id: 't-1', description: 'step 1', agentType: 'claude', status: 'pending', dependsOn: [] },
        ],
      },
    };
    coordinator._goals.set(goalId, goal);
    setImmediate(() => coordinator.emit('goal:event', { goalId, type: 'planning', prompt, timestamp: Date.now() }));
    setImmediate(() => coordinator.emit('goal:event', {
      goalId, type: 'plan_ready',
      tasks: goal.plan.tasks.map(t => ({ id: t.id, description: t.description, agentType: t.agentType, dependsOn: [] })),
      timestamp: Date.now(),
    }));
    return { goalId };
  };
  coordinator.getActiveGoals = function () { return Array.from(this._goals.values()); };
  coordinator.cancelGoal = function (goalId) {
    const g = this._goals.get(goalId);
    if (g) {
      g.status = 'failed';
      g.result = 'Cancelled by user';
      this.emit('goal:event', { goalId, type: 'cancelled', reason: 'cancelled_by_user', timestamp: Date.now() });
    }
  };
  // Test helper: drive a goal to completion
  coordinator._finish = function (goalId, status) {
    const g = this._goals.get(goalId);
    if (!g) return;
    g.status = status || 'completed';
    g.result = status === 'failed' ? 'failed' : 'ok';
    this.emit('goal:event', {
      goalId, type: status === 'failed' ? 'error' : 'done',
      status: g.status, result: g.result, taskSummaries: [], durationMs: 1,
      timestamp: Date.now(),
    });
  };
  return coordinator;
}

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

const VALID_KEY = 'goals-test-key';
const AUTH = { Authorization: 'Bearer ' + VALID_KEY };

// --- Suites ---

describe('Gateway /v1/goals: mind disabled', () => {
  let harness;
  beforeEach(async () => {
    harness = await startServer({
      taskManager: createStubTaskManager(),
      getKey: () => VALID_KEY,
      // No mind opt — every /v1/goals route should 503
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('POST /v1/goals returns 503 mind_not_enabled', async () => {
    const r = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'do something' }),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'mind_not_enabled');
  });

  it('GET /v1/goals returns 503', async () => {
    const r = await fetch(harness.url + '/v1/goals', { headers: AUTH });
    assert.equal(r.status, 503);
  });
});

describe('Gateway /v1/goals: validation', () => {
  let coordinator, harness;
  beforeEach(async () => {
    coordinator = createStubCoordinator();
    harness = await startServer({
      taskManager: createStubTaskManager(),
      getKey: () => VALID_KEY,
      mind: { coordinator },
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('401 without bearer', async () => {
    const r = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'do it' }),
    });
    assert.equal(r.status, 401);
  });

  it('400 on empty goal', async () => {
    const r = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '   ' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_goal');
  });

  it('400 on missing goal', async () => {
    const r = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  it('400 on overlong goal', async () => {
    const r = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'a'.repeat(50_001) }),
    });
    assert.equal(r.status, 400);
  });

  it('400 on invalid goal id in GET /v1/goals/:id', async () => {
    const r = await fetch(harness.url + '/v1/goals/..%2Fescape', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_goal_id');
  });

  it('400 on invalid goal id in DELETE', async () => {
    const r = await fetch(harness.url + '/v1/goals/garbage', {
      method: 'DELETE', headers: AUTH,
    });
    assert.equal(r.status, 400);
  });

  it('400 on invalid goal id in /stream', async () => {
    const r = await fetch(harness.url + '/v1/goals/nope/stream', { headers: AUTH });
    assert.equal(r.status, 400);
  });
});

describe('Gateway /v1/goals: lifecycle', () => {
  let coordinator, harness;
  beforeEach(async () => {
    coordinator = createStubCoordinator();
    harness = await startServer({
      taskManager: createStubTaskManager(),
      getKey: () => VALID_KEY,
      mind: { coordinator },
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('POST returns 201 + goalId + streamUrl', async () => {
    const r = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'do something' }),
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.match(body.goalId, /^goal-[a-z0-9-]+$/);
    assert.equal(body.streamUrl, '/v1/goals/' + body.goalId + '/stream');
  });

  it('GET /v1/goals lists active goals', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'g1' }),
    });
    const { goalId } = await create.json();

    const r = await fetch(harness.url + '/v1/goals', { headers: AUTH });
    assert.equal(r.status, 200);
    const list = await r.json();
    assert.ok(Array.isArray(list.goals));
    assert.ok(list.goals.find(g => g.id === goalId));
  });

  it('GET /v1/goals/:id returns the goal snapshot', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'inspect me' }),
    });
    const { goalId } = await create.json();
    const r = await fetch(harness.url + '/v1/goals/' + goalId, { headers: AUTH });
    assert.equal(r.status, 200);
    const snap = await r.json();
    assert.equal(snap.id, goalId);
    assert.equal(snap.status, 'running');
    assert.ok(snap.plan);
    assert.ok(Array.isArray(snap.plan.tasks));
  });

  it('404 for unknown goal id', async () => {
    const r = await fetch(harness.url + '/v1/goals/goal-deadbeef', { headers: AUTH });
    assert.equal(r.status, 404);
  });

  it('DELETE cancels a running goal', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'cancel me' }),
    });
    const { goalId } = await create.json();
    const r = await fetch(harness.url + '/v1/goals/' + goalId, { method: 'DELETE', headers: AUTH });
    assert.equal(r.status, 204);
    const after = await fetch(harness.url + '/v1/goals/' + goalId, { headers: AUTH });
    const snap = await after.json();
    assert.equal(snap.status, 'failed');
  });

  it('DELETE 409 on already-terminal goal', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'finish first' }),
    });
    const { goalId } = await create.json();
    coordinator._finish(goalId, 'completed');
    const r = await fetch(harness.url + '/v1/goals/' + goalId, { method: 'DELETE', headers: AUTH });
    assert.equal(r.status, 409);
  });
});

describe('Gateway /v1/goals/:id/stream (SSE)', () => {
  let coordinator, harness;
  beforeEach(async () => {
    coordinator = createStubCoordinator();
    harness = await startServer({
      taskManager: createStubTaskManager(),
      getKey: () => VALID_KEY,
      mind: { coordinator },
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  async function consumeEvents(resp, untilTypes) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    const stops = new Set(untilTypes);
    while (true) {
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
          if (stops.has(type)) return events;
        }
      }
    }
    return events;
  }

  it('sends a snapshot for a running goal, then relays done', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'streamy' }),
    });
    const { goalId } = await create.json();
    const stream = await fetch(harness.url + '/v1/goals/' + goalId + '/stream', { headers: AUTH });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');

    setTimeout(() => coordinator._finish(goalId, 'completed'), 20);

    const events = await consumeEvents(stream, ['done', 'error']);
    const types = events.map(e => e.type);
    // Late subscribers may miss the early events that fired before they
    // connected; the snapshot guarantees they see the current state.
    assert.ok(types.includes('snapshot'), 'snapshot replayed');
    const snap = events.find(e => e.type === 'snapshot');
    assert.equal(snap.data.goalId, goalId);
    assert.ok(snap.data.plan);
    assert.ok(snap.data.plan.tasks.length >= 1);
    assert.ok(types.includes('done'));
    assert.equal(types[types.length - 1], 'done');
  });

  it('replays a synthetic done for already-terminal goals', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'already done' }),
    });
    const { goalId } = await create.json();
    // Finish BEFORE subscribing
    coordinator._finish(goalId, 'completed');
    const stream = await fetch(harness.url + '/v1/goals/' + goalId + '/stream', { headers: AUTH });
    const events = await consumeEvents(stream, ['done']);
    assert.ok(events.find(e => e.type === 'done' && e.data.replayed === true));
  });

  it('relays cancelled event when a goal is cancelled mid-stream', async () => {
    const create = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'cancel midflight' }),
    });
    const { goalId } = await create.json();
    const stream = await fetch(harness.url + '/v1/goals/' + goalId + '/stream', { headers: AUTH });
    setTimeout(() => coordinator.cancelGoal(goalId), 20);
    const events = await consumeEvents(stream, ['cancelled', 'done', 'error']);
    assert.ok(events.find(e => e.type === 'cancelled'));
  });

  it('does not leak events from other goals to this subscriber', async () => {
    const c1 = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'first' }),
    });
    const { goalId: g1 } = await c1.json();
    const c2 = await fetch(harness.url + '/v1/goals', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'second' }),
    });
    const { goalId: g2 } = await c2.json();

    const stream1 = await fetch(harness.url + '/v1/goals/' + g1 + '/stream', { headers: AUTH });
    // Finish goal 2 then goal 1; stream 1 must only see g1 events
    setTimeout(() => { coordinator._finish(g2, 'completed'); }, 10);
    setTimeout(() => { coordinator._finish(g1, 'completed'); }, 30);
    const events = await consumeEvents(stream1, ['done']);
    // All events must carry the right goalId
    for (const e of events) {
      if (e.data && e.data.goalId) assert.equal(e.data.goalId, g1);
    }
  });
});
