const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { GatewayUploadStore, UploadError } = require('../src/server/gateway-uploads');

function tempRoot() {
  return path.join(os.tmpdir(), 'polpo-uploads-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

const TOKEN_FP_A = crypto.createHash('sha256').update('caller-A-key').digest('hex');
const TOKEN_FP_B = crypto.createHash('sha256').update('caller-B-key').digest('hex');

function basicInput(overrides) {
  return Object.assign({
    buffer: Buffer.from('hello world', 'utf8'),
    filename: 'note.txt',
    mediaType: 'text/plain',
    tokenFingerprint: TOKEN_FP_A,
  }, overrides || {});
}

describe('GatewayUploadStore.put', () => {
  let store, root;
  beforeEach(() => { root = tempRoot(); store = new GatewayUploadStore({ root }); });
  afterEach(() => { store.destroy(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('persists a file and returns an upload record', () => {
    const r = store.put(basicInput());
    assert.match(r.uploadId, /^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(r.filename, 'note.txt');
    assert.equal(r.size, 11);
    assert.equal(r.mediaType, 'text/plain');
    assert.equal(r.sha256.length, 64);
    assert.ok(r.expiresAt > Date.now());
  });

  it('writes data and meta files with 0o600', () => {
    const r = store.put(basicInput());
    const dir = path.join(root, r.uploadId);
    const dataMode = fs.statSync(path.join(dir, 'data')).mode & 0o777;
    const metaMode = fs.statSync(path.join(dir, 'meta.json')).mode & 0o777;
    assert.equal(dataMode & 0o077, 0, 'data must not be group/world readable: ' + dataMode.toString(8));
    assert.equal(metaMode & 0o077, 0, 'meta must not be group/world readable: ' + metaMode.toString(8));
  });

  it('sanitizes filename: spaces and dangerous chars become underscore', () => {
    const r = store.put(basicInput({ filename: 'my report v2.txt' }));
    assert.equal(r.filename, 'my_report_v2.txt');
  });

  it('rejects filenames containing ..', () => {
    assert.throws(() => store.put(basicInput({ filename: '../etc/passwd' })),
      (err) => err.code === 'invalid_filename');
  });

  it('rejects filenames with path separators', () => {
    assert.throws(() => store.put(basicInput({ filename: 'sub/dir/x.txt' })),
      (err) => err.code === 'invalid_filename');
    assert.throws(() => store.put(basicInput({ filename: 'win\\path.txt' })),
      (err) => err.code === 'invalid_filename');
  });

  it('rejects filenames with NUL/control chars', () => {
    assert.throws(() => store.put(basicInput({ filename: 'x\x00.txt' })),
      (err) => err.code === 'invalid_filename');
    assert.throws(() => store.put(basicInput({ filename: 'x\n.txt' })),
      (err) => err.code === 'invalid_filename');
  });

  it('rejects empty filename', () => {
    assert.throws(() => store.put(basicInput({ filename: '' })),
      (err) => err.code === 'invalid_filename');
  });

  it('rejects buffer exceeding maxBytes', () => {
    const tiny = new GatewayUploadStore({ root: tempRoot(), maxBytes: 10 });
    try {
      assert.throws(() => tiny.put(basicInput({ buffer: Buffer.alloc(11, 0xaa) })),
        (err) => err.code === 'upload_too_large' && err.limit === 10);
    } finally { tiny.destroy(); fs.rmSync(tiny.root, { recursive: true, force: true }); }
  });

  it('rejects missing tokenFingerprint', () => {
    assert.throws(() => store.put(basicInput({ tokenFingerprint: undefined })),
      (err) => err.code === 'invalid_token_fingerprint');
  });

  it('rejects malformed tokenFingerprint (wrong length)', () => {
    assert.throws(() => store.put(basicInput({ tokenFingerprint: 'short' })),
      (err) => err.code === 'invalid_token_fingerprint');
  });

  it('computes a stable sha256 of the payload', () => {
    const buf = Buffer.from('determinism');
    const r = store.put(basicInput({ buffer: buf }));
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(r.sha256, expected);
  });
});

describe('GatewayUploadStore.get', () => {
  let store, root;
  beforeEach(() => { root = tempRoot(); store = new GatewayUploadStore({ root }); });
  afterEach(() => { store.destroy(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('returns dataPath and meta for a fresh upload', () => {
    const r = store.put(basicInput());
    const got = store.get(r.uploadId, TOKEN_FP_A);
    assert.ok(got.dataPath.endsWith('/data'));
    assert.equal(got.meta.uploadId, r.uploadId);
    assert.equal(got.meta.size, r.size);
    // Read the actual file to confirm content
    const bytes = fs.readFileSync(got.dataPath);
    assert.equal(bytes.toString('utf8'), 'hello world');
  });

  it('throws invalid_upload_id for non-matching shape', () => {
    assert.throws(() => store.get('not-a-uuid', TOKEN_FP_A),
      (err) => err.code === 'invalid_upload_id');
    assert.throws(() => store.get('u-deadbeef', TOKEN_FP_A),
      (err) => err.code === 'invalid_upload_id');
    assert.throws(() => store.get('u-../etc/passwd', TOKEN_FP_A),
      (err) => err.code === 'invalid_upload_id');
  });

  it('throws upload_not_found for unknown id', () => {
    assert.throws(() => store.get('u-00000000-0000-0000-0000-000000000000', TOKEN_FP_A),
      (err) => err.code === 'upload_not_found');
  });

  it('throws upload_expired for past expiresAt', () => {
    const short = new GatewayUploadStore({ root: tempRoot(), ttlMs: 1 });
    try {
      const r = short.put(basicInput());
      // Wait past TTL deterministically by tweaking meta.json
      const metaPath = path.join(short.root, r.uploadId, 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.expiresAt = Date.now() - 1000;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      assert.throws(() => short.get(r.uploadId, TOKEN_FP_A),
        (err) => err.code === 'upload_expired');
    } finally { short.destroy(); fs.rmSync(short.root, { recursive: true, force: true }); }
  });

  it('throws upload_forbidden when tokenFingerprint mismatches', () => {
    const r = store.put(basicInput({ tokenFingerprint: TOKEN_FP_A }));
    assert.throws(() => store.get(r.uploadId, TOKEN_FP_B),
      (err) => err.code === 'upload_forbidden');
  });

  it('refuses to follow a symlink swapped in as data', () => {
    const r = store.put(basicInput());
    const dir = path.join(root, r.uploadId);
    const dataPath = path.join(dir, 'data');
    fs.rmSync(dataPath);
    fs.symlinkSync('/etc/passwd', dataPath);
    assert.throws(() => store.get(r.uploadId, TOKEN_FP_A),
      (err) => err.code === 'upload_not_found');
  });
});

describe('GatewayUploadStore: pinning + GC', () => {
  let store, root;
  beforeEach(() => { root = tempRoot(); store = new GatewayUploadStore({ root }); });
  afterEach(() => { store.destroy(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('gcExpired removes uploads past their TTL + grace window', () => {
    const r = store.put(basicInput());
    // Force-expire far enough back to clear the grace window
    const metaPath = path.join(root, r.uploadId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.expiresAt = Date.now() - 60_000;
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    const removed = store.gcExpired();
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(path.join(root, r.uploadId)), false);
  });

  it('gcExpired skips pinned uploads even if expired', () => {
    const r = store.put(basicInput());
    const metaPath = path.join(root, r.uploadId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.expiresAt = Date.now() - 60_000;
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    store.pinToTask(r.uploadId, 'task-1');
    const removed = store.gcExpired();
    assert.equal(removed, 0);
    assert.equal(fs.existsSync(path.join(root, r.uploadId)), true);

    store.releaseFromTask(r.uploadId, 'task-1');
    const removed2 = store.gcExpired();
    assert.equal(removed2, 1);
  });

  it('gcExpired leaves non-expired uploads alone', () => {
    const r = store.put(basicInput());
    const removed = store.gcExpired();
    assert.equal(removed, 0);
    assert.equal(fs.existsSync(path.join(root, r.uploadId)), true);
  });

  it('pinToTask rejects malformed uploadId', () => {
    assert.throws(() => store.pinToTask('not-an-id', 't1'),
      (err) => err.code === 'invalid_upload_id');
  });

  it('releaseFromTask is a no-op for unknown ids', () => {
    store.releaseFromTask('u-00000000-0000-0000-0000-000000000000', 't1');
    // no throw
  });
});
