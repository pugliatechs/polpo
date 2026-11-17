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

/**
 * Background work the CLI reports (background_tasks_changed) and the turn
 * it starts on its own when that work finishes (task_notification). The
 * sequences below are what claude 2.1.301 emits in stream-json mode.
 */
describe('WrappedAgent background tasks', () => {
  function agentWithHub() {
    const agent = new WrappedAgent({ cwd: os.tmpdir() });
    agent.instanceId = 'test-wrapped-background';
    const sent = [];
    agent._sendToHub = (m) => sent.push(m);
    agent._log = () => {};
    agent.claude = { stdin: { writable: false } };   // a live process
    return { agent, sent };
  }

  const changed = (...tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
  const bash = (id, extra) => Object.assign({ task_id: id, task_type: 'local_bash', description: 'd' }, extra);
  const notification = (id) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' });
  const result = (text) => ({ type: 'result', subtype: 'success', result: text });
  const statuses = (sent) => sent.filter((m) => m.type === 'status');

  it('reports background work with the idle, then the turn that follows it', () => {
    const { agent, sent } = agentWithHub();
    agent.busy = true;
    agent._handleClaudeMessage(changed(bash('b1')));
    agent._handleClaudeMessage(result('launched'));
    agent._handleClaudeMessage(notification('b1'));
    agent._handleClaudeMessage(changed());
    agent._handleClaudeMessage(result('finished'));

    assert.deepEqual(statuses(sent).map((m) => [m.status, m.backgroundTasks]), [
      ['idle', 1],
      ['busy', undefined],
      ['idle', 0],
    ]);
  });

  it('leaves out watchers and tasks a tool call waits for', () => {
    const { agent, sent } = agentWithHub();
    agent._handleClaudeMessage(changed(
      bash('w1', { ambient: true }),
      bash('a1', { awaited: true }),
      bash('b1'),
    ));
    agent._handleClaudeMessage(result('ok'));
    assert.equal(statuses(sent).at(-1).backgroundTasks, 1);
  });

  it('replaces the set on every change instead of adding to it', () => {
    const { agent, sent } = agentWithHub();
    agent._handleClaudeMessage(changed(bash('b1'), bash('b2')));
    agent._handleClaudeMessage(changed(bash('b2')));
    agent._handleClaudeMessage(result('ok'));
    assert.equal(statuses(sent).at(-1).backgroundTasks, 1);
  });

  it('does not start a turn for a notification nothing follows', () => {
    // Foreground commands get notifications too; so do watchers.
    const { agent, sent } = agentWithHub();
    agent._handleClaudeMessage(changed(bash('w1', { ambient: true })));
    agent._handleClaudeMessage(notification('fg1'));
    agent._handleClaudeMessage(notification('w1'));
    assert.equal(agent.busy, false);
    assert.equal(statuses(sent).length, 0);
  });

  it('counts a task whose notification comes after it left the set', () => {
    const { agent } = agentWithHub();
    agent._handleClaudeMessage(changed(bash('b1')));
    agent._handleClaudeMessage(changed());
    agent._handleClaudeMessage(notification('b1'));
    assert.equal(agent.busy, true);
  });

  it('does nothing for a notification that arrives mid-turn', () => {
    // The CLI folds it into the turn already running.
    const { agent, sent } = agentWithHub();
    agent.busy = true;
    agent._handleClaudeMessage(changed(bash('b1')));
    agent._handleClaudeMessage(notification('b1'));
    assert.equal(statuses(sent).length, 0);
  });

  it('forgets the work of a process that is gone', () => {
    const { agent, sent } = agentWithHub();
    agent._handleClaudeMessage(changed(bash('b1')));
    agent.claude = { kill: () => {} };
    agent.releaseProcess();
    agent.claude = { stdin: { writable: false } };
    agent._handleClaudeMessage(notification('b1'));
    agent._handleClaudeMessage(result('ok'));
    assert.equal(agent.busy, false);
    assert.equal(statuses(sent).at(-1).backgroundTasks, 0);
  });
});
