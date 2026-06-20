const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  SessionOutboxManager,
  MAX_FILES,
  SAFE_NAME_RE,
} = require('../src/server/session-outbox');

function tmpBase() {
  return path.join(os.tmpdir(), 'polpo-outbox-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

describe('SessionOutboxManager: enable/disable', () => {
  let base, mgr;
  beforeEach(() => { base = tmpBase(); mgr = new SessionOutboxManager({ baseDir: base }); });
  afterEach(() => {
    try { mgr.destroyAll(); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });

  it('enable() creates the per-instance dir with 0700 mode', () => {
    const dir = mgr.enable('inst-1');
    const st = fs.statSync(dir);
    assert.equal(st.isDirectory(), true);
    assert.equal(mgr.isEnabled('inst-1'), true);
    // Mode bits: only check user-readable portion to stay portable across umasks
    assert.equal(st.mode & 0o777, 0o700);
  });

  it('disable() removes the dir and marks not enabled', () => {
    mgr.enable('inst-1');
    const dir = mgr.dirFor('inst-1');
    writeFile(dir, 'report.txt', 'hello');
    mgr.disable('inst-1');
    assert.equal(mgr.isEnabled('inst-1'), false);
    assert.equal(fs.existsSync(dir), false);
  });

  it('enable() twice is a no-op for state but ensures the dir exists', () => {
    mgr.enable('inst-1');
    const dir = mgr.dirFor('inst-1');
    writeFile(dir, 'a.txt', 'x');
    mgr.enable('inst-1');
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
  });

  it('isEnabled returns false for unknown instances', () => {
    assert.equal(mgr.isEnabled('missing'), false);
  });

  it('disable is idempotent', () => {
    mgr.enable('inst-1');
    assert.equal(mgr.disable('inst-1'), true);
    assert.equal(mgr.disable('inst-1'), true);
    assert.equal(mgr.isEnabled('inst-1'), false);
  });
});

describe('SessionOutboxManager: injectDirective', () => {
  let base, mgr;
  beforeEach(() => { base = tmpBase(); mgr = new SessionOutboxManager({ baseDir: base }); });
  afterEach(() => { try { mgr.destroyAll(); } catch {} try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  it('returns the original text when outbox is disabled', () => {
    const out = mgr.injectDirective('inst-1', 'hello world');
    assert.equal(out, 'hello world');
  });

  it('prepends the <polpo:outbox> block when enabled', () => {
    mgr.enable('inst-1');
    const out = mgr.injectDirective('inst-1', 'analyze this and write a CSV');
    assert.ok(out.startsWith('<polpo:outbox dir="'));
    assert.ok(out.includes('</polpo:outbox>'));
    assert.ok(out.endsWith('analyze this and write a CSV'));
    // The directive and the user text are separated by a blank line so
    // a clever user can't subvert directive parsing with prefix text.
    assert.ok(out.includes('</polpo:outbox>\n\nanalyze'));
  });

  it('the directive carries the server-controlled dir path, not user input', () => {
    mgr.enable('inst-../etc/passwd');  // try to escape
    const out = mgr.injectDirective('inst-../etc/passwd', 'x');
    // The instance id is hashed, never interpolated. The directive should
    // point under our base dir, with no parent-traversal in the path.
    assert.ok(out.includes('dir="' + base));
    assert.ok(!out.includes('etc/passwd'));
  });
});

describe('SessionOutboxManager: list', () => {
  let base, mgr;
  beforeEach(() => { base = tmpBase(); mgr = new SessionOutboxManager({ baseDir: base }); });
  afterEach(() => { try { mgr.destroyAll(); } catch {} try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  it('returns [] when the instance has no outbox enabled', () => {
    assert.deepEqual(mgr.list('inst-1'), []);
  });

  it('lists regular files at top level, newest first', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'old.txt', 'a');
    // mtime resolution can be coarse — sleep briefly between writes
    const t = Date.now() + 50;
    while (Date.now() < t) {}
    writeFile(dir, 'new.txt', 'b');
    const files = mgr.list('inst-1');
    assert.equal(files.length, 2);
    assert.equal(files[0].name, 'new.txt');
    assert.equal(files[1].name, 'old.txt');
    assert.equal(files[0].size, 1);
    assert.ok(files[0].mediaType);
  });

  it('skips subdirectories', () => {
    const dir = mgr.enable('inst-1');
    fs.mkdirSync(path.join(dir, 'subdir'));
    writeFile(dir, 'real.txt', 'x');
    const files = mgr.list('inst-1');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'real.txt');
  });

  it('skips files with names violating the safe-name regex', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'ok.txt', 'x');
    // Bypass our regex by writing directly with a weird name
    writeFile(dir, 'bad name with spaces.txt', 'x');
    const files = mgr.list('inst-1');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'ok.txt');
  });

  it('skips empty files', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'empty.txt', '');
    writeFile(dir, 'has-content.txt', 'x');
    const files = mgr.list('inst-1');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'has-content.txt');
  });

  it('marks inline-safe images as isInlineSafe: true', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'pic.png', 'fakepng');
    writeFile(dir, 'doc.pdf', 'fakepdf');
    const files = mgr.list('inst-1');
    const pic = files.find(f => f.name === 'pic.png');
    const doc = files.find(f => f.name === 'doc.pdf');
    assert.equal(pic.isInlineSafe, true);
    assert.equal(doc.isInlineSafe, false);
  });
});

describe('SessionOutboxManager: open', () => {
  let base, mgr;
  beforeEach(() => { base = tmpBase(); mgr = new SessionOutboxManager({ baseDir: base }); });
  afterEach(() => { try { mgr.destroyAll(); } catch {} try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  it('rejects when outbox is not enabled', () => {
    assert.throws(() => mgr.open('inst-1', 'a.txt'), (err) => err.code === 'outbox_not_enabled');
  });

  it('rejects names that contain path separators or NUL', () => {
    mgr.enable('inst-1');
    assert.throws(() => mgr.open('inst-1', '../etc/passwd'), (err) => err.code === 'invalid_name');
    assert.throws(() => mgr.open('inst-1', 'sub/file.txt'), (err) => err.code === 'invalid_name');
    assert.throws(() => mgr.open('inst-1', 'bad\x00name.txt'), (err) => err.code === 'invalid_name');
  });

  it('rejects names that violate the safe-name regex even without traversal', () => {
    mgr.enable('inst-1');
    assert.throws(() => mgr.open('inst-1', 'has space.txt'), (err) => err.code === 'invalid_name');
  });

  it('returns 404 for a name that does not exist', () => {
    mgr.enable('inst-1');
    assert.throws(() => mgr.open('inst-1', 'missing.txt'), (err) => err.code === 'file_not_found');
  });

  it('returns a readable stream + metadata for a valid file', async () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'data.txt', 'hello world');
    const opened = mgr.open('inst-1', 'data.txt');
    assert.equal(opened.filename, 'data.txt');
    assert.equal(opened.size, 11);
    assert.equal(opened.isInlineSafe, false);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello world');
  });
});

describe('SessionOutboxManager: diffSinceLastIdle', () => {
  let base, mgr;
  beforeEach(() => { base = tmpBase(); mgr = new SessionOutboxManager({ baseDir: base }); });
  afterEach(() => { try { mgr.destroyAll(); } catch {} try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  it('returns [] when outbox is not enabled', () => {
    assert.deepEqual(mgr.diffSinceLastIdle('inst-1'), []);
  });

  it('first call after enable returns only files added since enable', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'one.txt', 'x');
    const added = mgr.diffSinceLastIdle('inst-1');
    assert.deepEqual(added, ['one.txt']);
  });

  it('subsequent calls only report further-new files', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'one.txt', 'x');
    mgr.diffSinceLastIdle('inst-1');                  // consume
    writeFile(dir, 'two.txt', 'y');
    const added = mgr.diffSinceLastIdle('inst-1');
    assert.deepEqual(added, ['two.txt']);
  });

  it('empty diff when nothing new', () => {
    const dir = mgr.enable('inst-1');
    writeFile(dir, 'one.txt', 'x');
    mgr.diffSinceLastIdle('inst-1');
    assert.deepEqual(mgr.diffSinceLastIdle('inst-1'), []);
  });
});

describe('SessionOutboxManager: cross-instance isolation', () => {
  let base, mgr;
  beforeEach(() => { base = tmpBase(); mgr = new SessionOutboxManager({ baseDir: base }); });
  afterEach(() => { try { mgr.destroyAll(); } catch {} try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  it('two instances get independent dirs and cannot see each other', () => {
    const dirA = mgr.enable('A');
    const dirB = mgr.enable('B');
    assert.notEqual(dirA, dirB);
    writeFile(dirA, 'a.txt', 'A');
    writeFile(dirB, 'b.txt', 'B');
    const aFiles = mgr.list('A').map(f => f.name);
    const bFiles = mgr.list('B').map(f => f.name);
    assert.deepEqual(aFiles, ['a.txt']);
    assert.deepEqual(bFiles, ['b.txt']);
    // Asking instance A for B's filename should fail (file_not_found,
    // not a leak)
    assert.throws(() => mgr.open('A', 'b.txt'), (err) => err.code === 'file_not_found');
  });

  it('disable on one instance does not affect another', () => {
    const dirA = mgr.enable('A');
    const dirB = mgr.enable('B');
    writeFile(dirA, 'a.txt', 'A');
    writeFile(dirB, 'b.txt', 'B');
    mgr.disable('A');
    assert.equal(fs.existsSync(dirA), false);
    assert.equal(fs.existsSync(dirB), true);
    assert.equal(mgr.list('B').length, 1);
  });
});
