const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { OneShotAgentRunner } = require('../src/agent/one-shot-runner');

// Same minimal mock InstanceManager used by gateway-tasks.test.js, kept
// local so the runner test isn't coupled to the gateway test file.
function createMockIM() {
  const em = new EventEmitter();
  const instances = new Map();
  const sent = [];

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
  em.unregister = function (id) {
    instances.delete(id);
    em.emit('instance:disconnected', { id });
  };
  em.get = function (id) { return instances.get(id) || null; };
  em.getAll = function () { return Array.from(instances.values()); };
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
  em.emitApproval = function (id, approval) {
    em.emit('instance:approval', { id, approval });
  };
  em.setAutoApprove = function (id, value) {
    const inst = instances.get(id);
    if (inst) inst.autoApprove = !!value;
  };
  em.sendToAgent = function (id, message) {
    if (!instances.has(id)) return false;
    sent.push({ id, message });
    return true;
  };
  em._sent = sent;
  em._instances = instances;
  return em;
}

function createFakeAgent(im, agentType, options) {
  const id = 'fake-' + Math.random().toString(36).slice(2, 8);
  return {
    instanceId: id,
    started: false,
    stopped: false,
    options,
    async start() {
      this.started = true;
      im.register({
        id, name: options.name, cwd: options.cwd,
        project: options.project, agentType,
        source: options.source,
      });
    },
    stop() { this.stopped = true; },
  };
}

describe('OneShotAgentRunner: basic lifecycle', () => {
  let im, runner;

  beforeEach(() => {
    im = createMockIM();
    runner = new OneShotAgentRunner({
      instanceManager: im,
      hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });

  afterEach(() => runner.destroy());

  it('rejects when required opts are missing', async () => {
    await assert.rejects(() => runner.run({}), /requires agentType/);
    await assert.rejects(
      () => runner.run({ agentType: 'claude', cwd: '/tmp', prompt: 'x', name: 'n' }),
      /requires.*source/
    );
  });

  it('spawns an agent and tags name + source', async () => {
    let spawnedId = null;
    const p = runner.run({
      agentType: 'claude',
      cwd: '/tmp',
      prompt: 'do the thing',
      name: 'Test: integration',
      source: 'test:integration',
      onSpawn: (id) => { spawnedId = id; },
    });
    // run() is async — yield once so the agent.start() await completes
    // and onSpawn fires before we assert.
    await new Promise(r => setImmediate(r));
    assert.ok(spawnedId, 'onSpawn should fire with the agent id');
    const inst = im.get(spawnedId);
    assert.ok(inst, 'instance must be registered');
    assert.equal(inst.source, 'test:integration');
    assert.equal(inst.name, 'Test: integration');

    // Drive the agent to completion
    im.updateStatus(spawnedId, 'busy');
    im.addMessage(spawnedId, { role: 'assistant', content: 'done' });
    im.updateStatus(spawnedId, 'idle');

    const result = await p;
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'done');
    assert.equal(result.agentInstanceId, spawnedId);
    assert.ok(result.durationMs >= 0);
  });

  it('streams assistant text via onChunk in order', async () => {
    const chunks = [];
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:chunks',
      onChunk: (text) => chunks.push(text),
    });
    // Wait one tick for run() to set up
    await new Promise(r => setImmediate(r));
    const id = Array.from(im._instances.keys())[0];
    im.updateStatus(id, 'busy');
    im.addMessage(id, { role: 'assistant', content: 'chunk 1' });
    im.addMessage(id, { role: 'assistant', content: 'chunk 2' });
    im.updateStatus(id, 'idle');
    const result = await p;
    assert.deepEqual(chunks, ['chunk 1', 'chunk 2']);
    assert.ok(result.output.includes('chunk 1'));
    assert.ok(result.output.includes('chunk 2'));
  });

  it('sends the prompt with attachments forwarded to the agent', async () => {
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'hello',
      name: 'Test', source: 'test:atts',
      attachments: [{ path: '/tmp/x.png', mediaType: 'image/png', filename: 'x.png' }],
    });
    await new Promise(r => setImmediate(r));
    const promptMsg = im._sent.find(s => s.message.type === 'prompt');
    assert.ok(promptMsg, 'a prompt should have been sent');
    assert.equal(promptMsg.message.text, 'hello');
    assert.equal(promptMsg.message.attachments.length, 1);
    assert.equal(promptMsg.message.attachments[0].filename, 'x.png');
    const id = Array.from(im._instances.keys())[0];
    im.updateStatus(id, 'busy'); im.updateStatus(id, 'idle');
    await p;
  });
});

describe('OneShotAgentRunner: failure modes', () => {
  let im, runner;

  beforeEach(() => {
    im = createMockIM();
    runner = new OneShotAgentRunner({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });

  afterEach(() => runner.destroy());

  it('fails closed on approval requests with reason approval_required', async () => {
    let approvalSeen = null;
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:approval',
      onApproval: (req) => { approvalSeen = req; },
    });
    await new Promise(r => setImmediate(r));
    const id = Array.from(im._instances.keys())[0];
    im.updateStatus(id, 'busy');
    im.emitApproval(id, { tool: 'Bash', toolUseId: 'tu-1' });
    const result = await p;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'approval_required');
    assert.ok(approvalSeen);
    assert.equal(approvalSeen.tool, 'Bash');
    // Abort should have been delivered
    const abort = im._sent.find(s => s.message.type === 'abort');
    assert.ok(abort, 'abort should be sent to the agent');
  });

  it('fires the timeout when the agent never returns idle', async () => {
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:timeout',
      timeoutMs: 25,
    });
    const result = await p;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'timeout');
  });

  it('cancel() terminates an in-flight run with status cancelled', async () => {
    let spawnedId = null;
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:cancel',
      onSpawn: (id) => { spawnedId = id; },
    });
    await new Promise(r => setImmediate(r));
    const ok = runner.cancel(spawnedId);
    assert.equal(ok, true);
    const result = await p;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.error, 'cancelled_by_caller');
    // Cancel again should be a no-op
    assert.equal(runner.cancel(spawnedId), false);
  });

  it('surfaces agent_ws_timeout when the socket never opens', async () => {
    runner = new OneShotAgentRunner({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => { throw new Error('agent_ws_timeout'); },
    });
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:ws',
    });
    const result = await p;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'agent_ws_timeout');
  });
});

describe('OneShotAgentRunner: cleanup', () => {
  let im, runner;

  beforeEach(() => {
    im = createMockIM();
    runner = new OneShotAgentRunner({
      instanceManager: im, hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });

  it('stops the agent and unregisters on terminal state', async () => {
    let spawnedId = null;
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:cleanup',
      onSpawn: (id) => { spawnedId = id; },
    });
    await new Promise(r => setImmediate(r));
    im.updateStatus(spawnedId, 'busy');
    im.updateStatus(spawnedId, 'idle');
    await p;
    assert.equal(im.get(spawnedId), null, 'instance should be unregistered');
  });

  it('emits run:done after a successful run', async () => {
    const events = [];
    runner.on('run:done', (r) => events.push(r));
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:emit',
    });
    await new Promise(r => setImmediate(r));
    const id = Array.from(im._instances.keys())[0];
    im.updateStatus(id, 'busy'); im.updateStatus(id, 'idle');
    await p;
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'completed');
    runner.destroy();
  });

  it('destroy() tears down listeners and aborts in-flight runs', async () => {
    let spawnedId = null;
    const p = runner.run({
      agentType: 'claude', cwd: '/tmp', prompt: 'x',
      name: 'Test', source: 'test:destroy',
      onSpawn: (id) => { spawnedId = id; },
    });
    await new Promise(r => setImmediate(r));
    runner.destroy();
    // The instance was force-unregistered by destroy
    assert.equal(im.get(spawnedId), null);
    // No listeners remain
    assert.equal(im.listenerCount('instance:status'), 0);
    assert.equal(im.listenerCount('instance:message'), 0);
    assert.equal(im.listenerCount('instance:approval'), 0);
  });
});

describe('OneShotAgentRunner: bounded in-session turns', () => {
  let im, runner;

  beforeEach(() => {
    im = createMockIM();
    runner = new OneShotAgentRunner({
      instanceManager: im,
      hubPort: 7890,
      createAgent: (type, opts) => createFakeAgent(im, type, opts),
      waitForSocket: async () => {},
    });
  });

  afterEach(() => runner.destroy());

  const tick = () => new Promise((r) => setImmediate(r));

  // Drive one agent turn: busy, some text, then idle.
  async function turn(id, text) {
    im.updateStatus(id, 'busy');
    if (text) im.addMessage(id, { role: 'assistant', content: text });
    im.updateStatus(id, 'idle');
    await tick();
  }

  function start(opts) {
    let id = null;
    const p = runner.run(Object.assign({
      agentType: 'claude', cwd: '/tmp', prompt: 'do it',
      name: 'Arm', source: 'mind:g1',
      onSpawn: (agentInstanceId) => { id = agentInstanceId; },
    }, opts));
    return { promise: p, id: () => id };
  }

  it('ends after one turn by default, as before', async () => {
    const run = start({});
    await tick();
    await turn(run.id(), 'all done');
    const res = await run.promise;
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'all done');
    assert.equal(res.turns, 1);
  });

  it('never consults onTurnEnd when maxTurns is 1', async () => {
    let asked = 0;
    const run = start({ onTurnEnd: () => { asked++; return 'answer'; } });
    await tick();
    await turn(run.id(), 'question?');
    await run.promise;
    assert.equal(asked, 0);
  });

  it('answers the agent in the same session instead of killing it', async () => {
    // The point of the whole thing: an arm that asks for a detail keeps
    // its context and continues, rather than being replaced by a fresh
    // arm that has to redo the work it already did.
    const seen = [];
    const run = start({
      maxTurns: 3,
      onTurnEnd: (t) => {
        seen.push(t.output);
        return t.turn === 1 ? 'use postgres' : null;
      },
    });
    await tick();
    await turn(run.id(), 'Which database should I use?');
    await turn(run.id(), 'Done, migrated to postgres.');

    const res = await run.promise;
    assert.equal(res.status, 'completed');
    assert.equal(res.turns, 2);
    assert.deepEqual(seen, ['Which database should I use?', 'Done, migrated to postgres.']);
    // The follow-up went to the SAME agent instance.
    const prompts = im._sent.filter((m) => m.message.type === 'prompt');
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].id, prompts[1].id);
    assert.equal(prompts[1].message.text, 'use postgres');
  });

  it('gives each turn only its own output, and the run the whole thing', async () => {
    const perTurn = [];
    let full = null;
    const run = start({
      maxTurns: 2,
      onTurnEnd: (t) => { perTurn.push(t.output); full = t.fullOutput; return 'go on'; },
    });
    await tick();
    await turn(run.id(), 'first');
    await turn(run.id(), 'second');
    const res = await run.promise;
    assert.deepEqual(perTurn, ['first']);
    assert.equal(full, 'first');
    assert.equal(res.output, 'first\nsecond');
  });

  it('stops at the turn budget even if the caller keeps answering', async () => {
    let asked = 0;
    const run = start({ maxTurns: 2, onTurnEnd: () => { asked++; return 'keep going'; } });
    await tick();
    await turn(run.id(), 'one');
    await turn(run.id(), 'two');
    const res = await run.promise;
    assert.equal(res.turns, 2);
    assert.equal(asked, 1, 'not consulted once the budget is spent');
  });

  it('ends the run when the caller declines to answer', async () => {
    const run = start({ maxTurns: 5, onTurnEnd: () => null });
    await tick();
    await turn(run.id(), 'anything else?');
    const res = await run.promise;
    assert.equal(res.status, 'completed');
    assert.equal(res.turns, 1);
  });

  it('treats a blank answer as declining', async () => {
    const run = start({ maxTurns: 5, onTurnEnd: () => '   ' });
    await tick();
    await turn(run.id(), 'hm');
    const res = await run.promise;
    assert.equal(res.turns, 1);
  });

  it('does not fail the run when the caller throws while deciding', async () => {
    const run = start({ maxTurns: 3, onTurnEnd: () => { throw new Error('reasoner down'); } });
    await tick();
    await turn(run.id(), 'partial work');
    const res = await run.promise;
    assert.equal(res.status, 'completed', 'the work already done still counts');
    assert.equal(res.output, 'partial work');
  });

  it('accepts an async decision', async () => {
    const run = start({
      maxTurns: 2,
      onTurnEnd: async (t) => {
        await new Promise((r) => setTimeout(r, 10));
        return t.turn === 1 ? 'answered late' : null;
      },
    });
    await tick();
    await turn(run.id(), 'q?');
    await new Promise((r) => setTimeout(r, 30));
    await turn(run.id(), 'ok');
    const res = await run.promise;
    assert.equal(res.turns, 2);
  });

  it('can be cancelled while the caller is still deciding', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const run = start({ maxTurns: 3, onTurnEnd: async () => { await gate; return 'too late'; } });
    await tick();
    await turn(run.id(), 'thinking');

    runner.cancel(run.id());
    release();
    const res = await run.promise;
    assert.equal(res.status, 'cancelled');
    // The stale answer must not be delivered after cancellation.
    const prompts = im._sent.filter((m) => m.message.type === 'prompt');
    assert.equal(prompts.length, 1);
  });

  it('ignores a stray idle arriving before the follow-up turn starts', async () => {
    // Between sending a follow-up and the agent going busy, an idle
    // event must not be read as that turn already finishing.
    let asked = 0;
    const run = start({
      maxTurns: 4,
      onTurnEnd: () => { asked++; return asked === 1 ? 'continue' : null; },
    });
    await tick();
    await turn(run.id(), 'first');

    im.updateStatus(run.id(), 'idle');   // stray, agent not busy yet
    await tick();
    assert.equal(asked, 1, 'stray idle must not end a turn that never began');

    await turn(run.id(), 'second');
    const res = await run.promise;
    assert.equal(res.turns, 2);
  });
});
