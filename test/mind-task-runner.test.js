const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { TaskRunner } = require('../src/mind/task-runner');

// Mock InstanceManager
function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
  const sent = [];
  em.register = function (info) {
    const id = info.id || 'inst-' + instances.size;
    const inst = { id, name: info.name || 'Test', status: 'idle', cwd: info.cwd || '/tmp',
      project: info.project || 'test', agentType: info.agentType || 'claude',
      canReceivePrompts: true, conversationLength: 0 };
    instances.set(id, inst);
    return inst;
  };
  em.get = function (id) { return instances.get(id) || null; };
  em.getAll = function () { return [...instances.values()]; };
  em.updateStatus = function (id, status) {
    const inst = instances.get(id);
    if (inst) { inst.status = status; em.emit('instance:status', { id, status }); }
  };
  em.sendToAgent = function (id, msg) { sent.push({ id, msg }); return instances.has(id); };
  em.setAutoApprove = function () {};
  em.unregister = function (id) { instances.delete(id); };
  em._sent = sent;
  em._instances = instances;
  return em;
}

// Mock AgentPool
function createMockPool(im) {
  const assigned = new Map();
  return {
    acquire: async function (task) {
      // Find first unassigned idle agent
      const all = im.getAll();
      for (const a of all) {
        if (a.status === 'idle' && !assigned.has(a.id)) {
          assigned.set(a.id, task.id);
          return a.id;
        }
      }
      return null;
    },
    release: function (agentId) { assigned.delete(agentId); },
    getAssignment: function (agentId) { return assigned.get(agentId) || null; },
    isAssigned: function (agentId) { return assigned.has(agentId); },
    destroy: function () { assigned.clear(); },
  };
}

function makeTasks(specs) {
  return specs.map(function (s, i) {
    return {
      id: 'task-' + i,
      index: i,
      description: s.desc || 'Task ' + i,
      agentType: s.agentType || 'claude',
      targetCwd: s.cwd || '/tmp',
      prompt: s.prompt || 'do task ' + i,
      dependsOn: s.dependsOn || [],
      status: 'pending',
      agentId: null,
      result: null,
      startedAt: null,
      completedAt: null,
    };
  });
}

describe('TaskRunner', () => {
  let im;
  let pool;
  let runner;

  beforeEach(() => {
    im = createMockIM();
    pool = createMockPool(im);
  });

  afterEach(() => {
    if (runner) runner.destroy();
  });

  it('runs independent tasks in parallel', async () => {
    im.register({ id: 'a1' });
    im.register({ id: 'a2' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([
      { desc: 'Task A' },
      { desc: 'Task B' },
    ]);

    var promise = runner.execute(tasks);

    // Wait for async agent acquisition
    await new Promise(function (r) { setTimeout(r, 20); });

    // Both tasks should be dispatched
    assert.equal(tasks[0].status, 'running');
    assert.equal(tasks[1].status, 'running');

    // Complete both
    im.updateStatus('a1', 'idle');
    im.updateStatus('a2', 'idle');

    var result = await promise;
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
  });

  it('runs sequential tasks in order', async () => {
    im.register({ id: 'a1' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([
      { desc: 'First' },
      { desc: 'Second', dependsOn: [0] },
    ]);

    var promise = runner.execute(tasks);
    await new Promise(function (r) { setTimeout(r, 20); });

    // Only first should be running
    assert.equal(tasks[0].status, 'running');
    assert.equal(tasks[1].status, 'pending');

    // Complete first
    im.updateStatus('a1', 'idle');
    await new Promise(function (r) { setTimeout(r, 20); });

    // Second should now be running
    assert.equal(tasks[1].status, 'running');

    // Complete second
    im.updateStatus('a1', 'idle');

    var result = await promise;
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
  });

  it('handles diamond dependency (A->B, A->C, B+C->D)', async () => {
    im.register({ id: 'a1' });
    im.register({ id: 'a2' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([
      { desc: 'A' },
      { desc: 'B', dependsOn: [0] },
      { desc: 'C', dependsOn: [0] },
      { desc: 'D', dependsOn: [1, 2] },
    ]);

    var promise = runner.execute(tasks);
    await new Promise(function (r) { setTimeout(r, 20); });

    // Only A should be running
    assert.equal(tasks[0].status, 'running');
    assert.equal(tasks[1].status, 'pending');
    assert.equal(tasks[2].status, 'pending');
    assert.equal(tasks[3].status, 'pending');

    // Complete A
    im.updateStatus('a1', 'idle');
    await new Promise(function (r) { setTimeout(r, 20); });

    // B and C should be running (parallel)
    assert.equal(tasks[1].status, 'running');
    assert.equal(tasks[2].status, 'running');
    assert.equal(tasks[3].status, 'pending');

    // Complete B and C
    im.updateStatus('a1', 'idle');
    im.updateStatus('a2', 'idle');
    await new Promise(function (r) { setTimeout(r, 20); });

    // D should be running
    assert.equal(tasks[3].status, 'running');

    // Complete D
    im.updateStatus('a1', 'idle');

    var result = await promise;
    assert.equal(result.completed, 4);
    assert.equal(result.failed, 0);
  });

  it('cascades failure to dependent tasks', async () => {
    im.register({ id: 'a1' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im, taskTimeoutMs: 100 });
    var tasks = makeTasks([
      { desc: 'Fail' },
      { desc: 'Depends on fail', dependsOn: [0] },
    ]);

    var promise = runner.execute(tasks);

    // Wait for timeout
    await new Promise(function (r) { setTimeout(r, 200); });

    var result = await promise;
    assert.equal(result.failed, 2);
    assert.equal(tasks[0].status, 'failed');
    assert.equal(tasks[1].status, 'failed');
    assert.ok(tasks[1].result.summary.includes('Dependency failed'));
  });

  it('abortAll cancels everything', async () => {
    im.register({ id: 'a1' });
    im.register({ id: 'a2' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([
      { desc: 'Running' },
      { desc: 'Pending', dependsOn: [0] },
    ]);

    var promise = runner.execute(tasks);
    // Wait for async dispatch to complete before aborting
    await new Promise(function (r) { setTimeout(r, 50); });
    runner.abortAll();

    var result = await promise;
    assert.equal(result.failed, 2);
  });

  it('fails task when no agents available', async () => {
    // No agents registered
    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([{ desc: 'Orphan' }]);

    var promise = runner.execute(tasks);
    // Give async dispatch a tick
    await new Promise(function (r) { setTimeout(r, 50); });

    var result = await promise;
    assert.equal(result.failed, 1);
    assert.ok(tasks[0].result.summary.includes('No agent'));
  });

  it('emits task:dispatched and task:completed events', async () => {
    im.register({ id: 'a1' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([{ desc: 'Tracked' }]);

    var dispatched = [];
    var completed = [];
    runner.on('task:dispatched', function (d) { dispatched.push(d); });
    runner.on('task:completed', function (d) { completed.push(d); });

    var promise = runner.execute(tasks);
    await new Promise(function (r) { setTimeout(r, 20); });
    im.updateStatus('a1', 'idle');

    await promise;
    assert.equal(dispatched.length, 1);
    assert.equal(completed.length, 1);
    assert.equal(dispatched[0].agentId, 'a1');
  });

  it('emits plan:completed on full success', async () => {
    im.register({ id: 'a1' });

    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([{ desc: 'Solo' }]);

    var planEvents = [];
    runner.on('plan:completed', function (d) { planEvents.push(d); });

    var promise = runner.execute(tasks);
    await new Promise(function (r) { setTimeout(r, 20); });
    im.updateStatus('a1', 'idle');

    await promise;
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].completed, 1);
  });

  it('emits plan:failed when any task fails', async () => {
    runner = new TaskRunner({ agentPool: pool, instanceManager: im });
    var tasks = makeTasks([{ desc: 'Will fail' }]);

    var planEvents = [];
    runner.on('plan:failed', function (d) { planEvents.push(d); });

    var promise = runner.execute(tasks);
    await new Promise(function (r) { setTimeout(r, 50); });

    await promise;
    assert.equal(planEvents.length, 1);
    assert.ok(planEvents[0].failed > 0);
  });
});
