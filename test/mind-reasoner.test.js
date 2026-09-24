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

  describe('_parseAssessment', () => {
    const r = new Reasoner({ runner: createMockRunner() });

    it('reads a done verdict', () => {
      const a = r._parseAssessment('{"verdict":"done","summary":"shipped it"}', true);
      assert.equal(a.verdict, 'done');
      assert.equal(a.summary, 'shipped it');
    });

    it('reads a failed verdict', () => {
      assert.equal(r._parseAssessment('{"verdict":"failed","summary":"refused"}', true).verdict, 'failed');
    });

    it('carries the answer on needs_input when a turn remains', () => {
      const a = r._parseAssessment(
        '{"verdict":"needs_input","summary":"asked which db","answer":"use postgres"}', true);
      assert.equal(a.verdict, 'needs_input');
      assert.equal(a.answer, 'use postgres');
    });

    it('downgrades needs_input to failed when no turn is left', () => {
      // Nothing can be done with an answer there is no turn to send.
      const a = r._parseAssessment(
        '{"verdict":"needs_input","summary":"asked which db","answer":"use postgres"}', false);
      assert.equal(a.verdict, 'failed');
      assert.equal(a.answer, null);
    });

    it('downgrades needs_input with no answer to failed', () => {
      const a = r._parseAssessment('{"verdict":"needs_input","summary":"stuck"}', true);
      assert.equal(a.verdict, 'failed');
    });

    it('treats a blank answer as no answer', () => {
      const a = r._parseAssessment('{"verdict":"needs_input","answer":"   "}', true);
      assert.equal(a.verdict, 'failed');
    });

    it('fails open to done when the reply is unparseable', () => {
      // Manufacturing a failure would replan or escalate work that may
      // well have succeeded. Absence of evidence is not evidence.
      const a = r._parseAssessment('sorry, I got confused', true);
      assert.equal(a.verdict, 'done');
      assert.equal(a.answer, null);
    });

    it('fails open to done on an unknown verdict', () => {
      assert.equal(r._parseAssessment('{"verdict":"sideways"}', true).verdict, 'done');
    });

    it('never returns an answer alongside done', () => {
      const a = r._parseAssessment('{"verdict":"done","answer":"ignore me"}', true);
      assert.equal(a.answer, null);
    });
  });

  describe('assessTurn', () => {
    it('sends the arm output and the goal for context', async () => {
      const runner = createMockRunner({ output: '{"verdict":"done","summary":"ok"}' });
      const a = await new Reasoner({ runner }).assessTurn({
        goalPrompt: 'ship the migration',
        taskDescription: 'migrate the db',
        taskPrompt: 'do the migration',
        output: 'I cannot pick a database.',
        turn: 1,
        maxTurns: 2,
      });
      assert.equal(a.verdict, 'done');
      const prompt = runner.calls[0].prompt;
      assert.ok(prompt.includes('ship the migration'));
      assert.ok(prompt.includes('migrate the db'));
      assert.ok(prompt.includes('I cannot pick a database.'));
    });

    it('tells the reasoner when it may answer', async () => {
      const runner = createMockRunner({ output: '{"verdict":"done"}' });
      await new Reasoner({ runner }).assessTurn({ taskDescription: 't', output: 'o', turn: 1, maxTurns: 2 });
      assert.match(runner.calls[0].prompt, /You may answer it/);
    });

    it('tells the reasoner when it may not', async () => {
      const runner = createMockRunner({ output: '{"verdict":"done"}' });
      await new Reasoner({ runner }).assessTurn({ taskDescription: 't', output: 'o', turn: 2, maxTurns: 2 });
      assert.match(runner.calls[0].prompt, /You may NOT answer it/);
    });

    it('returns the answer to send back to the arm', async () => {
      const runner = createMockRunner({
        output: '{"verdict":"needs_input","summary":"which db","answer":"use postgres"}',
      });
      const a = await new Reasoner({ runner }).assessTurn({
        taskDescription: 't', output: 'which db?', turn: 1, maxTurns: 2,
      });
      assert.equal(a.verdict, 'needs_input');
      assert.equal(a.answer, 'use postgres');
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

  describe('answer', () => {
    it('grounds the answer on the stored result and the question', async () => {
      const runner = createMockRunner({ output: '  It uses Yocto.  ' });
      const text = await new Reasoner({ runner }).answer({
        goalPrompt: 'Research the device', result: 'Built with Yocto.', question: 'which toolchain?',
      });
      assert.equal(text, 'It uses Yocto.');
      const prompt = runner.calls[0].prompt;
      assert.match(prompt, /The goal: Research the device/);
      assert.match(prompt, /Built with Yocto\./);
      assert.match(prompt, /Question: which toolchain\?/);
    });

    it('forbids tools, since reasoning runs have them with approvals bypassed', async () => {
      const runner = createMockRunner({ output: 'ok' });
      await new Reasoner({ runner }).answer({ goalPrompt: 'g', result: 'r', question: 'q' });
      assert.match(runner.calls[0].prompt, /Do not run commands, read files, search the web, or use any tool/);
    });

    it('tells the model to say so when the result has no answer', async () => {
      const runner = createMockRunner({ output: 'ok' });
      await new Reasoner({ runner }).answer({ goalPrompt: 'g', result: 'r', question: 'q' });
      assert.match(runner.calls[0].prompt, /If the result does not contain the answer, say so/);
    });

    it('keeps the end of a very long result', async () => {
      const runner = createMockRunner({ output: 'ok' });
      await new Reasoner({ runner }).answer({
        goalPrompt: 'g', result: 'HEAD' + 'x'.repeat(20000) + 'TAIL', question: 'q',
      });
      const prompt = runner.calls[0].prompt;
      assert.ok(prompt.includes('TAIL'));
      assert.ok(!prompt.includes('HEAD'));
      assert.match(prompt, /earlier part omitted/);
    });

    it('says when only a summary survived', async () => {
      const runner = createMockRunner({ output: 'ok' });
      await new Reasoner({ runner }).answer({ goalPrompt: 'g', result: 'r', question: 'q', fromMemory: true });
      assert.match(runner.calls[0].prompt, /Only a short summary of the result survived/);
    });
  });
});

describe('splitGoalArg', () => {
  const { splitGoalArg } = require('../src/mind/index');

  it('takes a leading goal id', () => {
    assert.deepEqual(splitGoalArg(' goal-ab12cd34 make it shorter'), { goalId: 'goal-ab12cd34', text: 'make it shorter' });
  });

  it('treats text without an id as referring to the latest goal', () => {
    assert.deepEqual(splitGoalArg('make it shorter'), { goalId: null, text: 'make it shorter' });
  });

  it('does not accept something that only looks like an id', () => {
    assert.equal(splitGoalArg('goal-<script> hi').goalId, null);
    assert.equal(splitGoalArg('goal-AB hi').goalId, null);
  });

  it('handles an id with nothing after it', () => {
    assert.deepEqual(splitGoalArg('goal-ab12cd34'), { goalId: 'goal-ab12cd34', text: '' });
  });
});

