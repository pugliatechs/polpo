const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const InstanceManager = require('../src/server/instances');
const { PendingApprovals } = require('../src/server/approvals');
const { createApiRouter } = require('../src/server/api');

/**
 * Approvals an agent waits on. Outside campaigns one expires after five
 * minutes; in a campaign it waits for an answer however long it takes,
 * with the permission server asking again every few minutes so no HTTP
 * request stays open for hours.
 */

describe('PendingApprovals', () => {
  let im, a;
  beforeEach(() => {
    im = new InstanceManager();
    im.register({ id: 'i1', name: 'x' });
    a = new PendingApprovals(im);
  });
  afterEach(() => a.destroy());

  it('expires an ordinary approval', async () => {
    const settled = [];
    a.on('settled', (e) => settled.push(e));
    const d = await a.wait('i1', { toolUseId: 't', toolInput: {} }, { expiresMs: 20 });
    assert.equal(d.behavior, 'deny');
    assert.equal(d.message, 'Approval timed out');
    assert.equal(settled[0].meta.via, 'timeout');
  });

  it('holds a campaign approval with retries and keeps an answer given between them', async () => {
    const first = await a.wait('i1', { toolUseId: 't1', toolInput: { x: 1 } }, { expiresMs: null, holdMs: 20 });
    assert.deepEqual(first, { retry: true });
    assert.ok(a.current('i1'), 'still pending after the retry');
    assert.equal(a.isRepoll('i1', 't1'), true);
    // Answered while no request is attached.
    assert.equal(a.approve('i1', { channel: 'gateway:pa' }), true);
    const second = await a.wait('i1', { toolUseId: 't1', toolInput: { x: 1 } }, { expiresMs: null, holdMs: 20 });
    assert.deepEqual(second, { behavior: 'allow', updatedInput: { x: 1 } });
    assert.equal(a.current('i1'), null);
  });

  it('answers a re-poll that is waiting', async () => {
    const p = a.wait('i1', { toolUseId: 't2', toolInput: { q: 1 } }, { expiresMs: null, holdMs: 1000 });
    a.answer('i1', { 'Which?': 'B' }, { channel: 'dashboard' });
    assert.deepEqual((await p).updatedInput, { q: 1, answers: { 'Which?': 'B' } });
  });

  it('a new request replaces an abandoned one and says so', async () => {
    const settled = [];
    a.on('settled', (e) => settled.push(e));
    const old = a.wait('i1', { toolUseId: 'old', toolInput: {} }, { expiresMs: null });
    // The route shows the new request before waiting on it.
    im.setPendingApproval('i1', { tool: 'Bash', description: 'the new one' });
    a.wait('i1', { toolUseId: 'new', toolInput: {} }, { expiresMs: null });
    assert.equal((await old).behavior, 'deny', 'an unanswered approval is never allowed');
    assert.equal(im.get('i1').pendingApproval.description, 'the new one', 'the banner shows the new request');
    assert.equal(settled[0].toolUseId, 'old');
    assert.equal(settled[0].meta.via, 'superseded');
    assert.equal(a.current('i1').toolUseId, 'new');
  });

  it('settles once', () => {
    a.wait('i1', { toolUseId: 't3', toolInput: {} }, { expiresMs: null });
    assert.equal(a.reject('i1', 'no', {}), true);
    assert.equal(a.reject('i1', 'no', {}), false);
  });
});

describe('Permission server with a held approval', () => {
  let server, url, im, approvals, campaignCalls;

  beforeEach(async () => {
    im = new InstanceManager();
    im.register({ id: 'camp-1', name: 'held' });
    im.setControl('camp-1', { heldBy: 'campaign:demo' });
    im.register({ id: 'plain-1', name: 'plain' });
    approvals = new PendingApprovals(im);
    campaignCalls = [];
    const campaigns = {
      campaignForInstance: (id) => (id === 'camp-1' ? 'demo' : null),
      approvalRequested: (cid, iid, info) => campaignCalls.push({ cid, iid, info }),
      get: () => null,
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(im, () => null, null, null, () => null, null, { approvals, campaigns, approvalHoldMs: 100 }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    url = 'http://127.0.0.1:' + server.address().port;
  });

  afterEach(async () => {
    approvals.destroy();
    await new Promise((r) => server.close(r));
  });

  /** Run the real MCP permission server for one tools/call. */
  function askThroughMcp(instanceId) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'agent', 'permission-server.js')], {
      env: Object.assign({}, process.env, { POLPO_INSTANCE_ID: instanceId, POLPO_HUB_URL: url }),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const done = new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (c) => {
        buf += c;
        const line = buf.split('\n').find((l) => l.includes('"id":7'));
        if (line) {
          child.kill();
          resolve(JSON.parse(JSON.parse(line).result.content[0].text));
        }
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { arguments: { tool_use_id: 'tu-9', tool_name: 'Bash', input: { command: 'make deploy' } } } }) + '\n');
    return done;
  }

  it('keeps asking until the campaign approval is answered, and raises one decision', async () => {
    const answer = askThroughMcp('camp-1');
    // Several hold periods pass with nobody answering.
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(campaignCalls.length, 1, 'one decision, however many re-polls');
    assert.equal(campaignCalls[0].info.toolUseId, 'tu-9');
    assert.ok(approvals.current('camp-1'));
    const r = await fetch(url + '/api/instances/camp-1/approve', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { command: 'make deploy' } });
  });

  it('ignores auto-approve on a campaign session', async () => {
    im.setAutoApprove('camp-1', true);
    const answer = askThroughMcp('camp-1');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(approvals.current('camp-1'), 'still waiting for you');
    await fetch(url + '/api/instances/camp-1/reject', { method: 'POST' });
    assert.equal((await answer).behavior, 'deny');
  });

  it('denies when polpo goes away during the wait', async () => {
    const answer = askThroughMcp('camp-1');
    await new Promise((r) => setTimeout(r, 150));
    // polpo restarts: the next re-poll finds nobody listening.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    const d = await answer;
    assert.equal(d.behavior, 'deny');
    assert.match(d.message, /could not be reached/);
    server = require('http').createServer().listen(0); // for afterEach
  });

  it('leaves an ordinary session as it was', async () => {
    im.setAutoApprove('plain-1', true);
    assert.equal((await askThroughMcp('plain-1')).behavior, 'allow');
    assert.equal(campaignCalls.length, 0);
  });
});

describe('Approvals of a session a gateway caller drives', () => {
  let server, url, im, approvals;

  async function start(gatewayApprovals) {
    im = new InstanceManager();
    im.register({ id: 'gw-held', name: 'driven by a PA' });
    im.setControl('gw-held', { heldBy: 'gateway:pa', canReceivePrompts: true });
    approvals = new PendingApprovals(im);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(im, () => null, null, null, () => null, null, { approvals, approvalHoldMs: 100, gatewayApprovals }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    url = 'http://127.0.0.1:' + server.address().port;
  }

  afterEach(async () => {
    approvals.destroy();
    await new Promise((r) => server.close(r));
  });

  function request() {
    return fetch(url + '/api/permission-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: 'gw-held', toolUseId: 'tu-1', toolName: 'Bash', toolInput: { command: 'make deploy' } }),
    }).then((r) => r.json());
  }

  it('waits for the relayed answer instead of expiring, when the host allows relaying', async () => {
    await start(true);
    assert.deepEqual(await request(), { retry: true }, 'held, and asked again');
    const shown = im.get('gw-held').pendingApproval;
    assert.equal(shown.toolUseId, 'tu-1');
    assert.equal(shown.input, '{"command":"make deploy"}');
    const again = request();
    approvals.approve('gw-held', { channel: 'gateway:pa' });
    assert.equal((await again).behavior, 'allow');
  });

  it('expires as before otherwise', async () => {
    await start(false);
    let answered = false;
    const r = request().then((d) => { answered = true; return d; });
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(answered, false, 'no retry: an ordinary five-minute wait');
    approvals.reject('gw-held', 'no', {});
    assert.equal((await r).behavior, 'deny');
  });
});
