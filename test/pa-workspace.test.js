const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensurePAWorkspace, DEFAULT_CLAUDE_MD } = require('../src/pa/workspace');

describe('PA workspace', () => {
  const testDir = path.join(os.tmpdir(), 'polpo-test-workspace-' + Date.now());

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('creates workspace directory', () => {
    const dir = ensurePAWorkspace(testDir);
    assert.equal(dir, testDir);
    assert.ok(fs.existsSync(testDir));
  });

  it('creates CLAUDE.md with default content', () => {
    ensurePAWorkspace(testDir);
    const claudeMd = path.join(testDir, 'CLAUDE.md');
    assert.ok(fs.existsSync(claudeMd));
    const content = fs.readFileSync(claudeMd, 'utf8');
    assert.ok(content.includes('Personal Assistant'));
    assert.ok(content.includes('Telegram'));
  });

  it('does not overwrite existing CLAUDE.md', () => {
    fs.mkdirSync(testDir, { recursive: true });
    const claudeMd = path.join(testDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, 'custom content');

    ensurePAWorkspace(testDir);
    const content = fs.readFileSync(claudeMd, 'utf8');
    assert.equal(content, 'custom content');
  });

  it('is idempotent', () => {
    ensurePAWorkspace(testDir);
    ensurePAWorkspace(testDir);
    assert.ok(fs.existsSync(path.join(testDir, 'CLAUDE.md')));
  });

  it('DEFAULT_CLAUDE_MD contains key sections', () => {
    assert.ok(DEFAULT_CLAUDE_MD.includes('## Personality'));
    assert.ok(DEFAULT_CLAUDE_MD.includes('## What You Do'));
    assert.ok(DEFAULT_CLAUDE_MD.includes('## Formatting for Telegram'));
    assert.ok(DEFAULT_CLAUDE_MD.includes('## Image Analysis'));
    assert.ok(DEFAULT_CLAUDE_MD.includes('Polpo'));
  });
});
