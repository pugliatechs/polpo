const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GatewayArtifactStore } = require('../src/server/gateway-artifacts');

function tempRoot() {
  return path.join(os.tmpdir(), 'polpo-artifacts-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

const TASK_ID = 'gtask-abc12345';

describe('GatewayArtifactStore.createDir', () => {
  let store, root;
  beforeEach(() => { root = tempRoot(); store = new GatewayArtifactStore({ root }); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('creates a write directory the agent can write into', () => {
    const dir = store.createDir(TASK_ID);
    assert.ok(dir.endsWith('/write'));
    const st = fs.statSync(dir);
    assert.ok(st.isDirectory());
    const mode = st.mode & 0o777;
    assert.equal(mode & 0o077, 0, 'write/ must not be group/world accessible: ' + mode.toString(8));
  });

  it('is idempotent', () => {
    const a = store.createDir(TASK_ID);
    const b = store.createDir(TASK_ID);
    assert.equal(a, b);
  });

  it('rejects malformed taskId', () => {
    assert.throws(() => store.createDir('not-a-task'),
      (err) => err.code === 'invalid_task_id');
    assert.throws(() => store.createDir('../escape'),
      (err) => err.code === 'invalid_task_id');
  });
});

describe('GatewayArtifactStore.sealOnFinalize', () => {
  let store, root, writeDir;
  beforeEach(() => {
    root = tempRoot();
    store = new GatewayArtifactStore({ root });
    writeDir = store.createDir(TASK_ID);
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('seals regular files into sealed/ with mode 0o400 and stable list', () => {
    fs.writeFileSync(path.join(writeDir, 'b.txt'), 'second');
    fs.writeFileSync(path.join(writeDir, 'a.md'), '# first');
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.equal(artifacts.length, 2);
    // Sorted by name asc
    assert.equal(artifacts[0].name, 'a.md');
    assert.equal(artifacts[1].name, 'b.txt');
    assert.equal(artifacts[0].mediaType, 'text/markdown; charset=utf-8');
    assert.equal(stats.skipped.length, 0);
    // Sealed files mode = 0o400
    const sealedA = fs.statSync(path.join(root, TASK_ID, 'sealed', 'a.md'));
    const modeA = sealedA.mode & 0o777;
    assert.equal(modeA & 0o277, 0, 'sealed file must be owner-read-only: ' + modeA.toString(8));
  });

  it('refuses symlinks pointing into the agent write/ dir', () => {
    fs.symlinkSync('/etc/passwd', path.join(writeDir, 'leak.txt'));
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.equal(artifacts.length, 0);
    const skipReason = stats.skipped.find(s => s.name === 'leak.txt').reason;
    assert.equal(skipReason, 'not_a_regular_file');
  });

  it('refuses subdirectories (non-recursive)', () => {
    fs.mkdirSync(path.join(writeDir, 'subdir'));
    fs.writeFileSync(path.join(writeDir, 'subdir', 'nested.txt'), 'x');
    fs.writeFileSync(path.join(writeDir, 'top.txt'), 'ok');
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.deepEqual(artifacts.map(a => a.name).sort(), ['top.txt']);
    assert.ok(stats.skipped.find(s => s.name === 'subdir' && s.reason === 'not_a_regular_file'));
  });

  it('refuses fifos / sockets / devices', () => {
    // simulate by creating a directory; same isFile() check
    fs.mkdirSync(path.join(writeDir, 'fake-fifo'));
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.equal(artifacts.length, 0);
    assert.equal(stats.skipped[0].reason, 'not_a_regular_file');
  });

  it('refuses files exceeding maxFileBytes', () => {
    store = new GatewayArtifactStore({ root: tempRoot(), maxFileBytes: 10 });
    writeDir = store.createDir(TASK_ID);
    fs.writeFileSync(path.join(writeDir, 'big.bin'), Buffer.alloc(11, 0xaa));
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.equal(artifacts.length, 0);
    assert.equal(stats.skipped[0].reason, 'too_large');
    try { fs.rmSync(store.root, { recursive: true, force: true }); } catch {}
  });

  it('enforces aggregate cap deterministically (sorted by name asc)', () => {
    store = new GatewayArtifactStore({ root: tempRoot(), maxBytes: 200 });
    writeDir = store.createDir(TASK_ID);
    fs.writeFileSync(path.join(writeDir, 'a.bin'), Buffer.alloc(150));
    fs.writeFileSync(path.join(writeDir, 'b.bin'), Buffer.alloc(60));
    fs.writeFileSync(path.join(writeDir, 'c.bin'), Buffer.alloc(40));
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    // a.bin (150) fits; b.bin (150+60=210 > 200) skipped; c.bin (150+40=190 ≤ 200) fits
    assert.deepEqual(artifacts.map(a => a.name).sort(), ['a.bin', 'c.bin']);
    assert.ok(stats.skipped.find(s => s.name === 'b.bin' && s.reason === 'aggregate_cap_reached'));
    try { fs.rmSync(store.root, { recursive: true, force: true }); } catch {}
  });

  it('enforces maxFiles cap', () => {
    store = new GatewayArtifactStore({ root: tempRoot(), maxFiles: 2 });
    writeDir = store.createDir(TASK_ID);
    fs.writeFileSync(path.join(writeDir, 'a'), 'a');
    fs.writeFileSync(path.join(writeDir, 'b'), 'b');
    fs.writeFileSync(path.join(writeDir, 'c'), 'c');
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.equal(artifacts.length, 2);
    assert.equal(stats.skipped.find(s => s.name === 'c').reason, 'max_files_reached');
    try { fs.rmSync(store.root, { recursive: true, force: true }); } catch {}
  });

  it('skips files whose name fails ARTIFACT_NAME_REGEX', () => {
    fs.writeFileSync(path.join(writeDir, 'ok.txt'), 'a');
    fs.writeFileSync(path.join(writeDir, 'has space.txt'), 'b');
    fs.writeFileSync(path.join(writeDir, 'évolué.txt'), 'c');
    const { artifacts, stats } = store.sealOnFinalize(TASK_ID);
    assert.deepEqual(artifacts.map(a => a.name).sort(), ['ok.txt']);
    assert.ok(stats.skipped.find(s => s.name === 'has space.txt' && s.reason === 'invalid_name'));
    assert.ok(stats.skipped.find(s => s.name === 'évolué.txt' && s.reason === 'invalid_name'));
  });

  it('returns empty when no write/ dir exists', () => {
    const { artifacts, stats } = store.sealOnFinalize('gtask-nodir01');
    assert.deepEqual(artifacts, []);
    assert.deepEqual(stats.skipped, []);
  });

  it('does NOT serve newly-added writes after seal (TOCTOU defence)', () => {
    fs.writeFileSync(path.join(writeDir, 'a.txt'), 'first');
    const first = store.sealOnFinalize(TASK_ID);
    assert.equal(first.artifacts.length, 1);

    // Adversary races a new file into write/ AFTER the seal pass.
    // sealed/ is the only directory served from, so the late file
    // must be inaccessible.
    fs.writeFileSync(path.join(writeDir, 'late.txt'), 'after seal');
    assert.throws(() => store.openSealed(TASK_ID, 'late.txt'),
      (err) => err.code === 'artifact_not_found');
  });
});

describe('GatewayArtifactStore.openSealed', () => {
  let store, root;
  beforeEach(() => {
    root = tempRoot();
    store = new GatewayArtifactStore({ root });
    const writeDir = store.createDir(TASK_ID);
    fs.writeFileSync(path.join(writeDir, 'report.md'), '# report');
    fs.writeFileSync(path.join(writeDir, 'photo.png'), Buffer.alloc(16));
    store.sealOnFinalize(TASK_ID);
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('returns a readable stream with correct media type', async () => {
    const opened = store.openSealed(TASK_ID, 'report.md');
    assert.equal(opened.mediaType, 'text/markdown; charset=utf-8');
    assert.equal(opened.size, 8);
    assert.equal(opened.isInlineSafe, false);
    const chunks = [];
    for await (const c of opened.stream) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString('utf8'), '# report');
  });

  it('flags inline-safe image types', async () => {
    const opened = store.openSealed(TASK_ID, 'photo.png');
    assert.equal(opened.mediaType, 'image/png');
    assert.equal(opened.isInlineSafe, true);
    // Drain the stream so the underlying fd is closed before afterEach rmrf
    for await (const _ of opened.stream) { /* consume */ }
  });

  it('throws invalid_artifact_name for ../ traversal', () => {
    assert.throws(() => store.openSealed(TASK_ID, '../../etc/passwd'),
      (err) => err.code === 'invalid_artifact_name');
  });

  it('throws invalid_artifact_name for separators and unicode', () => {
    assert.throws(() => store.openSealed(TASK_ID, 'sub/x'),
      (err) => err.code === 'invalid_artifact_name');
    assert.throws(() => store.openSealed(TASK_ID, 'café'),
      (err) => err.code === 'invalid_artifact_name');
  });

  it('throws artifact_not_found for unknown sealed name', () => {
    assert.throws(() => store.openSealed(TASK_ID, 'nothere.txt'),
      (err) => err.code === 'artifact_not_found');
  });

  it('refuses to open a symlink that was injected into sealed/', () => {
    const sealedDir = path.join(root, TASK_ID, 'sealed');
    fs.symlinkSync('/etc/passwd', path.join(sealedDir, 'evil.txt'));
    assert.throws(() => store.openSealed(TASK_ID, 'evil.txt'),
      (err) => err.code === 'artifact_not_found');
  });

  it('rejects invalid task id', () => {
    assert.throws(() => store.openSealed('bad', 'report.md'),
      (err) => err.code === 'invalid_task_id');
  });
});

describe('GatewayArtifactStore.destroyTask', () => {
  it('removes both write and sealed dirs', () => {
    const root = tempRoot();
    const store = new GatewayArtifactStore({ root });
    const wd = store.createDir(TASK_ID);
    fs.writeFileSync(path.join(wd, 'x.txt'), 'x');
    store.sealOnFinalize(TASK_ID);
    store.destroyTask(TASK_ID);
    assert.equal(fs.existsSync(path.join(root, TASK_ID)), false);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('is a no-op for unknown task', () => {
    const root = tempRoot();
    const store = new GatewayArtifactStore({ root });
    store.destroyTask('gtask-doesnotexist'); // no throw
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('ignores malformed taskId (no throw, no rm /)', () => {
    const root = tempRoot();
    const store = new GatewayArtifactStore({ root });
    store.destroyTask('../escape');
    store.destroyTask('');
    store.destroyTask(null);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
});
