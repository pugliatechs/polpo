const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const InstanceManager = require('../src/server/instances');
const { createGatewayRouter } = require('../src/server/gateway');

/**
 * Read-only access to live coding sessions through the gateway, so an
 * external agent (a PA on Telegram) can see what the coding agents on
 * this machine are doing and follow a session as it progresses.
 */

const KEY = 'instances-test-key';
const AUTH = { Authorization: 'Bearer ' + KEY };

function stubTaskManager() {
  return {
    _activeTaskCount() { return 0; },
    createTask: async () => { throw new Error('not used'); },
    getTask: () => null,
    cancelTask: () => false,
    subscribe: () => function unsub() {},
    listArtifacts: () => [],
    openArtifact: () => { throw new Error('not used'); },
  };
}

function start(im) {
  const app = express();
  app.use('/v1', createGatewayRouter({ taskManager: stubTaskManager(), getKey: () => KEY, instanceManager: im }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

async function get(h, path, headers) {
  const r = await fetch(h.url + path, { headers: headers === undefined ? AUTH : headers });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

describe('Gateway /v1/instances', () => {
  let im, h;

  beforeEach(async () => {
    im = new InstanceManager();
    // A VSCode session polpo only watches, busy.
    im.register({ id: 'vscode-1', name: 'fix the auth bug', type: 'vscode', project: 'fmpro',
      cwd: '/home/u/fmpro', sessionId: 'sess-vscode', canReceivePrompts: false, firstPrompt: 'fix the auth bug' });
    im.updateStatus('vscode-1', 'busy');
    // A session taken over from the phone, idle.
    im.register({ id: 'phone-1', name: 'Takeover', project: 'polpo', cwd: '/home/u/polpo', sessionId: 'sess-phone' });
    im.updateStatus('phone-1', 'idle');
    // A gateway task and the mind's reasoner, which must stay hidden.
    im.register({ id: 'gw-1', name: 'Gateway: openclaw', source: 'gateway:openclaw', project: 'docs' });
    im.register({ id: 'reasoner-1', name: 'Mind reasoner', source: 'mind-reasoner' });
    h = await start(im);
  });

  afterEach(() => new Promise((r) => h.server.close(r)));

  it('requires the bearer token', async () => {
    assert.equal((await get(h, '/v1/instances', {})).status, 401);
    assert.equal((await get(h, '/v1/instances/vscode-1/conversation', {})).status, 401);
  });

  it('lists live instances with their status and origin', async () => {
    const { status, body } = await get(h, '/v1/instances');
    assert.equal(status, 200);
    const byId = Object.fromEntries(body.instances.map((i) => [i.instanceId, i]));
    assert.equal(byId['vscode-1'].status, 'busy');
    assert.equal(byId['vscode-1'].origin, 'discovered');
    assert.equal(byId['vscode-1'].canReceivePrompts, false);
    assert.equal(byId['vscode-1'].sessionId, 'sess-vscode');
    assert.equal(byId['phone-1'].origin, 'polpo');
    assert.equal(byId['phone-1'].canReceivePrompts, true);
    assert.equal(byId['gw-1'].origin, 'gateway');
    assert.equal(byId['vscode-1'].heldBy, null, 'nobody holds a session polpo only watches');
  });

  it("never lists polpo's own machinery", async () => {
    const { body } = await get(h, '/v1/instances');
    assert.ok(!body.instances.some((i) => i.instanceId === 'reasoner-1'));
    assert.equal((await get(h, '/v1/instances/reasoner-1')).status, 404);
  });

  it('shows what an agent is waiting to be approved, without a huge input', async () => {
    im.setPendingApproval('phone-1', { tool: 'Bash', description: 'Run the test suite', input: { command: 'npm test', blob: 'x'.repeat(10000) } });
    const { body } = await get(h, '/v1/instances/phone-1');
    assert.equal(body.status, 'waiting');
    assert.equal(body.pendingApproval.tool, 'Bash');
    assert.equal(body.pendingApproval.description, 'Run the test suite');
    assert.match(body.pendingApproval.input, /npm test/);
    assert.ok(body.pendingApproval.input.length <= 2000);
  });

  it('returns 404 for an unknown instance and 400 for a malformed id', async () => {
    assert.equal((await get(h, '/v1/instances/nope-404')).status, 404);
    assert.equal((await get(h, '/v1/instances/' + encodeURIComponent('../etc'))).status, 400);
  });

  describe('conversation polling', () => {
    beforeEach(() => {
      im.addMessage('vscode-1', { role: 'user', content: 'fix the auth bug' });
      im.addMessage('vscode-1', { role: 'assistant', content: 'Looking at auth.js' });
      im.addMessage('vscode-1', { role: 'assistant', content: 'Fixed and tested.' });
    });

    it('returns everything kept when no cursor is given', async () => {
      const { body } = await get(h, '/v1/instances/vscode-1/conversation');
      assert.deepEqual(body.messages.map((m) => m.seq), [1, 2, 3]);
      assert.equal(body.lastSeq, 3);
      assert.equal(body.status, 'busy');
    });

    it('returns only what is newer than the cursor', async () => {
      const { body } = await get(h, '/v1/instances/vscode-1/conversation?since=2');
      assert.deepEqual(body.messages.map((m) => m.content), ['Fixed and tested.']);
      assert.equal(body.lastSeq, 3);
    });

    it('returns nothing new, and keeps the cursor, once caught up', async () => {
      const { body } = await get(h, '/v1/instances/vscode-1/conversation?since=3');
      assert.deepEqual(body.messages, []);
      assert.equal(body.lastSeq, 3);
      assert.equal(body.hasMore, false);
    });

    it('pages with limit', async () => {
      const { body } = await get(h, '/v1/instances/vscode-1/conversation?since=0&limit=2');
      assert.equal(body.messages.length, 2);
      assert.equal(body.hasMore, true);
      assert.equal(body.lastSeq, 2);
    });

    it('caps a very large message', async () => {
      im.addMessage('vscode-1', { role: 'tool', content: 'y'.repeat(50000), contentType: 'tool_result' });
      const { body } = await get(h, '/v1/instances/vscode-1/conversation?since=3');
      assert.equal(body.messages[0].content.length, 20000);
      assert.equal(body.messages[0].truncated, true);
    });

    it('reports a gap when the caller fell behind what polpo keeps', async () => {
      // polpo keeps the last 200 messages per instance.
      for (let i = 0; i < 205; i++) im.addMessage('phone-1', { role: 'assistant', content: 'm' + i });
      const { body } = await get(h, '/v1/instances/phone-1/conversation?since=1');
      assert.equal(body.gap, true);
    });
  });
});

describe('Gateway: driving live sessions', () => {
  const EventEmitter = require('events');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { SessionController } = require('../src/server/session-control');

  let im, h, tmp, transcript, agents;

  function agentFactory(type, opts) {
    const id = 'agent-' + (agents.length + 1);
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.close = () => { ws.readyState = 3; ws.emit('close'); };
    const agent = {
      instanceId: id, ws, opts, released: 0,
      async start() {
        im.register({ id, name: opts.name, cwd: opts.cwd, agentType: type });
        im.setAgentSocket(id, { readyState: 1, send: () => {} });
      },
      releaseProcess() { this.released++; },
    };
    agents.push(agent);
    return agent;
  }

  function startWith(sessionControl) {
    const app = express();
    app.use('/v1', createGatewayRouter({
      taskManager: stubTaskManager(), getKey: () => KEY, instanceManager: im, sessionControl,
    }));
    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
    });
  }

  async function post(path, body) {
    const r = await fetch(h.url + path, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json', 'X-Polpo-Client': 'openclaw' },
      body: JSON.stringify(body || {}),
    });
    let parsed = null;
    try { parsed = await r.json(); } catch {}
    return { status: r.status, body: parsed };
  }

  beforeEach(() => {
    im = new InstanceManager();
    agents = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-gw-sc-'));
    transcript = path.join(tmp, 'sess-1.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'v1', entrypoint: 'claude-vscode', message: { stop_reason: 'end_turn' } }) + '\n');
    im.register({ id: 'vscode-1', name: 'fix auth', type: 'vscode', agentType: 'claude', sessionId: 'sess-1',
      transcriptPath: transcript, cwd: tmp, canReceivePrompts: false });
    im.updateStatus('vscode-1', 'idle');
    im.register({ id: 'gw-1', name: 'Gateway: openclaw', source: 'gateway:openclaw' });
    im.register({ id: 'mind-1', name: 'Alien Mind', agentType: 'mind' });
  });

  afterEach(async () => {
    await new Promise((r) => h.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is off unless the host opted in', async () => {
    h = await startWith(null);
    assert.equal((await post('/v1/instances/vscode-1/takeover')).status, 503);
    assert.equal((await post('/v1/instances/vscode-1/prompt', { text: 'hi' })).status, 503);
    assert.equal((await post('/v1/sessions/sess-1/resume')).status, 503);
  });

  describe('when enabled', () => {
    let ctl;
    beforeEach(async () => {
      ctl = new SessionController({ instanceManager: im, createAgent: agentFactory, sessions: {} });
      h = await startWith(ctl);
    });

    it('will not take over a busy session, but it can still be read', async () => {
      im.updateStatus('vscode-1', 'busy');
      fs.appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'v2', entrypoint: 'claude-vscode',
        timestamp: new Date().toISOString(), message: {} }) + '\n');
      const r = await post('/v1/instances/vscode-1/takeover');
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'session_busy');
      assert.equal((await get(h, '/v1/instances/vscode-1/conversation')).status, 200);
    });

    it('asks for a takeover before prompting a watched session', async () => {
      const r = await post('/v1/instances/vscode-1/prompt', { text: 'run the tests' });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'takeover_required');
    });

    it('takes over an idle session and drives it, attributed to the caller', async () => {
      const t = await post('/v1/instances/vscode-1/takeover');
      assert.equal(t.status, 200);
      assert.equal(t.body.instance.heldBy, 'gateway:openclaw', 'the caller can see it holds the session');
      const id = t.body.instanceId;
      assert.equal(im.get(id).heldBy, 'gateway:openclaw');

      const p = await post('/v1/instances/' + id + '/prompt', { text: 'run the tests' });
      assert.equal(p.status, 200);
      assert.equal(p.body.ok, true);
      const last = im.get(id).conversation.slice(-1)[0];
      assert.equal(last.content, 'run the tests');
      assert.equal(last.source, 'gateway:openclaw');
    });

    it('is told when the session was picked up again in VSCode', async () => {
      const id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
      fs.appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'v2', entrypoint: 'claude-vscode', message: {} }) + '\n');
      const r = await post('/v1/instances/' + id + '/prompt', { text: 'run the tests' });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'session_resumed_elsewhere');
      assert.equal(r.body.writer, 'claude-vscode');
      assert.equal(im.get(id).canReceivePrompts, false);
    });

    it('refuses to drive the mind or a gateway task', async () => {
      for (const id of ['mind-1', 'gw-1']) {
        const r = await post('/v1/instances/' + id + '/prompt', { text: 'x' });
        assert.equal(r.status, 400);
        assert.equal(r.body.error, 'not_a_coding_session');
      }
    });

    it('rejects an empty or oversized prompt', async () => {
      const id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
      for (const text of ['', '   ', 'x'.repeat(50001)]) {
        assert.equal((await post('/v1/instances/' + id + '/prompt', { text })).status, 400);
      }
    });

    it('resumes a session from the catalogue', async () => {
      const r = await post('/v1/sessions/sess-9/resume', { cwd: tmp });
      assert.equal(r.status, 200);
      assert.equal(agents[0].opts.resumeSessionId, 'sess-9');
      assert.equal(im.get(r.body.instanceId).heldBy, 'gateway:openclaw');
    });

    it('validates resume input', async () => {
      assert.equal((await post('/v1/sessions/' + encodeURIComponent('../x') + '/resume')).status, 400);
      assert.equal((await post('/v1/sessions/sess-9/resume', { agentType: 'rm' })).status, 400);
    });

    it('aborts a turn only on a session polpo drives', async () => {
      assert.equal((await post('/v1/instances/vscode-1/abort')).status, 409);
      const id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
      assert.equal((await post('/v1/instances/' + id + '/abort')).status, 200);
    });

    it('requires the bearer token', async () => {
      const r = await fetch(h.url + '/v1/instances/vscode-1/takeover', { method: 'POST' });
      assert.equal(r.status, 401);
    });
  });
});
