const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { Coordinator } = require('../src/mind/coordinator');
const { WorldModel } = require('../src/mind/world-model');

// Mock InstanceManager
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

// Mock Reasoner that returns a canned plan
function createMockReasoner(plan) {
  return {
    plan: async function () { return plan || { tasks: [{ description: 'Do the thing', agentType: 'claude', targetCwd: '/tmp', prompt: 'Please do the thing', dependsOn: [] }] }; },
    evaluate: async function () { return { success: true, summary: 'Looks good' }; },
    destroy: function () {},
  };
}

describe('Coordinator', () => {
  let im;
  let wm;
  let coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    wm.destroy();
  });

  it('submitGoal creates a goal with correct shape', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    // Add an idle agent
    im.register({ id: 'agent-1', name: 'Worker', agentType: 'claude' });

    const result = await coordinator.submitGoal('Fix the tests');
    assert.ok(result.goalId);
    assert.ok(result.goalId.startsWith('goal-'));

    const goals = coordinator.getActiveGoals();
    assert.equal(goals.length, 1);
    assert.equal(goals[0].prompt, 'Fix the tests');
  });

  it('assigns task to idle agent', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker', agentType: 'claude' });

    await coordinator.submitGoal('Fix the tests');

    // Check that a prompt was sent to the agent
    const sentToAgent = im._sent.filter(function (s) { return s.id === 'agent-1'; });
    assert.ok(sentToAgent.length > 0);
    assert.equal(sentToAgent[0].msg.type, 'prompt');
    assert.ok(sentToAgent[0].msg.text.includes('do the thing'));
  });

  it('prefers agent matching targetCwd', async () => {
    const plan = { tasks: [{ description: 'Task', agentType: 'claude', targetCwd: '/project-a', prompt: 'work on A', dependsOn: [] }] };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-wrong', name: 'Wrong', agentType: 'claude', cwd: '/project-b' });
    im.register({ id: 'agent-right', name: 'Right', agentType: 'claude', cwd: '/project-a' });

    await coordinator.submitGoal('Work on A');

    const sentToRight = im._sent.filter(function (s) { return s.id === 'agent-right'; });
    assert.ok(sentToRight.length > 0);
  });

  it('reports failure when no idle agents', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    // No agents registered (besides mind)

    await coordinator.submitGoal('Do something');

    const goals = coordinator.getActiveGoals();
    // Task should have failed
    const task = goals[0].plan.tasks[0];
    assert.equal(task.status, 'failed');
    assert.ok(task.result.summary.includes('No idle agent'));
  });

  it('detects task completion when agent goes idle', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker', agentType: 'claude' });

    await coordinator.submitGoal('Fix tests');

    // Simulate agent going busy then idle
    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    const goals = coordinator.getActiveGoals();
    assert.equal(goals[0].plan.tasks[0].status, 'completed');
  });

  it('marks goal completed when all tasks done', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker', agentType: 'claude' });

    let completedGoalId = null;
    coordinator.on('goal:completed', function (data) { completedGoalId = data.goalId; });

    await coordinator.submitGoal('Fix tests');

    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    assert.ok(completedGoalId);
    const goals = coordinator.getActiveGoals();
    assert.equal(goals[0].status, 'completed');
  });

  it('cancelGoal aborts running tasks', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker', agentType: 'claude' });

    const result = await coordinator.submitGoal('Long task');
    coordinator.cancelGoal(result.goalId);

    const goals = coordinator.getActiveGoals();
    assert.equal(goals[0].status, 'failed');
    assert.equal(goals[0].result, 'Cancelled by user');

    // Should have sent abort to agent
    const aborts = im._sent.filter(function (s) { return s.msg.type === 'abort'; });
    assert.ok(aborts.length > 0);
  });

  it('handles planning failure gracefully', async () => {
    const failingReasoner = {
      plan: async function () { throw new Error('LLM unavailable'); },
      evaluate: async function () { return { success: true, summary: '' }; },
      destroy: function () {},
    };
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner: failingReasoner, mindInstanceId: MIND_ID });

    await coordinator.submitGoal('Something');

    const goals = coordinator.getActiveGoals();
    assert.equal(goals[0].status, 'failed');
    assert.ok(goals[0].result.includes('Planning failed'));
  });

  it('reports progress to mind conversation', async () => {
    const reasoner = createMockReasoner();
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker', agentType: 'claude' });

    await coordinator.submitGoal('Fix tests');

    // Check mind's conversation has planning and assignment messages
    const conv = im.getConversation(MIND_ID, 20);
    const assistantMsgs = conv.filter(function (m) { return m.role === 'assistant' && m.source === 'mind'; });
    assert.ok(assistantMsgs.length >= 2); // At least "Planning..." and "Assigned to..."
    assert.ok(assistantMsgs.some(function (m) { return m.content.includes('Planning'); }));
    assert.ok(assistantMsgs.some(function (m) { return m.content.includes('Assigned'); }));
  });
});

describe('Coordinator with dependencies', () => {
  let im;
  let wm;
  let coordinator;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
  });

  afterEach(() => {
    if (coordinator) coordinator.destroy();
    wm.destroy();
  });

  it('only dispatches tasks with met dependencies', async () => {
    const plan = {
      tasks: [
        { description: 'First', agentType: 'claude', targetCwd: '', prompt: 'do first', dependsOn: [] },
        { description: 'Second', agentType: 'claude', targetCwd: '', prompt: 'do second', dependsOn: [0] },
      ],
    };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker 1', agentType: 'claude' });
    im.register({ id: 'agent-2', name: 'Worker 2', agentType: 'claude' });

    await coordinator.submitGoal('Two-step task');

    // Only the first task should have been dispatched
    const prompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].msg.text.includes('do first'));

    // Complete first task
    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    // Now second task should be dispatched
    const allPrompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    assert.equal(allPrompts.length, 2);
    assert.ok(allPrompts[1].msg.text.includes('do second'));
  });
});
