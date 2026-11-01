const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const InstanceManager = require('../src/server/instances');
const { PendingApprovals } = require('../src/server/approvals');
const { CampaignManager } = require('../src/campaign');
const { CampaignStore } = require('../src/campaign/store');
const { parseAgentMay } = require('../src/campaign/decisions');

/**
 * Campaigns, phase 1: a campaign file you approve before anything runs,
 * a session held as campaign:<id>, decisions that close on the first
 * answer, approvals that wait, and a ledger of every intervention.
 */

const DEF = {
  version: 1,
  name: 'storage-engine',
  objective: 'Replace the in-memory index with a crash-safe engine',
  read_first: ['ARCHITECTURE.md'],
  constraints: ['public API does not change'],
  milestones: [
    { id: 'm1-format', goal: 'On-disk format', gate: { run: ['node', '-e', 'process.exit(0)'], timeout_s: 60 }, accept: 'round-trips every fixture' },
    { id: 'm2-recovery', goal: 'Crash recovery', gate: { run: ['node', '-e', 'process.exit(3)'] }, accept: 'no acknowledged write lost' },
  ],
  pinned_paths: ['gates/'],
};

/** A stand-in SessionController: real instances, no agent processes. */
function fakeController(im) {
  const calls = { start: [], takeover: [], resume: [], prompts: [], handOver: [], release: [] };
  let foreign = null;
  return {
    calls,
    setForeign(w) { foreign = w; },
    transcriptPathFor(inst) { return inst.sessionId === 'known-session' ? '/tmp/known.jsonl' : null; },
    agentFor(inst) { return inst && inst._agent ? {} : null; },
    async start(o) {
      calls.start.push(o);
      const inst = im.register({ name: o.name, cwd: o.cwd, project: 'p' });
      inst._agent = true;
      im.setControl(inst.id, { canReceivePrompts: true, heldBy: o.heldBy });
      return { ok: true, instanceId: inst.id };
    },
    async takeover(id, o) {
      calls.takeover.push({ id, o });
      const inst = im.get(id);
      if (inst.status === 'busy') return { ok: false, error: 'session_busy', message: 'busy' };
      inst._agent = true;
      im.setControl(id, { canReceivePrompts: true, heldBy: o.heldBy });
      return { ok: true, instanceId: id };
    },
    async resume(sessionId, o) {
      calls.resume.push({ sessionId, o });
      const inst = im.register({ name: o.name, cwd: o.cwd, sessionId });
      inst._agent = true;
      im.setControl(inst.id, { canReceivePrompts: true, heldBy: o.heldBy });
      return { ok: true, instanceId: inst.id };
    },
    sendPrompt(id, text, o) {
      calls.prompts.push({ id, text, source: o.source });
      im.addMessage(id, { role: 'user', content: text, source: o.source });
      return { ok: true, queued: false };
    },
    checkHandback() { return foreign; },
    release(id, writer) {
      calls.release.push({ id, writer });
      im.setControl(id, { canReceivePrompts: false, heldBy: null });
    },
    handOver(id, heldBy) {
      calls.handOver.push({ id, heldBy });
      im.setControl(id, { canReceivePrompts: true, heldBy });
      return true;
    },
  };
}

function writeDef(repo, def) {
  fs.mkdirSync(path.join(repo, '.polpo'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.polpo', 'campaign.json'), JSON.stringify(def, null, 2));
}

function fakeGate(result) {
  const started = [];
  const fn = (o) => {
    started.push(o);
    fs.writeFileSync(o.logPath, 'ok\n');
    return { done: Promise.resolve(Object.assign({ exit: 0, signal: null, timedOut: false, durationMs: 5, logSha256: 'abc', tail: 'ok' }, result)), cancel() {} };
  };
  fn.started = started;
  return fn;
}

describe('CampaignManager', () => {
  let tmp, repo, im, approvals, ctl, store, mgr, gate;

  function makeManager(opts) {
    return new CampaignManager(Object.assign({
      instanceManager: im,
      sessionController: ctl,
      approvals,
      store,
      runGate: gate,
      gitState: async () => ({ commit: 'c0ffee', dirty: false, treeHash: null }),
    }, opts || {}));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-campaign-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'gates'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'gates', 'crash.sh'), 'exit 0\n');
    writeDef(repo, DEF);
    im = new InstanceManager();
    approvals = new PendingApprovals(im);
    ctl = fakeController(im);
    store = new CampaignStore({ root: path.join(tmp, 'state') });
    gate = fakeGate({});
    mgr = makeManager();
  });

  afterEach(() => {
    mgr.destroy();
    approvals.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function approved() {
    const out = mgr.create({ cwd: repo, channel: 'dashboard' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const ans = await mgr.answer(out.campaign.campaignId, out.decision.decisionId, {
      answer: 'approve', hash: out.decision.details.hash, channel: 'dashboard', decidedBy: 'user',
    });
    assert.equal(ans.ok, true, JSON.stringify(ans));
    return mgr.get('storage-engine');
  }

  function kinds(id) {
    return mgr.ledgerSince(id || 'storage-engine', 0, 500).entries.map((e) => e.kind);
  }

  it('proposes a campaign and runs nothing until its file is approved', () => {
    const out = mgr.create({ cwd: repo, channel: 'gateway:pa' });
    assert.equal(out.ok, true);
    assert.equal(out.campaign.status, 'awaiting_definition');
    assert.equal(out.decision.kind, 'definition');
    assert.deepEqual(out.decision.options, ['approve', 'reject']);
    assert.match(out.decision.text, /m1-format: On-disk format/);
    assert.match(out.decision.text, /Gate: node -e "process.exit\(0\)"/);
    assert.equal(ctl.calls.start.length, 0, 'no session before approval');
    const gateTry = mgr.runGate('storage-engine', {}, { channel: 'dashboard' });
    assert.equal(gateTry.error, 'awaiting_definition');
    assert.deepEqual(kinds(), ['campaign_created']);
  });

  it('refuses a campaign file with errors, outside cwd, or a duplicate name', () => {
    writeDef(repo, Object.assign({}, DEF, { milestones: [{ id: 'X', goal: 'g', gate: { run: 'make' }, accept: 'a' }] }));
    const bad = mgr.create({ cwd: repo });
    assert.equal(bad.error, 'invalid_definition');
    assert.ok(bad.errors.some((e) => /gate.run/.test(e)));
    assert.equal(mgr.create({ cwd: repo, file: '../outside.json' }).error, 'invalid_file');
    writeDef(repo, DEF);
    assert.equal(mgr.create({ cwd: repo }).ok, true);
    assert.equal(mgr.create({ cwd: repo }).error, 'campaign_exists');
  });

  it('needs the hash of the version shown, and the user, to approve', async () => {
    const out = mgr.create({ cwd: repo });
    const id = out.campaign.campaignId;
    const did = out.decision.decisionId;
    assert.equal((await mgr.answer(id, did, { answer: 'approve', hash: 'f'.repeat(64), decidedBy: 'user' })).error, 'hash_mismatch');
    assert.equal((await mgr.answer(id, did, { answer: 'approve', hash: out.decision.details.hash, decidedBy: 'agent' })).error, 'agent_may_not_decide');
    assert.equal((await mgr.answer(id, did, { answer: 'reject', decidedBy: 'user' })).error, 'text_required');
    assert.equal((await mgr.answer(id, did, { answer: 'maybe', decidedBy: 'user' })).error, 'invalid_answer');
  });

  it('on approval pins the file, holds a new session and briefs the agent', async () => {
    const c = await approved();
    assert.equal(c.status, 'active');
    assert.ok(c.definitionHash);
    assert.deepEqual(Object.keys(c.pinned), ['gates/']);
    assert.equal(ctl.calls.start.length, 1);
    assert.equal(ctl.calls.start[0].heldBy, 'campaign:storage-engine');
    assert.equal(mgr.campaignForInstance(c.instanceId), 'storage-engine');
    assert.equal(ctl.calls.prompts.length, 1);
    assert.match(ctl.calls.prompts[0].text, /Active milestone m1-format \(1 of 2\)/);
    assert.match(ctl.calls.prompts[0].text, /polpo runs the gate itself/);
    assert.match(ctl.calls.prompts[0].text, /Read these first: ARCHITECTURE.md/);
    assert.deepEqual(kinds(), ['campaign_created', 'campaign_approved', 'prompt']);
    const prompt = mgr.ledgerSince('storage-engine', 0).entries[2];
    assert.equal(prompt.channel, 'polpo');
  });

  it('takes over an existing session, keeping its desk permission mode', async () => {
    const inst = im.register({ name: 'vscode', sessionId: 'known-session', canReceivePrompts: false });
    im.updateStatus(inst.id, 'idle');
    const out = mgr.create({ cwd: repo, sessionId: 'known-session' });
    assert.equal(out.ok, true);
    await mgr.answer('storage-engine', out.decision.decisionId, { answer: 'approve', hash: out.decision.details.hash, decidedBy: 'user' });
    assert.equal(ctl.calls.takeover.length, 1);
    assert.equal(ctl.calls.takeover[0].o.inheritPermissionMode, true);
    assert.equal(mgr.get('storage-engine').instanceId, inst.id);
    assert.equal(mgr.create({ cwd: repo, sessionId: 'nope' }).error, 'session_not_found');
  });

  it('a campaign proposed through the gateway follows the host\'s inherit setting', async () => {
    const inst = im.register({ name: 'vscode', sessionId: 'known-session', canReceivePrompts: false });
    im.updateStatus(inst.id, 'idle');
    const out = mgr.create({ cwd: repo, sessionId: 'known-session', channel: 'gateway:pa' });
    await mgr.answer('storage-engine', out.decision.decisionId, { answer: 'approve', hash: out.decision.details.hash, decidedBy: 'user', userMessage: 'y' });
    assert.equal(ctl.calls.takeover[0].o.inheritPermissionMode, false, 'off unless the host allows it');
    assert.equal(mgr.ledgerSince('storage-engine', 0).entries[0].inheritPermissionMode, false);
  });

  it('a gateway caller taking the session of a desk campaign does not get the desk mode', async () => {
    const inst = im.register({ name: 'vscode', sessionId: 'known-session', canReceivePrompts: false });
    im.updateStatus(inst.id, 'idle');
    const out = mgr.create({ cwd: repo, sessionId: 'known-session' });
    await mgr.answer('storage-engine', out.decision.decisionId, {
      answer: 'approve', hash: out.decision.details.hash, channel: 'gateway:pa', decidedBy: 'user', userMessage: 'go',
    });
    assert.equal(ctl.calls.takeover[0].o.inheritPermissionMode, false, 'approved through the gateway');
    // The session ends; the PA resumes the campaign.
    im.unregister(inst.id);
    mgr.get('storage-engine').status = 'paused';
    await mgr.resume('storage-engine', { channel: 'gateway:pa', decidedBy: 'user', userMessage: 'resume' });
    assert.equal(ctl.calls.resume[0].o.inheritPermissionMode, false, 'resumed through the gateway');
    assert.equal(mgr.get('storage-engine').inheritPermissionMode, true, 'the campaign itself is unchanged');
  });

  it('a stored campaign without the setting decides it from where it was proposed', async () => {
    mgr.create({ cwd: repo, sessionId: 'known-session', channel: 'gateway:pa' });
    const s = store.load('storage-engine');
    delete s.inheritPermissionMode;
    store.save(s);
    mgr.destroy();
    const im2 = new InstanceManager();
    const mgr2 = new CampaignManager({ instanceManager: im2, sessionController: fakeController(im2), approvals: new PendingApprovals(im2), store });
    mgr2.load();
    assert.equal(mgr2.get('storage-engine').inheritPermissionMode, false);
    mgr2.destroy();
    mgr = makeManager();
  });

  it('pauses with the reason when the session is busy at approval', async () => {
    const inst = im.register({ name: 'vscode', sessionId: 'known-session', canReceivePrompts: false });
    im.updateStatus(inst.id, 'busy');
    const out = mgr.create({ cwd: repo, sessionId: 'known-session' });
    const ans = await mgr.answer('storage-engine', out.decision.decisionId, { answer: 'approve', hash: out.decision.details.hash, decidedBy: 'user' });
    assert.equal(ans.ok, true);
    assert.equal(mgr.get('storage-engine').status, 'paused');
    assert.ok(kinds().includes('pause'));
  });

  it('closes a decision on the first answer; a later one learns what was decided', async () => {
    const out = mgr.create({ cwd: repo });
    await mgr.answer('storage-engine', out.decision.decisionId, { answer: 'approve', hash: out.decision.details.hash, channel: 'dashboard', decidedBy: 'user' });
    const late = await mgr.answer('storage-engine', out.decision.decisionId, {
      answer: 'reject', text: 'no', channel: 'gateway:pa', decidedBy: 'user', userMessage: 'no',
    });
    assert.equal(late.error, 'decision_closed');
    assert.equal(late.decided.answer, 'approve');
    assert.equal(late.decided.channel, 'dashboard');
  });

  it('records a rejection with your words and does not ask again about the same file', async () => {
    const out = mgr.create({ cwd: repo });
    const r = await mgr.answer('storage-engine', out.decision.decisionId, {
      answer: 'reject', text: 'split m1 in two', channel: 'gateway:pa', decidedBy: 'user', userMessage: 'no, split m1',
    });
    assert.equal(r.ok, true);
    const e = mgr.ledgerSince('storage-engine', 0).entries.find((x) => x.kind === 'definition_rejected');
    assert.equal(e.reason, 'split m1 in two');
    assert.equal(e.userMessage, 'no, split m1');
    assert.equal(e.channel, 'gateway:pa');
    const resumed = await mgr.resume('storage-engine', { channel: 'dashboard' });
    assert.equal(resumed.error, 'awaiting_definition');
    assert.equal(resumed.decisions.length, 0, 'the rejected version is not raised again');
    writeDef(repo, Object.assign({}, DEF, { objective: 'Two milestones for the format' }));
    const again = await mgr.resume('storage-engine', { channel: 'dashboard' });
    assert.equal(again.decisions.length, 1, 'a new version is');
  });

  it('pauses when the agent edits the campaign file, and shows what changed', async () => {
    const c = await approved();
    const changed = JSON.parse(JSON.stringify(DEF));
    changed.milestones[0].gate.run = ['true'];
    writeDef(repo, changed);
    im.updateStatus(c.instanceId, 'idle');
    assert.equal(c.status, 'awaiting_definition');
    const d = mgr.describe(c).pendingDecisions[0];
    assert.equal(d.kind, 'definition');
    assert.match(d.text, /changed since you approved it/);
    assert.match(d.text, /m1-format gate: node -e "process.exit\(0\)" -> true/);
    assert.ok(kinds().includes('campaign_changed'));
    assert.equal(mgr.prompt('storage-engine', 'go on', { channel: 'dashboard' }).error, 'not_active');

    // The PA answers about the old version after the file moved on again.
    writeDef(repo, DEF);
    const stale = await mgr.answer('storage-engine', d.decisionId, { answer: 'approve', hash: d.details.hash, decidedBy: 'user' });
    assert.equal(stale.error, 'decision_superseded');
    assert.equal(c.status, 'paused', 'back to the approved version, paused for you to resume');
  });

  it('a changed file approved again resumes and briefs the agent', async () => {
    const c = await approved();
    writeDef(repo, Object.assign({}, DEF, { objective: 'A sharper objective' }));
    im.updateStatus(c.instanceId, 'idle');
    const d = mgr.describe(c).pendingDecisions[0];
    await mgr.answer('storage-engine', d.decisionId, { answer: 'approve', hash: d.details.hash, decidedBy: 'user' });
    assert.equal(c.status, 'active');
    assert.match(ctl.calls.prompts[ctl.calls.prompts.length - 1].text, /changed and was approved again/);
  });

  it('an approval waits as a decision and is answered from the gateway', async () => {
    const c = await approved();
    const waiting = approvals.wait(c.instanceId, { toolUseId: 'tu-1', toolInput: { command: 'rm -rf build' } }, { expiresMs: null });
    const d = mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: 'tu-1', tool: 'Bash', command: 'rm -rf build', approvalType: 'tool' });
    assert.equal(d.kind, 'approval');
    assert.match(d.text, /Command: rm -rf build/);
    const agent = await mgr.answer('storage-engine', d.decisionId, { answer: 'allow', decidedBy: 'agent', userMessage: null });
    assert.equal(agent.error, 'agent_may_not_decide', 'approvals are always yours');
    const ok = await mgr.answer('storage-engine', d.decisionId, {
      answer: 'deny', text: 'not the build dir', channel: 'gateway:pa', decidedBy: 'user', userMessage: 'no!',
    });
    assert.equal(ok.ok, true);
    const decision = await waiting;
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /not the build dir/);
    const e = mgr.ledgerSince('storage-engine', 0).entries.find((x) => x.kind === 'denial');
    assert.equal(e.channel, 'gateway:pa');
    assert.equal(e.userMessage, 'no!');
    assert.equal(mgr.describe(c).pendingDecisions.length, 0);
  });

  it('an approval answered on the dashboard closes the gateway decision', async () => {
    const c = await approved();
    const waiting = approvals.wait(c.instanceId, { toolUseId: 'tu-2', toolInput: { a: 1 } }, { expiresMs: null });
    const d = mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: 'tu-2', tool: 'Edit', toolInput: { a: 1 } });
    approvals.approve(c.instanceId, { channel: 'dashboard' });
    assert.equal((await waiting).behavior, 'allow');
    const late = await mgr.answer('storage-engine', d.decisionId, { answer: 'deny', decidedBy: 'user', userMessage: 'no' });
    assert.equal(late.error, 'decision_closed');
    assert.equal(late.decided.channel, 'dashboard');
    assert.ok(kinds().includes('approval'));
  });

  it('an answer about an approval the agent stopped waiting on is superseded', async () => {
    const c = await approved();
    const d = mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: 'gone', tool: 'Bash' });
    const out = await mgr.answer('storage-engine', d.decisionId, { answer: 'allow', decidedBy: 'user', userMessage: 'yes' });
    assert.equal(out.error, 'decision_superseded');
  });

  it('runs a gate outside the agent and records it', async () => {
    const c = await approved();
    const started = mgr.runGate('storage-engine', {}, { channel: 'gateway:pa' });
    assert.equal(started.ok, true);
    assert.equal(mgr.runGate('storage-engine', {}, {}).error, 'gate_running');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(gate.started[0].argv, ['node', '-e', 'process.exit(0)']);
    assert.equal(gate.started[0].cwd, fs.realpathSync(repo));
    const run = c.gateRuns[0];
    assert.equal(run.passed, true);
    assert.equal(run.commit, 'c0ffee');
    assert.deepEqual(run.pinnedChanged, []);
    const e = mgr.ledgerSince('storage-engine', 0).entries.find((x) => x.kind === 'gate_run');
    assert.equal(e.channel, 'gateway:pa');
    assert.equal(e.milestone, 'm1-format');
    assert.equal(e.logSha256, 'abc');
    assert.equal(mgr.describe(c).milestones[0].lastRun.passed, true);
  });

  it('lists gate files changed since approval on a gate run', async () => {
    const c = await approved();
    fs.writeFileSync(path.join(repo, 'gates', 'crash.sh'), 'exit 0 # weakened\n');
    mgr.runGate('storage-engine', { milestone: 'm2-recovery' }, {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.gateRuns[0].pinnedChanged, ['gates/']);
    assert.equal(mgr.runGate('storage-engine', { milestone: 'm9' }, {}).error, 'unknown_milestone');
  });

  it('refuses a gate while the agent is working', async () => {
    const c = await approved();
    im.updateStatus(c.instanceId, 'busy');
    assert.equal(mgr.runGate('storage-engine', {}, {}).error, 'session_busy');
  });

  it('refuses a prompt while the agent works, sends one when idle', async () => {
    const c = await approved();
    im.updateStatus(c.instanceId, 'busy');
    assert.equal(mgr.prompt('storage-engine', 'focus on fsync', { channel: 'gateway:pa' }).error, 'session_busy');
    im.updateStatus(c.instanceId, 'idle');
    assert.equal(mgr.prompt('storage-engine', 'focus on fsync', { channel: 'gateway:pa' }).ok, true);
    const e = mgr.ledgerSince('storage-engine', 0).entries.filter((x) => x.kind === 'prompt').pop();
    assert.equal(e.channel, 'gateway:pa');
    assert.equal(e.text, 'focus on fsync');
  });

  it('hands the session back when it is written to at the desk', async () => {
    const c = await approved();
    ctl.setForeign({ writer: 'claude-vscode' });
    im.addMessage(c.instanceId, { role: 'user', content: 'let me try something', source: 'jsonl' });
    assert.equal(ctl.calls.release.length, 1);
    assert.equal(c.status, 'paused_desk');
    const ks = kinds();
    assert.equal(ks[ks.length - 2], 'handback');
    const last = mgr.ledgerSince('storage-engine', 0).entries.pop();
    assert.equal(last.kind, 'prompt');
    assert.equal(last.channel, 'desk');
  });

  it("does not record polpo's own prompt twice when the transcript echoes it", async () => {
    const c = await approved();
    const before = kinds().length;
    im.addMessage(c.instanceId, { role: 'user', content: 'echo', source: 'jsonl' });
    assert.equal(kinds().length, before);
    assert.equal(c.status, 'active');
  });

  it('pauses when another holder takes the session', async () => {
    const c = await approved();
    im.setControl(c.instanceId, { heldBy: 'gateway:other' });
    assert.equal(c.status, 'paused_desk');
    const e = mgr.ledgerSince('storage-engine', 0).entries.pop();
    assert.equal(e.kind, 'handback');
    assert.equal(e.channel, 'gateway:other');
  });

  it('resumes a paused campaign and tells the agent', async () => {
    const c = await approved();
    mgr.pause('storage-engine', { channel: 'gateway:pa' });
    assert.equal(c.status, 'paused');
    const out = await mgr.resume('storage-engine', { channel: 'gateway:pa', decidedBy: 'user', userMessage: 'go' });
    assert.equal(out.ok, true);
    assert.equal(c.status, 'active');
    assert.match(ctl.calls.prompts.pop().text, /resuming after a pause/);
  });

  it('stopping ends it, closes what it waited on and hands the session to the dashboard', async () => {
    const c = await approved();
    const waiting = approvals.wait(c.instanceId, { toolUseId: 'tu-3', toolInput: {} }, { expiresMs: null });
    mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: 'tu-3', tool: 'Bash' });
    const out = await mgr.stop('storage-engine', { channel: 'dashboard', text: 'done for now' });
    assert.equal(out.ok, true);
    assert.equal(c.status, 'stopped');
    assert.equal((await waiting).behavior, 'deny');
    assert.deepEqual(ctl.calls.handOver, [{ id: c.instanceId, heldBy: 'dashboard' }]);
    assert.equal(mgr.campaignForInstance(c.instanceId), null);
    assert.equal(mgr.describe(c).pendingDecisions.length, 0);
    assert.ok(kinds().includes('approval_expired'));
    assert.equal(kinds().pop(), 'stop');
    assert.equal((await mgr.resume('storage-engine', {})).error, 'campaign_stopped');
  });

  it('comes back paused after a restart, with pending decisions kept', async () => {
    const c = await approved();
    mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: 'tu-4', tool: 'Bash' });
    writeDef(repo, Object.assign({}, DEF, { objective: 'changed before the restart' }));
    im.updateStatus(c.instanceId, 'idle');
    const pendingDef = mgr.describe(c).pendingDecisions.filter((d) => d.kind === 'definition');
    assert.equal(pendingDef.length, 1);
    mgr.destroy();

    const im2 = new InstanceManager();
    const mgr2 = new CampaignManager({ instanceManager: im2, sessionController: fakeController(im2), approvals: new PendingApprovals(im2), store });
    assert.equal(mgr2.load(), 1);
    const c2 = mgr2.get('storage-engine');
    assert.equal(c2.instanceId, null);
    const pending = mgr2.describe(c2).pendingDecisions;
    assert.deepEqual(pending.map((d) => d.kind), ['definition'], 'the definition survives, the approval lapsed');
    assert.equal(pending[0].decisionId, pendingDef[0].decisionId);
    assert.ok(mgr2.ledgerSince('storage-engine', 0).entries.some((e) => e.kind === 'approval_expired' && e.reason === 'restart'));
    assert.equal(mgr2.describe(c2).ledger.chainOk, true);
    mgr2.destroy();
    mgr = makeManager();
  });

  it('a running campaign comes back paused after a restart', async () => {
    await approved();
    mgr.destroy();
    const im2 = new InstanceManager();
    const mgr2 = new CampaignManager({ instanceManager: im2, sessionController: fakeController(im2), approvals: new PendingApprovals(im2), store });
    mgr2.load();
    assert.equal(mgr2.get('storage-engine').status, 'paused');
    assert.equal(mgr2.get('storage-engine').statusReason, 'polpo restarted');
    mgr2.destroy();
    mgr = makeManager();
  });

  it('lists pending decisions across campaigns with a cursor, and closed ones since it', async () => {
    const first = mgr.decisionsSince(0);
    assert.equal(first.decisions.length, 0);
    const out = mgr.create({ cwd: repo });
    const a = mgr.decisionsSince(first.cursor);
    assert.deepEqual(a.decisions.map((d) => d.decisionId), [out.decision.decisionId]);
    assert.equal(mgr.decisionsSince(a.cursor).decisions.length, 0, 'nothing new');
    await mgr.answer('storage-engine', out.decision.decisionId, { answer: 'approve', hash: out.decision.details.hash, channel: 'dashboard', decidedBy: 'user' });
    const b = mgr.decisionsSince(a.cursor);
    assert.deepEqual(b.closed.map((d) => [d.decisionId, d.answer, d.channel]), [[out.decision.decisionId, 'approve', 'dashboard']]);
    assert.ok(b.cursor > a.cursor);
  });

  it('a PA may decide only the kinds the host listed', () => {
    assert.deepEqual([...parseAgentMay('')], []);
    assert.deepEqual([...parseAgentMay('question, resume')], ['question', 'resume']);
    assert.throws(() => parseAgentMay('verdict'), /always yours/);
    assert.throws(() => parseAgentMay('approval'), /always yours/);
    assert.throws(() => parseAgentMay('definition'), /always yours/);
    assert.throws(() => parseAgentMay('questions'), /unknown/);
  });

  it('keeps a random-looking tool use id usable, and filters the definition shown', async () => {
    const c = await approved();
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const waiting = approvals.wait(c.instanceId, { toolUseId: id, toolInput: {} }, { expiresMs: null });
    const d = mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: id, tool: 'Bash' });
    assert.equal(d.details.toolUseId, id);
    assert.equal((await mgr.answer('storage-engine', d.decisionId, { answer: 'allow', decidedBy: 'user', userMessage: 'y' })).ok, true);
    assert.equal((await waiting).behavior, 'allow');
    const key = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    writeDef(repo, Object.assign({}, DEF, { constraints: ['deploy with ' + key] }));
    im.updateStatus(c.instanceId, 'idle');
    const pending = mgr.describe(c, { full: true }).pendingDecisions[0];
    assert.ok(!JSON.stringify(pending).includes(key));
    assert.ok(!JSON.stringify(mgr.describe(c, { full: true })).includes(key));
  });

  it('keeps secrets out of the ledger and decisions', async () => {
    const c = await approved();
    const key = ['fmpro', '_', 'Ab3dEf9hIj2kLm8nOp1qRs7tUv4wXy6zAB0cD-eFgH5iJk='].join('');
    const d = mgr.approvalRequested('storage-engine', c.instanceId, { toolUseId: 'tu-5', tool: 'Bash', command: "printf '%s' '" + key + "' > /tmp/k" });
    assert.ok(!d.text.includes(key));
    im.updateStatus(c.instanceId, 'idle');
    mgr.prompt('storage-engine', 'use API_KEY=' + key, { channel: 'gateway:pa' });
    const raw = fs.readFileSync(store.ledgerPath('storage-engine'), 'utf8');
    assert.ok(!raw.includes(key));
    assert.equal((fs.statSync(store.ledgerPath('storage-engine')).mode & 0o777), 0o600);
  });
});
