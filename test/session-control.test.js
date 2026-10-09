const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const InstanceManager = require('../src/server/instances');
const {
  SessionController,
  readTranscriptTail,
  lastConversationalUuid,
  foreignWriterSince,
  writerLabel,
} = require('../src/server/session-control');

/**
 * One writer at a time.
 *
 * A session busy anywhere can only be read; an idle one can be taken over
 * and continued with the same session id; and a session polpo drives is
 * handed back the moment someone else writes to its transcript, which is
 * what happens when you reload VSCode and carry on at the desk. Real
 * transcripts show these handoffs as alternating 'claude-vscode' and
 * 'sdk-cli' runs.
 */

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-sc-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function entry(uuid, writer, extra) {
  return Object.assign({ type: 'assistant', uuid, entrypoint: writer, message: { content: 'x' } }, extra || {});
}

function writeTranscript(file, entries) {
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function append(file, e) {
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
}

describe('transcript helpers', () => {
  it('reads the end of a transcript and skips a partial first line', () => {
    const f = path.join(tmp, 't.jsonl');
    writeTranscript(f, [entry('a', 'claude-vscode'), entry('b', 'claude-vscode'), entry('c', 'sdk-cli')]);
    const size = fs.statSync(f).size;
    const tail = readTranscriptTail(f, size - 10);   // cuts into the first line
    assert.deepEqual(tail.map((e) => e.uuid), ['b', 'c']);
  });

  it('returns nothing for a missing transcript', () => {
    assert.deepEqual(readTranscriptTail(path.join(tmp, 'nope.jsonl')), []);
  });

  it('takes the newest main-conversation entry as the baseline', () => {
    const entries = [
      entry('a', 'claude-vscode'),
      entry('sub', 'claude-vscode', { isSidechain: true }),
      { type: 'summary', uuid: 'meta' },
    ];
    assert.equal(lastConversationalUuid(entries), 'a');
  });

  it('ignores polpo\'s own turns after the baseline', () => {
    const entries = [entry('base', 'claude-vscode'), entry('p1', 'sdk-cli'), entry('p2', 'sdk-cli')];
    assert.equal(foreignWriterSince(entries, 'base'), null);
  });

  it('spots VSCode writing after the baseline', () => {
    const entries = [entry('base', 'claude-vscode'), entry('p1', 'sdk-cli'), entry('v1', 'claude-vscode')];
    assert.deepEqual(foreignWriterSince(entries, 'base'), { writer: 'claude-vscode' });
  });

  it('does not count entries before the baseline', () => {
    const entries = [entry('old', 'claude-vscode'), entry('base', 'claude-vscode')];
    assert.equal(foreignWriterSince(entries, 'base'), null);
  });

  it('ignores subagent entries, which polpo\'s own process writes', () => {
    const entries = [entry('base', 'sdk-cli'), entry('s', 'claude-vscode', { isSidechain: true })];
    assert.equal(foreignWriterSince(entries, 'base'), null);
  });

  it('treats the whole window as new when the baseline scrolled out', () => {
    const entries = [entry('p1', 'sdk-cli'), entry('t1', 'cli')];
    assert.deepEqual(foreignWriterSince(entries, 'long-gone'), { writer: 'cli' });
  });

  it('names writers for the user', () => {
    assert.equal(writerLabel('claude-vscode'), 'VSCode');
    assert.equal(writerLabel('cli'), 'a terminal');
    assert.equal(writerLabel('sdk-py'), 'another program');
  });
});

describe('transcriptActivity', () => {
  const { transcriptActivity } = require('../src/server/session-control');
  const now = Date.parse('2026-10-09T12:00:00Z');
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const opts = { now, staleMs: 10 * 60000 };

  it('is idle once the last turn ended', () => {
    const e = [entry('a', 'cli', { type: 'user', timestamp: at(1) }),
      entry('b', 'cli', { timestamp: at(1), message: { stop_reason: 'end_turn' } })];
    assert.deepEqual(transcriptActivity(e, opts), { state: 'idle', reason: 'turn_ended' });
  });

  it('is idle after a refusal ended the turn', () => {
    const e = [entry('b', 'cli', { timestamp: at(1), message: { stop_reason: 'refusal' } })];
    assert.equal(transcriptActivity(e, opts).state, 'idle');
  });

  it('is busy while a tool runs or a prompt waits for its answer', () => {
    assert.equal(transcriptActivity([entry('b', 'cli', { timestamp: at(1), message: { stop_reason: 'tool_use' } })], opts).state, 'busy');
    assert.equal(transcriptActivity([entry('u', 'cli', { type: 'user', timestamp: at(1) })], opts).state, 'busy');
  });

  it('treats a turn silent for longer than the stale window as interrupted', () => {
    const e = [entry('u', 'claude-vscode', { type: 'user', timestamp: at(30) })];
    assert.deepEqual(transcriptActivity(e, opts), { state: 'idle', reason: 'stale' });
  });

  it('ignores subagent entries', () => {
    const e = [entry('b', 'cli', { timestamp: at(1), message: { stop_reason: 'end_turn' } }),
      entry('s', 'cli', { isSidechain: true, timestamp: at(0) })];
    assert.equal(transcriptActivity(e, opts).state, 'idle');
  });

  it('cannot tell from an empty transcript', () => {
    assert.equal(transcriptActivity([], opts).state, 'unknown');
  });
});

describe('SessionController', () => {
  let im, agents, ctl, transcript;

  /** Agents that register with the instance manager like real ones. */
  function agentFactory(type, opts) {
    const id = 'agent-' + (agents.length + 1);
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.close = () => { ws.readyState = 3; ws.emit('close'); };
    const agent = {
      instanceId: id, ws, type, opts, released: 0,
      async start() {
        im.register({ id, name: opts.name, cwd: opts.cwd, agentType: type });
        im.setAgentSocket(id, { readyState: 1, send: () => {} });
      },
      releaseProcess() { this.released++; },
    };
    agents.push(agent);
    return agent;
  }

  /** A VSCode session polpo only watches. */
  function discovered(status) {
    im.register({
      id: 'vscode-1', name: 'fix auth', type: 'vscode', agentType: 'claude',
      sessionId: 'sess-1', transcriptPath: transcript, cwd: tmp, canReceivePrompts: false,
    });
    im.updateStatus('vscode-1', status || 'idle');
    im.addMessage('vscode-1', { role: 'user', content: 'fix auth' });
  }

  beforeEach(() => {
    im = new InstanceManager();
    agents = [];
    transcript = path.join(tmp, 'sess-1.jsonl');
    // A VSCode session whose last turn ended.
    writeTranscript(transcript, [
      entry('v0', 'claude-vscode', { type: 'user' }),
      entry('v1', 'claude-vscode', { message: { content: 'x', stop_reason: 'end_turn' } }),
    ]);
    ctl = new SessionController({ instanceManager: im, createAgent: agentFactory, hubPort: 7890, sessions: {} });
  });

  describe('takeover', () => {
    it('is refused while the agent is busy', async () => {
      discovered('busy');
      append(transcript, entry('v2', 'claude-vscode', { type: 'user', timestamp: new Date().toISOString() }));
      const out = await ctl.takeover('vscode-1', { heldBy: 'dashboard' });
      assert.equal(out.ok, false);
      assert.equal(out.error, 'session_busy');
      assert.equal(agents.length, 0, 'nothing spawned');
    });

    it('is refused while the agent waits for an approval', async () => {
      discovered('idle');
      im.setPendingApproval('vscode-1', { tool: 'Bash' });
      const out = await ctl.takeover('vscode-1');
      assert.equal(out.error, 'session_busy');
    });

    it('continues the same session once it is idle', async () => {
      discovered('idle');
      const out = await ctl.takeover('vscode-1', { heldBy: 'gateway:openclaw' });
      assert.equal(out.ok, true);
      assert.equal(agents[0].opts.resumeSessionId, 'sess-1', 'same session id, not a fork');
      const inst = im.get(out.instanceId);
      assert.equal(inst.canReceivePrompts, true);
      assert.equal(inst.heldBy, 'gateway:openclaw');
      assert.equal(inst.sessionId, 'sess-1');
      assert.equal(inst.conversation.length, 1, 'history carried over');
      assert.equal(im.get('vscode-1'), undefined, 'the watched card is retired');
    });

    it('watches the transcript of the session it now holds', async () => {
      // Without this a held session reported only polpo's own status, so
      // "idle" stayed true while VSCode worked on it after a handback.
      discovered('idle');
      const infos = [];
      im.on('instance:session_info', (e) => infos.push(e));
      const out = await ctl.takeover('vscode-1');
      const forHeld = infos.filter((e) => e.id === out.instanceId);
      assert.ok(forHeld.length >= 1);
      assert.equal(forHeld.pop().transcriptPath, transcript);
    });

    it('keeps the transcript path when the agent reports its session without one', async () => {
      discovered('idle');
      const out = await ctl.takeover('vscode-1');
      im.setSessionInfo(out.instanceId, 'sess-1', undefined);   // polpo's claude agent does this
      assert.equal(im.get(out.instanceId).transcriptPath, transcript);
    });

    it('trusts the transcript over a stale busy status', async () => {
      // A session discovered just after its last turn used to stay busy.
      discovered('busy');
      const out = await ctl.takeover('vscode-1');
      assert.equal(out.ok, true);
    });

    it('trusts the transcript over a stale idle status', async () => {
      discovered('idle');
      append(transcript, entry('v2', 'claude-vscode', { type: 'user', timestamp: new Date().toISOString() }));
      const out = await ctl.takeover('vscode-1');
      assert.equal(out.error, 'session_busy', 'VSCode is mid-turn');
    });

    it('announces the change of driver', async () => {
      discovered('idle');
      const events = [];
      im.on('instance:control', (e) => events.push(e));
      const out = await ctl.takeover('vscode-1', { heldBy: 'dashboard' });
      assert.deepEqual(events.pop(), { id: out.instanceId, canReceivePrompts: true, heldBy: 'dashboard' });
    });
  });

  describe('prompting a session polpo drives', () => {
    let id;
    beforeEach(async () => {
      discovered('idle');
      id = (await ctl.takeover('vscode-1', { heldBy: 'dashboard' })).instanceId;
      im.get(id).transcriptPath = transcript;
    });

    it('goes through while only polpo has written since the takeover', () => {
      append(transcript, entry('p1', 'sdk-cli', { type: 'user' }));
      append(transcript, entry('p2', 'sdk-cli'));
      const out = ctl.sendPrompt(id, 'now run the tests', { source: 'gateway:openclaw', requireDelivery: true });
      assert.equal(out.ok, true);
      const last = im.get(id).conversation.slice(-1)[0];
      assert.equal(last.content, 'now run the tests');
      assert.equal(last.source, 'gateway:openclaw');
    });

    it('is refused, and the session handed back, once VSCode wrote again', () => {
      append(transcript, entry('p1', 'sdk-cli'));
      append(transcript, entry('v2', 'claude-vscode', { type: 'user' }));   // you reloaded VSCode and typed
      const before = im.get(id).conversation.length;
      const out = ctl.sendPrompt(id, 'now run the tests', { source: 'mobile' });

      assert.equal(out.ok, false);
      assert.equal(out.error, 'session_resumed_elsewhere');
      assert.equal(out.writer, 'claude-vscode');
      const inst = im.get(id);
      assert.equal(inst.canReceivePrompts, false, 'back to watching');
      assert.equal(inst.heldBy, null);
      assert.equal(agents[0].released, 1, 'the stale claude process is stopped');
      const notice = inst.conversation.slice(-1)[0];
      assert.equal(notice.role, 'system');
      assert.match(notice.content, /picked up again in VSCode/);
      assert.equal(inst.conversation.length, before + 1, 'the refused prompt is not logged');
    });

    it('can be taken over again once idle, and then accepts prompts', async () => {
      // You worked at the desk and VSCode's turn ended.
      append(transcript, entry('v2', 'claude-vscode', { message: { content: 'x', stop_reason: 'end_turn' } }));
      ctl.sendPrompt(id, 'x');                       // hands it back
      const again = await ctl.takeover(id, { heldBy: 'dashboard' });
      assert.equal(again.ok, true);
      assert.equal(again.instanceId, id, 'same card, no second agent');
      assert.equal(again.retaken, true);
      assert.equal(agents.length, 1);
      assert.equal(ctl.sendPrompt(id, 'carry on').ok, true, 'VSCode turns before the retake do not count');
    });
  });

  describe('prompting paths that must not change', () => {
    it('still logs a prompt with no agent socket on the dashboard path', () => {
      // The mind's chat has no agent socket and is driven by the message
      // being logged; requireDelivery is off for the WebSocket path.
      im.register({ id: 'mind-1', name: 'Alien Mind', agentType: 'mind' });
      const out = ctl.sendPrompt('mind-1', 'research X');
      assert.equal(out.ok, true);
      assert.equal(im.get('mind-1').conversation.slice(-1)[0].content, 'research X');
    });

    it('fails without logging when delivery is required and nothing is connected', () => {
      im.register({ id: 'gone-1', name: 'x', agentType: 'claude' });
      const out = ctl.sendPrompt('gone-1', 'hello', { requireDelivery: true });
      assert.equal(out.error, 'agent_not_connected');
      assert.equal(im.get('gone-1').conversation.length, 0);
    });

    it('does not guard sessions it cannot read (non-Claude agents)', async () => {
      im.register({ id: 'codex-1', name: 'c', agentType: 'codex', sessionId: 'cx', transcriptPath: transcript });
      im.setAgentSocket('codex-1', { readyState: 1, send: () => {} });
      append(transcript, entry('v9', 'claude-vscode'));
      assert.equal(ctl.sendPrompt('codex-1', 'go', { requireDelivery: true }).ok, true);
    });

    it('reports a queued prompt while polpo\'s own agent is busy', async () => {
      discovered('idle');
      const id = (await ctl.takeover('vscode-1')).instanceId;
      im.get(id).transcriptPath = transcript;
      im.updateStatus(id, 'busy');
      const out = ctl.sendPrompt(id, 'also update the docs');
      assert.equal(out.ok, true);
      assert.equal(out.queued, true);
    });
  });

  describe('resume from the catalogue', () => {
    it('is refused while a live copy of the session is busy', async () => {
      discovered('busy');
      append(transcript, entry('v2', 'claude-vscode', { type: 'user', timestamp: new Date().toISOString() }));
      const out = await ctl.resume('sess-1', {});
      assert.equal(out.error, 'session_busy');
      assert.equal(agents.length, 0);
    });

    it('continues the session and marks who holds it', async () => {
      const out = await ctl.resume('sess-9', { cwd: tmp, heldBy: 'gateway:openclaw' });
      assert.equal(out.ok, true);
      assert.equal(agents[0].opts.resumeSessionId, 'sess-9');
      assert.equal(im.get(out.instanceId).heldBy, 'gateway:openclaw');
    });

    it('reuses a live agent instead of spawning a second one', async () => {
      const first = await ctl.resume('sess-9', { cwd: tmp });
      const second = await ctl.resume('sess-9', { cwd: tmp });
      assert.equal(second.instanceId, first.instanceId);
      assert.equal(second.alreadyRunning, true);
      assert.equal(agents.length, 1);
    });
  });

  it('forgets an agent whose connection closed', async () => {
    const out = await ctl.resume('sess-9', { cwd: tmp });
    agents[0].ws.close();
    assert.equal(im.get(out.instanceId), undefined);
    assert.equal(ctl.agents.has('sess-9'), false);
    assert.equal(ctl.held.has(out.instanceId), false);
  });
});
