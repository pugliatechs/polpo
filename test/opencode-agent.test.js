const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { OpencodeAgent } = require('../src/agent/opencode-agent');

describe('OpencodeAgent', () => {
  describe('constructor', () => {
    it('sets defaults', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp/project' });
      assert.equal(agent.cwd, '/tmp/project');
      assert.equal(agent.opencodeBinary, 'opencode');
      assert.equal(agent.busy, false);
      assert.equal(agent.sessionId, null);
      assert.match(agent.name, /OpenCode/);
    });

    it('accepts custom options', () => {
      const agent = new OpencodeAgent({
        name: 'My OpenCode',
        cwd: '/home/user/app',
        model: 'ollama/llama3',
        resumeSessionId: 'ses_abc123',
        serverUrl: 'ws://localhost:9999',
        token: 'secret',
      });
      assert.equal(agent.name, 'My OpenCode');
      assert.equal(agent.model, 'ollama/llama3');
      assert.equal(agent.resumeSessionId, 'ses_abc123');
      assert.equal(agent.serverUrl, 'ws://localhost:9999');
      assert.equal(agent.token, 'secret');
    });
  });

  describe('_handleOpencodeEvent', () => {
    let agent;
    let hubMessages;

    beforeEach(() => {
      agent = new OpencodeAgent({ cwd: '/tmp' });
      hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);
    });

    it('handles session.created', () => {
      agent._handleOpencodeEvent({
        type: 'session.created',
        session_id: 'ses_abc123',
      });
      assert.equal(agent.sessionId, 'ses_abc123');
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].type, 'message');
      assert.equal(hubMessages[0].message.role, 'system');
      assert.equal(hubMessages[0].message.contentType, 'json');
      const content = JSON.parse(hubMessages[0].message.content);
      assert.equal(content.subtype, 'init');
      assert.equal(content.session_id, 'ses_abc123');
      assert.equal(content.agent, 'opencode');
    });

    it('handles message.part.updated with text', () => {
      agent._handleOpencodeEvent({
        type: 'message.part.updated',
        part: { type: 'text', text: 'Hello ' },
      });
      assert.equal(agent.pendingText, 'Hello ');
      assert.equal(hubMessages.length, 0); // accumulated, not flushed
    });

    it('handles message.part.updated with tool (running)', () => {
      agent.pendingText = 'Some text';
      agent._handleOpencodeEvent({
        type: 'message.part.updated',
        part: {
          type: 'tool',
          state: 'running',
          name: 'Bash',
          input: { command: 'ls' },
          id: 'tool_1',
        },
      });
      // Should flush pending text first
      assert.equal(hubMessages.length, 2);
      assert.equal(hubMessages[0].message.role, 'assistant');
      assert.equal(hubMessages[0].message.content, 'Some text');
      // Then tool_use
      assert.equal(hubMessages[1].message.contentType, 'tool_use');
      const tool = JSON.parse(hubMessages[1].message.content);
      assert.equal(tool.name, 'Bash');
      assert.deepEqual(tool.input, { command: 'ls' });
    });

    it('handles message.part.updated with tool (completed)', () => {
      agent._handleOpencodeEvent({
        type: 'message.part.updated',
        part: {
          type: 'tool',
          state: 'completed',
          output: 'file1.js\nfile2.js',
          id: 'tool_2',
        },
      });
      assert.equal(hubMessages[0].message.role, 'tool');
      assert.equal(hubMessages[0].message.contentType, 'tool_result');
      assert.equal(hubMessages[0].message.isError, false);
    });

    it('handles message.part.updated with tool (error)', () => {
      agent._handleOpencodeEvent({
        type: 'message.part.updated',
        part: {
          type: 'tool',
          state: 'error',
          output: 'command not found',
          id: 'tool_3',
        },
      });
      assert.equal(hubMessages[0].message.isError, true);
    });

    it('truncates long tool output', () => {
      const longOutput = 'x'.repeat(3000);
      agent._handleOpencodeEvent({
        type: 'message.part.updated',
        part: {
          type: 'tool',
          state: 'completed',
          output: longOutput,
          id: 'tool_4',
        },
      });
      assert.ok(hubMessages[0].message.content.length < 3000);
      assert.ok(hubMessages[0].message.content.includes('3000 chars'));
    });

    it('handles session.idle', () => {
      agent.pendingText = 'Final text';
      agent.busy = true;
      agent.sessionId = 'ses_abc123';
      agent._handleOpencodeEvent({ type: 'session.idle' });
      // Should flush text + send idle + turn_complete
      assert.equal(agent.busy, false);
      assert.equal(hubMessages.length, 3);
      assert.equal(hubMessages[0].message.content, 'Final text');
      assert.equal(hubMessages[1].type, 'status');
      assert.equal(hubMessages[1].status, 'idle');
      assert.equal(hubMessages[2].message.contentType, 'turn_complete');
    });

    it('handles session.error', () => {
      agent._handleOpencodeEvent({
        type: 'session.error',
        message: 'Rate limit exceeded',
      });
      assert.ok(hubMessages[0].content.includes('Rate limit exceeded'));
    });

    it('handles tool.execute.before', () => {
      agent._handleOpencodeEvent({
        type: 'tool.execute.before',
        tool: 'Read',
        input: { file_path: '/tmp/test.js' },
        id: 'tool_5',
      });
      assert.equal(hubMessages[0].message.contentType, 'tool_use');
      const tool = JSON.parse(hubMessages[0].message.content);
      assert.equal(tool.name, 'Read');
    });

    it('handles tool.execute.after', () => {
      agent._handleOpencodeEvent({
        type: 'tool.execute.after',
        output: 'file contents here',
        id: 'tool_5',
      });
      assert.equal(hubMessages[0].message.role, 'tool');
      assert.equal(hubMessages[0].message.contentType, 'tool_result');
    });

    it('skips thinking parts', () => {
      agent._handleOpencodeEvent({
        type: 'message.part.updated',
        part: { type: 'thinking', text: 'internal reasoning' },
      });
      assert.equal(hubMessages.length, 0);
      assert.equal(agent.pendingText, '');
    });
  });

  describe('_flushPendingText', () => {
    it('sends accumulated text and clears buffer', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);

      agent.pendingText = 'Hello world';
      agent._flushPendingText();
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.content, 'Hello world');
      assert.equal(agent.pendingText, '');
    });

    it('does nothing when buffer is empty', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);

      agent._flushPendingText();
      assert.equal(hubMessages.length, 0);
    });
  });

  describe('_handleFallbackResponse', () => {
    it('sends response field as assistant message', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);

      agent._handleFallbackResponse('{"response":"Hello from OpenCode"}');
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0].message.content, 'Hello from OpenCode');
    });

    it('ignores invalid JSON', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp' });
      const hubMessages = [];
      agent._sendToHub = (msg) => hubMessages.push(msg);

      agent._handleFallbackResponse('not json');
      assert.equal(hubMessages.length, 0);
    });
  });

  describe('_handleHubMessage', () => {
    it('calls sendPrompt on prompt message', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp' });
      let called = false;
      agent.sendPrompt = () => { called = true; };
      agent._handleHubMessage({ type: 'prompt', text: 'hello' });
      assert.ok(called);
    });

    it('calls abort on abort message', () => {
      const agent = new OpencodeAgent({ cwd: '/tmp' });
      let called = false;
      agent.abort = () => { called = true; };
      agent._handleHubMessage({ type: 'abort' });
      assert.ok(called);
    });
  });
});
