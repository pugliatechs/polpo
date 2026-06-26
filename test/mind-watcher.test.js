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
      // Origin tag — null by default so unset registrations behave
      // like a user-started session; tests that want mind-owned arms
      // pass `source: 'mind:test'` explicitly.
      source: info.source != null ? info.source : null,
    };
    instances.set(id, inst);
    em.emit('instance:registered', inst);
    return inst;
  };
  // Helper for tests that want the watcher to actually fire — it only
  // alerts on mind-owned arms now (the source tag scoping). Use this
  // in place of `em.register({...})` to stamp source: 'mind:test'.
  em.registerMindArm = function (info) {
    return em.register(Object.assign({}, info, { source: 'mind:test' }));
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
    im.registerMindArm({ id: 'a1', name: 'Slow Worker' });
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

    im.registerMindArm({ id: 'a1', name: 'Active Worker' });
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

    im.registerMindArm({ id: 'a1', name: 'Stuck' });
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

    im.registerMindArm({ id: 'a1', name: 'Recovering' });
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

    im.registerMindArm({ id: 'a1', name: 'Waiting Agent' });
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

  // v1.2.2: the watcher's "infiltration" fix — the watcher should
  // only alert about arms the mind itself spawned (source: 'mind:...'),
  // not user-started sessions (source: null) or gateway-spawned tasks
  // (source: 'gateway:...'). Previously a user with a Claude/Codex
  // session pending an approval modal would see noisy "X is waiting
  // for approval" messages flooding the mind's chat even though the
  // mind had never been asked to touch that session.
  it('does NOT alert on stuck USER-started sessions (source: null)', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    // Plain im.register — no source tag → user-started session
    im.register({ id: 'a1', name: 'User session' });
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 200;

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 0);
  });

  it('does NOT alert on stuck GATEWAY-spawned tasks (source: gateway:...)', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.register({ id: 'a1', name: 'Gateway task', source: 'gateway:openclaw' });
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 200;

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 0);
  });

  it('does NOT alert on user-started sessions waiting for approval', () => {
    var policy = { stuckThresholdMs: 60000, watcherIntervalMs: 30000 };
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.register({ id: 'a1', name: 'User session waiting' });
    var inst = im.get('a1');
    inst.status = 'waiting';
    inst.pendingApproval = { tool: 'Bash', description: 'rm -rf /tmp/x' };

    watcher._check();

    var conv = im.getConversation(MIND_ID, 10);
    var alerts = conv.filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 0, 'mind chat must NOT light up for user sessions awaiting approval');
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
    var required = ['name', 'autoApproveSpawned', 'maxConcurrentTasks', 'maxSpawnedAgents', 'taskTimeoutMs', 'stuckThresholdMs', 'watcherIntervalMs', 'autoActOnStuck', 'stuckActionMultiplier'];
    for (var key in POLICIES) {
      var p = POLICIES[key];
      for (var i = 0; i < required.length; i++) {
        assert.ok(p[required[i]] !== undefined, key + ' missing ' + required[i]);
      }
    }
  });
});

// ---- Autonomous action ----

describe('Watcher autonomous action on stuck agents', () => {
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

  function createMockCoordinator() {
    return {
      _calls: [],
      _taskAgents: new Set(),
      registerTask: function (agentId) { this._taskAgents.add(agentId); },
      failAgentTask: function (agentId, reason) {
        this._calls.push({ agentId: agentId, reason: reason });
        if (this._taskAgents.has(agentId)) {
          this._taskAgents.delete(agentId);
          return true;
        }
        return false;
      },
    };
  }

  it('does NOT act when policy.autoActOnStuck is false', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: false, stuckActionMultiplier: 2 };
    var coordinator = createMockCoordinator();
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy, coordinator: coordinator });

    im.registerMindArm({ id: 'a1', name: 'Stuck' });
    coordinator.registerTask('a1');
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 10000; // very stuck

    watcher._check();

    assert.equal(coordinator._calls.length, 0, 'coordinator should not be called when autoActOnStuck is false');
  });

  it('alerts but does NOT act before the action threshold (multiplier window)', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: true, stuckActionMultiplier: 5 };
    var coordinator = createMockCoordinator();
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy, coordinator: coordinator });

    im.registerMindArm({ id: 'a1', name: 'Briefly stuck' });
    coordinator.registerTask('a1');
    im.updateStatus('a1', 'busy');
    // Past the alert threshold (100ms) but well before action threshold (500ms)
    im.get('a1').lastActivity = Date.now() - 200;

    watcher._check();

    var alerts = im.getConversation(MIND_ID, 10).filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 1, 'should alert in stage 1');
    assert.equal(coordinator._calls.length, 0, 'should NOT have acted yet');
  });

  it('acts when busy duration exceeds threshold * multiplier', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: true, stuckActionMultiplier: 2 };
    var coordinator = createMockCoordinator();
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy, coordinator: coordinator });

    im.registerMindArm({ id: 'a1', name: 'Very stuck' });
    coordinator.registerTask('a1');
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 500; // > 100 * 2

    watcher._check();

    assert.equal(coordinator._calls.length, 1);
    assert.equal(coordinator._calls[0].agentId, 'a1');
    assert.ok(coordinator._calls[0].reason.indexOf('Auto-cancelled') !== -1);

    var actionMsgs = im.getConversation(MIND_ID, 10).filter(function (m) {
      return m.source === 'mind-watcher' && m.content.indexOf('Auto-cancelled') !== -1;
    });
    assert.equal(actionMsgs.length, 1, 'should report the cancellation');
  });

  it('only acts once per stuck episode', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: true, stuckActionMultiplier: 2 };
    var coordinator = createMockCoordinator();
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy, coordinator: coordinator });

    im.registerMindArm({ id: 'a1', name: 'Stubborn' });
    coordinator.registerTask('a1');
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 500;

    watcher._check();
    watcher._check();
    watcher._check();

    assert.equal(coordinator._calls.length, 1, 'should only call coordinator once');
  });

  it('does NOT touch user-started sessions even when stuck past the action threshold', () => {
    // v1.2.2: the watcher's source-tag scoping means it now skips
    // user sessions entirely — neither alerting nor auto-acting.
    // The coordinator should never even be called.
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: true, stuckActionMultiplier: 2 };
    var coordinator = createMockCoordinator();
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy, coordinator: coordinator });

    // Plain im.register (no source tag) → user-started session
    im.register({ id: 'user-sess', name: 'User Session' });
    im.updateStatus('user-sess', 'busy');
    im.get('user-sess').lastActivity = Date.now() - 500;

    watcher._check();

    assert.equal(coordinator._calls.length, 0, 'coordinator must not be asked to cancel a session the mind never spawned');
    var actionMsgs = im.getConversation(MIND_ID, 10).filter(function (m) {
      return m.source === 'mind-watcher' && m.content.indexOf('Auto-cancelled') !== -1;
    });
    assert.equal(actionMsgs.length, 0, 'no action message for a session we did not own');
  });

  it('does not act without a coordinator reference', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: true, stuckActionMultiplier: 2 };
    // No coordinator passed
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy });

    im.registerMindArm({ id: 'a1', name: 'Stuck no coord' });
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 500;

    // Should not throw; alert only
    watcher._check();

    var alerts = im.getConversation(MIND_ID, 10).filter(function (m) { return m.source === 'mind-watcher'; });
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].content.indexOf('busy for') !== -1);
  });

  it('re-arms after the agent stops being busy', () => {
    var policy = { stuckThresholdMs: 100, watcherIntervalMs: 30000, autoActOnStuck: true, stuckActionMultiplier: 2 };
    var coordinator = createMockCoordinator();
    watcher = new Watcher({ worldModel: wm, instanceManager: im, mindInstanceId: MIND_ID, policy: policy, coordinator: coordinator });

    im.registerMindArm({ id: 'a1', name: 'Round 1' });
    coordinator.registerTask('a1');
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 500;
    watcher._check();
    assert.equal(coordinator._calls.length, 1);

    // Agent recovers
    im.updateStatus('a1', 'idle');
    watcher._check(); // cleanup pass clears the alerted/acted flags

    // New stuck episode
    coordinator.registerTask('a1');
    im.updateStatus('a1', 'busy');
    im.get('a1').lastActivity = Date.now() - 500;
    watcher._check();

    assert.equal(coordinator._calls.length, 2, 'should be able to act on a fresh stuck episode');
  });
});
