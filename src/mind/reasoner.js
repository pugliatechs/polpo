/**
 * Reasoner - LLM-backed planning engine for the Alien Mind.
 *
 * Every reasoning call (plan / evaluate / replan) is one isolated
 * OneShotAgentRunner run: spawn, prompt, capture, terminate. This is
 * the same primitive the HTTP gateway and the coordinator's arms use.
 *
 * Until v1.2.3 this class hand-rolled its own long-lived subprocess.
 * That had four defects the runner does not have:
 *
 *   - a single-slot mutex that rejected concurrent calls with
 *     "Reasoner is busy", which the coordinator turned into an
 *     outright task abandon
 *   - no timeout, so one stalled process bricked the mind for the
 *     lifetime of the server
 *   - one unbounded conversation shared by every goal, so context
 *     grew without limit and earlier goals contaminated later ones
 *   - a hardcoded binary, so the mind could only ever reason with one
 *     of the six agent CLIs Polpo supports
 *
 * Each call now gets a fresh context, its own deadline, and runs
 * concurrently with any other call.
 */

const { makeLogger } = require('../util/logger');

const log = makeLogger('mind-reasoner');

// Origin tag for reasoner runs. Deliberately NOT prefixed 'mind:',
// which is what the watcher treats as a coordinator-owned arm; the
// reasoner is mind infrastructure, not an arm doing user work.
const REASONER_SOURCE = 'mind-reasoner';
const REASONER_NAME = 'Mind reasoner';
const DEFAULT_TIMEOUT_MS = 120000;

var SYSTEM_PROMPT = [
  'You are the coordination brain of Polpo, an octopus-inspired multi-agent system.',
  'You receive a user goal and a snapshot of all available coding agents.',
  'Your job is to produce a task plan as JSON.',
  '',
  'Respond ONLY with valid JSON. No markdown, no explanation, no code fences.',
  '',
  'Response format:',
  '{ "tasks": [{ "description": "...", "agentType": "claude", "targetCwd": "...", "prompt": "...", "dependsOn": [] }] }',
  '',
  'Rules:',
  '- Produce 1 task for simple goals, up to 5 tasks for complex multi-step goals.',
  '- Each task must have a specific, actionable prompt.',
  '- agentType should match an available idle agent when possible.',
  '- targetCwd should match the relevant project directory.',
  '- dependsOn is an array of task indices (0-based) that must complete before this task starts.',
  '- Tasks with no dependencies can run in parallel.',
  '- If no suitable agent exists, use agentType "claude" as default.',
  '',
  'Task dependencies and context sharing:',
  '- When task B depends on task A (dependsOn: [0] where A is index 0), B will automatically receive A\'s output as context in a <previous_task_results> XML block prepended to its prompt.',
  '- Use dependencies when a later task needs information the earlier task produced (e.g., research first, then build based on findings).',
  '- The dependent task\'s prompt should reference what will come from the previous task (e.g., "Based on the research above, build a prototype that...") rather than restating the work.',
  '- Prefer splitting research + action into two dependent tasks rather than combining them into one.',
  '',
  'Past work context:',
  '- The world state may include a "Relevant past work (from memory)" section listing previously completed goals.',
  '- Use it to avoid redoing work, respect established conventions, and build on prior decisions.',
  '- If a past goal addressed the same or similar problem, reference it in your task prompts (e.g., "Following the approach from the past auth refactor...").',
].join('\n');

var ASSESS_PROMPT = [
  'A coding agent has stopped and is waiting. Decide what its output means.',
  'The agent is STILL ALIVE: if it is only missing a detail you can supply,',
  'you can answer it and it will continue with everything it has already done.',
  '',
  'Respond ONLY with valid JSON, one of:',
  '',
  '1) The task is finished:',
  '{ "verdict": "done", "summary": "what it accomplished" }',
  '',
  '2) It is blocked on something you can answer from the goal or its context:',
  '{ "verdict": "needs_input", "summary": "what it asked", "answer": "the answer to send it" }',
  '',
  '3) It refused, failed, or needs a human decision you cannot make:',
  '{ "verdict": "failed", "summary": "why" }',
  '',
  'Rules:',
  '- "done" means the work is actually done, not that the agent stopped politely.',
  '  An agent that explains why it cannot proceed has NOT done the task.',
  '- Choose "needs_input" only when the answer is genuinely derivable from the',
  '  goal, the task, or what the agent already produced. Never invent a fact,',
  '  a credential, a file path, or a product decision.',
  '- Choose "failed" when the block needs a human: a missing secret, an',
  '  ambiguous product call, or a refusal on policy grounds.',
  '- The answer must be a direct instruction to the agent, not a description.',
  '- Use "How the turn ended" below. A turn that ended mid tool call or on its',
  '  output limit was INTERRUPTED: the agent did not ask anything. If the task',
  '  is not finished, choose needs_input and tell it to continue where it left off.',
  '- If a safety guardrail stopped the agent, NEVER tell it to work around,',
  '  rephrase around, or retry the blocked action. If the rest of the task is',
  '  legitimate, choose needs_input and redirect it to that part only. If the',
  '  blocked action was the task itself, choose failed.',
  '- Respond ONLY with valid JSON. No markdown, no code fences.',
].join('\n');

// Plain-language description of a stop reason for the assessment prompt.
var STOP_REASON_TEXT = {
  end_turn: 'it finished its turn normally',
  refusal: 'a safety guardrail stopped it',
  tool_use: 'it was cut off in the middle of a tool call (interrupted)',
  max_tokens: 'it hit its output limit (interrupted)',
  pause_turn: 'it paused mid-task (interrupted)',
};

var ANSWER_PROMPT = [
  'The user ran a goal through a team of coding agents and is asking a question about its result.',
  '',
  'Rules:',
  '- Answer using ONLY the result text below. Do not add facts that are not in it.',
  '- Do not run commands, read files, search the web, or use any tool. Everything you',
  '  may use is in this message.',
  '- If the result does not contain the answer, say so in one sentence and suggest',
  '  using Follow up to have the agents find out.',
  '- Answer directly and concisely in markdown. No preamble, no restating the question.',
].join('\n');

// How much of a result an answer is grounded on. The end is kept: that
// is where an agent's conclusions are.
var ANSWER_RESULT_MAX_CHARS = 12000;

var REPLAN_PROMPT = [
  'You are the coordination brain of Polpo. A task failed during execution and you must decide how to recover.',
  '',
  'Possible outcomes (respond with ONE of these JSON shapes):',
  '',
  '1) Retry with a revised prompt (same task, different approach):',
  '{ "action": "retry", "prompt": "...new prompt..." }',
  '',
  '2) Split the failed task into smaller replacement tasks:',
  '{ "action": "split", "tasks": [{ "description": "...", "prompt": "...", "agentType": "claude", "targetCwd": "..." }, ...] }',
  '',
  '3) Abandon the task (cannot recover):',
  '{ "action": "abandon", "reason": "brief explanation" }',
  '',
  'Rules:',
  '- Choose "retry" when the failure looks like a transient issue or the prompt was ambiguous',
  '- Choose "split" when the task was too complex or too broad for a single arm',
  '- Choose "abandon" when the task is fundamentally unachievable or would require human intervention',
  '- Keep replacement prompts specific and actionable',
  '- Do NOT produce more than 3 replacement tasks when splitting',
  '- Respond ONLY with valid JSON. No markdown, no code fences.',
].join('\n');

class Reasoner {
  /**
   * @param {object} options
   * @param {object} options.runner   - OneShotAgentRunner (required)
   * @param {string} [options.agentType] - which CLI reasons; default 'claude'
   *   (env POLPO_MIND_AGENT). Any type the agent factory supports works,
   *   so the mind can reason with a local model via goose or codex --oss.
   * @param {string} [options.model]  - model override (env POLPO_MIND_MODEL)
   * @param {string} [options.cwd]    - working dir for reasoning runs
   * @param {number} [options.timeoutMs] - per-call deadline
   *   (env POLPO_MIND_TIMEOUT_MS, default 120s)
   */
  constructor(options) {
    if (!options) options = {};
    this.runner = options.runner || null;
    this.agentType = options.agentType || process.env.POLPO_MIND_AGENT || 'claude';
    this.model = options.model || process.env.POLPO_MIND_MODEL || null;
    this.cwd = options.cwd || process.cwd();
    this.timeoutMs = positiveInt(options.timeoutMs)
      || positiveInt(process.env.POLPO_MIND_TIMEOUT_MS)
      || DEFAULT_TIMEOUT_MS;
    this._inflight = new Set(); // agentInstanceIds of live reasoning runs
    this._destroyed = false;
  }

  /**
   * Plan a goal given the current world state.
   * @param {string} worldSummary - Human-readable world state from WorldModel.getSummary()
   * @param {string} goalPrompt - The user's goal
   * @returns {Promise<{ tasks: Array<{ description, agentType, targetCwd, prompt, dependsOn }> }>}
   */
  async plan(worldSummary, goalPrompt) {
    var prompt = SYSTEM_PROMPT + '\n\n' +
      'Available agents:\n' + worldSummary + '\n\n' +
      'User goal: ' + goalPrompt + '\n\n' +
      'Respond with JSON only:';

    var response = await this._ask(prompt);
    return this._parseTaskPlan(response);
  }

  /**
   * Decide what an arm's output means, while the arm is still alive.
   *
   * This replaced evaluate(). Two reasons. It used to run after the
   * agent had been destroyed, which made a verdict of "failed" useless
   * for anything but bookkeeping and arrived after dependent tasks had
   * already consumed the output. And it could only ever judge; it could
   * not answer. Running at turn end means a "needs_input" verdict can
   * be sent straight back into the same session, so an arm that asks
   * for a detail keeps the work it has already done.
   *
   * @param {object} opts
   * @param {string} opts.taskDescription
   * @param {string} [opts.taskPrompt]
   * @param {string} [opts.goalPrompt]
   * @param {string} opts.output       what the arm produced this turn
   * @param {number} [opts.turn]
   * @param {number} [opts.maxTurns]
   * @param {?string} [opts.stopReason] - how the turn ended, when the
   *   agent reports it ('end_turn', 'refusal', 'tool_use', ...)
   * @returns {Promise<{verdict:'done'|'needs_input'|'failed', summary:string, answer:?string}>}
   *   verdict is 'done' when the reply could not be parsed, so an
   *   unreadable assessment never invents a failure.
   */
  async assessTurn(opts) {
    opts = opts || {};
    var canAnswer = (opts.maxTurns || 1) > (opts.turn || 1);

    var prompt = ASSESS_PROMPT + '\n\n' +
      (opts.goalPrompt ? 'Overall goal: ' + opts.goalPrompt + '\n\n' : '') +
      'Task: ' + (opts.taskDescription || '(unknown)') + '\n\n' +
      (opts.taskPrompt ? 'What the agent was asked:\n' + String(opts.taskPrompt).slice(0, 2000) + '\n\n' : '') +
      'What the agent just produced:\n' + String(opts.output || '').slice(0, 8000) + '\n\n' +
      'How the turn ended: ' + describeStopReason(opts.stopReason) + '\n\n' +
      (canAnswer
        ? 'You may answer it: it has turns remaining.\n\n'
        : 'You may NOT answer it: it has no turns left, so choose done or failed.\n\n') +
      'Respond with JSON only:';

    var response = await this._ask(prompt);
    return this._parseAssessment(response, canAnswer);
  }

  /**
   * Answer a question about a finished goal from its stored result.
   *
   * No plan and no arms: one reasoning run over text the mind already
   * has. It is the cheap path for "what did you find about X?", which
   * would otherwise be submitted as a whole new goal.
   *
   * @param {object} opts
   * @param {string} opts.goalPrompt
   * @param {string} opts.result
   * @param {string} opts.question
   * @param {boolean} [opts.fromMemory] - only a summary of the result survived
   * @returns {Promise<string>} markdown answer
   */
  async answer(opts) {
    opts = opts || {};
    var result = String(opts.result || '');
    if (result.length > ANSWER_RESULT_MAX_CHARS) {
      result = '(earlier part omitted)\n' + result.slice(-ANSWER_RESULT_MAX_CHARS);
    }
    var prompt = ANSWER_PROMPT + '\n\n' +
      'The goal: ' + (opts.goalPrompt || '(unknown)') + '\n\n' +
      (opts.fromMemory
        ? 'Only a short summary of the result survived:\n'
        : 'The result:\n') +
      (result || '(no result text)') + '\n\n' +
      'Question: ' + String(opts.question || '') + '\n';

    var text = await this._ask(prompt);
    return text.trim().slice(0, 20000);
  }

  /**
   * Decide how to recover from a failed task.
   * @param {object} opts
   * @param {string} opts.goalPrompt - Original user goal
   * @param {object} opts.failedTask - { description, prompt, agentType, targetCwd }
   * @param {string} opts.failureReason - Why the task failed
   * @param {string} [opts.partialOutput] - Anything the arm produced before failing
   * @param {Array} [opts.completedTasks] - Already-completed tasks for context
   * @returns {Promise<{ action: 'retry'|'split'|'abandon', prompt?, tasks?, reason? }>}
   */
  async replan(opts) {
    var ctxLines = [];
    if (opts.completedTasks && opts.completedTasks.length > 0) {
      ctxLines.push('Completed tasks so far:');
      for (var i = 0; i < opts.completedTasks.length; i++) {
        var c = opts.completedTasks[i];
        ctxLines.push('- ' + c.description);
      }
      ctxLines.push('');
    }

    var prompt = REPLAN_PROMPT + '\n\n' +
      'Original goal: ' + (opts.goalPrompt || '(unknown)') + '\n\n' +
      (ctxLines.length > 0 ? ctxLines.join('\n') + '\n' : '') +
      'Failed task:\n' +
      '  description: ' + opts.failedTask.description + '\n' +
      '  prompt: ' + (opts.failedTask.prompt || '').slice(0, 2000) + '\n' +
      '  agentType: ' + (opts.failedTask.agentType || 'claude') + '\n' +
      '  targetCwd: ' + (opts.failedTask.targetCwd || '') + '\n\n' +
      'Failure reason: ' + opts.failureReason + '\n\n' +
      (opts.partialOutput
        ? 'Partial output from the arm before failure:\n' +
          opts.partialOutput.slice(0, 3000) + '\n\n'
        : '') +
      'Respond with JSON only:';

    var response = await this._ask(prompt);
    return this._parseReplan(response);
  }

  _parseReplan(response) {
    var json = this._extractJson(response);
    if (!json || typeof json.action !== 'string') {
      return { action: 'abandon', reason: 'Reasoner produced invalid recovery plan' };
    }
    if (json.action === 'retry') {
      return {
        action: 'retry',
        prompt: typeof json.prompt === 'string' && json.prompt.trim() ? json.prompt : null,
      };
    }
    if (json.action === 'split') {
      var tasks = Array.isArray(json.tasks) ? json.tasks : [];
      // Cap at 3 replacement tasks and normalize fields
      var normalized = tasks.slice(0, 3).map(function (t) {
        return {
          description: t.description || 'Recovery task',
          agentType: t.agentType || 'claude',
          targetCwd: t.targetCwd || '',
          prompt: t.prompt || t.description || '',
        };
      });
      if (normalized.length === 0) {
        return { action: 'abandon', reason: 'Reasoner returned empty split plan' };
      }
      return { action: 'split', tasks: normalized };
    }
    if (json.action === 'abandon') {
      return { action: 'abandon', reason: json.reason || 'Reasoner chose to abandon' };
    }
    return { action: 'abandon', reason: 'Unknown action: ' + json.action };
  }

  /**
   * Run one reasoning turn as an isolated one-shot agent run.
   *
   * Never shares context with another call, always bounded by
   * `timeoutMs`, and safe to invoke concurrently: each call is its own
   * process. The runner resolves (rather than rejects) on a normal
   * agent failure, so a non-completed status is turned into a throw
   * here for callers that treat reasoning failure as fatal.
   *
   * @param {string} prompt
   * @returns {Promise<string>} the agent's captured text
   */
  async _ask(prompt) {
    if (!this.runner) {
      throw new Error('Reasoner requires a one-shot runner');
    }
    if (this._destroyed) {
      throw new Error('Reasoner destroyed');
    }

    var self = this;
    var opts = {
      agentType: this.agentType,
      cwd: this.cwd,
      prompt: prompt,
      name: REASONER_NAME,
      source: REASONER_SOURCE,
      timeoutMs: this.timeoutMs,
      // The reasoner only emits JSON; it should never stall on an
      // approval prompt nobody is watching.
      permissionMode: 'bypass',
      onSpawn: function (agentInstanceId) {
        self._inflight.add(agentInstanceId);
      },
    };
    if (this.model) opts.model = this.model;

    var result = await this.runner.run(opts);

    if (result && result.agentInstanceId) {
      this._inflight.delete(result.agentInstanceId);
    }

    if (!result || result.status !== 'completed') {
      var why = (result && (result.error || result.status)) || 'no result';
      log.error('Reasoning run did not complete:', why);
      throw new Error('Reasoner run failed: ' + why);
    }

    var text = (result.output || '').trim();
    if (!text) {
      throw new Error('Reasoner returned no output');
    }
    return text;
  }

  /**
   * Parse a task plan from the LLM response.
   */
  _parseTaskPlan(response) {
    var json = this._extractJson(response);
    if (!json || !Array.isArray(json.tasks)) {
      // Until v1.2.3 this fell back to dispatching a task whose prompt
      // WAS the unparsed reply. Arms run with approvals bypassed, so a
      // malformed reasoner reply became an instruction executed against
      // the user's machine. A plan we cannot read is a planning
      // failure; submitGoal reports it and the goal stops here.
      throw new Error('Reasoner did not return a usable task plan');
    }
    if (json.tasks.length === 0) {
      throw new Error('Reasoner returned an empty task plan');
    }

    // Validate and normalize tasks
    var tasks = json.tasks.map(function (t, idx) {
      return {
        description: t.description || 'Task ' + (idx + 1),
        agentType: t.agentType || 'claude',
        targetCwd: t.targetCwd || '',
        prompt: t.prompt || t.description || '',
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      };
    });

    return { tasks: tasks };
  }

  /**
   * Parse a turn assessment.
   *
   * Defaults to 'done' when the reply is unreadable. Failing open on a
   * parse error is deliberate here: the alternative is manufacturing a
   * failure, which would replan or escalate work that may well have
   * succeeded. An unreadable assessment is an absence of evidence.
   */
  _parseAssessment(response, canAnswer) {
    var json = this._extractJson(response);
    if (!json || typeof json.verdict !== 'string') {
      return { verdict: 'done', summary: 'Could not parse assessment', answer: null };
    }
    var verdict = json.verdict;
    if (verdict !== 'done' && verdict !== 'needs_input' && verdict !== 'failed') {
      return { verdict: 'done', summary: 'Unknown verdict: ' + verdict, answer: null };
    }
    var answer = typeof json.answer === 'string' && json.answer.trim() ? json.answer : null;
    // needs_input without an answer, or with no turn left to spend it
    // on, is just a failure the coordinator has to route elsewhere.
    if (verdict === 'needs_input' && (!answer || !canAnswer)) {
      return {
        verdict: 'failed',
        summary: json.summary || 'Agent needs input that cannot be supplied',
        answer: null,
      };
    }
    return {
      verdict: verdict,
      summary: json.summary || '',
      answer: verdict === 'needs_input' ? answer : null,
    };
  }

  /**
   * Extract JSON from a potentially messy LLM response.
   */
  _extractJson(text) {
    if (!text) return null;
    // Try direct parse
    try { return JSON.parse(text.trim()); } catch {}
    // Try extracting from code fences
    var match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch {}
    }
    // Try finding first { ... } block
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    return null;
  }

  /**
   * Refuse further reasoning and cancel any run still in flight.
   */
  destroy() {
    this._destroyed = true;
    for (var id of this._inflight) {
      try { this.runner.cancel(id); } catch {}
    }
    this._inflight.clear();
  }
}

/**
 * Describe a stop reason for the assessment prompt. Unknown values are
 * reported as unknown rather than echoed, since they come from an
 * agent process.
 */
function describeStopReason(reason) {
  if (!reason) return 'unknown (this agent does not report it)';
  return STOP_REASON_TEXT[reason] || 'unknown';
}

/**
 * Coerce to a positive integer, or null. Used so a malformed env var
 * falls through to the default instead of producing NaN deadlines.
 */
function positiveInt(value) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

module.exports = { Reasoner, REASONER_SOURCE };
