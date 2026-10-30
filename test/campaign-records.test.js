const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const def = require('../src/campaign/definition');
const { Ledger, readLedger } = require('../src/campaign/ledger');
const { runGate, gitState } = require('../src/campaign/gate-runner');
const { CampaignStore } = require('../src/campaign/store');
const { exportCampaign } = require('../src/campaign/export');

/**
 * The parts of a campaign that are records: the definition you approve,
 * the hash-chained ledger, the gate runs, and their export.
 */

const DEF = {
  version: 1,
  name: 'demo',
  objective: 'o',
  milestones: [{ id: 'm1', goal: 'g', gate: { run: ['make', 'test'] }, accept: 'a' }],
};

describe('campaign definition', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-def-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('accepts a minimal file and refuses typos and shells', () => {
    assert.equal(def.validateDefinition(DEF).ok, true);
    const typo = def.validateDefinition(Object.assign({}, DEF, { milstones: [] }));
    assert.ok(typo.errors.some((e) => /unknown keys: milstones/.test(e)));
    const shell = def.validateDefinition(Object.assign({}, DEF, { milestones: [{ id: 'm1', goal: 'g', gate: { run: 'make test && rm -rf /' }, accept: 'a' }] }));
    assert.ok(shell.errors.some((e) => /no shell/.test(e)));
    const dup = def.validateDefinition(Object.assign({}, DEF, { milestones: [DEF.milestones[0], DEF.milestones[0]] }));
    assert.ok(dup.errors.some((e) => /used twice/.test(e)));
    const pin = def.validateDefinition(Object.assign({}, DEF, { pinned_paths: ['../outside'] }));
    assert.ok(pin.errors.some((e) => /pinned_paths/.test(e)));
    const budget = def.validateDefinition(Object.assign({}, DEF, { budgets: { dollars: 5 } }));
    assert.ok(budget.errors.some((e) => /unknown budget/.test(e)));
  });

  it('refuses a campaign file that leaves the repository through a symlink', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.polpo'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'secret.json'), '{}');
    fs.symlinkSync(path.join(tmp, 'secret.json'), path.join(repo, '.polpo', 'campaign.json'));
    assert.equal(def.resolveCampaignFile(repo).error, 'invalid_file');
    assert.equal(def.resolveCampaignFile(repo, '/etc/passwd').error, 'invalid_file');
  });

  it('renders the ladder and the changes in plain text', () => {
    const text = def.renderDefinition(Object.assign({}, DEF, { budgets: { turns_per_milestone: 60, same_failure_limit: 4 } }));
    assert.match(text, /1\. m1: g\n {3}Gate: make test \(timeout 30m\)\n {3}Accept when: a/);
    assert.match(text, /Budgets: 60 turns, 4 identical gate failures per milestone/);
    const after = JSON.parse(JSON.stringify(DEF));
    after.milestones[0].gate.run = ['make', 'test-quick'];
    after.milestones.push({ id: 'm2', goal: 'more', gate: { run: ['x'] }, accept: 'b' });
    const changes = def.describeChange(DEF, after);
    assert.ok(changes.includes('m1 gate: make test -> make test-quick'));
    assert.ok(changes.includes('Added milestone m2: more'));
    assert.match(def.capDecisionText('x'.repeat(5000), 'see the API'), /shortened; see the API\)$/);
    assert.equal(def.capDecisionText('x'.repeat(5000), 'r').length, def.MAX_DECISION_TEXT);
  });

  it('hashes pinned files and directories, and notices a change', () => {
    fs.mkdirSync(path.join(tmp, 'gates'));
    fs.writeFileSync(path.join(tmp, 'gates', 'a.sh'), 'one');
    fs.writeFileSync(path.join(tmp, 'Makefile'), 'all:');
    const pinned = def.hashPinnedPaths(tmp, { pinned_paths: ['gates/', 'Makefile', 'missing'] });
    assert.equal(pinned.missing, null);
    assert.deepEqual(def.changedPinnedPaths(tmp, pinned), []);
    fs.writeFileSync(path.join(tmp, 'gates', 'b.sh'), 'new file');
    assert.deepEqual(def.changedPinnedPaths(tmp, pinned), ['gates/']);
  });
});

describe('campaign ledger', () => {
  let tmp, file;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-ledger-'));
    file = path.join(tmp, 'ledger.jsonl');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('chains entries and keeps its own keys', () => {
    const l = new Ledger(file);
    l.append('prompt', 'dashboard', { text: 'a', seq: 99, prev: 'forged', kind: 'stop' });
    l.append('gate_run', 'polpo', { passed: true });
    const r = readLedger(file);
    assert.equal(r.ok, true);
    assert.deepEqual(r.entries.map((e) => [e.seq, e.kind]), [[1, 'prompt'], [2, 'gate_run']]);
    assert.equal(r.entries[0].prev, null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // A new process continues the chain.
    new Ledger(file).append('stop', 'dashboard', {});
    assert.equal(readLedger(file).ok, true);
  });

  it('detects an edited, removed or garbage entry', () => {
    const l = new Ledger(file);
    for (let i = 0; i < 4; i++) l.append('prompt', 'desk', { text: 'p' + i });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, lines.map((x, i) => (i === 1 ? x.replace('p1', 'P1') : x)).join('\n') + '\n');
    assert.equal(readLedger(file).brokenAt, 3, 'the entry after the edit no longer matches');
    fs.writeFileSync(file, [lines[0], lines[2], lines[3]].join('\n') + '\n');
    assert.equal(readLedger(file).brokenAt, 3);
    fs.writeFileSync(file, [lines[0], 'not json', lines[1]].join('\n') + '\n');
    assert.equal(readLedger(file).ok, false);
  });

  it('filters secrets and caps long fields', () => {
    const l = new Ledger(file);
    const tok = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    l.append('prompt', 'desk', { text: 'export T=' + tok, nested: { deep: tok }, long: 'y'.repeat(20000) });
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(tok));
    assert.ok(readLedger(file).entries[0].long.length < 9000);
  });
});

describe('gate runner', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-gate-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('runs argv without a shell and records the exit, tail and log hash', async () => {
    const logPath = path.join(tmp, 'g.log');
    const r = await runGate({
      cwd: tmp,
      argv: [process.execPath, '-e', 'console.log("line1"); console.error("line2"); console.log(process.argv[1]); process.exit(3)', 'a; touch pwned'],
      timeoutMs: 10000,
      logPath,
    }).done;
    assert.equal(r.exit, 3);
    assert.equal(r.timedOut, false);
    assert.match(r.tail, /line1/);
    assert.match(r.tail, /a; touch pwned/, 'an argument is passed as it is');
    assert.ok(!fs.existsSync(path.join(tmp, 'pwned')), 'no shell ran');
    const log = fs.readFileSync(logPath);
    assert.equal(r.logSha256, require('crypto').createHash('sha256').update(log).digest('hex'));
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  });

  it('kills a gate that runs past its timeout, children included', async () => {
    const marker = path.join(tmp, 'child-alive');
    const child = path.join(tmp, 'child.js');
    const parent = path.join(tmp, 'parent.js');
    fs.writeFileSync(child, 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x"), 1500);');
    fs.writeFileSync(parent, 'require("child_process").spawn(process.execPath, [' + JSON.stringify(child) + '], { stdio: "ignore" });'
      + 'console.log("started"); setInterval(() => {}, 1000);');
    const r = await runGate({ cwd: tmp, argv: [process.execPath, parent], timeoutMs: 400, logPath: path.join(tmp, 't.log') }).done;
    assert.equal(r.timedOut, true);
    assert.match(r.tail, /timed out/);
    await new Promise((res) => setTimeout(res, 1800));
    assert.ok(!fs.existsSync(marker), 'the gate\'s own children were stopped too');
  });

  it('reports a command that does not exist', async () => {
    const r = await runGate({ cwd: tmp, argv: ['polpo-no-such-gate'], timeoutMs: 5000, logPath: path.join(tmp, 'n.log') }).done;
    assert.equal(r.exit, null);
    assert.match(r.error, /ENOENT/);
  });

  it('records the commit and tells a dirty tree apart', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'f'), '1');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'f'], { cwd: tmp });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: tmp });
    const clean = await gitState(tmp);
    assert.match(clean.commit, /^[0-9a-f]{40}$/);
    assert.equal(clean.dirty, false);
    fs.writeFileSync(path.join(tmp, 'f'), '2');
    const a = await gitState(tmp);
    fs.writeFileSync(path.join(tmp, 'f'), '3');
    const b = await gitState(tmp);
    assert.equal(a.dirty, true);
    assert.notEqual(a.treeHash, b.treeHash);
    const none = await gitState(os.tmpdir());
    assert.equal(typeof none.dirty, 'boolean');
  });
});

describe('campaign export', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-export-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writes a pass/fail manifest and the chronology from the ledger', () => {
    const store = new CampaignStore({ root: path.join(tmp, 'state') });
    store.create('demo');
    store.save({ id: 'demo', status: 'active', cwd: '/r', file: '.polpo/campaign.json', createdAt: 'x', definition: DEF, definitionHash: 'h1' });
    const l = new Ledger(store.ledgerPath('demo'));
    l.append('campaign_approved', 'gateway:pa', { hash: 'h1', decidedBy: 'user', userMessage: 'go' });
    l.append('gate_run', 'dashboard', { milestone: 'm1', runId: 'g1', exit: 1, passed: false, durationMs: 4000, commit: 'abc', logSha256: 'l1' });
    l.append('gate_run', 'polpo', { milestone: 'm1', runId: 'g2', exit: 0, passed: true, durationMs: 5000, commit: 'def', logSha256: 'l2', pinnedChanged: ['gates/'] });
    const out = exportCampaign('demo', path.join(tmp, 'out'), { store });
    const m = JSON.parse(fs.readFileSync(out.manifest, 'utf8'));
    assert.equal(m.ledger.chainOk, true);
    assert.deepEqual(m.milestones[0].gateRuns.map((r) => [r.runId, r.passed, r.commit, r.logSha256]), [['g1', false, 'abc', 'l1'], ['g2', true, 'def', 'l2']]);
    assert.deepEqual(m.definitions, [{ at: m.definitions[0].at, hash: 'h1', channel: 'gateway:pa', decidedBy: 'user' }]);
    const steering = fs.readFileSync(out.steering, 'utf8');
    assert.match(steering, /\[gateway:pa\] Campaign file approved \(h1\)\. Your words: "go"/);
    assert.match(steering, /Gate of m1 FAILED \(exit 1, 4s, commit abc\)/);
    assert.match(steering, /Gate files changed: gates\//);
    assert.ok(!/\u2014/.test(steering), "no em dashes");
  });
});
