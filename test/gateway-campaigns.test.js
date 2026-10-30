const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const InstanceManager = require('../src/server/instances');
const { PendingApprovals } = require('../src/server/approvals');
const { CampaignManager } = require('../src/campaign');
const { CampaignStore } = require('../src/campaign/store');
const { createGatewayRouter } = require('../src/server/gateway');

/**
 * A PA directing a campaign through the gateway: it reads decisions,
 * polls for new ones, and carries your answers back with an attestation
 * of who decided. Acting is off unless the host turns it on.
 */

const KEY = 'campaigns-test-key';
const AUTH = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'X-Polpo-Client': 'telegram-pa' };

const DEF = {
  version: 1,
  name: 'demo',
  objective: 'Prove the gateway carries decisions',
  milestones: [{ id: 'm1', goal: 'It works', gate: { run: ['true'] }, accept: 'the gate passes' }],
};

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

function fakeController(im) {
  return {
    transcriptPathFor: () => null,
    agentFor: (inst) => (inst ? {} : null),
    async start(o) {
      const inst = im.register({ name: o.name, cwd: o.cwd });
      im.setControl(inst.id, { canReceivePrompts: true, heldBy: o.heldBy });
      return { ok: true, instanceId: inst.id };
    },
    sendPrompt(id, text, o) {
      im.addMessage(id, { role: 'user', content: text, source: o.source });
      return { ok: true };
    },
    checkHandback: () => null,
    release() {},
    handOver(id, heldBy) { im.setControl(id, { heldBy }); return true; },
  };
}

function start(opts) {
  const app = express();
  app.use('/v1', createGatewayRouter(Object.assign({ taskManager: stubTaskManager(), getKey: () => KEY }, opts)));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

async function call(h, method, p, body, headers) {
  const r = await fetch(h.url + p, {
    method,
    headers: headers === undefined ? AUTH : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

describe('Gateway /v1/campaigns', () => {
  let tmp, repo, im, approvals, mgr, h;

  async function boot(control) {
    h = await start({ instanceManager: im, campaigns: mgr, campaignControl: control });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-gw-campaign-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.polpo'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.polpo', 'campaign.json'), JSON.stringify(DEF));
    im = new InstanceManager();
    approvals = new PendingApprovals(im);
    mgr = new CampaignManager({
      instanceManager: im,
      sessionController: fakeController(im),
      approvals,
      store: new CampaignStore({ root: path.join(tmp, 'state') }),
    });
  });

  afterEach(async () => {
    if (h) await new Promise((r) => h.server.close(r));
    h = null;
    mgr.destroy();
    approvals.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('answers 503 when campaigns are not wired', async () => {
    h = await start({ instanceManager: im });
    assert.equal((await call(h, 'GET', '/v1/campaigns')).status, 503);
    assert.equal((await call(h, 'GET', '/v1/decisions')).status, 503);
  });

  it('needs the gateway key to read', async () => {
    await boot(false);
    assert.equal((await call(h, 'GET', '/v1/campaigns', undefined, {})).status, 401);
    assert.equal((await call(h, 'GET', '/v1/decisions', undefined, {})).status, 401);
  });

  it('reads without control, refuses to act without it', async () => {
    await boot(false);
    mgr.create({ cwd: repo, channel: 'dashboard' });
    const list = await call(h, 'GET', '/v1/campaigns');
    assert.equal(list.status, 200);
    assert.equal(list.body.control, false);
    assert.equal(list.body.campaigns[0].campaignId, 'demo');
    const one = await call(h, 'GET', '/v1/campaigns/demo');
    assert.equal(one.body.proposedDefinition.name, 'demo');
    const d = (await call(h, 'GET', '/v1/decisions')).body.decisions[0];
    const ans = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, {
      answer: 'approve', hash: d.details.hash, relay: { decidedBy: 'user', userMessage: 'yes' },
    });
    assert.equal(ans.status, 403);
    assert.equal(ans.body.error, 'campaign_control_not_enabled');
    assert.equal((await call(h, 'POST', '/v1/campaigns', { cwd: repo })).status, 403);
    assert.equal((await call(h, 'POST', '/v1/campaigns/demo/stop', { relay: { decidedBy: 'user', userMessage: 'stop' } })).status, 403);
  });

  it('validates ids before looking anything up', async () => {
    await boot(true);
    assert.equal((await call(h, 'GET', '/v1/campaigns/..%2Fetc')).status, 400);
    assert.equal((await call(h, 'GET', '/v1/campaigns/nope')).status, 404);
    mgr.create({ cwd: repo });
    assert.equal((await call(h, 'GET', '/v1/campaigns/demo/decisions/xyz')).status, 404);
    assert.equal((await call(h, 'POST', '/v1/campaigns/demo/decisions/xyz', { answer: 'approve', relay: { decidedBy: 'user', userMessage: 'y' } })).status, 400);
  });

  it('carries a definition from proposal to approval, attested', async () => {
    await boot(true);
    const created = await call(h, 'POST', '/v1/campaigns', { cwd: repo });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.campaign.status, 'awaiting_definition');
    const d = created.body.decision;
    assert.ok(d.text.length <= 3500);

    const poll = await call(h, 'GET', '/v1/decisions?since=0');
    assert.equal(poll.body.decisions.length, 1);
    const cursor = poll.body.cursor;

    const noRelay = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, { answer: 'approve', hash: d.details.hash });
    assert.equal(noRelay.status, 400);
    assert.equal(noRelay.body.error, 'invalid_relay');
    const noWords = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, {
      answer: 'approve', hash: d.details.hash, relay: { decidedBy: 'user' },
    });
    assert.equal(noWords.body.error, 'invalid_relay', 'the user\'s words are required');
    const byAgent = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, {
      answer: 'approve', hash: d.details.hash, relay: { decidedBy: 'agent' },
    });
    assert.equal(byAgent.status, 403);
    const wrongHash = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, {
      answer: 'approve', hash: 'abc', relay: { decidedBy: 'user', userMessage: 'ok' },
    });
    assert.equal(wrongHash.status, 409);
    assert.equal(wrongHash.body.error, 'hash_mismatch');

    const ok = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, {
      answer: 'approve', hash: d.details.hash, relay: { decidedBy: 'user', userMessage: 'yes, go' },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.campaign.status, 'active');

    const again = await call(h, 'POST', '/v1/campaigns/demo/decisions/' + d.decisionId, {
      answer: 'reject', text: 'x', relay: { decidedBy: 'user', userMessage: 'no' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'decision_closed');
    assert.equal(again.body.decided.channel, 'gateway:telegram-pa');

    const closed = await call(h, 'GET', '/v1/decisions?since=' + cursor);
    assert.equal(closed.body.decisions.length, 0);
    assert.equal(closed.body.closed[0].decisionId, d.decisionId);

    const ledger = await call(h, 'GET', '/v1/campaigns/demo/ledger?since=0');
    const approvedEntry = ledger.body.entries.find((e) => e.kind === 'campaign_approved');
    assert.equal(approvedEntry.channel, 'gateway:telegram-pa');
    assert.equal(approvedEntry.decidedBy, 'user');
    assert.equal(approvedEntry.userMessage, 'yes, go');
    const created1 = ledger.body.entries.find((e) => e.kind === 'campaign_created');
    assert.equal(created1.channel, 'gateway:telegram-pa');
  });

  it('only the user can stop a campaign', async () => {
    await boot(true);
    mgr.create({ cwd: repo });
    const noRelay = await call(h, 'POST', '/v1/campaigns/demo/stop', {});
    assert.equal(noRelay.status, 400);
    const agent = await call(h, 'POST', '/v1/campaigns/demo/stop', { relay: { decidedBy: 'agent' } });
    assert.equal(agent.status, 403);
    const user = await call(h, 'POST', '/v1/campaigns/demo/stop', { text: 'enough', relay: { decidedBy: 'user', userMessage: 'stop it' } });
    assert.equal(user.status, 200);
    assert.equal(user.body.campaign.status, 'stopped');
  });

  it('pauses, refuses to resume an unapproved campaign, prompts and gates', async () => {
    await boot(true);
    mgr.create({ cwd: repo });
    const resume = await call(h, 'POST', '/v1/campaigns/demo/resume', {});
    assert.equal(resume.status, 409);
    assert.equal(resume.body.error, 'awaiting_definition');
    assert.equal((await call(h, 'POST', '/v1/campaigns/demo/prompt', { text: 'hi' })).status, 409);
    assert.equal((await call(h, 'POST', '/v1/campaigns/demo/gate', {})).status, 409);
    assert.equal((await call(h, 'POST', '/v1/campaigns/demo/prompt', { text: '' })).status, 400);
    assert.equal((await call(h, 'POST', '/v1/campaigns/demo/gate', { milestone: 7 })).status, 400);
  });

  it('refuses a campaign file outside cwd', async () => {
    await boot(true);
    const r = await call(h, 'POST', '/v1/campaigns', { cwd: repo, file: '../../etc/passwd' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_file');
    const missing = await call(h, 'POST', '/v1/campaigns', { cwd: repo, file: 'none.json' });
    assert.equal(missing.status, 404);
    const rel = await call(h, 'POST', '/v1/campaigns', { cwd: 'relative/dir' });
    assert.equal(rel.body.error, 'invalid_cwd');
  });
});
