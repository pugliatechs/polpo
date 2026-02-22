const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { CodexScanner } = require('../src/server/codex-scanner');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `polpo-codex-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createCodexJsonl(dir, sessionId, opts = {}) {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const lines = [];
  lines.push(JSON.stringify({
    type: 'thread.started',
    thread_id: sessionId,
    cwd: opts.cwd || '/home/test/codex-project',
  }));
  if (opts.firstMessage) {
    lines.push(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: opts.firstMessage },
    }));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe('CodexScanner', () => {
  let sessionsDir;
  let scanner;

  beforeEach(() => {
    sessionsDir = tmpDir();
    scanner = new CodexScanner({
      sessionsDir,
      idleCheckInterval: 100,
      idleTimeout: 5000,
    });
  });

  afterEach(() => {
    if (scanner) scanner.stop();
    cleanup(sessionsDir);
  });

  it('discovers existing JSONL sessions on start', async () => {
    const sessionId = crypto.randomUUID();
    createCodexJsonl(sessionsDir, sessionId, { firstMessage: 'Hello world' });

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    // Give fs.watch time
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(discovered.length >= 1, 'Should discover at least one session');
    const d = discovered[0];
    assert.equal(d.sessionId, sessionId);
    assert.equal(d.agentType, 'codex');
    assert.equal(d.cwd, '/home/test/codex-project');
    assert.equal(d.firstPrompt, 'Hello world');
  });

  it('discovers new JSONL file created after start', async () => {
    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 100));

    // Create a new session file
    const sessionId = crypto.randomUUID();
    createCodexJsonl(sessionsDir, sessionId, { cwd: '/tmp/new' });

    await new Promise((r) => setTimeout(r, 500));

    assert.ok(discovered.length >= 1, 'Should discover the new session');
    assert.equal(discovered[discovered.length - 1].sessionId, sessionId);
    assert.equal(discovered[discovered.length - 1].agentType, 'codex');
  });

  it('does not duplicate discovered sessions', async () => {
    const sessionId = crypto.randomUUID();
    createCodexJsonl(sessionsDir, sessionId);

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 200));

    // Append to the file (simulating activity)
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify({ type: 'turn.started' }) + '\n');

    await new Promise((r) => setTimeout(r, 300));

    assert.equal(discovered.length, 1, 'Should only discover once');
  });

  it('emits session:inactive for stale sessions', async () => {
    // Use a scanner with short idle timeout for this test
    scanner.stop();
    scanner = new CodexScanner({
      sessionsDir,
      idleCheckInterval: 100,
      idleTimeout: 200,
    });

    const sessionId = crypto.randomUUID();
    createCodexJsonl(sessionsDir, sessionId);

    const inactive = [];
    scanner.on('session:inactive', (data) => inactive.push(data));
    scanner.on('session:discovered', () => {});

    scanner.start();
    await new Promise((r) => setTimeout(r, 200));

    // Wait for idle timeout (200ms) + idle check interval (100ms)
    await new Promise((r) => setTimeout(r, 500));

    assert.ok(inactive.length >= 1, 'Should emit inactive');
    assert.equal(inactive[0].sessionId, sessionId);
  });

  it('ignores non-JSONL files', async () => {
    fs.writeFileSync(path.join(sessionsDir, 'readme.txt'), 'not a session');

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(discovered.length, 0);
  });

  it('tracks sessions via has()', async () => {
    const sessionId = crypto.randomUUID();
    createCodexJsonl(sessionsDir, sessionId);

    scanner.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(scanner.has(sessionId));
    assert.ok(!scanner.has('nonexistent'));
  });

  it('handles sessions dir not existing initially', async () => {
    const missingDir = path.join(os.tmpdir(), `polpo-missing-${crypto.randomUUID()}`);
    const s = new CodexScanner({
      sessionsDir: missingDir,
      idleCheckInterval: 100,
      idleTimeout: 200,
    });

    // Should not throw
    s.start();
    await new Promise((r) => setTimeout(r, 100));
    s.stop();
  });

  it('stop() cleans up watchers', () => {
    scanner.start();
    scanner.stop();
    assert.equal(scanner.closed, true);
    assert.equal(scanner.watchers.size, 0);
    assert.equal(scanner.idleTimer, null);
  });

  it('discovers sessions in nested YYYY/MM/DD subdirectories', async () => {
    // Simulate VS Code extension structure: sessions/2026/02/21/rollout-abc.jsonl
    const nestedDir = path.join(sessionsDir, '2026', '02', '21');
    fs.mkdirSync(nestedDir, { recursive: true });

    const sessionId = 'rollout-' + crypto.randomUUID();
    createCodexJsonl(nestedDir, sessionId, { cwd: '/home/test/vscode-project', firstMessage: 'Nested session' });

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 500));

    assert.ok(discovered.length >= 1, 'Should discover nested session');
    assert.equal(discovered[0].sessionId, sessionId);
    assert.equal(discovered[0].cwd, '/home/test/vscode-project');
    assert.equal(discovered[0].firstPrompt, 'Nested session');
  });

  it('discovers new subdirectory created after start', async () => {
    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create nested dir after scanner is running
    const nestedDir = path.join(sessionsDir, '2026', '02', '22');
    fs.mkdirSync(nestedDir, { recursive: true });
    await new Promise((r) => setTimeout(r, 200));

    const sessionId = 'rollout-' + crypto.randomUUID();
    createCodexJsonl(nestedDir, sessionId, { cwd: '/tmp/dynamic' });
    await new Promise((r) => setTimeout(r, 500));

    assert.ok(discovered.some(d => d.sessionId === sessionId), 'Should discover session in dynamically created subdir');
  });

  it('reads cwd from thread.started event', async () => {
    const sessionId = crypto.randomUUID();
    createCodexJsonl(sessionsDir, sessionId, { cwd: '/custom/cwd' });

    const discovered = [];
    scanner.on('session:discovered', (data) => discovered.push(data));

    scanner.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(discovered[0].cwd, '/custom/cwd');
  });
});
