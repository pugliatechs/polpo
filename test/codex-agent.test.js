const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CodexAgent } = require('../src/agent/codex-agent');

describe('CodexAgent', () => {
  describe('constructor', () => {
    it('sets defaults', () => {
      const agent = new CodexAgent({ cwd: '/tmp/project' });
      assert.equal(agent.cwd, '/tmp/project');
      assert.equal(agent.codexBinary, 'codex');
      assert.equal(agent.permissionMode, 'default');
      assert.equal(agent.busy, false);
      assert.equal(agent.threadId, null);
      assert.match(agent.name, /Codex/);
    });

    it('accepts custom options', () => {
      const agent = new CodexAgent({
        name: 'My Codex',
        cwd: '/home/user/app',
        model: 'gpt-5-codex',
        permissionMode: 'bypass',
        resumeSessionId: 'thread-abc-123',
        serverUrl: 'ws://localhost:9999',
        token: 'secret',
      });
      assert.equal(agent.name, 'My Codex');
      assert.equal(agent.model, 'gpt-5-codex');
      assert.equal(agent.permissionMode, 'bypass');
      assert.equal(agent.resumeSessionId, 'thread-abc-123');
      assert.equal(agent.serverUrl, 'ws://localhost:9999');
      assert.equal(agent.token, 'secret');
    });
  });

  describe('_handleCodexEvent', () => {
    let agent;
    let hubMessages;

    beforeEach(() => {
      agent = new CodexAgent({ cwd: '/tmp' });
      hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
    });

    it('handles thread.started', () => {
      agent._handleCodexEvent({
        type: 'thread.started',
        thread_id: 'thread-abc-123',
      });
      assert.equal(agent.threadId, 'thread-abc-123');
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].type, 'message');
      assert.equal(hubMessages[0].message.role, 'system');
      assert.equal(hubMessages[0].message.contentType, 'json');
      const content = JSON.parse(hubMessages[0].message.content);
      assert.equal(content.subtype, 'init');
      assert.equal(content.session_id, 'thread-abc-123');
      assert.equal(content.agent, 'codex');
    });

    it('handles turn.started', () => {
      agent._handleCodexEvent({ type: 'turn.started' });
      assert.equal(agent.busy, true);
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].type, 'status');
      assert.equal(hubMessages[0].status, 'busy');
    });

    it('handles item.started with command_execution', () => {
      agent._handleCodexEvent({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'ls -la' },
      });
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.contentType, 'tool_use');
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'Bash');
      assert.equal(tool.input.command, 'ls -la');
    });

    it('handles item.started with file_change (create)', () => {
      agent._handleCodexEvent({
        type: 'item.started',
        item: { id: 'item_2', type: 'file_change', action: 'create', file: 'src/new.js' },
      });
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'Write');
      assert.equal(tool.input.file_path, 'src/new.js');
    });

    it('handles item.started with file_change (edit)', () => {
      agent._handleCodexEvent({
        type: 'item.started',
        item: { id: 'item_3', type: 'file_change', action: 'edit', file: 'src/old.js' },
      });
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'Edit');
    });

    it('handles item.completed with agent_message', () => {
      agent._handleCodexEvent({
        type: 'item.completed',
        item: { id: 'item_4', type: 'agent_message', text: 'Hello from Codex' },
      });
      assert.equal(hubMessages[0].message.role, 'assistant');
      assert.equal(hubMessages[0].message.content, 'Hello from Codex');
      assert.equal(hubMessages[0].message.contentType, 'text');
    });

    it('handles item.completed with command_execution', () => {
      agent._handleCodexEvent({
        type: 'item.completed',
        item: { id: 'item_5', type: 'command_execution', output: 'file1.js\nfile2.js', exit_code: 0 },
      });
      assert.equal(hubMessages[0].message.role, 'tool');
      assert.equal(hubMessages[0].message.contentType, 'tool_result');
      assert.equal(hubMessages[0].message.isError, false);
    });

    it('marks command errors', () => {
      agent._handleCodexEvent({
        type: 'item.completed',
        item: { id: 'item_6', type: 'command_execution', output: 'error!', exit_code: 1 },
      });
      assert.equal(hubMessages[0].message.isError, true);
    });

    it('truncates long output', () => {
      const longOutput = 'x'.repeat(3000);
      agent._handleCodexEvent({
        type: 'item.completed',
        item: { id: 'item_7', type: 'command_execution', output: longOutput, exit_code: 0 },
      });
      assert.ok(hubMessages[0].message.content.length < 3000);
      assert.ok(hubMessages[0].message.content.includes('3000 chars'));
    });

    it('handles turn.completed', () => {
      agent.busy = true;
      agent._handleCodexEvent({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      assert.equal(agent.busy, false);
      // Should emit status idle + turn_complete message
      assert.equal(hubMessages.length, 2);
      assert.equal(hubMessages[0].type, 'status');
      assert.equal(hubMessages[0].status, 'idle');
      assert.equal(hubMessages[1].message.contentType, 'turn_complete');
    });

    it('handles turn.failed', () => {
      agent.busy = true;
      agent._handleCodexEvent({
        type: 'turn.failed',
        error: 'Rate limit exceeded',
      });
      assert.equal(agent.busy, false);
      assert.equal(hubMessages[0].status, 'idle');
      assert.ok(hubMessages[1].message.content.includes('Rate limit exceeded'));
    });

    it('handles error event', () => {
      agent._handleCodexEvent({
        type: 'error',
        message: 'Something went wrong',
      });
      assert.ok(hubMessages[0].content.includes('Something went wrong'));
    });

    it('skips reasoning items', () => {
      agent._handleCodexEvent({
        type: 'item.started',
        item: { id: 'item_r', type: 'reasoning' },
      });
      assert.equal(hubMessages.length, 0);
    });

    it('handles item.started with mcp_tool_call', () => {
      agent._handleCodexEvent({
        type: 'item.started',
        item: { id: 'item_mcp', type: 'mcp_tool_call', tool_name: 'my_tool', arguments: { key: 'val' } },
      });
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'my_tool');
      assert.deepEqual(tool.input, { key: 'val' });
    });
  });

  describe('_handleHubMessage', () => {
    it('calls sendPrompt on prompt message', () => {
      const agent = new CodexAgent({ cwd: '/tmp' });
      let called = false;
      agent.sendPrompt = () => { called = true; };
      agent._handleHubMessage({ type: 'prompt', text: 'hello' });
      assert.ok(called);
    });

    it('calls abort on abort message', () => {
      const agent = new CodexAgent({ cwd: '/tmp' });
      let called = false;
      agent.abort = () => { called = true; };
      agent._handleHubMessage({ type: 'abort' });
      assert.ok(called);
    });
  });
});
