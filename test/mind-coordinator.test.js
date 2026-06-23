const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { Coordinator } = require('../src/mind/coordinator');
const { WorldModel } = require('../src/mind/world-model');

/**
 * Minimal mock InstanceManager — same as the gateway-tasks mock, just
 * adapted to the bits the coordinator + mock runner use here.
 */
function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
  const sentMessages = [];
  em.register = function (info) {
    const id = info.id || 'inst-' + instances.size;
    const inst = {
      id, name: info.name || 'Test', project: info.project || 'test',
      cwd: info.cwd || '/tmp', status: 'idle', conversation: [],
      pendingApproval: null, canReceivePrompts: info.canReceivePrompts !== false,
      agentType: info.agentType || 'claude', conversationLength: 0,
      source: info.source || null,
    };
    instances.set(id, inst);
    em.emit('instance:registered', inst);
    return inst;
  };
  em.unregister = function (id) {
    const inst = instances.get(id);
    if (inst) { inst.status = 'disconnected'; instances.delete(id); em.emit('instance:disconnected', inst); }
  };
  em.get = function (id) { return instances.get(id) || null; };
  em.getAll = function () {
    return [...instances.values()].map(function (i) { return { ...i, conversationLength: i.conversation.length }; });
  };
  em.updateStatus = function (id, status) {
    const inst = instances.get(id);
    if (inst) { inst.status = status; em.emit('instance:status', { id, status }); }
  };
  em.addMessage = function (id, msg) {
    const inst = instances.get(id);
    if (inst) { inst.conversation.push(msg); em.emit('instance:message', { id, message: msg }); }
  };
  em.getConversation = function (id, limit) {
    const inst = instances.get(id);
    return inst ? inst.conversation.slice(-(limit || 50)) : [];
  };
  em.sendToAgent = function (id, msg) {
    sentMessages.push({ id, msg });
    return instances.has(id);
  };
  em._sent = sentMessages;
  return em;
}

/**
 * Mock OneShotAgentRunner — under test, the coordinator spawns ALL
 * arms through the runner. This mock records every run() call and
 * exposes helpers that simulate the runner's terminal events
 * (completed / failed / cancelled). It registers a fake instance in
 * the InstanceManager so coordinator-side helpers like addMessage()
 * and get() continue to work.
 */
function createMockRunner(im) {
  let nextAgentId = 0;
  const activeRuns = new Map(); // agentInstanceId -> record
  const allRuns = [];           // full history

  function makeAgentId(opts) {
    nextAgentId++;
    return 'mind-arm-' + nextAgentId;
  }

  const runner = {
    _activeRuns: activeRuns,
    _allRuns: allRuns,

    run(opts) {
      const agentId = makeAgentId(opts);
      im.register({
        id: agentId,
        name: opts.name,
        cwd: opts.cwd,
        project: 'polpo',
        agentType: opts.agentType,
        source: opts.source,
      });
      const record = {
        opts,
        agentInstanceId: agentId,
        terminated: false,
        startedAt: Date.now(),
      };
      activeRuns.set(agentId, record);
      allRuns.push(record);
      // Synchronous spawn signal so the coordinator's onSpawn callback
      // fires before any test code looks at the resulting state.
      if (opts.onSpawn) opts.onSpawn(agentId);
      return new Promise((resolve) => { record.resolve = resolve; });
    },

    cancel(agentInstanceId) {
      const r = activeRuns.get(agentInstanceId);
      if (!r || r.terminated) return false;
      runner._finishRun(r, 'cancelled', '', 'cancelled_by_caller');
      return true;
    },

    destroy() {
      for (const r of [...activeRuns.values()]) {
        if (!r.terminated) runner._finishRun(r, 'cancelled', '', 'destroyed');
      }
      activeRuns.clear();
    },

    // --- test helpers ---
    /** Drive the most-recent still-running arm to a successful finish. */
    completeNextRun(output) {
      const r = runner._lastActive();
      if (!r) throw new Error('no active run');
      runner._finishRun(r, 'completed', output || '', null);
      return r.agentInstanceId;
    },
    completeRun(agentInstanceId, output) {
      const r = activeRuns.get(agentInstanceId);
      if (!r) throw new Error('no run for ' + agentInstanceId);
      runner._finishRun(r, 'completed', output || '', null);
    },
    failRun(agentInstanceId, error) {
      const r = activeRuns.get(agentInstanceId);
      if (!r) throw new Error('no run for ' + agentInstanceId);
      runner._finishRun(r, 'failed', '', error || 'failed');
    },
    /** Simulate the runner forwarding a chunk from the agent. */
    fireChunk(agentInstanceId, text) {
      const r = activeRuns.get(agentInstanceId);
      if (!r || !r.opts.onChunk) return;
      r.opts.onChunk(text);
    },
    /** Most-recent still-running record (in insertion order). */
    _lastActive() {
      for (const r of [...activeRuns.values()].reverse()) {
        if (!r.terminated) return r;
      }
      return null;
    },
    _finishRun(record, status, output, error) {
      record.terminated = true;
      activeRuns.delete(record.agentInstanceId);
      try { im.unregister(record.agentInstanceId); } catch {}
      const result = {
        status,
        output: output || '',
        error: error || null,
        durationMs: Date.now() - record.startedAt,
        agentInstanceId: record.agentInstanceId,
      };
      if (record.opts.onTerminal) record.opts.onTerminal(result);
      if (record.resolve) record.resolve(result);
    },

    promptsSent() { return allRuns.map(r => r.opts.prompt); },
  };
  return runner;
}

function createMockReasoner(plan, replanResponse) {
  return {
    plan: async function () {
      return plan || {
        tasks: [{ description: 'Do the thing', agentType: 'claude', targetCwd: '/tmp', prompt: 'Please do the thing', dependsOn: [] }],
      };
    },
    replan: async function () { return replanResponse || { action: 'abandon', reason: 'mock default' }; },
    evaluate: async function () { return { success: true, summary: 'Looks good' }; },
    destroy: function () {},
  };
}

function newCoord(im, wm, reasoner, runner, extra) {
  const c = new Coordinator(Object.assign({
    instanceManager: im,
    worldModel: wm,
    reasoner,
    runner,
    mindInstanceId: 'mind-001',
  }, extra || {}));
  // The interactive plan-approval flow (v1.2.2) makes submitGoal hold
  // dispatch until /approve. The existing test suite was written
  // assuming the legacy fire-and-forget behaviour, so we wrap
  // submitGoal here to default autoDispatch:true. Tests that want to
  // exercise the interactive path explicitly pass {autoDispatch:false}.
  const origSubmit = c.submitGoal.bind(c);
  c.submitGoal = function (prompt, opts) {
    return origSubmit(prompt, Object.assign({ autoDispatch: true }, opts || {}));
  };
  return c;
}

describe('Coordinator: basic lifecycle', () => {
  let im, wm, runner, coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
  });

  it('requires a runner', () => {
    assert.throws(() => new Coordinator({
      instanceManager: im, worldModel: wm, reasoner: createMockReasoner(),
      mindInstanceId: MIND_ID,
    }), /runner/);
  });

  it('submitGoal creates a goal with correct shape', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    const result = await coordinator.submitGoal('Fix the tests');
    assert.ok(result.goalId.startsWith('goal-'));
    const goals = coordinator.getActiveGoals();
    assert.equal(goals.length, 1);
    assert.equal(goals[0].prompt, 'Fix the tests');
  });

  it('dispatches each task as a runner.run() call', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    await coordinator.submitGoal('Fix the tests');
    assert.equal(runner._allRuns.length, 1);
    assert.ok(runner.promptsSent()[0].includes('do the thing'));
  });

  it('tags each arm with source: mind:<goalId-tail>', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    const { goalId } = await coordinator.submitGoal('Fix the tests');
    const opts = runner._allRuns[0].opts;
    assert.equal(opts.source, 'mind:' + goalId.slice(-8));
    assert.ok(opts.name.startsWith('Mind arm:'));
  });

  it('treats runner.run completion as task completion', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    await coordinator.submitGoal('Fix the tests');
    runner.completeNextRun('I did the thing');
    const goals = coordinator.getActiveGoals();
    assert.equal(goals[0].plan.tasks[0].status, 'completed');
    assert.equal(goals[0].plan.tasks[0].output, 'I did the thing');
  });

  it('marks goal completed when all tasks done', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    let completedGoalId = null;
    coordinator.on('goal:completed', d => { completedGoalId = d.goalId; });
    await coordinator.submitGoal('Fix the tests');
    runner.completeNextRun('done');
    assert.ok(completedGoalId);
    assert.equal(coordinator.getActiveGoals()[0].status, 'completed');
  });

  it('cancelGoal aborts running tasks via the runner', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    const { goalId } = await coordinator.submitGoal('Long task');
    const armId = runner._allRuns[0].agentInstanceId;
    assert.ok(runner._activeRuns.has(armId), 'arm is in flight before cancel');
    coordinator.cancelGoal(goalId);
    assert.equal(runner._activeRuns.has(armId), false, 'arm cancelled');
    const goal = coordinator.getActiveGoals()[0];
    assert.equal(goal.status, 'failed');
    assert.equal(goal.result, 'Cancelled by user');
  });

  it('handles planning failure gracefully', async () => {
    const failingReasoner = {
      plan: async () => { throw new Error('LLM unavailable'); },
      evaluate: async () => ({ success: true, summary: '' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, failingReasoner, runner);
    await coordinator.submitGoal('Something');
    const goals = coordinator.getActiveGoals();
    assert.equal(goals[0].status, 'failed');
    assert.ok(goals[0].result.includes('Planning failed'));
    assert.equal(runner._allRuns.length, 0, 'no arm spawned on planning failure');
  });

  it('reports progress to mind conversation', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    await coordinator.submitGoal('Fix tests');
    const conv = im.getConversation(MIND_ID, 20);
    const assistant = conv.filter(m => m.role === 'assistant' && m.source === 'mind');
    assert.ok(assistant.length >= 2);
    assert.ok(assistant.some(m => m.content.includes('Planning')));
    assert.ok(assistant.some(m => m.content.includes('Assigned')));
  });
});

describe('Coordinator: task dependencies', () => {
  let im, wm, runner, coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
  });

  it('only dispatches tasks with met dependencies', async () => {
    const plan = { tasks: [
      { description: 'First', agentType: 'claude', targetCwd: '', prompt: 'do first', dependsOn: [] },
      { description: 'Second', agentType: 'claude', targetCwd: '', prompt: 'do second', dependsOn: [0] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan), runner);
    await coordinator.submitGoal('Two-step');
    assert.equal(runner._allRuns.length, 1);
    assert.ok(runner.promptsSent()[0].includes('do first'));

    runner.completeNextRun('first done');
    assert.equal(runner._allRuns.length, 2);
    assert.ok(runner.promptsSent()[1].includes('do second'));
  });

  it('injects predecessor output as context for dependent tasks', async () => {
    const plan = { tasks: [
      { description: 'Research', agentType: 'claude', targetCwd: '', prompt: 'research the topic', dependsOn: [] },
      { description: 'Build', agentType: 'claude', targetCwd: '', prompt: 'build based on research', dependsOn: [0] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan), runner);
    await coordinator.submitGoal('Two-step');
    runner.completeNextRun('Found that X uses Y library');

    const second = runner.promptsSent()[1];
    assert.ok(second.includes('<previous_task_results>'));
    assert.ok(second.includes('Found that X uses Y library'));
    assert.ok(second.includes('build based on research'));
    assert.ok(second.indexOf('<previous_task_results>') < second.indexOf('build based on research'));
  });

  it('first task has no predecessor context', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    await coordinator.submitGoal('Single');
    assert.ok(!runner.promptsSent()[0].includes('<previous_task_results>'));
  });

  it('multiple predecessors each provide context', async () => {
    const plan = { tasks: [
      { description: 'A', agentType: 'claude', targetCwd: '', prompt: 'research A', dependsOn: [] },
      { description: 'B', agentType: 'claude', targetCwd: '', prompt: 'research B', dependsOn: [] },
      { description: 'C', agentType: 'claude', targetCwd: '', prompt: 'synthesize findings', dependsOn: [0, 1] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan), runner);
    await coordinator.submitGoal('Diamond');
    // Two parallel arms run first
    assert.equal(runner._allRuns.length, 2);
    runner.completeRun(runner._allRuns[0].agentInstanceId, 'Finding A: alpha');
    runner.completeRun(runner._allRuns[1].agentInstanceId, 'Finding B: beta');

    assert.equal(runner._allRuns.length, 3);
    const synth = runner.promptsSent()[2];
    assert.ok(synth.includes('Finding A: alpha'));
    assert.ok(synth.includes('Finding B: beta'));
  });

  it('truncates long predecessor outputs', async () => {
    const plan = { tasks: [
      { description: 'A', agentType: 'claude', targetCwd: '', prompt: 'produce lots', dependsOn: [] },
      { description: 'B', agentType: 'claude', targetCwd: '', prompt: 'use output', dependsOn: [0] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan), runner);
    await coordinator.submitGoal('Big context');
    runner.completeNextRun('x'.repeat(20000));
    const second = runner.promptsSent()[1];
    assert.ok(second.includes('output truncated'));
    assert.ok(second.length < 15000);
  });

  it('the runner output is the authoritative source for predecessor context', async () => {
    // Earlier versions walked the world-model conversation to recover
    // the arm's trailing assistant text. The runner now captures every
    // chunk and feeds it to onTerminal, so the coordinator takes that
    // snapshot at face value — no world-model fallback needed.
    const plan = { tasks: [
      { description: 'A', agentType: 'claude', targetCwd: '', prompt: 'first', dependsOn: [] },
      { description: 'B', agentType: 'claude', targetCwd: '', prompt: 'second', dependsOn: [0] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan), runner);
    await coordinator.submitGoal('mm');
    runner.completeNextRun('final 1\n\nfinal 2');
    const second = runner.promptsSent()[1];
    assert.ok(second.includes('final 1'));
    assert.ok(second.includes('final 2'));
  });
});

describe('Coordinator: re-planning on failure', () => {
  let im, wm, runner, coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
  });

  it('retries task with revised prompt when reasoner says retry', async () => {
    const plan = { tasks: [
      { description: 'Risky', agentType: 'claude', targetCwd: '', prompt: 'original prompt', dependsOn: [] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan, { action: 'retry', prompt: 'revised prompt' }), runner);
    await coordinator.submitGoal('Try');
    assert.ok(runner.promptsSent()[0].includes('original prompt'));

    coordinator._failTask(coordinator.getActiveGoals()[0].plan.tasks[0].id, 'wrong');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(runner.promptsSent()[1].includes('revised prompt'));
    assert.equal(coordinator.getActiveGoals()[0].plan.tasks[0].replanCount, 1);
  });

  it('splits task into replacement subtasks when reasoner says split', async () => {
    const plan = { tasks: [
      { description: 'Complex', agentType: 'claude', targetCwd: '', prompt: 'do complex', dependsOn: [] },
    ] };
    const reasoner = createMockReasoner(plan, {
      action: 'split',
      tasks: [
        { description: 'Subtask A', prompt: 'simpler A', agentType: 'claude' },
        { description: 'Subtask B', prompt: 'simpler B', agentType: 'claude' },
      ],
    });
    coordinator = newCoord(im, wm, reasoner, runner);
    await coordinator.submitGoal('Complex');
    coordinator._failTask(coordinator.getActiveGoals()[0].plan.tasks[0].id, 'Too complex');
    await new Promise(r => setTimeout(r, 20));

    const tasks = coordinator.getActiveGoals()[0].plan.tasks;
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].status, 'completed');
    assert.equal(tasks[1].description, 'Subtask A');
    assert.equal(tasks[2].description, 'Subtask B');
    assert.deepEqual(tasks[2].dependsOn, [1]);
  });

  it('abandons task when reasoner says abandon', async () => {
    const plan = { tasks: [
      { description: 'Unsolvable', agentType: 'claude', targetCwd: '', prompt: 'cannot do', dependsOn: [] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan, { action: 'abandon', reason: 'Not feasible' }), runner);
    await coordinator.submitGoal('Impossible');
    coordinator._failTask(coordinator.getActiveGoals()[0].plan.tasks[0].id, 'Cannot proceed');
    await new Promise(r => setTimeout(r, 20));
    const t = coordinator.getActiveGoals()[0].plan.tasks[0];
    assert.equal(t.status, 'failed');
    assert.ok(t.result.summary.includes('Not feasible'));
  });

  it('respects MAX_REPLANS limit', async () => {
    const plan = { tasks: [
      { description: 'Flaky', agentType: 'claude', targetCwd: '', prompt: 'flaky', dependsOn: [] },
    ] };
    coordinator = newCoord(im, wm, createMockReasoner(plan, { action: 'retry', prompt: 'retry' }), runner);
    await coordinator.submitGoal('Flaky');
    const taskId = coordinator.getActiveGoals()[0].plan.tasks[0].id;
    for (let i = 0; i <= coordinator.MAX_REPLANS; i++) {
      coordinator._failTask(taskId, 'again #' + i);
      await new Promise(r => setTimeout(r, 20));
    }
    const t = coordinator.getActiveGoals()[0].plan.tasks[0];
    assert.equal(t.status, 'failed');
    assert.equal(t.replanCount, coordinator.MAX_REPLANS);
  });

  it('split: dependents of original task redirected to last replacement', async () => {
    const plan = { tasks: [
      { description: 'A', agentType: 'claude', targetCwd: '', prompt: 'do A', dependsOn: [] },
      { description: 'B depends on A', agentType: 'claude', targetCwd: '', prompt: 'do B', dependsOn: [0] },
    ] };
    const reasoner = createMockReasoner(plan, {
      action: 'split',
      tasks: [
        { description: 'A1', prompt: 'a1' },
        { description: 'A2', prompt: 'a2' },
      ],
    });
    coordinator = newCoord(im, wm, reasoner, runner);
    await coordinator.submitGoal('Multi');
    const taskA = coordinator.getActiveGoals()[0].plan.tasks[0];
    coordinator._failTask(taskA.id, 'A failed');
    await new Promise(r => setTimeout(r, 20));
    const all = coordinator.getActiveGoals()[0].plan.tasks;
    const taskB = all.find(t => t.description === 'B depends on A');
    assert.deepEqual(taskB.dependsOn, [3]);
  });
});

// ---- In-flight goal persistence + recovery ----

const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoalStore } = require('../src/mind/goal-store');
const { Memory } = require('../src/mind/memory');

function tempGoalStorePath() {
  return path.join(os.tmpdir(), 'polpo-coord-goalstore-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}
function tempMemoryPath() {
  return path.join(os.tmpdir(), 'polpo-coord-memory-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
}

describe('Coordinator: goal persistence', () => {
  let im, wm, runner, coordinator, goalStorePath, memoryPath;
  const MIND_ID = 'mind-persist';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
    goalStorePath = tempGoalStorePath();
    memoryPath = tempMemoryPath();
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
    try { fs.unlinkSync(goalStorePath); } catch {}
    try { fs.unlinkSync(memoryPath); } catch {}
  });

  it('persists a goal to the store while running', async () => {
    const goalStore = new GoalStore({ path: goalStorePath });
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { goalStore, mindInstanceId: MIND_ID });
    await coordinator.submitGoal('Persistent goal');
    const reload = new GoalStore({ path: goalStorePath });
    reload.load();
    assert.equal(reload.size(), 1);
    assert.equal(reload.getAll()[0].prompt, 'Persistent goal');
    assert.equal(reload.getAll()[0].status, 'running');
  });

  it('removes the goal from the store on completion', async () => {
    const goalStore = new GoalStore({ path: goalStorePath });
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { goalStore, mindInstanceId: MIND_ID });
    await coordinator.submitGoal('Goal that finishes');
    runner.completeNextRun('done');
    await new Promise(r => setTimeout(r, 30));
    const reload = new GoalStore({ path: goalStorePath });
    reload.load();
    assert.equal(reload.size(), 0);
  });

  it('removes the goal from the store on cancel', async () => {
    const goalStore = new GoalStore({ path: goalStorePath });
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { goalStore, mindInstanceId: MIND_ID });
    const { goalId } = await coordinator.submitGoal('Doomed goal');
    coordinator.cancelGoal(goalId);
    const reload = new GoalStore({ path: goalStorePath });
    reload.load();
    assert.equal(reload.size(), 0);
  });

  it('persists task-level progress snapshots', async () => {
    const plan = { tasks: [
      { description: 'Step 1', agentType: 'claude', targetCwd: '/tmp', prompt: 'p1', dependsOn: [] },
      { description: 'Step 2', agentType: 'claude', targetCwd: '/tmp', prompt: 'p2', dependsOn: [0] },
    ] };
    const goalStore = new GoalStore({ path: goalStorePath });
    coordinator = newCoord(im, wm, createMockReasoner(plan), runner, { goalStore, mindInstanceId: MIND_ID });
    await coordinator.submitGoal('Two steps');
    runner.completeNextRun('step 1 done');
    await new Promise(r => setTimeout(r, 30));
    const reload = new GoalStore({ path: goalStorePath });
    reload.load();
    assert.equal(reload.size(), 1);
    assert.equal(reload.getAll()[0].plan.tasks[0].status, 'completed');
  });

  it('recoverInterruptedGoals marks stored goals as interrupted and clears the store', async () => {
    const seed = new GoalStore({ path: goalStorePath });
    seed.upsert({
      id: 'goal-seed',
      prompt: 'Old work',
      status: 'running',
      createdAt: Date.now() - 60000,
      plan: { tasks: [
        { id: 't1', description: 'done step', status: 'completed', result: null },
        { id: 't2', description: 'in flight step', status: 'running', result: null },
      ] },
    });
    const memory = new Memory({ path: memoryPath });
    const goalStore = new GoalStore({ path: goalStorePath });
    goalStore.load();
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { memory, goalStore, mindInstanceId: MIND_ID });
    const recovered = coordinator.recoverInterruptedGoals();
    assert.deepEqual(recovered, ['goal-seed']);
    const check = new GoalStore({ path: goalStorePath });
    check.load();
    assert.equal(check.size(), 0);
    assert.equal(memory.size(), 1);
    const mindMessages = im.get(MIND_ID).conversation;
    const reportMsg = mindMessages.find(m => m.content && m.content.indexOf('Recovered') === 0);
    assert.ok(reportMsg);
    assert.ok(reportMsg.content.indexOf('1/2') !== -1);
  });

  it('recoverInterruptedGoals is a no-op when the store is empty', () => {
    const goalStore = new GoalStore({ path: goalStorePath });
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { goalStore, mindInstanceId: MIND_ID });
    assert.deepEqual(coordinator.recoverInterruptedGoals(), []);
  });

  it('works without a goalStore (graceful degradation)', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner);
    await coordinator.submitGoal('No store goal');
    assert.deepEqual(coordinator.recoverInterruptedGoals(), []);
  });
});

// ---- goal:event emissions (for the gateway /v1/goals SSE relay) ----

describe('Coordinator: goal:event emissions', () => {
  let im, wm, runner, coordinator;
  const MIND_ID = 'mind-events';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
  });

  function captureEvents(c) {
    const events = [];
    c.on('goal:event', ev => events.push(ev));
    return events;
  }

  it('emits planning -> plan_ready in order on submitGoal', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const events = captureEvents(coordinator);
    const { goalId } = await coordinator.submitGoal('Refactor auth');
    const types = events.map(e => e.type);
    const p = types.indexOf('planning');
    const r = types.indexOf('plan_ready');
    assert.ok(p >= 0);
    assert.ok(r > p);
    assert.equal(events[p].goalId, goalId);
    assert.equal(events[p].prompt, 'Refactor auth');
    assert.ok(Array.isArray(events[r].tasks));
    assert.ok(events[r].tasks.length > 0);
  });

  it('emits task_started when the task is dispatched to an arm', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const events = captureEvents(coordinator);
    await coordinator.submitGoal('p');
    const started = events.find(e => e.type === 'task_started');
    assert.ok(started);
    assert.ok(started.agentInstanceId.startsWith('mind-arm-'));
    assert.equal(started.agentType, 'claude');
  });

  it('emits task_chunk when the runner forwards a chunk', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const events = captureEvents(coordinator);
    await coordinator.submitGoal('p');
    runner.fireChunk(runner._allRuns[0].agentInstanceId, 'streaming text');
    const chunk = events.find(e => e.type === 'task_chunk');
    assert.ok(chunk);
    assert.equal(chunk.text, 'streaming text');
  });

  it('emits task_done and done when a task completes', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const events = captureEvents(coordinator);
    await coordinator.submitGoal('p');
    runner.completeNextRun('out');
    const types = events.map(e => e.type);
    assert.ok(types.includes('task_done'));
    assert.ok(types.includes('done'));
    assert.equal(types[types.length - 1], 'done');
  });

  it('emits cancelled when the user cancels a running goal', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const events = captureEvents(coordinator);
    const { goalId } = await coordinator.submitGoal('p');
    coordinator.cancelGoal(goalId);
    const cancelled = events.find(e => e.type === 'cancelled');
    assert.ok(cancelled);
    assert.equal(cancelled.goalId, goalId);
    assert.equal(cancelled.reason, 'cancelled_by_user');
  });

  it('emits replanning before retrying', async () => {
    const reasoner = {
      plan: async () => ({ tasks: [{ description: 'do', agentType: 'claude', targetCwd: '/tmp', prompt: 'p', dependsOn: [] }] }),
      replan: async () => ({ action: 'retry', prompt: 'revised p' }),
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    const events = captureEvents(coordinator);
    await coordinator.submitGoal('p');
    const task = coordinator.getActiveGoals()[0].plan.tasks[0];
    coordinator._failTask(task.id, 'mock failure');
    await new Promise(r => setTimeout(r, 20));
    const replanning = events.find(e => e.type === 'replanning');
    assert.ok(replanning);
    assert.equal(replanning.attempt, 1);
    assert.equal(replanning.reason, 'mock failure');
  });

  it('does not crash when an emit happens without listeners', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('silent');
  });
});

// ---- v1.2.2: interactive plan-approval + escalation ----

describe('Coordinator: interactive plan approval', () => {
  let im, wm, runner, coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
  });

  it('submitGoal({autoDispatch:false}) stays in awaiting_approval until /approve', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const { goalId } = await coordinator.submitGoal('Plan something', { autoDispatch: false });
    const goal = coordinator.getActiveGoals().find((g) => g.id === goalId);
    assert.equal(goal.status, 'awaiting_approval');
    assert.equal(runner._allRuns.length, 0, 'no arms spawned yet');

    // Plan preview should have been posted to chat
    const conv = im.getConversation(MIND_ID, 30);
    const preview = conv.find((m) => m.content && m.content.includes('/approve'));
    assert.ok(preview, 'plan preview posted to mind chat');
  });

  it('/approve dispatches the plan and the goal transitions to running', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const { goalId } = await coordinator.submitGoal('Ship it', { autoDispatch: false });
    assert.equal(runner._allRuns.length, 0);

    const ok = coordinator.approvePlan(null); // resolve to pending
    assert.equal(ok, true);
    const goal = coordinator.getActiveGoals().find((g) => g.id === goalId);
    assert.equal(goal.status, 'running');
    assert.equal(runner._allRuns.length, 1);
  });

  it('/approve with an unknown goalId returns false', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('p', { autoDispatch: false });
    assert.equal(coordinator.approvePlan('goal-doesnotexist'), false);
  });

  it('/tweak re-invokes the reasoner with the original prompt + feedback appended', async () => {
    let lastPlanPrompt = null;
    const reasoner = {
      plan: async (_world, prompt) => { lastPlanPrompt = prompt; return { tasks: [{ description: 'do', agentType: 'claude', targetCwd: '/tmp', prompt: 'p', dependsOn: [] }] }; },
      replan: async () => ({ action: 'abandon', reason: 'mock' }),
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('original goal', { autoDispatch: false });
    lastPlanPrompt = null;
    const ok = await coordinator.tweakPlan(null, 'narrower scope, just auth tests');
    assert.equal(ok, true);
    assert.ok(lastPlanPrompt.includes('original goal'), 'original prompt preserved');
    assert.ok(lastPlanPrompt.includes('narrower scope, just auth tests'), 'feedback appended');
    // Still awaiting approval after tweak — the user must /approve again
    const goal = coordinator.getActiveGoals()[0];
    assert.equal(goal.status, 'awaiting_approval');
  });

  it('/tweak with empty feedback no-ops and reports a hint', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('p', { autoDispatch: false });
    const ok = await coordinator.tweakPlan(null, '');
    assert.equal(ok, false);
  });

  it('/abandon on an awaiting_approval goal terminates without dispatching', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const { goalId } = await coordinator.submitGoal('p', { autoDispatch: false });
    const ok = coordinator.abandonAwaitingPlan(null);
    assert.equal(ok, true);
    const goal = coordinator.getActiveGoals().find((g) => g.id === goalId);
    assert.equal(goal.status, 'failed');
    assert.equal(runner._allRuns.length, 0);
  });

  it('emits awaiting_approval + plan_approved goal:events', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    const events = [];
    coordinator.on('goal:event', (ev) => events.push(ev));
    await coordinator.submitGoal('p', { autoDispatch: false });
    coordinator.approvePlan(null);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('awaiting_approval'));
    assert.ok(types.includes('plan_approved'));
    assert.ok(types.indexOf('awaiting_approval') < types.indexOf('plan_approved'));
  });

  it('autoDispatch:true preserves the legacy fire-and-forget behaviour', async () => {
    coordinator = newCoord(im, wm, createMockReasoner(), runner, { mindInstanceId: MIND_ID });
    // newCoord defaults to autoDispatch:true; this asserts the
    // default-path still dispatches immediately.
    const { goalId } = await coordinator.submitGoal('legacy');
    const goal = coordinator.getActiveGoals().find((g) => g.id === goalId);
    assert.equal(goal.status, 'running');
    assert.equal(runner._allRuns.length, 1);
  });
});

describe('Coordinator: interactive task escalation', () => {
  let im, wm, runner, coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
    runner = createMockRunner(im);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    runner.destroy();
    wm.destroy();
  });

  it('a task at MAX_REPLANS escalates to awaiting_user_input instead of failing permanently', async () => {
    // reasoner.replan returns 'retry' to keep re-failing through the budget
    const reasoner = {
      plan: async () => ({ tasks: [{ description: 'risky', agentType: 'claude', targetCwd: '/tmp', prompt: 'p', dependsOn: [] }] }),
      replan: async () => ({ action: 'retry', prompt: 'retry p' }),
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    const { goalId } = await coordinator.submitGoal('Risk', { autoDispatch: false });
    coordinator.approvePlan(null);
    const taskId = coordinator.getActiveGoals()[0].plan.tasks[0].id;

    // Burn through the replan budget
    for (let i = 0; i <= coordinator.MAX_REPLANS; i++) {
      coordinator._failTask(taskId, 'still stuck #' + i);
      await new Promise((r) => setTimeout(r, 20));
    }

    const task = coordinator.getActiveGoals()[0].plan.tasks[0];
    assert.equal(task.status, 'awaiting_user_input');
    // Goal should still be running (escalation is non-terminal)
    const goal = coordinator.getActiveGoals().find((g) => g.id === goalId);
    assert.equal(goal.status, 'running');
  });

  it('autoDispatch goals do NOT escalate — they fail permanently (legacy behaviour)', async () => {
    const reasoner = {
      plan: async () => ({ tasks: [{ description: 'x', agentType: 'claude', targetCwd: '/tmp', prompt: 'p', dependsOn: [] }] }),
      replan: async () => ({ action: 'retry', prompt: 'retry' }),
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('auto');
    const taskId = coordinator.getActiveGoals()[0].plan.tasks[0].id;
    for (let i = 0; i <= coordinator.MAX_REPLANS; i++) {
      coordinator._failTask(taskId, 'again ' + i);
      await new Promise((r) => setTimeout(r, 20));
    }
    const task = coordinator.getActiveGoals()[0].plan.tasks[0];
    assert.equal(task.status, 'failed');
  });

  it('/retry with a hint resets the replan budget and feeds the hint to the reasoner', async () => {
    let replanCallReason = null;
    const reasoner = {
      plan: async () => ({ tasks: [{ description: 'x', agentType: 'claude', targetCwd: '/tmp', prompt: 'p', dependsOn: [] }] }),
      replan: async (args) => { replanCallReason = args.failureReason; return { action: 'retry', prompt: 'retry' }; },
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('p', { autoDispatch: false });
    coordinator.approvePlan(null);
    const taskId = coordinator.getActiveGoals()[0].plan.tasks[0].id;
    // Escalate
    for (let i = 0; i <= coordinator.MAX_REPLANS; i++) {
      coordinator._failTask(taskId, 'original failure');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(coordinator.getActiveGoals()[0].plan.tasks[0].status, 'awaiting_user_input');

    // User retries with guidance
    const ok = await coordinator.userRetryEscalatedTask(null, 'try with --verbose');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ok, true);
    assert.ok(replanCallReason.includes('USER GUIDANCE: try with --verbose'));
    // replanCount reset so subsequent failures can re-iterate
    assert.equal(coordinator.getActiveGoals()[0].plan.tasks[0].replanCount, 1);
  });

  it('/skip marks the escalated task failed and cascades to its dependents', async () => {
    const plan = { tasks: [
      { description: 'A', agentType: 'claude', targetCwd: '/tmp', prompt: 'a', dependsOn: [] },
      { description: 'B depends on A', agentType: 'claude', targetCwd: '/tmp', prompt: 'b', dependsOn: [0] },
      { description: 'C depends on B', agentType: 'claude', targetCwd: '/tmp', prompt: 'c', dependsOn: [1] },
    ] };
    const reasoner = {
      plan: async () => plan,
      replan: async () => ({ action: 'retry', prompt: 'r' }),
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    await coordinator.submitGoal('p', { autoDispatch: false });
    coordinator.approvePlan(null);
    const taskA_id = coordinator.getActiveGoals()[0].plan.tasks[0].id;
    // Escalate A
    for (let i = 0; i <= coordinator.MAX_REPLANS; i++) {
      coordinator._failTask(taskA_id, 'A stuck');
      await new Promise((r) => setTimeout(r, 20));
    }
    // Skip
    const ok = coordinator.userSkipEscalatedTask(null);
    assert.equal(ok, true);
    const tasks = coordinator.getActiveGoals()[0].plan.tasks;
    assert.equal(tasks[0].status, 'failed');
    assert.equal(tasks[1].status, 'failed', 'B (depends on A) cascade-failed');
    assert.equal(tasks[2].status, 'failed', 'C (depends on B) cascade-failed');
  });

  it('/abandon while awaiting_user_input cancels the goal', async () => {
    const reasoner = {
      plan: async () => ({ tasks: [{ description: 'x', agentType: 'claude', targetCwd: '/tmp', prompt: 'p', dependsOn: [] }] }),
      replan: async () => ({ action: 'retry', prompt: 'r' }),
      evaluate: async () => ({ success: true, summary: 'ok' }),
      destroy: () => {},
    };
    coordinator = newCoord(im, wm, reasoner, runner, { mindInstanceId: MIND_ID });
    const { goalId } = await coordinator.submitGoal('p', { autoDispatch: false });
    coordinator.approvePlan(null);
    const taskId = coordinator.getActiveGoals()[0].plan.tasks[0].id;
    for (let i = 0; i <= coordinator.MAX_REPLANS; i++) {
      coordinator._failTask(taskId, 'stuck');
      await new Promise((r) => setTimeout(r, 20));
    }
    const ok = coordinator.userAbandonEscalatedGoal(null);
    assert.equal(ok, true);
    const goal = coordinator.getActiveGoals().find((g) => g.id === goalId);
    assert.equal(goal.status, 'failed');
  });
});
