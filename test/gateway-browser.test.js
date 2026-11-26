'use strict';

/**
 * Browser sessions end to end inside polpo (no real CLI): a gateway caller
 * starts one with POST /v1/instances, the agent's browser tool calls reach
 * the guard through /api/permission-request, a plan with a screenshot goes
 * through /api/browser-grant, the caller relays the user's answer, and the
 * grant lets the planned commit through.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const InstanceManager = require('../src/server/instances');
const { createGatewayRouter } = require('../src/server/gateway');
const { createApiRouter } = require('../src/server/api');
const { SessionController } = require('../src/server/session-control');
const { PendingApprovals } = require('../src/server/approvals');
const { BrowserGuard, CHROME_PREFIX } = require('../src/server/browser-guard');

const KEY = 'browser-test-key';
const C = (name) => CHROME_PREFIX + name;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

function stubTaskManager() {
  return { _activeTaskCount() { return 0; }, createTask: async () => { throw new Error('not used'); }, getTask: () => null };
}

describe('Gateway browser sessions', () => {
  let im, approvals, guard, ctl, agents, sent, h, cwd, shotDir, connectDelayMs;

  function agentFactory(type, opts) {
    const id = 'agent-' + (agents.length + 1);
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.close = () => { ws.readyState = 3; ws.emit('close'); };
    const agent = {
      instanceId: id, ws, opts,
      async start() {
        im.register({ id, name: opts.name, cwd: opts.cwd, agentType: type });
        const socket = { readyState: 1, send: (raw) => sent.push({ id, msg: JSON.parse(raw) }) };
        // The real agent's connection opens after start() returns.
        if (connectDelayMs) setTimeout(() => im.setAgentSocket(id, socket), connectDelayMs);
        else im.setAgentSocket(id, socket);
      },
      releaseProcess() {},
      setClaudePermissionMode(mode) { this.mode = mode; },
    };
    agents.push(agent);
    return agent;
  }

  function startApp(extra) {
    const o = extra || {};
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(im, () => null, null, null, () => null, ctl, {
      approvals, gatewayApprovals: true, approvalHoldMs: 200, browserGuard: o.noGuard ? null : guard,
    }));
    app.use('/v1', createGatewayRouter({
      taskManager: stubTaskManager(), getKey: () => KEY, instanceManager: im,
      sessionControl: o.noSessionControl ? null : ctl,
      allowedPermissionModes: new Set(['default', 'acceptEdits', 'auto']),
      approvals, approvalControl: true,
      browserGuard: o.noGuard ? null : guard,
    }));
    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
    });
  }

  async function call(method, p, body, headers) {
    const r = await fetch(h.url + p, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.startsWith('/v1') ? { Authorization: 'Bearer ' + KEY, 'X-Polpo-Client': 'openclaw' } : {}, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = r.headers.get('content-type') || '';
    const out = { status: r.status, type };
    if (type.startsWith('image/')) out.bytes = Buffer.from(await r.arrayBuffer());
    else { try { out.body = await r.json(); } catch { out.body = null; } }
    return out;
  }
  const post = (p, b) => call('POST', p, b);
  const get = (p) => call('GET', p);

  /** What the permission server sends for a tool call. */
  const permission = (instanceId, toolName, toolInput) => post('/api/permission-request', {
    instanceId, toolUseId: 'toolu_' + crypto.randomBytes(6).toString('hex'), toolName, toolInput,
  });

  beforeEach(async () => {
    im = new InstanceManager();
    approvals = new PendingApprovals(im);
    guard = new BrowserGuard({ grantMaxMinutes: 15 });
    ctl = new SessionController({ instanceManager: im, createAgent: agentFactory, sessions: {}, browserGuard: guard });
    agents = [];
    sent = [];
    connectDelayMs = 0;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-browser-cwd-'));
    shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-chrome-screenshots-'));
    fs.chmodSync(shotDir, 0o700);
    h = await startApp();
  });

  afterEach(async () => {
    await new Promise((r) => h.server.close(r));
    approvals.destroy();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(shotDir, { recursive: true, force: true });
  });

  async function startBrowserSession(extra) {
    const r = await post('/v1/instances', Object.assign({
      cwd, prompt: 'Fill the order form', title: 'Order on httpbin', browser: { sites: ['httpbin.org', 'example.com'] },
    }, extra || {}));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.instanceId;
  }

  describe('POST /v1/instances', () => {
    it('starts a session the caller drives and can keep driving', async () => {
      const r = await post('/v1/instances', { cwd, prompt: 'hello', title: 'A new session' });
      assert.equal(r.status, 201);
      const inst = r.body.instance;
      assert.equal(inst.heldBy, 'gateway:openclaw');
      assert.equal(inst.origin, 'polpo', 'not tagged as a gateway task: it stays drivable');
      assert.equal(inst.canReceivePrompts, true);
      assert.equal(inst.title, 'A new session');
      assert.equal(agents[0].opts.browser, undefined, 'no browser unless asked');
      assert.ok(sent.some((s) => s.msg.type === 'prompt' || JSON.stringify(s.msg).includes('hello')), 'the prompt reached the agent');
      assert.equal((await post('/v1/instances/' + r.body.instanceId + '/prompt', { text: 'and then?' })).status, 200);
    });

    it('waits for the new agent to connect before sending the prompt', async () => {
      connectDelayMs = 150;
      const r = await post('/v1/instances', { cwd, prompt: 'first words' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(sent.some((x) => JSON.stringify(x.msg).includes('first words')));
    });

    it('is off without session control', async () => {
      await new Promise((r) => h.server.close(r));
      h = await startApp({ noSessionControl: true });
      assert.equal((await post('/v1/instances', { cwd })).status, 503);
    });

    it('checks cwd, model, title, prompt and agent type like /v1/tasks', async () => {
      assert.equal((await post('/v1/instances', { cwd: 'relative/dir' })).body.error, 'cwd_must_be_absolute');
      assert.equal((await post('/v1/instances', { cwd: path.join(cwd, 'missing') })).body.error, 'cwd_does_not_exist');
      assert.equal((await post('/v1/instances', { cwd, model: 'x\ny' })).status, 400);
      assert.equal((await post('/v1/instances', { cwd, title: 'a\u0007b' })).body.error, 'invalid_title');
      assert.equal((await post('/v1/instances', { cwd, prompt: '   ' })).body.error, 'invalid_prompt');
      assert.equal((await post('/v1/instances', { cwd, agentType: 'shell' })).body.error, 'invalid_agentType');
      assert.equal(agents.length, 0);
    });

    it('takes only a permission mode the host allows', async () => {
      assert.equal((await post('/v1/instances', { cwd, permissionMode: 'bypassPermissions' })).status, 400);
      const r = await post('/v1/instances', { cwd, permissionMode: 'acceptEdits' });
      assert.equal(r.status, 201);
      assert.equal(agents[0].opts.claudePermissionMode, 'acceptEdits');
      assert.equal(r.body.instance.permissionMode, 'acceptEdits');
    });
  });

  describe('browser opt-in', () => {
    it('is refused when the host does not run browser sessions', async () => {
      await new Promise((r) => h.server.close(r));
      h = await startApp({ noGuard: true });
      const r = await post('/v1/instances', { cwd, browser: { sites: ['httpbin.org'] } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'browser_not_enabled');
      assert.equal((await get('/v1/health')).body.sessionControl.browser.enabled, false);
    });

    it('refuses invalid sites and unknown browser fields', async () => {
      for (const sites of [['https://httpbin.org'], ['127.0.0.1'], ['localhost'], [], 'httpbin.org']) {
        const r = await post('/v1/instances', { cwd, browser: { sites } });
        assert.equal(r.status, 400, JSON.stringify(sites));
        assert.equal(r.body.error, 'invalid_browser_sites');
      }
      assert.equal((await post('/v1/instances', { cwd, browser: { sites: ['httpbin.org'], allowTools: ['javascript_tool'] } })).body.error, 'invalid_browser');
      assert.equal(agents.length, 0);
    });

    it('refuses auto mode, at start and later', async () => {
      const r = await post('/v1/instances', { cwd, permissionMode: 'auto', browser: { sites: ['httpbin.org'] } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'browser_auto_mode');
      const id = await startBrowserSession();
      const m = await post('/v1/instances/' + id + '/permission-mode', { permissionMode: 'auto' });
      assert.equal(m.status, 400);
      assert.equal(m.body.error, 'browser_auto_mode');
    });

    it('starts the agent with the browser under the guard: ask rules for every browser tool but the tab tools', async () => {
      const id = await startBrowserSession();
      const b = agents[0].opts.browser;
      assert.deepEqual(b.sites, ['httpbin.org', 'example.com']);
      assert.ok(b.cli.askTools.includes(C('computer')));
      assert.ok(b.cli.askTools.includes(C('browser_batch')));
      assert.ok(b.cli.disallowedTools.includes(C('javascript_tool')));
      assert.ok(guard.has(id));
      assert.deepEqual((await get('/v1/health')).body.sessionControl.browser, { enabled: true, grantMaxMinutes: 15 });
    });
  });

  describe('the guard on tool calls', () => {
    it('allows free actions, refuses others, relays commits', async () => {
      const id = await startBrowserSession();
      guard.observeTabs(id, [{ tabId: 5, url: 'https://httpbin.org/forms/post' }]);
      const free = await permission(id, C('form_input'), { tabId: 5, ref: 'ref_3', value: 'Polpo Test' });
      assert.deepEqual(free.body, { behavior: 'allow', updatedInput: { tabId: 5, ref: 'ref_3', value: 'Polpo Test' } });
      const off = await permission(id, C('navigate'), { tabId: 5, url: 'https://mail.google.com/' });
      assert.equal(off.body.behavior, 'deny');

      // A click waits for the user; the gateway caller sees it, with the page.
      const pending = permission(id, C('computer'), { tabId: 5, action: 'left_click', ref: 'ref_9', action_summary: 'Submits the order' });
      await new Promise((r) => setTimeout(r, 50));
      const view = await get('/v1/instances/' + id);
      assert.equal(view.body.pendingApproval.tool, C('computer'));
      assert.equal(view.body.pendingApproval.description, 'Browser on httpbin.org: Submits the order (https://httpbin.org/forms/post)');
      const toolUseId = view.body.pendingApproval.toolUseId;
      const ans = await post('/v1/instances/' + id + '/approval', { toolUseId, answer: 'reject', relay: { decidedBy: 'user', userMessage: 'no, not yet' } });
      assert.equal(ans.status, 200);
      assert.equal((await pending).body.behavior, 'deny');
      // Rejected, the click never ran: the agent can still look at the page.
      assert.equal((await permission(id, C('computer'), { tabId: 5, action: 'screenshot' })).body.behavior, 'allow');

      // Approved, it ran: the page is unknown until the next result.
      const second = permission(id, C('computer'), { tabId: 5, action: 'left_click', ref: 'ref_9', action_summary: 'Submits the order' });
      await new Promise((r) => setTimeout(r, 50));
      const pa2 = (await get('/v1/instances/' + id)).body.pendingApproval;
      await post('/v1/instances/' + id + '/approval', { toolUseId: pa2.toolUseId, answer: 'approve', relay: { decidedBy: 'user', userMessage: 'yes' } });
      assert.equal((await second).body.behavior, 'allow');
      assert.equal((await permission(id, C('computer'), { tabId: 5, action: 'screenshot' })).body.behavior, 'deny');
    });

    it('is not bypassed by auto-approve', async () => {
      const id = await startBrowserSession();
      im.setAutoApprove(id, true);
      guard.observeTabs(id, [{ tabId: 5, url: 'https://httpbin.org/forms/post' }]);
      assert.equal((await permission(id, C('get_page_text'), { tabId: 5 })).body.behavior, 'allow');
      assert.equal((await permission(id, C('javascript_tool'), { tabId: 5 })).body.behavior, 'deny');
      const pending = permission(id, C('computer'), { tabId: 5, action: 'key', text: 'Return', action_summary: 'Submits' });
      const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('waiting'), 150))]);
      assert.equal(raced, 'waiting', 'the commit waits for the user despite auto-approve');
      approvals.reject(id, 'test over');
      await pending;
    });

    it('is not bypassed by auto-approve when the permission server asks again', async () => {
      const id = await startBrowserSession();
      guard.observeTabs(id, [{ tabId: 5, url: 'https://httpbin.org/forms/post' }]);
      const body = { instanceId: id, toolUseId: 'toolu_repoll', toolName: C('computer'),
        toolInput: { tabId: 5, action: 'left_click', ref: 'ref_9', action_summary: 'Submits' } };
      // Held: the first request is told to come back (holdMs is 200 in this app).
      assert.deepEqual((await post('/api/permission-request', body)).body, { retry: true });
      im.setAutoApprove(id, true);
      const again = post('/api/permission-request', body);
      const raced = await Promise.race([again, new Promise((r) => setTimeout(() => r('waiting'), 100))]);
      assert.equal(raced, 'waiting', 'the repoll waits for the user, auto-approve or not');
      approvals.reject(id, 'test over');
      assert.equal((await again).body.behavior, 'deny');
    });

    it('denies browser tools to a session that is not a browser session', async () => {
      const r = await post('/v1/instances', { cwd });
      const out = await permission(r.body.instanceId, C('read_page'), { tabId: 1 });
      assert.equal(out.body.behavior, 'deny');
    });
  });

  describe('plans and grants', () => {
    const shot = () => {
      const p = path.join(shotDir, 'screenshot-1795705450960-0.jpg');
      fs.writeFileSync(p, JPEG);
      return p;
    };
    const requestId = () => 'grant-' + crypto.randomBytes(12).toString('hex');
    const plan = (id, extra) => post('/api/browser-grant', Object.assign({
      instanceId: id, requestId: requestId(), site: 'httpbin.org', purpose: 'Submit the test order',
      steps: ['Click Submit order'], minutes: 5, screenshotPath: shot(),
    }, extra || {}));

    it('puts the plan and its screenshot to the user; approved, the commit goes through', async () => {
      const id = await startBrowserSession();
      guard.observeTabs(id, [{ tabId: 5, url: 'https://httpbin.org/forms/post' }]);
      const pending = plan(id);
      await new Promise((r) => setTimeout(r, 50));

      const view = await get('/v1/instances/' + id);
      const pa = view.body.pendingApproval;
      assert.equal(pa.approvalType, 'browser_plan');
      assert.deepEqual(pa.browserPlan, { site: 'httpbin.org', minutes: 5, purpose: 'Submit the test order', steps: ['Click Submit order'], screenshot: true });
      const img = await get('/v1/instances/' + id + '/approval/screenshot');
      assert.equal(img.status, 200);
      assert.equal(img.type, 'image/jpeg');
      assert.deepEqual(img.bytes, JPEG);
      assert.equal((await get('/api/instances/' + id + '/approval/screenshot')).status, 200, 'the dashboard can see it too');

      // An agent's own word is not enough.
      const byAgent = await post('/v1/instances/' + id + '/approval', { toolUseId: pa.toolUseId, answer: 'approve', relay: { decidedBy: 'agent' } });
      assert.equal(byAgent.status, 403);
      const ok = await post('/v1/instances/' + id + '/approval', { toolUseId: pa.toolUseId, answer: 'approve', relay: { decidedBy: 'user', userMessage: 'yes go' } });
      assert.equal(ok.status, 200);
      const answer = await pending;
      assert.equal(answer.body.granted, true);
      assert.match(answer.body.message, /until .* \(5 minutes from the user's approval\)/);
      assert.match(answer.body.message, /take a fresh screenshot and request a new grant/);

      // The screenshot is gone with the approval.
      assert.equal((await get('/v1/instances/' + id + '/approval/screenshot')).status, 404);
      const click = await permission(id, C('computer'), { tabId: 5, action: 'left_click', ref: 'ref_9', action_summary: 'Submits the order' });
      assert.equal(click.body.behavior, 'allow');
    });

    it('rejected, tells the agent why and grants nothing', async () => {
      const id = await startBrowserSession();
      guard.observeTabs(id, [{ tabId: 5, url: 'https://httpbin.org/forms/post' }]);
      const pending = plan(id);
      await new Promise((r) => setTimeout(r, 50));
      const pa = (await get('/v1/instances/' + id)).body.pendingApproval;
      await post('/v1/instances/' + id + '/approval', { toolUseId: pa.toolUseId, answer: 'reject', text: 'wrong quantity', relay: { decidedBy: 'user', userMessage: 'no, the quantity is wrong' } });
      const answer = await pending;
      assert.equal(answer.body.granted, false);
      assert.match(answer.body.message, /wrong quantity/);
      assert.equal(guard.activeGrant(id, 'httpbin.org'), null);
    });

    it('starts the grant at the approval, even when the answer comes after a re-poll', async () => {
      const id = await startBrowserSession();
      const body = {
        instanceId: id, requestId: requestId(), site: 'httpbin.org', purpose: 'Submit', steps: ['Click Submit'], minutes: 5, screenshotPath: shot(),
      };
      const first = await post('/api/browser-grant', body);
      assert.deepEqual(first.body, { retry: true }, 'held: asked to come back');
      const pa = (await get('/v1/instances/' + id)).body.pendingApproval;
      await post('/v1/instances/' + id + '/approval', { toolUseId: pa.toolUseId, answer: 'approve', relay: { decidedBy: 'user', userMessage: 'ok' } });
      assert.ok(guard.activeGrant(id, 'httpbin.org'), 'granted at approval time');
      const again = await post('/api/browser-grant', body);
      assert.equal(again.body.granted, true);
    });

    it('refuses a bad plan before bothering the user', async () => {
      const id = await startBrowserSession();
      assert.equal((await plan(id, { site: 'mail.google.com' })).body.granted, false);
      assert.equal((await plan(id, { screenshotPath: '/etc/passwd' })).body.granted, false);
      assert.equal((await plan(id, { steps: [] })).body.granted, false);
      assert.equal((await plan(id, { purpose: 'x'.repeat(501) })).body.granted, false);
      assert.equal((await plan(id, { requestId: 'grant-../../x' })).body.granted, false);
      assert.equal((await plan('agent-99')).body.granted, false);
      assert.equal(im.get(id).pendingApproval, null);
    });

    it('ends grants on abort', async () => {
      const id = await startBrowserSession();
      guard.grant(id, 'httpbin.org', 5);
      assert.equal((await post('/v1/instances/' + id + '/abort')).status, 200);
      assert.equal(guard.activeGrant(id, 'httpbin.org'), null);
    });

    it('forgets the session when it ends', async () => {
      const id = await startBrowserSession();
      agents[0].ws.close();
      assert.equal(guard.has(id), false);
    });

    it('serves no screenshot without a pending plan', async () => {
      const id = await startBrowserSession();
      assert.equal((await get('/v1/instances/' + id + '/approval/screenshot')).status, 404);
      assert.equal((await get('/api/instances/' + id + '/approval/screenshot')).status, 404);
    });
  });
});
