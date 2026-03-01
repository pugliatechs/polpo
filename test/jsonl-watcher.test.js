const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { JsonlWatcher } = require('../src/server/jsonl-watcher');

// Helper: create a unique temp file path
function tmpFile() {
  return path.join(os.tmpdir(), `polpo-test-${crypto.randomUUID()}.jsonl`);
}

// Helper: build a JSONL user message line
function userLine(text, uuid) {
  return JSON.stringify({
    type: 'user',
    uuid: uuid || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

// Helper: build a JSONL assistant message line
function assistantLine(text, msgId, uuid) {
  return JSON.stringify({
    type: 'assistant',
    uuid: uuid || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: msgId || `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

// Helper: build a JSONL tool_use line
function toolUseLine(name, input, msgId, uuid) {
  return JSON.stringify({
    type: 'assistant',
    uuid: uuid || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: msgId || `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: [{ type: 'tool_use', name, input, id: `toolu_${crypto.randomUUID()}` }],
    },
  });
}

// Helper: build a non-conversation line (queue-operation)
function queueLine() {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: new Date().toISOString(),
    content: [{ type: 'text', text: 'test' }],
  });
}

// Helper: build a tool_result line
function toolResultLine(toolUseId, content, uuid) {
  return JSON.stringify({
    type: 'user',
    uuid: uuid || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
    },
  });
}

// Helper: wait for a specific number of events or timeout
function collectMessages(watcher, count, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const msgs = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    watcher.on('message', (msg) => {
      msgs.push(msg);
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

// Helper: wait ms
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('JsonlWatcher', () => {
  let filePath;
  let watcher;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    if (watcher) watcher.close();
    try { fs.unlinkSync(filePath); } catch {}
  });

  it('emits user messages from appended lines', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1);
    await watcher.start({ catchUp: false });

    // Append a user message
    fs.appendFileSync(filePath, userLine('Hello from terminal') + '\n');
    const msgs = await collected;

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'Hello from terminal');
    assert.equal(msgs[0].source, 'jsonl');
  });

  it('emits assistant text messages', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1);
    await watcher.start({ catchUp: false });

    fs.appendFileSync(filePath, assistantLine('Here is the answer') + '\n');
    const msgs = await collected;

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[0].content, 'Here is the answer');
    assert.equal(msgs[0].contentType, 'text');
  });

  it('emits assistant tool_use messages', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1);
    await watcher.start({ catchUp: false });

    fs.appendFileSync(filePath, toolUseLine('Bash', { command: 'ls' }) + '\n');
    const msgs = await collected;

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[0].contentType, 'tool_use');
    const parsed = JSON.parse(msgs[0].content);
    assert.equal(parsed.name, 'Bash');
  });

  it('emits tool_result messages', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1);
    await watcher.start({ catchUp: false });

    fs.appendFileSync(filePath, toolResultLine('toolu_123', 'file1.txt\nfile2.txt') + '\n');
    const msgs = await collected;

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'tool');
    assert.equal(msgs[0].contentType, 'tool_result');
    assert.equal(msgs[0].content, 'file1.txt\nfile2.txt');
  });

  it('deduplicates by uuid', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 2, 500);
    await watcher.start({ catchUp: false });

    const uuid = crypto.randomUUID();
    fs.appendFileSync(filePath, userLine('First', uuid) + '\n');
    fs.appendFileSync(filePath, userLine('First duplicate', uuid) + '\n');
    fs.appendFileSync(filePath, userLine('Second') + '\n');

    const msgs = await collected;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'First');
    assert.equal(msgs[1].content, 'Second');
  });

  it('emits all incremental blocks for same message.id', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const messages = [];
    watcher.on('message', (m) => messages.push(m));

    await watcher.start({ catchUp: false });

    // Simulate incremental JSONL entries: each entry has a new text block
    const msgId = 'msg_streaming_test';
    const uuid1 = crypto.randomUUID();
    const uuid2 = crypto.randomUUID();
    fs.appendFileSync(filePath, assistantLine('First block', msgId, uuid1) + '\n');
    await wait(150);
    fs.appendFileSync(filePath, assistantLine('Second block', msgId, uuid2) + '\n');
    await wait(150);

    // Both text blocks should be emitted (incremental, not cumulative)
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'First block');
    assert.equal(messages[1].content, 'Second block');
  });

  it('skips non-conversation types', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1, 500);
    await watcher.start({ catchUp: false });

    // Write a queue-operation (should be skipped)
    fs.appendFileSync(filePath, queueLine() + '\n');
    // Write a progress event (should be skipped)
    fs.appendFileSync(filePath, JSON.stringify({ type: 'progress', data: {} }) + '\n');
    // Write a file-history-snapshot (should be skipped)
    fs.appendFileSync(filePath, JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }) + '\n');
    // Write an actual user message
    fs.appendFileSync(filePath, userLine('Real message') + '\n');

    const msgs = await collected;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'Real message');
  });

  it('skips user text starting with <', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1, 500);
    await watcher.start({ catchUp: false });

    // System reminder text (starts with <)
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>...</system-reminder>' }] },
    }) + '\n');
    // Real user message
    fs.appendFileSync(filePath, userLine('Actual prompt') + '\n');

    const msgs = await collected;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'Actual prompt');
  });

  it('catches up on existing content when catchUp=true', async () => {
    // Write some content before starting the watcher
    fs.writeFileSync(filePath,
      userLine('Existing message 1') + '\n' +
      assistantLine('Existing reply') + '\n'
    );

    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });
    const collected = collectMessages(watcher, 2);
    await watcher.start({ catchUp: true });

    const msgs = await collected;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'Existing message 1');
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'Existing reply');
  });

  it('skips existing content when catchUp=false', async () => {
    fs.writeFileSync(filePath, userLine('Old message') + '\n');

    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });
    const collected = collectMessages(watcher, 1, 500);
    await watcher.start({ catchUp: false });

    // Only new content should be emitted
    fs.appendFileSync(filePath, userLine('New message') + '\n');
    const msgs = await collected;

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'New message');
  });

  it('handles file that does not exist yet', async () => {
    // Don't create the file
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });
    const collected = collectMessages(watcher, 1, 3000);
    await watcher.start({ catchUp: false });

    // Create the file and write to it after a delay
    await wait(100);
    fs.writeFileSync(filePath, userLine('Created later') + '\n');

    const msgs = await collected;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'Created later');
  });

  it('handles multiple messages in a single write', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 3);
    await watcher.start({ catchUp: false });

    // Write multiple lines at once
    fs.appendFileSync(filePath,
      userLine('Message 1') + '\n' +
      assistantLine('Reply 1') + '\n' +
      userLine('Message 2') + '\n'
    );

    const msgs = await collected;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].content, 'Message 1');
    assert.equal(msgs[1].content, 'Reply 1');
    assert.equal(msgs[2].content, 'Message 2');
  });

  it('close() stops emitting', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    let count = 0;
    watcher.on('message', () => count++);
    await watcher.start({ catchUp: false });

    fs.appendFileSync(filePath, userLine('Before close') + '\n');
    await wait(150);
    assert.equal(count, 1);

    watcher.close();

    fs.appendFileSync(filePath, userLine('After close') + '\n');
    await wait(150);
    assert.equal(count, 1); // No new messages
  });

  it('truncates long tool results', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const collected = collectMessages(watcher, 1);
    await watcher.start({ catchUp: false });

    const longContent = 'x'.repeat(3000);
    fs.appendFileSync(filePath, toolResultLine('toolu_456', longContent) + '\n');
    const msgs = await collected;

    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].content.length < 3000);
    assert.ok(msgs[0].content.includes('...'));
  });

  it('emits busy status on user text message', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const statuses = [];
    watcher.on('status', (s) => statuses.push(s));
    await watcher.start({ catchUp: false });

    fs.appendFileSync(filePath, userLine('Hello') + '\n');
    await wait(200);

    assert.ok(statuses.includes('busy'), 'Should emit busy on user text');
  });

  it('emits idle status on assistant with stop_reason', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const statuses = [];
    watcher.on('status', (s) => statuses.push(s));
    await watcher.start({ catchUp: false });

    // Write an assistant message with stop_reason
    const line = JSON.stringify({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: `msg_${crypto.randomUUID()}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done!' }],
        stop_reason: 'end_turn',
      },
    });
    fs.appendFileSync(filePath, line + '\n');
    await wait(200);

    assert.ok(statuses.includes('idle'), 'Should emit idle on stop_reason');
  });

  it('does not emit idle for assistant with stop_reason tool_use', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const statuses = [];
    watcher.on('status', (s) => statuses.push(s));
    await watcher.start({ catchUp: false });

    // Write an assistant message with stop_reason: tool_use (agent calling a tool)
    const line = JSON.stringify({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: `msg_${crypto.randomUUID()}`,
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { path: '/tmp/test' }, id: `toolu_${crypto.randomUUID()}` }],
        stop_reason: 'tool_use',
      },
    });
    fs.appendFileSync(filePath, line + '\n');
    await wait(200);

    const idleStatuses = statuses.filter((s) => s === 'idle');
    assert.equal(idleStatuses.length, 0, 'Should not emit idle for stop_reason tool_use');
  });

  it('emits busy status on tool_result', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const statuses = [];
    watcher.on('status', (s) => statuses.push(s));
    await watcher.start({ catchUp: false });

    fs.appendFileSync(filePath, toolResultLine('toolu_123', 'file contents here') + '\n');
    await wait(200);

    assert.ok(statuses.includes('busy'), 'Should emit busy on tool_result');
  });

  it('does not emit idle for assistant with null stop_reason', async () => {
    fs.writeFileSync(filePath, '');
    watcher = new JsonlWatcher(filePath, { debounceMs: 20 });

    const statuses = [];
    watcher.on('status', (s) => statuses.push(s));
    await watcher.start({ catchUp: false });

    // Normal assistant line (streaming, no stop_reason)
    fs.appendFileSync(filePath, assistantLine('thinking...') + '\n');
    await wait(200);

    const idleStatuses = statuses.filter((s) => s === 'idle');
    assert.equal(idleStatuses.length, 0, 'Should not emit idle for null stop_reason');
  });
});
