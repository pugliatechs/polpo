const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { WorldModel } = require('../src/mind/world-model');
const { createMind } = require('../src/mind/index');

// Mock InstanceManager
function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
  em.register = function (info) {
    const id = info.id || 'inst-' + instances.size;
    const inst = {
      id, name: info.name || 'Test', type: info.type || 'terminal',
      project: info.project || 'test', cwd: info.cwd || '/tmp',
      status: 'idle', conversation: [], pendingApproval: null,
      canReceivePrompts: info.canReceivePrompts !== false,
      agentType: info.agentType || 'claude', sessionId: null,
      conversationLength: 0,
    };
    instances.set(id, inst);
    em.emit('instance:registered', inst);
    return inst;
  };
  em.unregister = function (id) {
    const inst = instances.get(id);
    if (inst) {
      inst.status = 'disconnected';
      instances.delete(id);
      em.emit('instance:disconnected', inst);
    }
  };
  em.get = function (id) { return instances.get(id) || null; };
  em.getAll = function () {
    return [...instances.values()].map(function (i) {
      return { ...i, conversationLength: i.conversation.length };
    });
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
    if (!inst) return [];
    return inst.conversation.slice(-(limit || 50));
  };
  em.sendToAgent = function () { return true; };
  em._instances = instances;
  return em;
}

describe('WorldModel', () => {
  let im;
  let wm;
  const MIND_ID = 'mind-001';

  beforeEach(() => {
    im = createMockIM();
    wm = new WorldModel(im, MIND_ID);
  });

  afterEach(() => {
    wm.destroy();
  });

  it('getSnapshot returns empty when no agents', () => {
    const snap = wm.getSnapshot();
    assert.equal(snap.agents.length, 0);
    assert.ok(snap.timestamp > 0);
  });

  it('getSnapshot excludes the mind instance', () => {
    im.register({ id: MIND_ID, name: 'Alien Mind', agentType: 'mind' });
    im.register({ id: 'agent-1', name: 'Claude', agentType: 'claude' });

    const snap = wm.getSnapshot();
    assert.equal(snap.agents.length, 1);
    assert.equal(snap.agents[0].id, 'agent-1');
  });

  it('getSnapshot includes all agent fields', () => {
    im.register({ id: 'a1', name: 'Test', project: 'proj', cwd: '/code', agentType: 'goose' });
    const agent = wm.getSnapshot().agents[0];
    assert.equal(agent.name, 'Test');
    assert.equal(agent.project, 'proj');
    assert.equal(agent.cwd, '/code');
    assert.equal(agent.agentType, 'goose');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.canReceivePrompts, true);
  });

  it('getIdleAgents returns only idle agents with canReceivePrompts', () => {
    im.register({ id: 'a1', name: 'Idle', agentType: 'claude' });
    im.register({ id: 'a2', name: 'Busy', agentType: 'codex' });
    im.register({ id: 'a3', name: 'ReadOnly', agentType: 'claude', canReceivePrompts: false });
    im.updateStatus('a2', 'busy');

    const idle = wm.getIdleAgents();
    assert.equal(idle.length, 1);
    assert.equal(idle[0].id, 'a1');
  });

  it('getAgentsByProject filters by project name', () => {
    im.register({ id: 'a1', name: 'Backend', project: 'polpo' });
    im.register({ id: 'a2', name: 'Frontend', project: 'other' });

    const agents = wm.getAgentsByProject('polpo');
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, 'a1');
  });

  it('getAgentsByProject matches cwd substring', () => {
    im.register({ id: 'a1', name: 'Test', project: 'x', cwd: '/home/user/polpo' });

    const agents = wm.getAgentsByProject('polpo');
    assert.equal(agents.length, 1);
  });

  it('getSummary returns non-empty string when agents exist', () => {
    im.register({ id: 'a1', name: 'Test Agent', project: 'proj', agentType: 'claude' });
    const summary = wm.getSummary();
    assert.ok(summary.includes('Test Agent'));
    assert.ok(summary.includes('claude'));
    assert.ok(summary.includes('proj'));
  });

  it('getSummary returns "No active agents" when empty', () => {
    assert.ok(wm.getSummary().includes('No active agents'));
  });

  it('emits agent:idle when agent goes idle', () => {
    im.register({ id: 'a1', name: 'Worker' });
    im.updateStatus('a1', 'busy');

    const events = [];
    wm.on('agent:idle', function (data) { events.push(data); });
    im.updateStatus('a1', 'idle');

    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'a1');
  });

  it('emits agent:busy when agent goes busy', () => {
    im.register({ id: 'a1', name: 'Worker' });

    const events = [];
    wm.on('agent:busy', function (data) { events.push(data); });
    im.updateStatus('a1', 'busy');

    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'a1');
  });

  it('emits all:idle when last agent goes idle', () => {
    im.register({ id: 'a1' });
    im.register({ id: 'a2' });
    im.updateStatus('a1', 'busy');
    im.updateStatus('a2', 'busy');

    let allIdleCount = 0;
    wm.on('all:idle', function () { allIdleCount++; });

    im.updateStatus('a1', 'idle');
    assert.equal(allIdleCount, 0); // a2 still busy

    im.updateStatus('a2', 'idle');
    assert.equal(allIdleCount, 1);
  });

  it('does not emit events for mind instance', () => {
    im.register({ id: MIND_ID, name: 'Mind', agentType: 'mind' });

    const events = [];
    wm.on('agent:added', function (data) { events.push(data); });
    wm.on('agent:idle', function (data) { events.push(data); });

    im.updateStatus(MIND_ID, 'busy');
    im.updateStatus(MIND_ID, 'idle');

    assert.equal(events.length, 0);
  });

  it('emits agent:added on registration', () => {
    const events = [];
    wm.on('agent:added', function (data) { events.push(data); });

    im.register({ id: 'a1', name: 'New Agent', agentType: 'goose' });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'New Agent');
    assert.equal(events[0].agentType, 'goose');
  });

  it('emits agent:removed on disconnect', () => {
    im.register({ id: 'a1', name: 'Gone' });

    const events = [];
    wm.on('agent:removed', function (data) { events.push(data); });

    im.unregister('a1');
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'a1');
  });

  it('getAgentConversation returns messages', () => {
    im.register({ id: 'a1' });
    im.addMessage('a1', { role: 'user', content: 'hello' });
    im.addMessage('a1', { role: 'assistant', content: 'hi' });

    const conv = wm.getAgentConversation('a1', 5);
    assert.equal(conv.length, 2);
  });

  it('destroy removes all listeners', () => {
    wm.destroy();

    const events = [];
    wm.on('agent:added', function () { events.push(1); });

    im.register({ id: 'a1' });
    assert.equal(events.length, 0);
  });
});

describe('createMind', () => {
  let im;

  beforeEach(() => {
    im = createMockIM();
  });

  it('registers mind instance', () => {
    const mind = createMind(im, {});
    assert.ok(mind.instanceId);
    const inst = im.get(mind.instanceId);
    assert.equal(inst.agentType, 'mind');
    assert.equal(inst.name, 'Alien Mind');
    mind.destroy();
  });

  it('responds to user prompts with world summary', () => {
    const mind = createMind(im, {});
    im.register({ id: 'a1', name: 'Claude Worker', agentType: 'claude' });

    // Simulate user sending a prompt to the mind
    im.addMessage(mind.instanceId, { role: 'user', content: 'what agents are running?' });

    // Mind should have responded
    const conv = im.getConversation(mind.instanceId, 10);
    const assistantMsgs = conv.filter(function (m) { return m.role === 'assistant'; });
    assert.ok(assistantMsgs.length > 0);
    assert.ok(assistantMsgs[0].content.includes('Claude Worker'));

    mind.destroy();
  });

  it('destroy removes mind instance', () => {
    const mind = createMind(im, {});
    const id = mind.instanceId;
    mind.destroy();
    assert.equal(im.get(id), null);
  });

  it('worldModel is accessible', () => {
    const mind = createMind(im, {});
    assert.ok(mind.worldModel);
    assert.ok(typeof mind.worldModel.getSnapshot === 'function');
    mind.destroy();
  });
});
