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

  it('injects predecessor output as context for dependent tasks', async () => {
    const plan = {
      tasks: [
        { description: 'Research step', agentType: 'claude', targetCwd: '', prompt: 'research the topic', dependsOn: [] },
        { description: 'Build step', agentType: 'claude', targetCwd: '', prompt: 'build based on research', dependsOn: [0] },
      ],
    };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker 1', agentType: 'claude' });

    await coordinator.submitGoal('Two-step goal');

    // Simulate the first arm producing output, then completing
    im.addMessage('agent-1', { role: 'assistant', content: 'Found that X uses Y library', contentType: 'text' });
    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    // The second task should have been dispatched with the first's output as context
    const prompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    assert.equal(prompts.length, 2);
    const secondPrompt = prompts[1].msg.text;
    assert.ok(secondPrompt.includes('<previous_task_results>'), 'expected context block in dependent prompt');
    assert.ok(secondPrompt.includes('Found that X uses Y library'), 'expected predecessor output in context');
    assert.ok(secondPrompt.includes('build based on research'), 'expected task prompt still present');
    // The context block should come BEFORE the task prompt
    const ctxIdx = secondPrompt.indexOf('<previous_task_results>');
    const taskIdx = secondPrompt.indexOf('build based on research');
    assert.ok(ctxIdx < taskIdx, 'expected context to come before task prompt');
  });

  it('first task has no predecessor context', async () => {
    const plan = {
      tasks: [
        { description: 'Standalone', agentType: 'claude', targetCwd: '', prompt: 'do it', dependsOn: [] },
      ],
    };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker 1', agentType: 'claude' });

    await coordinator.submitGoal('Single task');

    const prompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    assert.equal(prompts.length, 1);
    assert.ok(!prompts[0].msg.text.includes('<previous_task_results>'));
  });

  it('multiple predecessors each provide context', async () => {
    const plan = {
      tasks: [
        { description: 'Research A', agentType: 'claude', targetCwd: '', prompt: 'research A', dependsOn: [] },
        { description: 'Research B', agentType: 'claude', targetCwd: '', prompt: 'research B', dependsOn: [] },
        { description: 'Synthesize', agentType: 'claude', targetCwd: '', prompt: 'synthesize findings', dependsOn: [0, 1] },
      ],
    };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker 1', agentType: 'claude' });
    im.register({ id: 'agent-2', name: 'Worker 2', agentType: 'claude' });

    await coordinator.submitGoal('Diamond task');

    // Simulate both parallel tasks completing with different outputs
    im.addMessage('agent-1', { role: 'assistant', content: 'Finding A: alpha', contentType: 'text' });
    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    im.addMessage('agent-2', { role: 'assistant', content: 'Finding B: beta', contentType: 'text' });
    im.updateStatus('agent-2', 'busy');
    im.updateStatus('agent-2', 'idle');

    // Synthesis task should now be dispatched with both outputs as context
    const prompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    assert.equal(prompts.length, 3);
    const synthPrompt = prompts[2].msg.text;
    assert.ok(synthPrompt.includes('Finding A: alpha'), 'expected predecessor A output');
    assert.ok(synthPrompt.includes('Finding B: beta'), 'expected predecessor B output');
  });

  it('truncates long predecessor outputs', async () => {
    const plan = {
      tasks: [
        { description: 'Big output', agentType: 'claude', targetCwd: '', prompt: 'produce lots', dependsOn: [] },
        { description: 'Consume', agentType: 'claude', targetCwd: '', prompt: 'use output', dependsOn: [0] },
      ],
    };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker 1', agentType: 'claude' });

    await coordinator.submitGoal('Big context');

    const hugeOutput = 'x'.repeat(20000);
    im.addMessage('agent-1', { role: 'assistant', content: hugeOutput, contentType: 'text' });
    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    const prompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    const secondPrompt = prompts[1].msg.text;
    assert.ok(secondPrompt.includes('output truncated'), 'expected truncation marker');
    assert.ok(secondPrompt.length < 15000, 'expected prompt to be bounded');
  });

  it('_extractAgentOutput pulls consecutive trailing assistant messages', async () => {
    const plan = { tasks: [
      { description: 'Step 1', agentType: 'claude', targetCwd: '', prompt: 'first', dependsOn: [] },
      { description: 'Step 2', agentType: 'claude', targetCwd: '', prompt: 'second', dependsOn: [0] },
    ] };
    const reasoner = createMockReasoner(plan);
    coordinator = new Coordinator({ instanceManager: im, worldModel: wm, reasoner, mindInstanceId: MIND_ID });

    im.register({ id: 'agent-1', name: 'Worker 1', agentType: 'claude' });

    await coordinator.submitGoal('Multi-message');

    // Add a mix of messages: user, assistant, tool, assistant, assistant
    im.addMessage('agent-1', { role: 'user', content: 'earlier user msg' });
    im.addMessage('agent-1', { role: 'assistant', content: 'earlier answer', contentType: 'text' });
    im.addMessage('agent-1', { role: 'tool', content: 'tool stuff', contentType: 'tool_result' });
    im.addMessage('agent-1', { role: 'assistant', content: 'final 1', contentType: 'text' });
    im.addMessage('agent-1', { role: 'assistant', content: 'final 2', contentType: 'text' });
    im.updateStatus('agent-1', 'busy');
    im.updateStatus('agent-1', 'idle');

    const prompts = im._sent.filter(function (s) { return s.msg.type === 'prompt'; });
    const secondPrompt = prompts[1].msg.text;
    // Should include the trailing consecutive assistant messages, not earlier ones
    assert.ok(secondPrompt.includes('final 1'));
    assert.ok(secondPrompt.includes('final 2'));
    assert.ok(!secondPrompt.includes('earlier answer'), 'should not include assistant msg before tool result');
  });
});
