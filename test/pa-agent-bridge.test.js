const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { AgentBridge } = require('../src/pa/agent-bridge');

// Mock InstanceManager
function createMockInstanceManager() {
  const em = new EventEmitter();
  em._agents = new Map();
  em._instances = new Map();
  em.sendToAgent = function (id, msg) {
    em._agents.set(id, msg);
  };
  em.clearPendingApproval = function () {};
  em.unregister = function () {};
  em.get = function (id) { return em._instances.get(id) || null; };
  em.getAll = function () { return [...em._instances.values()]; };
  em._addInstance = function (inst) { em._instances.set(inst.id, inst); };
  return em;
}

// Mock MemoryManager
function createMockMemory() {
  return {
    _messages: [],
    getHistory: function (chatId, limit) {
      return this._messages.slice(-(limit || 50));
    },
    saveMessage: function (chatId, role, content) {
      this._messages.push({ role, content, content_type: 'text', timestamp: Date.now() });
    },
  };
}

describe('AgentBridge', () => {
  let im;
  let bridge;

  beforeEach(() => {
    im = createMockInstanceManager();
    bridge = new AgentBridge({
      instanceManager: im,
      serverPort: 7890,
      authToken: 'test-token',
      agentConfig: { name: 'Test PA', cwd: '/tmp', idleTimeoutMinutes: 30, historyInjectCount: 20 },
    });
  });

  it('starts with no instance ID', () => {
    assert.equal(bridge.getInstanceId(), null);
  });

  it('throws on sendPrompt without agent', () => {
    assert.throws(() => bridge.sendPrompt('hello'), /No agent running/);
  });

  it('fires message callbacks on instance:message event', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();

    const received = [];
    bridge.onMessage(function (msg) { received.push(msg); });

    im.emit('instance:message', { id: 'test-123', message: { role: 'assistant', content: 'hello' } });
    assert.equal(received.length, 1);
    assert.equal(received[0].content, 'hello');
  });

  it('ignores messages for other instances', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();

    const received = [];
    bridge.onMessage(function (msg) { received.push(msg); });

    im.emit('instance:message', { id: 'other-456', message: { role: 'assistant', content: 'nope' } });
    assert.equal(received.length, 0);
  });

  it('fires approval callbacks', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();

    const received = [];
    bridge.onApproval(function (approval, id) { received.push({ approval, id }); });

    im.emit('instance:approval', { id: 'test-123', approval: { tool: 'Bash', description: 'run ls' } });
    assert.equal(received.length, 1);
    assert.equal(received[0].approval.tool, 'Bash');
  });

  it('fires status callbacks', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();

    const received = [];
    bridge.onStatusChange(function (status) { received.push(status); });

    im.emit('instance:status', { id: 'test-123', status: 'busy' });
    assert.equal(received.length, 1);
    assert.equal(received[0], 'busy');
  });

  it('approve sends approve message', () => {
    bridge.instanceId = 'test-123';
    bridge.approve();
    const msg = im._agents.get('test-123');
    assert.deepEqual(msg, { type: 'approve' });
  });

  it('reject sends reject message', () => {
    bridge.instanceId = 'test-123';
    bridge.reject();
    const msg = im._agents.get('test-123');
    assert.deepEqual(msg, { type: 'reject' });
  });

  it('stopAgent cleans up', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
    bridge.stopAgent();
    assert.equal(bridge.getInstanceId(), null);
    assert.equal(bridge.agent, null);
  });

  it('unsubscribes from events on stop', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
    bridge.stopAgent();

    const received = [];
    bridge.onMessage(function (msg) { received.push(msg); });
    im.emit('instance:message', { id: 'test-123', message: { role: 'assistant', content: 'late' } });
    assert.equal(received.length, 0);
  });

  it('listAllInstances returns formatted list', () => {
    im._addInstance({ id: 'inst-1', name: 'Coding', status: 'busy', project: 'proj', agentType: 'claude' });
    im._addInstance({ id: 'inst-2', name: 'PA', status: 'idle', project: 'home', agentType: 'claude' });
    bridge.instanceId = 'inst-2';

    const list = bridge.listAllInstances();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Coding');
    assert.equal(list[0].isPa, false);
    assert.equal(list[1].name, 'PA');
    assert.equal(list[1].isPa, true);
  });

  it('listAllInstances returns empty when no instances', () => {
    assert.deepEqual(bridge.listAllInstances(), []);
  });

  it('approveInstance validates instance exists', () => {
    assert.equal(bridge.approveInstance('nonexistent'), false);
  });

  it('approveInstance sends approve to valid instance', () => {
    im._addInstance({ id: 'target-1', name: 'Test' });
    assert.equal(bridge.approveInstance('target-1'), true);
    assert.deepEqual(im._agents.get('target-1'), { type: 'approve' });
  });

  it('rejectInstance validates instance exists', () => {
    assert.equal(bridge.rejectInstance('nonexistent'), false);
  });

  it('rejectInstance sends reject to valid instance', () => {
    im._addInstance({ id: 'target-2', name: 'Test' });
    assert.equal(bridge.rejectInstance('target-2'), true);
    assert.deepEqual(im._agents.get('target-2'), { type: 'reject' });
  });

  it('abort sends abort message', () => {
    bridge.instanceId = 'test-123';
    im._addInstance({ id: 'test-123', name: 'PA' });
    bridge.abort();
    assert.deepEqual(im._agents.get('test-123'), { type: 'abort' });
  });

  it('starts with no agent type', () => {
    assert.equal(bridge.getAgentType(), null);
  });

  it('clears agent type on stop', () => {
    bridge.instanceId = 'test-123';
    bridge.agentType = 'claude';
    bridge._subscribeToEvents();
    bridge.stopAgent();
    assert.equal(bridge.getAgentType(), null);
  });
});

// --- Turn serialization ---

describe('AgentBridge turn serialization', () => {
  let im;
  let bridge;

  beforeEach(() => {
    im = createMockInstanceManager();
    bridge = new AgentBridge({
      instanceManager: im,
      serverPort: 7890,
      authToken: null,
      agentConfig: { name: 'Test PA', cwd: '/tmp' },
    });
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
  });

  it('sends prompt immediately when not busy', () => {
    bridge.sendPrompt('hello');
    assert.deepEqual(im._agents.get('test-123'), { type: 'prompt', text: 'hello' });
  });

  it('queues prompt when busy', () => {
    bridge._busy = true;
    bridge.sendPrompt('queued');
    // Should not have sent yet
    assert.equal(im._agents.get('test-123'), undefined);
  });

  it('processes queue when agent goes idle', () => {
    bridge._busy = true;
    bridge.sendPrompt('queued msg');

    // Simulate agent going idle
    im.emit('instance:status', { id: 'test-123', status: 'idle' });

    // Now the queued prompt should have been sent
    assert.deepEqual(im._agents.get('test-123'), { type: 'prompt', text: 'queued msg' });
  });

  it('preserves FIFO order for queued prompts', () => {
    bridge._busy = true;
    bridge.sendPrompt('first');
    bridge.sendPrompt('second');

    // Go idle — should process 'first'
    im.emit('instance:status', { id: 'test-123', status: 'idle' });
    assert.deepEqual(im._agents.get('test-123'), { type: 'prompt', text: 'first' });

    // Go idle again — should process 'second'
    im.emit('instance:status', { id: 'test-123', status: 'idle' });
    assert.deepEqual(im._agents.get('test-123'), { type: 'prompt', text: 'second' });
  });

  it('abort clears busy and processes queue', () => {
    bridge._busy = true;
    bridge.sendPrompt('after abort');
    bridge.abort();

    // After abort, busy is cleared and queue is processed
    assert.deepEqual(im._agents.get('test-123'), { type: 'prompt', text: 'after abort' });
  });
});

// --- History injection ---

describe('AgentBridge history injection', () => {
  let im;
  let memory;
  let bridge;

  beforeEach(() => {
    im = createMockInstanceManager();
    memory = createMockMemory();
    bridge = new AgentBridge({
      instanceManager: im,
      serverPort: 7890,
      authToken: null,
      agentConfig: { name: 'Test PA', cwd: '/tmp', historyInjectCount: 5 },
      memory: memory,
    });
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
    bridge.setPrimaryChatId('chat-1');
  });

  it('injects history on first prompt', () => {
    memory.saveMessage('chat-1', 'user', 'old question');
    memory.saveMessage('chat-1', 'assistant', 'old answer');

    bridge.sendPrompt('new question');

    const sent = im._agents.get('test-123');
    assert.ok(sent.text.includes('<conversation_history>'));
    assert.ok(sent.text.includes('old question'));
    assert.ok(sent.text.includes('old answer'));
    assert.ok(sent.text.includes('new question'));
  });

  it('does not inject history on subsequent prompts', () => {
    memory.saveMessage('chat-1', 'user', 'old');

    bridge.sendPrompt('first');
    bridge._busy = false; // Reset for next prompt
    bridge.sendPrompt('second');

    const sent = im._agents.get('test-123');
    assert.ok(!sent.text.includes('<conversation_history>'));
    assert.equal(sent.text, 'second');
  });

  it('skips injection when no history', () => {
    bridge.sendPrompt('hello');
    const sent = im._agents.get('test-123');
    assert.equal(sent.text, 'hello');
  });

  it('truncates long messages in history', () => {
    memory.saveMessage('chat-1', 'user', 'a'.repeat(600));
    bridge.sendPrompt('q');

    const sent = im._agents.get('test-123');
    assert.ok(sent.text.includes('a'.repeat(500) + '...'));
  });
});

// --- Idle cleanup ---

describe('AgentBridge idle cleanup', () => {
  let im;
  let bridge;

  beforeEach(() => {
    im = createMockInstanceManager();
    bridge = new AgentBridge({
      instanceManager: im,
      serverPort: 7890,
      authToken: null,
      agentConfig: { name: 'Test PA', cwd: '/tmp', idleTimeoutMinutes: 30 },
    });
  });

  it('updates lastActivity on message', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
    const before = bridge._lastActivity;

    // Small delay to ensure timestamp difference
    bridge._lastActivity = Date.now() - 10000;
    im.emit('instance:message', { id: 'test-123', message: { role: 'assistant', content: 'hi' } });

    assert.ok(bridge._lastActivity > before - 10000);
  });

  it('updates lastActivity on sendPrompt', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
    bridge._lastActivity = Date.now() - 10000;

    bridge.sendPrompt('hello');
    assert.ok(Date.now() - bridge._lastActivity < 1000);
  });

  it('stopAgent clears idle timer', () => {
    bridge.instanceId = 'test-123';
    bridge._subscribeToEvents();
    bridge._startIdleCleanup();
    assert.ok(bridge._idleTimer !== null);

    bridge.stopAgent();
    assert.equal(bridge._idleTimer, null);
  });
});
