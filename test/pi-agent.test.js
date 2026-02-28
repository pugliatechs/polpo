const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PiAgent } = require('../src/agent/pi-agent');

describe('PiAgent', () => {
  describe('constructor', () => {
    it('sets defaults', () => {
      const agent = new PiAgent({ cwd: '/tmp/project' });
      assert.equal(agent.cwd, '/tmp/project');
      assert.equal(agent.piBinary, 'pi');
      assert.equal(agent.permissionMode, 'default');
      assert.equal(agent.busy, false);
      assert.equal(agent.piSessionId, null);
      assert.match(agent.name, /Pi/);
    });

    it('accepts custom options', () => {
      const agent = new PiAgent({
        name: 'My Pi',
        cwd: '/home/user/app',
        model: 'openai/gpt-4o',
        permissionMode: 'bypass',
        resumeSessionId: 'abc-123',
        serverUrl: 'ws://localhost:9999',
        token: 'secret',
      });
      assert.equal(agent.name, 'My Pi');
      assert.equal(agent.model, 'openai/gpt-4o');
      assert.equal(agent.permissionMode, 'bypass');
      assert.equal(agent.resumeSessionId, 'abc-123');
      assert.equal(agent.serverUrl, 'ws://localhost:9999');
      assert.equal(agent.token, 'secret');
    });
  });

  describe('_handlePiEvent', () => {
    let agent;
    let hubMessages;

    beforeEach(() => {
      agent = new PiAgent({ cwd: '/tmp' });
      hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
    });

    it('handles agent_start', () => {
      agent._handlePiEvent({ type: 'agent_start' });
      assert.equal(agent.busy, true);
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].type, 'status');
      assert.equal(hubMessages[0].status, 'busy');
    });

    it('handles agent_end', () => {
      agent.busy = true;
      agent._handlePiEvent({ type: 'agent_end' });
      assert.equal(agent.busy, false);
      assert.equal(hubMessages.length, 2);
      assert.equal(hubMessages[0].type, 'status');
      assert.equal(hubMessages[0].status, 'idle');
      assert.equal(hubMessages[1].message.contentType, 'turn_complete');
    });

    it('handles session_start', () => {
      agent._handlePiEvent({
        type: 'session_start',
        sessionId: 'ses-abc-123',
        model: 'openai/gpt-4o',
      });
      assert.equal(agent.piSessionId, 'ses-abc-123');
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.role, 'system');
      assert.equal(hubMessages[0].message.contentType, 'json');
      const content = JSON.parse(hubMessages[0].message.content);
      assert.equal(content.subtype, 'init');
      assert.equal(content.session_id, 'ses-abc-123');
      assert.equal(content.agent, 'pi');
    });

    it('handles tool_execution_start', () => {
      agent._handlePiEvent({
        type: 'tool_execution_start',
        tool: 'Bash',
        input: { command: 'ls -la' },
        id: 'tool_1',
      });
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.contentType, 'tool_use');
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'Bash');
      assert.equal(tool.input.command, 'ls -la');
    });

    it('handles tool_execution_end', () => {
      agent._handlePiEvent({
        type: 'tool_execution_end',
        output: 'file1.js\nfile2.js',
        id: 'tool_1',
        isError: false,
      });
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.role, 'tool');
      assert.equal(hubMessages[0].message.contentType, 'tool_result');
      assert.equal(hubMessages[0].message.content, 'file1.js\nfile2.js');
      assert.equal(hubMessages[0].message.isError, false);
    });

    it('truncates long tool output', () => {
      const longOutput = 'x'.repeat(3000);
      agent._handlePiEvent({
        type: 'tool_execution_end',
        output: longOutput,
        id: 'tool_2',
      });
      assert.ok(hubMessages[0].message.content.length < 3000);
      assert.ok(hubMessages[0].message.content.includes('3000 chars'));
    });

    it('handles error event', () => {
      agent._handlePiEvent({
        type: 'error',
        message: 'Something went wrong',
      });
      assert.ok(hubMessages[0].message.content.includes('Something went wrong'));
    });

    it('skips turn_start/end and message_start/end', () => {
      agent._handlePiEvent({ type: 'turn_start' });
      agent._handlePiEvent({ type: 'turn_end' });
      agent._handlePiEvent({ type: 'message_start' });
      agent._handlePiEvent({ type: 'message_end' });
      assert.equal(hubMessages.length, 0);
    });
  });

  describe('_handleMessageUpdate (text streaming)', () => {
    let agent;
    let hubMessages;

    beforeEach(() => {
      agent = new PiAgent({ cwd: '/tmp' });
      hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
    });

    it('accumulates text_delta and flushes on text_end', () => {
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
      });
      assert.equal(hubMessages.length, 0);

      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      });
      assert.equal(hubMessages.length, 0);

      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_end' },
      });
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.role, 'assistant');
      assert.equal(hubMessages[0].message.content, 'Hello world');
    });

    it('handles done event by flushing all', () => {
      agent.pendingText = 'accumulated text';
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'done' },
      });
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.content, 'accumulated text');
    });

    it('skips thinking events', () => {
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'thinking_start' },
      });
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm...' },
      });
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'thinking_end' },
      });
      assert.equal(hubMessages.length, 0);
      assert.equal(agent.pendingText, '');
    });
  });

  describe('_handleMessageUpdate (tool call streaming)', () => {
    let agent;
    let hubMessages;

    beforeEach(() => {
      agent = new PiAgent({ cwd: '/tmp' });
      hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
    });

    it('accumulates tool call deltas and flushes on toolcall_end', () => {
      // First flush any pending text
      agent.pendingText = 'Some text before tool';

      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_start', name: 'Bash', id: 'tc_1' },
      });
      // Should have flushed pending text
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.content, 'Some text before tool');

      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_delta', delta: '{"comma' },
      });
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_delta', delta: 'nd":"ls"}' },
      });
      assert.equal(hubMessages.length, 1); // No new messages yet

      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_end' },
      });
      assert.equal(hubMessages.length, 2);
      const tool = JSON.parse(hubMessages[1].message.content);
      assert.equal(tool.name, 'Bash');
      assert.deepEqual(tool.input, { command: 'ls' });
      assert.equal(tool.id, 'tc_1');
    });

    it('handles unparseable tool input', () => {
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_start', name: 'MyTool', id: 'tc_2' },
      });
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_delta', delta: 'not json' },
      });
      agent._handleMessageUpdate({
        assistantMessageEvent: { type: 'toolcall_end' },
      });
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'MyTool');
      assert.deepEqual(tool.input, { raw: 'not json' });
    });
  });

  describe('_flushPendingText', () => {
    it('does nothing when pendingText is empty', () => {
      const agent = new PiAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
      agent._flushPendingText();
      assert.equal(hubMessages.length, 0);
    });

    it('sends accumulated text and clears buffer', () => {
      const agent = new PiAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
      agent.pendingText = 'Hello world';
      agent._flushPendingText();
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.content, 'Hello world');
      assert.equal(agent.pendingText, '');
    });
  });

  describe('_handleHubMessage', () => {
    it('calls sendPrompt on prompt message', () => {
      const agent = new PiAgent({ cwd: '/tmp' });
      let called = false;
      agent.sendPrompt = () => { called = true; };
      agent._handleHubMessage({ type: 'prompt', text: 'hello' });
      assert.ok(called);
    });

    it('calls abort on abort message', () => {
      const agent = new PiAgent({ cwd: '/tmp' });
      let called = false;
      agent.abort = () => { called = true; };
      agent._handleHubMessage({ type: 'abort' });
      assert.ok(called);
    });
  });

  describe('agent_end flushes pending', () => {
    it('flushes pending text on agent_end', () => {
      const agent = new PiAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);

      agent.pendingText = 'leftover text';
      agent.busy = true;
      agent._handlePiEvent({ type: 'agent_end' });

      // Should have: flushed text, status idle, turn_complete
      assert.equal(hubMessages.length, 3);
      assert.equal(hubMessages[0].message.content, 'leftover text');
      assert.equal(hubMessages[1].status, 'idle');
      assert.equal(hubMessages[2].message.contentType, 'turn_complete');
    });
  });
});
