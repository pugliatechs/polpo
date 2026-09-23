const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Reasoner, REASONER_SOURCE } = require('../src/mind/reasoner');

/**
 * Mock OneShotAgentRunner. Records every run() call so tests can assert
 * what the reasoner asked for, and lets each test decide what the run
 * resolves with. The real runner resolves (never rejects) on a normal
 * agent failure, so this mock does the same.
 */
function createMockRunner(reply) {
  const calls = [];
  let n = 0;
  return {
    calls,
    cancelled: [],
    async run(opts) {
      const agentInstanceId = 'reasoner-run-' + (++n);
      calls.push(opts);
      if (opts.onSpawn) opts.onSpawn(agentInstanceId);
      const r = typeof reply === 'function' ? await reply(opts, agentInstanceId) : reply;
      return Object.assign(
        { status: 'completed', output: '', error: null, durationMs: 1, agentInstanceId },
        r || {}
      );
    },
    cancel(id) { this.cancelled.push(id); },
  };
}

const PLAN_JSON = JSON.stringify({
  tasks: [{ description: 'Do it', agentType: 'claude', targetCwd: '/tmp', prompt: 'go', dependsOn: [] }],
});

describe('Reasoner', () => {
  describe('run configuration', () => {
    it('reasons through the shared one-shot runner', async () => {
      const runner = createMockRunner({ output: PLAN_JSON });
      const r = new Reasoner({ runner, cwd: '/tmp/work' });
      await r.plan('no agents', 'ship it');

      assert.equal(runner.calls.length, 1);
      const opts = runner.calls[0];
      assert.equal(opts.agentType, 'claude');
      assert.equal(opts.cwd, '/tmp/work');
      assert.equal(opts.source, REASONER_SOURCE);
      assert.equal(opts.permissionMode, 'bypass');
    });

    it('tags runs with a source the watcher will not treat as an arm', () => {
      // The watcher alerts on sources starting with 'mind:'. The
      // reasoner is mind infrastructure, not an arm doing user work.
      assert.ok(!REASONER_SOURCE.startsWith('mind:'));
    });

    it('always sets a deadline, so a stalled reason cannot hang the mind', async () => {
      const runner = createMockRunner({ output: PLAN_JSON });
      await new Reasoner({ runner }).plan('w', 'g');
      assert.ok(runner.calls[0].timeoutMs > 0);
    });

    it('honours an explicit timeout and ignores a malformed one', async () => {
      const runner = createMockRunner({ output: PLAN_JSON });
      await new Reasoner({ runner, timeoutMs: 5000 }).plan('w', 'g');
      assert.equal(runner.calls[0].timeoutMs, 5000);

      const r2 = createMockRunner({ output: PLAN_JSON });
      await new Reasoner({ runner: r2, timeoutMs: 'nonsense' }).plan('w', 'g');
      assert.ok(Number.isFinite(r2.calls[0].timeoutMs) && r2.calls[0].timeoutMs > 0);
    });

    it('can reason with any supported agent, not only claude', async () => {
      const runner = createMockRunner({ output: PLAN_JSON });
      await new Reasoner({ runner, agentType: 'goose', model: 'qwen3.5' }).plan('w', 'g');
      assert.equal(runner.calls[0].agentType, 'goose');
      assert.equal(runner.calls[0].model, 'qwen3.5');
    });

    it('omits the model key entirely when none is configured', async () => {
      const runner = createMockRunner({ output: PLAN_JSON });
      await new Reasoner({ runner }).plan('w', 'g');
      assert.equal('model' in runner.calls[0], false);
    });

    it('gives each call its own run, so no context is shared between them', async () => {
      const runner = createMockRunner({ output: PLAN_JSON });
      const r = new Reasoner({ runner });
      await r.plan('w', 'goal one');
      await r.plan('w', 'goal two');
      assert.equal(runner.calls.length, 2);
      assert.ok(runner.calls[0].prompt.includes('goal one'));
      assert.ok(!runner.calls[1].prompt.includes('goal one'));
    });

    it('serves concurrent calls instead of rejecting them as busy', async () => {
      // The old single-slot implementation rejected the second caller
      // with "Reasoner is busy", which the coordinator turned into an
      // outright task abandon.
      let release;
      const gate = new Promise((res) => { release = res; });
      let started = 0;
      const runner = createMockRunner(async () => {
        started++;
        if (started === 1) await gate;
        return { output: PLAN_JSON };
      });
      const r = new Reasoner({ runner });

      const first = r.plan('w', 'a');
      const second = r.plan('w', 'b');
      release();
      const [p1, p2] = await Promise.all([first, second]);

      assert.equal(p1.tasks.length, 1);
      assert.equal(p2.tasks.length, 1);
      assert.equal(runner.calls.length, 2);
    });

    it('throws when the run does not complete', async () => {
      const runner = createMockRunner({ status: 'failed', error: 'timeout' });
      await assert.rejects(
        () => new Reasoner({ runner }).plan('w', 'g'),
        /Reasoner run failed: timeout/
      );
    });

    it('throws when the run completes with no output', async () => {
      const runner = createMockRunner({ output: '   ' });
      await assert.rejects(() => new Reasoner({ runner }).plan('w', 'g'), /no output/);
    });

    it('throws when constructed without a runner', async () => {
      await assert.rejects(() => new Reasoner({}).plan('w', 'g'), /requires a one-shot runner/);
    });

    it('cancels in-flight runs on destroy and refuses new ones', async () => {
      let release;
      const gate = new Promise((res) => { release = res; });
      const runner = createMockRunner(async () => { await gate; return { output: PLAN_JSON }; });
      const r = new Reasoner({ runner });
      const inflight = r.plan('w', 'g');
      await new Promise((res) => setImmediate(res));

      r.destroy();
      assert.deepEqual(runner.cancelled, ['reasoner-run-1']);
      await assert.rejects(() => r.plan('w', 'g2'), /destroyed/);

      release();
      await inflight.catch(() => {});
    });
  });

  describe('_parseTaskPlan', () => {
    const r = new Reasoner({ runner: createMockRunner() });

    it('parses a well-formed plan', () => {
      const plan = r._parseTaskPlan(PLAN_JSON);
      assert.equal(plan.tasks.length, 1);
      assert.equal(plan.tasks[0].description, 'Do it');
    });

    it('parses a plan wrapped in code fences', () => {
      const plan = r._parseTaskPlan('```json\n' + PLAN_JSON + '\n```');
      assert.equal(plan.tasks.length, 1);
    });

    it('refuses to turn an unparseable reply into an agent prompt', () => {
      // This is the important one. The old fallback built a task whose
      // prompt WAS the raw reply, and arms run with approvals bypassed,
      // so a malformed reasoner reply became an executed instruction.
      assert.throws(() => r._parseTaskPlan('I think we should probably rm -rf the build dir'),
        /usable task plan/);
    });

    it('rejects a reply with no tasks array', () => {
      assert.throws(() => r._parseTaskPlan('{"notTasks": []}'), /usable task plan/);
    });

    it('rejects an empty task list', () => {
      assert.throws(() => r._parseTaskPlan('{"tasks": []}'), /empty task plan/);
    });

    it('normalizes missing task fields', () => {
      const plan = r._parseTaskPlan('{"tasks":[{}]}');
      assert.equal(plan.tasks[0].agentType, 'claude');
      assert.deepEqual(plan.tasks[0].dependsOn, []);
    });
  });

  describe('_parseEvaluation', () => {
    const r = new Reasoner({ runner: createMockRunner() });

    it('reads an explicit pass', () => {
      assert.equal(r._parseEvaluation('{"success":true,"summary":"fine"}').success, true);
    });

    it('reads an explicit failure', () => {
      assert.equal(r._parseEvaluation('{"success":false,"summary":"refused"}').success, false);
    });

    it('returns no verdict rather than a pass when the reply is garbage', () => {
      // Previously this returned success:true, so an unreadable reply
      // was recorded as a passing verdict and written to memory as one.
      const ev = r._parseEvaluation('sorry, I got confused');
      assert.equal(ev.success, null);
    });

    it('returns no verdict when the JSON omits success', () => {
      assert.equal(r._parseEvaluation('{"summary":"hmm"}').success, null);
    });

    it('does not treat a truthy non-boolean as a pass', () => {
      assert.equal(r._parseEvaluation('{"success":"yes"}').success, null);
    });
  });

  describe('evaluate', () => {
    it('accepts the arm output text the coordinator now holds', async () => {
      const runner = createMockRunner({ output: '{"success":false,"summary":"it refused"}' });
      const ev = await new Reasoner({ runner }).evaluate('Do it', 'I cannot do that.');
      assert.equal(ev.success, false);
      assert.ok(runner.calls[0].prompt.includes('I cannot do that.'));
    });

    it('still accepts a legacy message array', async () => {
      const runner = createMockRunner({ output: '{"success":true,"summary":"ok"}' });
      const ev = await new Reasoner({ runner }).evaluate('Do it', [
        { role: 'assistant', content: 'Done, shipped it.' },
      ]);
      assert.equal(ev.success, true);
      assert.ok(runner.calls[0].prompt.includes('Done, shipped it.'));
    });
  });

  describe('_parseReplan', () => {
    const r = new Reasoner({ runner: createMockRunner() });

    it('abandons on an unparseable recovery plan', () => {
      assert.equal(r._parseReplan('nonsense').action, 'abandon');
    });

    it('caps a split at three replacement tasks', () => {
      const tasks = [1, 2, 3, 4, 5].map((i) => ({ description: 'T' + i, prompt: 'p' }));
      const out = r._parseReplan(JSON.stringify({ action: 'split', tasks }));
      assert.equal(out.tasks.length, 3);
    });

    it('abandons a split that carries no tasks', () => {
      assert.equal(r._parseReplan('{"action":"split","tasks":[]}').action, 'abandon');
    });
  });
});
