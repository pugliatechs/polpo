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

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function agentWithHub() {
    const agent = new WrappedAgent({ cwd: dir, claudeBinary: fakeClaude, resumeSessionId: 'sess-1' });
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
