const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WrappedAgent } = require('../src/agent/wrapped');

/**
 * Releasing a session's claude process when someone picked the session
 * up again elsewhere (VSCode after a reload). The process holds a stale
 * copy of the conversation and must go, but the agent stays connected so
 * a later takeover can resume the session from its transcript.
 */
describe('WrappedAgent.releaseProcess', () => {
  let dir, fakeClaude;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-wrapped-'));
    fakeClaude = path.join(dir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'polpo-mcp-test-wrapped-release.json'), { force: true });
  });

  function agentWithHub() {
    const agent = new WrappedAgent({ cwd: dir, claudeBinary: fakeClaude, resumeSessionId: 'sess-1' });
    agent.instanceId = 'test-wrapped-release';
    const sent = [];
    agent._sendToHub = (m) => sent.push(m);
    agent._log = () => {};
    return { agent, sent };
  }

  const exited = (agent) => new Promise((resolve) => {
    const child = agent.claude;
    if (!child) return resolve();
    child.once('exit', () => setImmediate(resolve));
  });

  it('stops the process quietly and stays connected', async () => {
    const { agent, sent } = agentWithHub();
    agent.spawnClaude();
    const done = exited(agent);
    agent.releaseProcess();
    await done;

    assert.equal(agent.claude, null);
    assert.equal(agent.stopping, false, 'the agent itself was not stopped');
    assert.ok(!sent.some((m) => m.type === 'output' && /session ended/.test(m.content)),
      'no "[session ended]" line in the conversation');
    assert.ok(sent.some((m) => m.type === 'status' && m.status === 'idle'));
  });

  it('resumes the same session on the next spawn', async () => {
    const { agent } = agentWithHub();
    agent.spawnClaude();
    const done = exited(agent);
    agent.releaseProcess();
    await done;
    assert.equal(agent.resumeSessionId, 'sess-1');
    agent.spawnClaude();
    assert.ok(agent.claude, 'a fresh process');
    agent.stop();
  });

  it('is a no-op with no process running', () => {
    const { agent } = agentWithHub();
    assert.doesNotThrow(() => agent.releaseProcess());
  });

  it('still reports an unexpected exit as before', async () => {
    const { agent, sent } = agentWithHub();
    agent.spawnClaude();
    const done = exited(agent);
    agent.claude.kill('SIGTERM');   // not a release
    await done;
    assert.ok(sent.some((m) => m.type === 'output' && /session ended/.test(m.content)));
  });
});

describe('WrappedAgent permission mode', () => {
  let dir, fakeClaude, argsFile;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-wrapped-mode-'));
    argsFile = path.join(dir, 'args');
    fakeClaude = path.join(dir, 'claude');
    // Records its arguments, one spawn per line, then waits.
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "$*" >> "' + argsFile + '"\nexec sleep 30\n', { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    // spawnClaude writes the approval server's config here.
    fs.rmSync(path.join(os.tmpdir(), 'polpo-mcp-test-wrapped-mode.json'), { force: true });
  });

  function agentWith(opts) {
    const agent = new WrappedAgent(Object.assign({ cwd: dir, claudeBinary: fakeClaude, resumeSessionId: 'sess-1' }, opts));
    agent.instanceId = 'test-wrapped-mode';
    agent._sendToHub = () => {};
    agent._log = () => {};
    return agent;
  }

  const spawns = async (n) => {
    for (let i = 0; i < 50; i++) {
      const lines = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n') : [];
      if (lines.length >= n) return lines;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('claude was not spawned ' + n + ' times');
  };

  it('starts claude in the session\'s own mode, still behind polpo\'s approval prompt', async () => {
    fs.rmSync(argsFile, { force: true });
    const agent = agentWith({ claudePermissionMode: 'auto' });
    agent.spawnClaude();
    const [line] = await spawns(1);
    agent.stop();
    assert.match(line, /--permission-mode auto/);
    assert.match(line, /--permission-prompt-tool mcp__polpo__polpo_approve/);
  });

  it('passes no mode by default', async () => {
    fs.rmSync(argsFile, { force: true });
    const agent = agentWith({});
    agent.spawnClaude();
    const [line] = await spawns(1);
    agent.stop();
    assert.doesNotMatch(line, /--permission-mode/);
  });

  it('restarts in the new mode on the next prompt after a change', async () => {
    fs.rmSync(argsFile, { force: true });
    const agent = agentWith({ claudePermissionMode: 'auto' });
    agent.spawnClaude();
    await spawns(1);
    agent.setClaudePermissionMode(null);
    assert.equal(agent.claude, null, 'the running process was released');
    // Sent before the old process has even exited: must not go into it.
    agent.sendPrompt('carry on');
    const lines = await spawns(2);
    agent.stop();
    assert.doesNotMatch(lines[1], /--permission-mode/);
  });

  it('leaves the process alone when the mode does not change', async () => {
    fs.rmSync(argsFile, { force: true });
    const agent = agentWith({ claudePermissionMode: 'auto' });
    agent.spawnClaude();
    await spawns(1);
    const proc = agent.claude;
    agent.setClaudePermissionMode('auto');
    assert.equal(agent.claude, proc);
    agent.stop();
  });
});
