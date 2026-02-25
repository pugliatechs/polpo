const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../src/agent/agent-factory');

describe('AgentFactory', () => {
  it('returns WrappedAgent for claude type', () => {
    const agent = createAgent('claude', { cwd: '/tmp' });
    assert.equal(agent.constructor.name, 'WrappedAgent');
  });

  it('returns WrappedAgent for undefined type', () => {
    const agent = createAgent(undefined, { cwd: '/tmp' });
    assert.equal(agent.constructor.name, 'WrappedAgent');
  });

  it('returns CodexAgent for codex type', () => {
    const agent = createAgent('codex', { cwd: '/tmp' });
    assert.equal(agent.constructor.name, 'CodexAgent');
  });

  it('passes options through to WrappedAgent', () => {
    const agent = createAgent('claude', {
      name: 'Test Session',
      cwd: '/home/user/project',
      model: 'opus',
    });
    assert.equal(agent.name, 'Test Session');
    assert.equal(agent.cwd, '/home/user/project');
    assert.equal(agent.model, 'opus');
  });

  it('passes options through to CodexAgent', () => {
    const agent = createAgent('codex', {
      name: 'Codex Task',
      cwd: '/home/user/project',
      model: 'gpt-5-codex',
      permissionMode: 'bypass',
    });
    assert.equal(agent.name, 'Codex Task');
    assert.equal(agent.cwd, '/home/user/project');
    assert.equal(agent.model, 'gpt-5-codex');
    assert.equal(agent.permissionMode, 'bypass');
  });

  it('returns GeminiAgent for gemini type', () => {
    const agent = createAgent('gemini', { cwd: '/tmp' });
    assert.equal(agent.constructor.name, 'GeminiAgent');
  });

  it('passes options through to GeminiAgent', () => {
    const agent = createAgent('gemini', {
      name: 'Gemini Task',
      cwd: '/home/user/project',
      model: 'flash',
      permissionMode: 'bypass',
    });
    assert.equal(agent.name, 'Gemini Task');
    assert.equal(agent.cwd, '/home/user/project');
    assert.equal(agent.model, 'flash');
    assert.equal(agent.permissionMode, 'bypass');
  });
});
