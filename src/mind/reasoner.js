/**
 * Reasoner — LLM-backed planning engine for the Alien Mind.
 *
 * Spawns a Claude Code process directly (not registered with the hub)
 * and uses it to decompose goals into task plans. The process stays
 * alive for reuse across multiple planning requests.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { v4: uuidv4 } = require('uuid');

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

var EVALUATE_PROMPT = [
  'You are evaluating whether a coding agent successfully completed a task.',
  'Given the task description and the agent\'s conversation, determine if the task was completed successfully.',
  '',
  'Respond ONLY with valid JSON:',
  '{ "success": true/false, "summary": "brief explanation" }',
].join('\n');

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
   * @param {string} [options.model] - Model override for reasoning
   * @param {string} [options.claudeBinary] - Path to claude binary
   */
  constructor(options) {
    if (!options) options = {};
    this.model = options.model || process.env.POLPO_MIND_MODEL || null;
    this.claudeBinary = options.claudeBinary || 'claude';
    this._process = null;
    this._rl = null;
    this._pending = null; // { resolve, reject, buffer }
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
   * Evaluate whether a task completed successfully.
   * @param {string} taskDescription
   * @param {Array} agentConversation - Last N messages from the agent
   * @returns {Promise<{ success: boolean, summary: string }>}
   */
  async evaluate(taskDescription, agentConversation) {
    var convText = agentConversation.map(function (m) {
      return (m.role || 'unknown') + ': ' + (m.content || '').slice(0, 500);
    }).join('\n');

    var prompt = EVALUATE_PROMPT + '\n\n' +
      'Task: ' + taskDescription + '\n\n' +
      'Agent conversation (last messages):\n' + convText + '\n\n' +
      'Respond with JSON only:';

    var response = await this._ask(prompt);
    return this._parseEvaluation(response);
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
   * Send a prompt to the Claude process and wait for a response.
   */
  _ask(prompt) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self._process) {
        self._spawn();
      }

      if (self._pending) {
        reject(new Error('Reasoner is busy'));
        return;
      }

      self._pending = { resolve: resolve, reject: reject, buffer: '' };

      var input = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      }) + '\n';

      if (self._process && self._process.stdin.writable) {
        self._process.stdin.write(input);
      } else {
        self._pending = null;
        reject(new Error('Reasoner process not writable'));
      }
    });
  }

  /**
   * Spawn the Claude process for reasoning.
   */
  _spawn() {
    var args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    if (this.model) {
      args.push('--model', this.model);
    }

    var nodeDir = path.dirname(process.execPath);
    var env = Object.assign({}, process.env);
    if (!env.PATH || !env.PATH.startsWith(nodeDir)) {
      env.PATH = nodeDir + ':' + (env.PATH || '');
    }

    this._process = spawn(this.claudeBinary, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
    });

    var self = this;

    this._rl = readline.createInterface({ input: this._process.stdout });
    this._rl.on('line', function (line) {
      if (!line.trim()) return;
      try {
        var msg = JSON.parse(line);
        self._handleMessage(msg);
      } catch {
        // Non-JSON line, ignore
      }
    });

    this._process.stderr.on('data', function () {});

    this._process.on('exit', function () {
      self._process = null;
      self._rl = null;
      if (self._pending) {
        var p = self._pending;
        self._pending = null;
        // Resolve with whatever we have in the buffer
        if (p.buffer) {
          p.resolve(p.buffer);
        } else {
          p.reject(new Error('Reasoner process exited'));
        }
      }
    });

    this._process.on('error', function (err) {
      if (self._pending) {
        var p = self._pending;
        self._pending = null;
        p.reject(err);
      }
    });
  }

  /**
   * Handle a message from the Claude process.
   */
  _handleMessage(msg) {
    if (!this._pending) return;

    if (msg.type === 'assistant') {
      // Accumulate text blocks
      var content = msg.message && msg.message.content;
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          if (content[i].type === 'text' && content[i].text) {
            this._pending.buffer += content[i].text;
          }
        }
      }
    } else if (msg.type === 'result') {
      // Turn complete, resolve with accumulated text
      var p = this._pending;
      this._pending = null;
      p.resolve(p.buffer);
    }
  }

  /**
   * Parse a task plan from the LLM response.
   */
  _parseTaskPlan(response) {
    var json = this._extractJson(response);
    if (!json || !Array.isArray(json.tasks)) {
      // Fallback: single task with the raw response as prompt
      return {
        tasks: [{
          description: 'Execute user goal',
          agentType: 'claude',
          targetCwd: '',
          prompt: response || 'No plan generated',
          dependsOn: [],
        }],
      };
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
   * Parse an evaluation from the LLM response.
   */
  _parseEvaluation(response) {
    var json = this._extractJson(response);
    if (!json) {
      return { success: true, summary: 'Could not evaluate (assuming success)' };
    }
    return {
      success: json.success !== false,
      summary: json.summary || 'No summary provided',
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
   * Kill the reasoning process and clean up.
   */
  destroy() {
    if (this._process) {
      try { this._process.kill('SIGTERM'); } catch {}
      this._process = null;
    }
    if (this._pending) {
      this._pending.reject(new Error('Reasoner destroyed'));
      this._pending = null;
    }
  }
}

module.exports = { Reasoner };
