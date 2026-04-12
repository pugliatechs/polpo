const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { Watcher } = require('../src/mind/watcher');
const { WorldModel } = require('../src/mind/world-model');
const { loadPolicy, POLICIES } = require('../src/mind/policies');

// Mock InstanceManager
function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
  em.register = function (info) {
    const id = info.id || 'inst-' + instances.size;
    const inst = {
      id, name: info.name || 'Test', status: 'idle',
      cwd: info.cwd || '/tmp', project: info.project || 'test',
      agentType: info.agentType || 'claude', canReceivePrompts: true,
      lastActivity: Date.now(), pendingApproval: null,
      conversation: [], conversationLength: 0,
    };
    instances.set(id, inst);
    em.emit('instance:registered', inst);
    return inst;
  };
  em.get = function (id) { return instances.get(id) || null; };
  em.getAll = function () {
    return [...instances.values()].map(function (i) {
      return { ...i, conversationLength: i.conversation.length };
    });
  };
  em.updateStatus = function (id, status) {
    const inst = instances.get(id);
    if (inst) { inst.status = status; inst.lastActivity = Date.now(); em.emit('instance:status', { id, status }); }
  };
  em.addMessage = function (id, msg) {
    const inst = instances.get(id);
    if (inst) { inst.conversation.push(msg); em.emit('instance:message', { id, message: msg }); }
  };
  em.getConversation = function (id, limit) {
    const inst = instances.get(id);
    return inst ? inst.conversation.slice(-(limit || 50)) : [];
  };
  em.unregister = function (id) { instances.delete(id); };
  em._instances = instances;
  return em;
}

const MIND_ID = 'mind-001';

describe('Watcher', () => {
  let im;
  let wm;
  let watcher;

  beforeEach(() => {
    im = createMockIM();
    im.register({ id: MIND_ID, name: 'Mind', agentType: 'mind' });
    wm = new WorldModel(im, MIND_ID);
  });

  afterEach(() => {
    if (watcher) watcher.destroy();
    wm.destroy();
  });

  it('detects stuck agents', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    // Register an agent and make it busy with old lastActivity
    im.register({ id: 'a1', name: 'Slow Worker' });
    im.updateStatus('a1', 'busy');
    // Hack lastActivity to be old
    im.get('a1').lastActivity = Date.now() - 200;

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].content.includes('Slow Worker'));
    assert.ok(alerts[0].content.includes('stuck'));
  });

  it('does not alert for recently active busy agents', () => {
    var policy = { stuckThresholdMs: 60000, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.register({ id: 'a1', name: 'Active Worker' });
    im.updateStatus('a1', 'busy');
    // lastActivity is fresh (just set by updateStatus)

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 0);
  });

  it('does not double-alert for the same stuck agent', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.register({ id: 'a1', name: 'Stuck' });
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 200;

    watcher._check();
    watcher._check(); // Second check should not re-alert

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 1);
  });

  it('clears stuck alert when agent goes idle', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.register({ id: 'a1', name: 'Recovering' });
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 200;

    watcher._check(); // Should alert
    im.updateStatus('a1', 'idle');
    watcher._check(); // Should clear alert

    // Make it stuck again
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 200;
    watcher._check(); // Should alert again

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 2); // Alerted twice (cleared in between)
  });

  it('detects stale approval requests', () => {
    var policy = { stuckThresholdMs: 60000, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.register({ id: 'a1', name: 'Waiting Agent' });
    var inst = im.get('a1');
    inst.status = 'waiting';
    inst.pendingApproval = { tool: 'Bash', description: 'run tests' };

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].content.includes('Waiting Agent'));
    assert.ok(alerts[0].content.includes('approval'));
  });

  it('ignores mind instance in checks', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    // Mind itself should not be detected as stuck
    im.updateStatus(MIND_ID, 'busy');
    im.get(MIND_ID).lastActivity = Date.now() - 200;

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 0);
  });

  it('start and stop control the timer', () => {
    var policy = { watcherIntervalMs: 100000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    assert.equal(watcher._timer, null);
    watcher.start();
    assert.ok(watcher._timer !== null);
    watcher.stop();
    assert.equal(watcher._timer, null);
  });

  it('destroy cleans up', () => {
    var policy = { watcherIntervalMs: 100000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });
    watcher.start();
    watcher.destroy();
    assert.equal(watcher._timer, null);
    assert.equal(watcher._alerted.size, 0);
  });
});

describe('Policies', () => {
  it('loadPolicy returns balanced by default', () => {
    var saved = process.env.POLPO_MIND_POLICY;
    delete process.env.POLPO_MIND_POLICY;
    var policy = loadPolicy();
    assert.equal(policy.name, 'balanced');
    if (saved) process.env.POLPO_MIND_POLICY = saved;
  });

  it('loadPolicy respects env var', () => {
    var saved = process.env.POLPO_MIND_POLICY;
    process.env.POLPO_MIND_POLICY = 'conservative';
    var policy = loadPolicy();
    assert.equal(policy.name, 'conservative');
    if (saved) process.env.POLPO_MIND_POLICY = saved;
    else delete process.env.POLPO_MIND_POLICY;
  });

  it('loadPolicy falls back for invalid', () => {
    var saved = process.env.POLPO_MIND_POLICY;
    process.env.POLPO_MIND_POLICY = 'invalid';
    var policy = loadPolicy();
    assert.equal(policy.name, 'balanced');
    if (saved) process.env.POLPO_MIND_POLICY = saved;
    else delete process.env.POLPO_MIND_POLICY;
  });

  it('all policies have required fields', () => {
    var required = ['name', 'autoApproveSpawned', 'maxConcurrentTasks', 'maxSpawnedAgents', 'taskTimeoutMs', 'stuckThresholdMs', 'watcherIntervalMs'];
    for (var key in POLICIES) {
      var p = POLICIES[key];
      for (var i = 0; i < required.length; i++) {
        assert.ok(p[required[i]] !== undefined, key + ' missing ' + required[i]);
      }
    }
  });
});
