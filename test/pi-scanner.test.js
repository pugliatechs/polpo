const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PiScanner } = require('../src/server/pi-scanner');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scanner-'));
}

describe('PiScanner', () => {
  let tmpDir;
  let scanner;

  afterEach(() => {
    if (scanner) scanner.stop();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  describe('_slugToCwd', () => {
    it('converts Pi slug to cwd path', () => {
      const s = new PiScanner();
      assert.equal(s._slugToCwd('--home-user-project--'), '/home/user/project');
      scanner = s; // for cleanup
    });

    it('handles empty slug', () => {
      const s = new PiScanner();
      assert.equal(s._slugToCwd(''), process.cwd());
      scanner = s;
    });

    it('handles slug with only delimiters', () => {
      const s = new PiScanner();
      assert.equal(s._slugToCwd('----'), process.cwd());
      scanner = s;
    });

    it('handles null slug', () => {
      const s = new PiScanner();
      assert.equal(s._slugToCwd(null), process.cwd());
      scanner = s;
    });
  });

  describe('session discovery', () => {
    it('discovers a new JSONL file', (t, done) => {
      tmpDir = mkTmpDir();
      const projectDir = path.join(tmpDir, '--tmp-myproject--');
      fs.mkdirSync(projectDir, { recursive: true });

      scanner = new PiScanner({
        sessionsDir: tmpDir,
        idleCheckInterval: 60000,
      });

      scanner.on('session:discovered', (data) => {
        assert.equal(data.agentType, 'pi');
        assert.ok(data.sessionId.includes('abc123'));
        assert.equal(data.cwd, '/tmp/myproject');
        assert.equal(data.firstPrompt, 'Hello Pi');
        done();
      });

      scanner.start();

      // Write a Pi JSONL session file
      const sessionFile = path.join(projectDir, '20260227_abc123.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 'ses-1', cwd: '/tmp/myproject' }),
        JSON.stringify({ type: 'message', role: 'user', id: 'msg-1', content: [{ type: 'text', text: 'Hello Pi' }] }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n');
    });

    it('marks session inactive after timeout', (t, done) => {
      tmpDir = mkTmpDir();
      const projectDir = path.join(tmpDir, '--tmp-project--');
      fs.mkdirSync(projectDir, { recursive: true });

      // Write file first
      const sessionFile = path.join(projectDir, '20260227_def456.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'ses-2', cwd: '/tmp/project' }) + '\n');

      scanner = new PiScanner({
        sessionsDir: tmpDir,
        idleCheckInterval: 50,
        idleTimeout: 100,
      });

      scanner.on('session:discovered', () => {
        // Wait for idle timeout
      });

      scanner.on('session:inactive', (data) => {
        assert.ok(data.sessionId.includes('def456'));
        done();
      });

      scanner.start();
    });

    it('does not duplicate already-tracked sessions', () => {
      tmpDir = mkTmpDir();
      const projectDir = path.join(tmpDir, '--tmp-project--');
      fs.mkdirSync(projectDir, { recursive: true });

      const sessionFile = path.join(projectDir, '20260227_ghi789.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'ses-3' }) + '\n');

      scanner = new PiScanner({
        sessionsDir: tmpDir,
        idleCheckInterval: 60000,
      });

      let count = 0;
      scanner.on('session:discovered', () => count++);

      scanner.start();
      // Trigger a second scan
      scanner._scanProjectDir(projectDir, '--tmp-project--');

      assert.equal(count, 1);
    });
  });

  describe('_readSessionInfo', () => {
    it('extracts cwd and firstPrompt from Pi JSONL', () => {
      tmpDir = mkTmpDir();
      const file = path.join(tmpDir, 'test.jsonl');
      const lines = [
        JSON.stringify({ type: 'session', id: 'ses-1', cwd: '/home/user/code' }),
        JSON.stringify({ type: 'message', role: 'user', id: 'msg-1', content: [{ type: 'text', text: 'Fix the bug in auth.js' }] }),
        JSON.stringify({ type: 'message', role: 'assistant', id: 'msg-2', content: [{ type: 'text', text: 'I will fix it.' }] }),
      ];
      fs.writeFileSync(file, lines.join('\n') + '\n');

      scanner = new PiScanner({ sessionsDir: tmpDir });
      const info = scanner._readSessionInfo(file);
      assert.equal(info.cwd, '/home/user/code');
      assert.equal(info.firstPrompt, 'Fix the bug in auth.js');
    });

    it('returns empty for non-existent file', () => {
      scanner = new PiScanner({ sessionsDir: '/nonexistent' });
      const info = scanner._readSessionInfo('/nonexistent/file.jsonl');
      assert.deepEqual(info, {});
    });
  });

  describe('handles missing sessions directory', () => {
    it('starts without error when dir does not exist', () => {
      scanner = new PiScanner({
        sessionsDir: '/tmp/polpo-test-nonexistent-' + Date.now(),
      });
      // Should not throw
      scanner.start();
      scanner.stop();
    });
  });

  describe('has()', () => {
    it('returns false for unknown sessions', () => {
      scanner = new PiScanner({ sessionsDir: '/tmp' });
      assert.equal(scanner.has('unknown-session'), false);
    });
  });
});
