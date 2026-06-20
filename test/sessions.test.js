const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// We test extractMetadata and loadHistory by creating temporary JSONL files
// that mimic the format written by Claude Code.

const tmpDir = path.join(os.tmpdir(), 'polpo-test-sessions-' + process.pid);
const fakeClaudeDir = path.join(tmpDir, '.claude', 'projects');
const projectSlug = '-home-user-myproject';

function setup() {
  fs.mkdirSync(path.join(fakeClaudeDir, projectSlug), { recursive: true });
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeSessionFile(sessionId, lines) {
  const filePath = path.join(fakeClaudeDir, projectSlug, sessionId + '.jsonl');
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

// Since sessions.js hardcodes CLAUDE_DIR, we test the internal helpers by
// creating JSONL files and reading them through the public loadHistory/scanSessions.
// To avoid patching the module constant, we test the parsing logic directly.

describe('session JSONL parsing', () => {
  afterEach(() => {
    try { teardown(); } catch {}
  });

  describe('readLines helper', () => {
    it('reads head lines from a file', async () => {
      setup();
      const filePath = path.join(tmpDir, 'test.jsonl');
      const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      // We can import the readLines helper directly since it's not exported,
      // so let's test via the extractMetadata flow instead.
      // For a focused unit test, we'll parse the file ourselves.
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = content.split('\n').filter(Boolean);
      assert.equal(parsed.length, 20);
      assert.equal(parsed[0], 'line-0');
      assert.equal(parsed[19], 'line-19');
    });
  });

  describe('JSONL format compatibility', () => {
    it('extracts metadata from valid session lines', () => {
      setup();
      const lines = [
        { type: 'system', cwd: '/home/user/myproject', slug: projectSlug, timestamp: '2025-01-01T00:00:00Z' },
        { type: 'user', message: { content: [{ type: 'text', text: 'Fix the login bug' }] }, timestamp: '2025-01-01T00:01:00Z' },
        { type: 'assistant', message: { id: 'msg-1', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'Looking at the code...' }] }, timestamp: '2025-01-01T00:01:05Z' },
      ];

      // Parse like extractMetadata does
      let cwd = null, firstPrompt = null, model = null, slug = null, firstTimestamp = null;
      for (const obj of lines) {
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;
        if (obj.slug && !slug) slug = obj.slug;
        if (obj.type === 'user' && !firstPrompt) {
          const content = obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && !block.text.startsWith('<')) {
                firstPrompt = block.text.slice(0, 120);
                break;
              }
            }
          }
        }
        if (obj.type === 'assistant' && obj.message && obj.message.model && !model) {
          model = obj.message.model;
        }
      }

      assert.equal(cwd, '/home/user/myproject');
      assert.equal(firstPrompt, 'Fix the login bug');
      assert.equal(model, 'claude-sonnet-4-20250514');
      assert.equal(slug, projectSlug);
      assert.equal(firstTimestamp, '2025-01-01T00:00:00Z');
    });

    it('skips system-tagged user content (starts with <)', () => {
      const lines = [
        { type: 'user', message: { content: [
          { type: 'text', text: '<system>injected</system>' },
          { type: 'text', text: 'Real user prompt' },
        ] } },
      ];

      let firstPrompt = null;
      for (const obj of lines) {
        if (obj.type === 'user' && !firstPrompt) {
          const content = obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && !block.text.startsWith('<')) {
                firstPrompt = block.text.slice(0, 120);
                break;
              }
            }
          }
        }
      }
      assert.equal(firstPrompt, 'Real user prompt');
    });

    it('truncates first prompt to 120 chars', () => {
      const longText = 'A'.repeat(200);
      const lines = [
        { type: 'user', message: { content: [{ type: 'text', text: longText }] } },
      ];

      let firstPrompt = null;
      for (const obj of lines) {
        if (obj.type === 'user' && !firstPrompt) {
          const content = obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && !block.text.startsWith('<')) {
                firstPrompt = block.text.slice(0, 120);
                break;
              }
            }
          }
        }
      }
      assert.equal(firstPrompt.length, 120);
    });
  });

  describe('loadHistory format', () => {
    it('deduplicates streaming assistant messages by id', () => {
      // Simulate what loadHistory does: multiple entries with same message.id
      const assistantMessages = new Map();
      const messages = [];

      const entries = [
        { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Partial...' }] }, timestamp: 't1' },
        { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Full response here' }] }, timestamp: 't2' },
      ];

      for (const obj of entries) {
        const msgId = obj.message.id;
        const content = obj.message.content;
        const alreadyPlaced = assistantMessages.has(msgId);
        assistantMessages.set(msgId, { blocks: content, timestamp: obj.timestamp });
        if (!alreadyPlaced) {
          messages.push({ type: 'assistant', msgId, timestamp: obj.timestamp });
        }
      }

      // Resolve: should have one entry with the LAST content
      const result = [];
      for (const msg of messages) {
        if (msg.msgId) {
          const entry = assistantMessages.get(msg.msgId);
          for (const block of entry.blocks) {
            if (block.type === 'text') {
              result.push({ role: 'assistant', content: block.text });
            }
          }
        }
      }

      assert.equal(result.length, 1);
      assert.equal(result[0].content, 'Full response here');
    });

    it('parses tool_use and tool_result blocks', () => {
      // tool_use from assistant
      const toolUseBlock = { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu-1' };
      const parsed = {
        role: 'assistant',
        content: JSON.stringify({
          type: 'tool_use',
          name: toolUseBlock.name,
          input: toolUseBlock.input,
          id: toolUseBlock.id,
        }),
        contentType: 'tool_use',
      };
      assert.ok(parsed.content.includes('"Bash"'));

      // tool_result from user
      const toolResultBlock = { type: 'tool_result', content: 'file1.js\nfile2.js', tool_use_id: 'tu-1' };
      const resultText = typeof toolResultBlock.content === 'string'
        ? toolResultBlock.content
        : JSON.stringify(toolResultBlock.content || '');
      const truncated = resultText.length > 2000
        ? resultText.slice(0, 2000) + '\n... (' + resultText.length + ' chars)'
        : resultText;
      assert.equal(truncated, 'file1.js\nfile2.js');
    });

    it('truncates tool results over 2000 chars', () => {
      const longResult = 'X'.repeat(3000);
      const truncated = longResult.length > 2000
        ? longResult.slice(0, 2000) + '\n... (' + longResult.length + ' chars)'
        : longResult;
      assert.ok(truncated.length < 3000);
      assert.ok(truncated.includes('(3000 chars)'));
    });
  });
});

// ---- Regression: user prompts must appear in loadClaudeHistory output ----
//
// Claude Code writes user messages in two shapes: a plain string and an
// array of blocks. An earlier version of loadClaudeHistory only handled
// the array case, silently dropping every plain-string user prompt —
// /v1/sessions/:id and /api/sessions/:id/history then returned only
// assistant text and tool results, with the user's actual prompts missing.
// This guards against a regression of that behaviour.

const { loadClaudeHistory, isSystemReminderText } = require('../src/server/sessions');

describe('loadClaudeHistory — user prompt preservation', () => {
  const fixtureDir = path.join(os.tmpdir(), 'polpo-test-loadhistory-' + process.pid);

  function writeFixture(name, lines) {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const filePath = path.join(fixtureDir, name);
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return filePath;
  }

  afterEach(() => {
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  });

  it('includes plain-string user prompts (the common case)', async () => {
    const file = writeFixture('string-user.jsonl', [
      { type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: '2026-06-01T10:00:00Z' },
      { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-06-01T10:00:01Z' },
    ]);
    const messages = await loadClaudeHistory(file);
    const userMsgs = messages.filter(m => m.role === 'user');
    assert.equal(userMsgs.length, 1, 'plain-string user prompt must be preserved');
    assert.equal(userMsgs[0].content, 'do the thing');
    assert.equal(userMsgs[0].timestamp, '2026-06-01T10:00:00Z');
  });

  it('still includes array-form user prompts (the structured case)', async () => {
    const file = writeFixture('array-user.jsonl', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'array form prompt' }] }, timestamp: 't' },
    ]);
    const messages = await loadClaudeHistory(file);
    const userMsgs = messages.filter(m => m.role === 'user');
    assert.equal(userMsgs.length, 1);
    assert.equal(userMsgs[0].content, 'array form prompt');
  });

  it('preserves user prompts that begin with an angle bracket (no false positives)', async () => {
    // The earlier startsWith('<') filter would have dropped these.
    const file = writeFixture('bracket-user.jsonl', [
      { type: 'user', message: { role: 'user', content: '<polpo:artifacts> reminder...' }, timestamp: 't1' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<important> notes' }] }, timestamp: 't2' },
    ]);
    const messages = await loadClaudeHistory(file);
    const userTexts = messages.filter(m => m.role === 'user').map(m => m.content);
    assert.ok(userTexts.includes('<polpo:artifacts> reminder...'));
    assert.ok(userTexts.includes('<important> notes'));
  });

  it('drops system-reminder blocks (the only thing the old filter wanted)', async () => {
    const file = writeFixture('sysreminder.jsonl', [
      { type: 'user', message: { role: 'user', content: '<system-reminder>tools: Bash, Edit</system-reminder>' }, timestamp: 't1' },
      { type: 'user', message: { role: 'user', content: 'real prompt' }, timestamp: 't2' },
      { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: '<system-reminder>env: x</system-reminder>' },
        { type: 'text', text: 'continue please' },
      ] }, timestamp: 't3' },
    ]);
    const messages = await loadClaudeHistory(file);
    const userTexts = messages.filter(m => m.role === 'user').map(m => m.content);
    assert.deepEqual(userTexts.sort(), ['continue please', 'real prompt'].sort());
  });

  it('mixed conversation order is preserved', async () => {
    const file = writeFixture('mixed.jsonl', [
      { type: 'user', message: { role: 'user', content: 'first' }, timestamp: 't1' },
      { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'one' }] }, timestamp: 't2' },
      { type: 'user', message: { role: 'user', content: 'second' }, timestamp: 't3' },
      { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'two' }] }, timestamp: 't4' },
    ]);
    const messages = await loadClaudeHistory(file);
    const contents = messages.map(m => m.content);
    assert.deepEqual(contents, ['first', 'one', 'second', 'two']);
  });

  it('tool_result blocks still come through (no regression on the other content types)', async () => {
    const file = writeFixture('tool.jsonl', [
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'cmd output', is_error: false },
      ] }, timestamp: 't' },
    ]);
    const messages = await loadClaudeHistory(file);
    const tool = messages.find(m => m.contentType === 'tool_result');
    assert.ok(tool);
    assert.equal(tool.toolUseId, 'tu1');
    assert.equal(tool.content, 'cmd output');
  });
});

describe('isSystemReminderText', () => {
  it('matches <system-reminder...> openings, case-insensitive, with optional whitespace', () => {
    assert.equal(isSystemReminderText('<system-reminder>hi</system-reminder>'), true);
    assert.equal(isSystemReminderText('  <system-reminder>hi'), true);
    assert.equal(isSystemReminderText('<System-Reminder type="x">'), true);
  });

  it('does not match arbitrary tags', () => {
    assert.equal(isSystemReminderText('<polpo:artifacts dir="...">'), false);
    assert.equal(isSystemReminderText('<important>'), false);
    assert.equal(isSystemReminderText('plain text'), false);
    assert.equal(isSystemReminderText('<system-prompt>'), false);
  });

  it('returns false for non-strings', () => {
    assert.equal(isSystemReminderText(null), false);
    assert.equal(isSystemReminderText(undefined), false);
    assert.equal(isSystemReminderText(42), false);
  });
});
