const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('GooseAgent', () => {
  it('can be constructed with default options', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    assert.equal(agent.cwd, '/tmp');
    assert.equal(agent.gooseBinary, 'goose');
    assert.equal(agent.busy, false);
    assert.equal(agent.gooseSessionId, null);
  });

  it('accepts custom options', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({
      name: 'Test Goose',
      cwd: '/projects/test',
      model: 'anthropic/claude-sonnet-4-20250514',
      gooseBinary: '/usr/local/bin/goose',
      serverUrl: 'ws://localhost:9999',
      token: 'test-token',
    });
    assert.equal(agent.name, 'Test Goose');
    assert.equal(agent.model, 'anthropic/claude-sonnet-4-20250514');
    assert.equal(agent.gooseBinary, '/usr/local/bin/goose');
    assert.equal(agent.serverUrl, 'ws://localhost:9999');
    assert.equal(agent.token, 'test-token');
  });

  it('starts with empty RPC state', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    assert.equal(agent._rpcId, 0);
    assert.equal(agent._pendingRpc.size, 0);
    assert.equal(agent.pendingText, '');
  });

  it('handles JSON-RPC response matching', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });

    // Simulate a pending RPC
    let resolved = null;
    agent._pendingRpc.set(1, {
      resolve: (val) => { resolved = val; },
      reject: () => {},
    });

    agent._handleGooseMessage({ jsonrpc: '2.0', id: 1, result: { sessionId: 'test-123' } });
    assert.deepEqual(resolved, { sessionId: 'test-123' });
    assert.equal(agent._pendingRpc.size, 0);
  });

  it('handles JSON-RPC error response', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });

    let rejected = null;
    agent._pendingRpc.set(2, {
      resolve: () => {},
      reject: (err) => { rejected = err; },
    });

    agent._handleGooseMessage({ jsonrpc: '2.0', id: 2, error: { message: 'Not found' } });
    assert.ok(rejected);
    assert.ok(rejected.message.includes('Not found'));
  });

  it('accumulates agent message chunks', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });

    agent._handleSessionUpdate({
      type: 'agentMessageChunk',
      chunk: { content: 'Hello ' },
    }, {});
    agent._handleSessionUpdate({
      type: 'agentMessageChunk',
      chunk: { content: 'world' },
    }, {});

    assert.equal(agent.pendingText, 'Hello world');
  });

  it('flushes pending text', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    const sent = [];
    agent._sendToHub = function (msg) { sent.push(msg); };

    agent.pendingText = 'test output';
    agent._flushPendingText();

    assert.equal(agent.pendingText, '');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'message');
    assert.equal(sent[0].message.role, 'assistant');
    assert.equal(sent[0].message.content, 'test output');
  });

  it('does not flush empty text', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    const sent = [];
    agent._sendToHub = function (msg) { sent.push(msg); };

    agent._flushPendingText();
    assert.equal(sent.length, 0);
  });

  it('handles tool call notification', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    const sent = [];
    agent._sendToHub = function (msg) { sent.push(msg); };

    agent._handleSessionUpdate({
      type: 'toolCall',
      id: 'tool-1',
      title: 'shell',
      status: 'pending',
    }, {});

    assert.equal(sent.length, 2); // status:busy + tool_use message
    assert.equal(sent[1].message.contentType, 'tool_use');
    const tool = JSON.parse(sent[1].message.content);
    assert.equal(tool.name, 'shell');
  });

  it('handles tool call update (completed)', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    const sent = [];
    agent._sendToHub = function (msg) { sent.push(msg); };

    agent._handleSessionUpdate({
      type: 'toolCallUpdate',
      id: 'tool-1',
      status: 'completed',
      content: [{ type: 'text', text: 'output here' }],
    }, {});

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.contentType, 'tool_result');
    assert.equal(sent[0].message.content, 'output here');
    assert.equal(sent[0].message.isError, false);
  });

  it('handles tool call update (failed)', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    const sent = [];
    agent._sendToHub = function (msg) { sent.push(msg); };

    agent._handleSessionUpdate({
      type: 'toolCallUpdate',
      id: 'tool-2',
      status: 'failed',
      content: [{ type: 'text', text: 'error msg' }],
    }, {});

    assert.equal(sent[0].message.isError, true);
  });

  it('abort cancels session and resets busy', () => {
    const { GooseAgent } = require('../src/agent/goose-agent');
    const agent = new GooseAgent({ cwd: '/tmp' });
    const sent = [];
    agent._sendToHub = function (msg) { sent.push(msg); };
    agent.gooseSessionId = 'sess-1';
    agent.busy = true;

    // Mock goose process
    const written = [];
    agent.goose = {
      stdin: {
        writable: true,
        write: function (data) { written.push(data); },
      },
    };

    agent.abort();
    assert.equal(agent.busy, false);
    // Should have sent cancel notification
    assert.ok(written.length > 0);
    const cancelMsg = JSON.parse(written[0].trim());
    assert.equal(cancelMsg.method, 'session/cancel');
  });
});

describe('AgentFactory goose routing', () => {
  it('creates GooseAgent for type goose', () => {
    const { createAgent } = require('../src/agent/agent-factory');
    const agent = createAgent('goose', { cwd: '/tmp', name: 'Test' });
    assert.equal(agent.constructor.name, 'GooseAgent');
  });
});
