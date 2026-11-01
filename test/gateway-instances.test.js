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
      setClaudePermissionMode(mode) { this.modes = (this.modes || []).concat([mode]); },
    };
    agents.push(agent);
    return agent;
  }

  function startWith(sessionControl, extra) {
    const app = express();
    app.use('/v1', createGatewayRouter(Object.assign({
      taskManager: stubTaskManager(), getKey: () => KEY, instanceManager: im, sessionControl,
    }, extra || {})));
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
  describe('permission mode', () => {
    // The session ran in auto mode at the desk.
    beforeEach(() => {
      fs.writeFileSync(transcript, [
        { type: 'user', uuid: 'v0', entrypoint: 'claude-vscode', permissionMode: 'auto', message: {} },
        { type: 'assistant', uuid: 'v1', entrypoint: 'claude-vscode', message: { stop_reason: 'end_turn' } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    });

    it('is not carried over to an external caller by default', async () => {
      h = await startWith(new SessionController({ instanceManager: im, createAgent: agentFactory, sessions: {} }));
      const r = await post('/v1/instances/vscode-1/takeover');
      assert.equal(r.status, 200);
      assert.equal(agents[0].opts.claudePermissionMode, undefined);
      assert.equal(r.body.instance.permissionMode, null);
    });

    it('is carried over when the host allows it', async () => {
      h = await startWith(new SessionController({ instanceManager: im, createAgent: agentFactory, sessions: {} }),
        { inheritPermissionMode: true });
      const r = await post('/v1/instances/vscode-1/takeover');
      assert.equal(agents[0].opts.claudePermissionMode, 'auto');
      assert.equal(r.body.instance.permissionMode, 'auto');
    });
  });

  describe('a permission mode the caller chooses', () => {
    let ctl;
    const ALLOWED = new Set(['default', 'auto']);
    beforeEach(() => {
      ctl = new SessionController({ instanceManager: im, createAgent: agentFactory, sessions: {} });
    });

    it('is refused unless the host lists the modes', async () => {
      h = await startWith(ctl);
      const r = await post('/v1/instances/vscode-1/takeover', { permissionMode: 'auto' });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'permission_mode_not_enabled');
      assert.equal(agents.length, 0, 'nothing was taken over');
      assert.deepEqual((await get(h, '/v1/health')).body.sessionControl, { enabled: true, permissionModes: [], approvals: false });
    });

    it('is refused outside the list, and the list is given back', async () => {
      h = await startWith(ctl, { allowedPermissionModes: ALLOWED });
      for (const permissionMode of ['acceptEdits', 'bypassPermissions', 'bypass', 42]) {
        const r = await post('/v1/instances/vscode-1/takeover', { permissionMode });
        assert.equal(r.status, 400);
        assert.equal(r.body.error, 'permission_mode_not_allowed');
        assert.deepEqual(r.body.allowed, ['default', 'auto']);
      }
      assert.equal(agents.length, 0);
    });

    it('applies at takeover, even where the session had none at the desk', async () => {
      h = await startWith(ctl, { allowedPermissionModes: ALLOWED });
      assert.deepEqual((await get(h, '/v1/health')).body.sessionControl.permissionModes, ['default', 'auto']);
      const r = await post('/v1/instances/vscode-1/takeover', { permissionMode: 'auto' });
      assert.equal(r.status, 200);
      assert.equal(agents[0].opts.claudePermissionMode, 'auto');
      assert.equal(r.body.instance.permissionMode, 'auto');
    });

    it("'default' means none, whatever the inherit setting says", async () => {
      fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'v0', entrypoint: 'claude-vscode', permissionMode: 'auto', message: {} }) + '\n'
        + JSON.stringify({ type: 'assistant', uuid: 'v1', entrypoint: 'claude-vscode', message: { stop_reason: 'end_turn' } }) + '\n');
      h = await startWith(ctl, { allowedPermissionModes: ALLOWED, inheritPermissionMode: true });
      const r = await post('/v1/instances/vscode-1/takeover', { permissionMode: 'default' });
      assert.equal(agents[0].opts.claudePermissionMode, undefined);
      assert.equal(r.body.instance.permissionMode, null);
    });

    it('applies when resuming from the catalogue, for Claude only', async () => {
      h = await startWith(ctl, { allowedPermissionModes: ALLOWED });
      const r = await post('/v1/sessions/sess-9/resume', { cwd: tmp, permissionMode: 'auto' });
      assert.equal(r.status, 200);
      assert.equal(agents[0].opts.claudePermissionMode, 'auto');
      const codex = await post('/v1/sessions/sess-8/resume', { cwd: tmp, agentType: 'codex', permissionMode: 'auto' });
      assert.equal(codex.status, 400);
      assert.equal(codex.body.error, 'permission_mode_unsupported');
    });

    it('changes between turns on a session the caller drives', async () => {
      h = await startWith(ctl, { allowedPermissionModes: ALLOWED });
      assert.equal((await post('/v1/instances/vscode-1/permission-mode', { permissionMode: 'auto' })).body.error, 'takeover_required');
      const id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
      assert.equal(im.get(id).permissionMode, null);

      const r = await post('/v1/instances/' + id + '/permission-mode', { permissionMode: 'auto' });
      assert.equal(r.status, 200);
      assert.equal(r.body.permissionMode, 'auto');
      assert.deepEqual(agents[0].modes, ['auto'], 'the next turn starts in the new mode');
      assert.equal(im.get(id).permissionMode, 'auto');
      assert.match(im.get(id).conversation.slice(-1)[0].content, /Permission mode set to auto by gateway:openclaw/);

      assert.equal((await post('/v1/instances/' + id + '/permission-mode', { permissionMode: 'dontAsk' })).status, 400);
      assert.equal((await post('/v1/instances/' + id + '/permission-mode', {})).body.error, 'permission_mode_required');
      im.updateStatus(id, 'waiting');
      const busy = await post('/v1/instances/' + id + '/permission-mode', { permissionMode: 'default' });
      assert.equal(busy.status, 409);
      assert.equal(busy.body.error, 'session_busy');
      assert.deepEqual(agents[0].modes, ['auto']);
    });

    it('does not change the mode of a session you or a campaign drive', async () => {
      h = await startWith(ctl, { allowedPermissionModes: ALLOWED });
      const id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
      for (const heldBy of ['dashboard', 'campaign:storage-engine']) {
        im.setControl(id, { heldBy });
        const r = await post('/v1/instances/' + id + '/permission-mode', { permissionMode: 'auto' });
        assert.equal(r.status, 409);
        assert.equal(r.body.error, 'held_elsewhere');
      }
      assert.equal(agents[0].modes, undefined);
    });
  });

  describe('approvals relayed by the caller', () => {
    const { PendingApprovals } = require('../src/server/approvals');
    let ctl, approvals, id;

    /** The agent asks for an approval, as the permission route does. */
    function ask(toolUseId, tool, input, approvalType) {
      im.setPendingApproval(id, {
        tool, description: 'Run: ' + (input.command || ''), command: input.command || '', approvalType: approvalType || 'tool',
        questions: input.questions || null, toolUseId, input: JSON.stringify(input),
      });
      return approvals.wait(id, { toolUseId, toolInput: input, approvalType: approvalType || 'tool' }, { expiresMs: null });
    }

    const RELAY = { decidedBy: 'user', userMessage: 'yes, run it' };

    beforeEach(async () => {
      ctl = new SessionController({ instanceManager: im, createAgent: agentFactory, sessions: {} });
      approvals = new PendingApprovals(im);
    });
    afterEach(() => approvals.destroy());

    async function driven(extra) {
      h = await startWith(ctl, Object.assign({ approvals, approvalControl: true }, extra || {}));
      id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
    }

    it('is off unless the host opted in', async () => {
      h = await startWith(ctl, { approvals });
      id = (await post('/v1/instances/vscode-1/takeover')).body.instanceId;
      ask('tu-1', 'Bash', { command: 'make deploy' });
      const r = await post('/v1/instances/' + id + '/approval', { toolUseId: 'tu-1', answer: 'approve', relay: RELAY });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'approval_control_not_enabled');
      assert.ok(approvals.current(id), 'still waiting');
    });

    it('shows the caller what to put to you', async () => {
      await driven();
      ask('tu-1', 'Bash', { command: 'make deploy ENV=prod' });
      const p = (await get(h, '/v1/instances/' + id)).body.pendingApproval;
      assert.equal(p.toolUseId, 'tu-1');
      assert.equal(p.approvalType, 'tool');
      assert.equal(p.command, 'make deploy ENV=prod');
      assert.match(p.input, /ENV=prod/);
      assert.equal((await get(h, '/v1/health')).body.sessionControl.approvals, true);
    });

    it('approves with your words, and records who decided', async () => {
      await driven();
      const decision = ask('tu-1', 'Bash', { command: 'make deploy' });
      const settled = [];
      approvals.on('settled', (e) => settled.push(e));
      const r = await post('/v1/instances/' + id + '/approval', { toolUseId: 'tu-1', answer: 'approve', relay: RELAY });
      assert.equal(r.status, 200);
      assert.deepEqual(await decision, { behavior: 'allow', updatedInput: { command: 'make deploy' } });
      assert.deepEqual(settled[0].meta, { channel: 'gateway:openclaw', decidedBy: 'user', userMessage: 'yes, run it' });
      assert.match(im.get(id).conversation.slice(-1)[0].content, /Approved Bash through gateway:openclaw\. The user said: "yes, run it"/);
    });

    it('passes your reason on a rejection to the agent', async () => {
      await driven();
      const decision = ask('tu-1', 'Bash', { command: 'git push --force' });
      const r = await post('/v1/instances/' + id + '/approval', {
        toolUseId: 'tu-1', answer: 'reject', text: 'open a PR instead', relay: { decidedBy: 'user', userMessage: 'no, open a PR' },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await decision, { behavior: 'deny', message: 'Rejected by the user: open a PR instead' });
    });

    it('answers a question with the choices you made', async () => {
      await driven();
      const questions = [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];
      const decision = ask('tu-q', 'AskUserQuestion', { questions }, 'question');
      const shown = (await get(h, '/v1/instances/' + id)).body.pendingApproval;
      assert.equal(shown.approvalType, 'question');
      assert.deepEqual(shown.questions[0].options.map((o) => o.label), ['Postgres', 'SQLite']);
      assert.equal((await post('/v1/instances/' + id + '/approval', { toolUseId: 'tu-q', answer: 'approve', relay: RELAY })).status, 400);
      for (const answers of [undefined, {}, ['Postgres'], { 'Which database?': 3 }, JSON.parse('{"__proto__": "x"}')]) {
        const r = await post('/v1/instances/' + id + '/approval', { toolUseId: 'tu-q', answer: 'answer', answers, relay: RELAY });
        assert.equal(r.status, 400, JSON.stringify(answers));
      }
      const r = await post('/v1/instances/' + id + '/approval', {
        toolUseId: 'tu-q', answer: 'answer', answers: { 'Which database?': 'Postgres' }, relay: RELAY,
      });
      assert.equal(r.status, 200);
      assert.deepEqual((await decision).updatedInput.answers, { 'Which database?': 'Postgres' });
    });

    it('needs your words: an agent may not approve on its own', async () => {
      await driven();
      ask('tu-1', 'Bash', { command: 'make deploy' });
      const url = '/v1/instances/' + id + '/approval';
      assert.equal((await post(url, { toolUseId: 'tu-1', answer: 'approve' })).body.error, 'invalid_relay');
      assert.equal((await post(url, { toolUseId: 'tu-1', answer: 'approve', relay: { decidedBy: 'user' } })).body.error, 'invalid_relay');
      const agent = await post(url, { toolUseId: 'tu-1', answer: 'approve', relay: { decidedBy: 'agent' } });
      assert.equal(agent.status, 403);
      assert.equal(agent.body.error, 'agent_may_not_decide');
      assert.ok(approvals.current(id), 'still waiting for you');
    });

    it('lands only on the approval you were shown', async () => {
      await driven();
      ask('tu-1', 'Bash', { command: 'ls' });
      ask('tu-2', 'Bash', { command: 'rm -rf build' });
      const r = await post('/v1/instances/' + id + '/approval', { toolUseId: 'tu-1', answer: 'approve', relay: RELAY });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'approval_superseded');
      assert.equal(r.body.pendingApproval.toolUseId, 'tu-2');
      assert.equal(r.body.pendingApproval.command, 'rm -rf build');
      assert.equal(approvals.current(id).toolUseId, 'tu-2', 'the newer one still waits');
      assert.equal((await post('/v1/instances/' + id + '/approval', { answer: 'approve', relay: RELAY })).body.error, 'invalid_tool_use_id');
    });

    it('is only for sessions a gateway caller drives', async () => {
      await driven();
      ask('tu-1', 'Bash', { command: 'ls' });
      for (const heldBy of ['dashboard', 'campaign:storage-engine']) {
        im.setControl(id, { heldBy });
        const r = await post('/v1/instances/' + id + '/approval', { toolUseId: 'tu-1', answer: 'approve', relay: RELAY });
        assert.equal(r.status, 409);
        assert.equal(r.body.error, 'not_held_by_gateway');
      }
      assert.ok(approvals.current(id));
    });
  });
});

// Coding sessions are full of credentials. What the gateway returns goes
// wherever the caller sends it (a chat app, a model provider), so the
// common shapes of secret are removed on the way out.
describe('Gateway: secrets in session content', () => {
  // Built at runtime so no secret-shaped literal sits in the source.
  const FAKE_KEY = ['fmpro', 'Ab3dEf9hIj2kLm8nOp1qRs7tUv4wXy6zAB0cD-eFgH5iJk='].join('_');
  const COMMAND = "printf '%s' '" + FAKE_KEY + "' > /tmp/.key";
  let im, h, saved;

  beforeEach(async () => {
    saved = process.env.POLPO_GATEWAY_REDACT;
    delete process.env.POLPO_GATEWAY_REDACT;
    im = new InstanceManager();
    im.register({ id: 'sess-inst', name: 'runner check', project: 'fmpro', sessionId: 'sess-secret',
      firstPrompt: 'use the key ' + FAKE_KEY });
    im.addMessage('sess-inst', { role: 'assistant', content: 'Staging the key: ' + COMMAND });
    im.addMessage('sess-inst', { role: 'assistant', contentType: 'tool_use', content: { command: COMMAND } });
    im.setPendingApproval('sess-inst', { tool: 'Bash', description: 'Stage the prod key', input: { command: COMMAND } });
    h = await start(im);
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.POLPO_GATEWAY_REDACT;
    else process.env.POLPO_GATEWAY_REDACT = saved;
    await new Promise((r) => h.server.close(r));
  });

  it('removes them from a pending approval and the first prompt', async () => {
    const { body } = await get(h, '/v1/instances/sess-inst');
    assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
    assert.match(body.pendingApproval.input, /\[redacted\]/);
    assert.match(body.firstPrompt, /\[redacted\]/);
  });

  it('removes them from the live conversation and says so', async () => {
    const { body } = await get(h, '/v1/instances/sess-inst/conversation');
    assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
    assert.ok(body.messages.every((m) => m.redacted === true));
  });

  it('removes them from session history and search', async () => {
    const hist = await get(h, '/v1/sessions/sess-secret');
    assert.equal(hist.status, 200);
    assert.ok(!JSON.stringify(hist.body).includes(FAKE_KEY));
    const search = await get(h, '/v1/search?q=staging+the+key&include=memory');
    assert.equal(search.status, 200);
    assert.ok(search.body.results.length >= 1, 'the message was found');
    assert.ok(!JSON.stringify(search.body).includes(FAKE_KEY));
  });

  it('leaves ordinary text alone', async () => {
    im.addMessage('sess-inst', { role: 'assistant', content: 'merged as 524280b, session 4b1f4bb6-14e6-49d8-89a7-411d362c78bf' });
    const { body } = await get(h, '/v1/instances/sess-inst/conversation?since=2');
    assert.equal(body.messages[0].content, 'merged as 524280b, session 4b1f4bb6-14e6-49d8-89a7-411d362c78bf');
    assert.equal(body.messages[0].redacted, undefined);
  });

  it('can be turned off by the host', async () => {
    process.env.POLPO_GATEWAY_REDACT = '0';
    const { body } = await get(h, '/v1/instances/sess-inst');
    assert.ok(body.pendingApproval.input.includes(FAKE_KEY));
  });
});
