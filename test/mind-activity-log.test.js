const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { attachActivityLog, labelFor, originOf, formatDuration } = require('../src/mind/activity-log');

/**
 * The mind's verbose activity log.
 *
 * It used to label every agent with its session's first prompt, which
 * wrote whatever the user had typed into a log that gets saved and
 * pasted around, used a different identifier on 'removed' than on every
 * other line, and printed a fresh 'busy' line on every activity event.
 */

const SECRET_PROMPT = 'Confidential: the client is weighing whether to switch vendors';

function harness() {
  const wm = new EventEmitter();
  const instances = new Map();
  const im = { get: (id) => instances.get(id) || null };
  const lines = [];
  let clock = 1000000;
  const detach = attachActivityLog({
    worldModel: wm,
    instanceManager: im,
    log: { info: (m) => lines.push(m) },
    now: () => clock,
  });
  return {
    wm, lines, detach,
    add(inst) { instances.set(inst.id, inst); },
    advance(ms) { clock += ms; },
  };
}

const SESSION = {
  id: 'c5005793-7b8d-4b50-8a7f-d3e10087b7c4',
  name: SECRET_PROMPT,
  firstPrompt: SECRET_PROMPT,
  agentType: 'claude',
  project: 'docs',
  source: null,
};

describe('activity log labels', () => {
  it('names an agent by type, short id, origin and project', () => {
    assert.equal(labelFor(SESSION), 'claude c5005793 [session] docs');
  });

  it('tells sessions, mind arms and gateway tasks apart', () => {
    assert.equal(originOf(null), 'session');
    assert.equal(originOf('mind:goal-1234'), 'mind arm');
    assert.equal(originOf('gateway:openclaw'), 'gateway openclaw');
  });

  it('formats durations compactly', () => {
    assert.equal(formatDuration(42000), '42s');
    assert.equal(formatDuration(84000), '1m24s');
    assert.equal(formatDuration(2 * 3600000 + 5 * 60000), '2h05m');
  });
});

describe('activity log output', () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.add(SESSION);
  });

  it('never writes prompt text', () => {
    h.wm.emit('agent:added', { id: SESSION.id, name: SESSION.name, agentType: 'claude' });
    h.wm.emit('agent:busy', { id: SESSION.id, name: SESSION.name });
    h.wm.emit('agent:idle', { id: SESSION.id, name: SESSION.name });
    h.wm.emit('agent:removed', { id: SESSION.id });
    for (const line of h.lines) {
      assert.ok(!line.includes('Confidential'), 'prompt leaked: ' + line);
      assert.ok(!line.includes('vendors'), 'prompt leaked: ' + line);
    }
  });

  it('uses the same label on every line, removal included', () => {
    h.wm.emit('agent:added', { id: SESSION.id });
    h.wm.emit('agent:busy', { id: SESSION.id });
    h.wm.emit('agent:removed', { id: SESSION.id });
    for (const line of h.lines) assert.ok(line.includes('claude c5005793 [session] docs'), line);
  });

  it('logs only transitions, not every busy event', () => {
    h.wm.emit('agent:added', { id: SESSION.id });
    for (let i = 0; i < 5; i++) h.wm.emit('agent:busy', { id: SESSION.id });
    assert.equal(h.lines.filter((l) => l.startsWith('Agent busy')).length, 1);
  });

  it('reports how long a turn and an agent lasted', () => {
    h.wm.emit('agent:added', { id: SESSION.id });
    h.wm.emit('agent:busy', { id: SESSION.id });
    h.advance(84000);
    h.wm.emit('agent:idle', { id: SESSION.id });
    h.advance(98000);
    h.wm.emit('agent:removed', { id: SESSION.id });
    assert.ok(h.lines.includes('Agent idle    claude c5005793 [session] docs (busy 1m24s)'), h.lines.join('\n'));
    assert.ok(h.lines.includes('Agent removed claude c5005793 [session] docs (alive 3m02s)'), h.lines.join('\n'));
  });

  it('labels an agent it only ever sees change status', () => {
    // Agents registered before the mind started never emit 'added'.
    h.wm.emit('agent:busy', { id: SESSION.id });
    assert.equal(h.lines[0], 'Agent busy    claude c5005793 [session] docs');
  });

  it('says "All agents idle" once per quiet period', () => {
    h.wm.emit('all:idle');
    h.wm.emit('all:idle');
    h.wm.emit('agent:busy', { id: SESSION.id });
    h.wm.emit('all:idle');
    assert.equal(h.lines.filter((l) => l === 'All agents idle').length, 2);
  });

  it('stops logging once detached', () => {
    h.detach();
    h.wm.emit('agent:busy', { id: SESSION.id });
    assert.equal(h.lines.length, 0);
  });
});
