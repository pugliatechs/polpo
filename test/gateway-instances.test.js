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
