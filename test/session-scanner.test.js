const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { SessionScanner } = require('../src/server/session-scanner');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `polpo-scanner-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createJsonlFile(dir, sessionId, cwd) {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const firstLine = JSON.stringify({
    type: 'system',
    cwd: cwd || '/home/test/project',
    version: '2.1.42',
    sessionId,
  });
  fs.writeFileSync(filePath, firstLine + '\n');
  return filePath;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe('SessionScanner', () => {
  let projectsDir;
  let scanner;

  beforeEach(() => {
    projectsDir = tmpDir();
    scanner = new SessionScanner({
      projectsDir,
      scanInterval: 50,
      activeThreshold: 60000,
      idleTimeout: 120000,
    });
  });

  afterEach(() => {
    if (scanner) scanner.stop();
    cleanup(projectsDir);
  });

  it('discovers new JSONL sessions', async () => {
    // Create a project directory with a session
    const projDir = path.join(projectsDir, '-home-test-myproject');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = crypto.randomUUID();
    createJsonlFile(projDir, sessionId, '/home/test/myproject');

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].sessionId, sessionId);
    assert.equal(discovered[0].cwd, '/home/test/myproject');
    assert.equal(discovered[0].projectName, 'test/myproject');
  });

  it('skips old JSONL files', async () => {
    const projDir = path.join(projectsDir, '-home-test-oldproject');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = crypto.randomUUID();
    const filePath = createJsonlFile(projDir, sessionId, '/home/test/oldproject');

    // Set modification time to 5 minutes ago
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(filePath, oldTime, oldTime);

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(discovered.length, 0);
  });

  it('skips subagent files', async () => {
    const projDir = path.join(projectsDir, '-home-test-project');
    fs.mkdirSync(projDir, { recursive: true });

    // Create main session
    const mainSessionId = crypto.randomUUID();
    createJsonlFile(projDir, mainSessionId, '/home/test/project');

    // Create subagent directory with a session
    const subDir = path.join(projDir, mainSessionId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    createJsonlFile(subDir, 'agent-abc123', '/home/test/project');

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 150));

    // Should only find the main session, not the subagent
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].sessionId, mainSessionId);
  });

  it('emits session:inactive for stale sessions', async () => {
    const projDir = path.join(projectsDir, '-home-test-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = crypto.randomUUID();
    const filePath = createJsonlFile(projDir, sessionId, '/home/test/project');

    // Use very short thresholds for testing
    scanner.stop();
    scanner = new SessionScanner({
      projectsDir,
      idleCheckInterval: 100,
      idleTimeout: 100,
    });

    const discovered = [];
    const inactive = [];
    scanner.on('session:discovered', (data) => discovered.push(data));
    scanner.on('session:inactive', (data) => inactive.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(discovered.length, 1);

    // Wait for the file to go stale
    await new Promise((r) => setTimeout(r, 400));

    assert.ok(inactive.length >= 1, 'Should have emitted session:inactive');
    assert.equal(inactive[0].sessionId, sessionId);
  });

  it('does not re-discover already tracked sessions', async () => {
    const projDir = path.join(projectsDir, '-home-test-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = crypto.randomUUID();
    const filePath = createJsonlFile(projDir, sessionId, '/home/test/project');

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 200));

    // Touch the file to keep it fresh
    fs.appendFileSync(filePath, JSON.stringify({ type: 'progress' }) + '\n');
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(discovered.length, 1, 'Should only discover once');
  });

  it('discovers multiple projects', async () => {
    const proj1 = path.join(projectsDir, '-home-test-project1');
    const proj2 = path.join(projectsDir, '-home-test-project2');
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    createJsonlFile(proj1, crypto.randomUUID(), '/home/test/project1');
    createJsonlFile(proj2, crypto.randomUUID(), '/home/test/project2');

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(discovered.length, 2);
    const cwds = discovered.map((d) => d.cwd).sort();
    assert.deepEqual(cwds, ['/home/test/project1', '/home/test/project2']);
  });

  it('extracts project name from cwd', () => {
    assert.equal(scanner._extractProjectName('/home/user/dev/myproject'), 'dev/myproject');
    assert.equal(scanner._extractProjectName('/opt/app'), 'opt/app');
    assert.equal(scanner._extractProjectName('/project'), 'project');
    assert.equal(scanner._extractProjectName(null), 'unknown');
  });

  it('handles missing projects directory gracefully', async () => {
    scanner.stop();
    scanner = new SessionScanner({
      projectsDir: '/tmp/nonexistent-polpo-test-dir',
      scanInterval: 50,
    });

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(discovered.length, 0);
  });
});
