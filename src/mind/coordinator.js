/**
 * Coordinator — goal/task lifecycle management for the Alien Mind.
 *
 * Receives goals from the user, asks the Reasoner to plan, dispatches
 * each task as an isolated one-shot agent run through OneShotAgentRunner,
 * captures the result, and feeds it as context to dependent tasks.
 *
 * Why one-shot (and not multi-turn + pool reuse)
 *
 *   The mind is conceptually a planner that calls polpo's own gateway.
 *   Each task = a self-contained prompt → result. The coordinator holds
 *   ALL the durable state (world-model, dependency graph, memory); each
 *   agent is a stateless function call that exists only long enough to
 *   process one prompt and terminate. This is the same lifecycle the
 *   HTTP gateway exposes to external apps (openclaw etc.), which means
 *   both call sites inherit the same hardening (timeouts, fail-closed
 *   on approvals, source tags, structured spawn logs) for free.
 *
 *   Trade-off: no cross-prompt agent memory. Mitigated by the
 *   coordinator injecting predecessor task output into dependent task
 *   prompts (see _buildPredecessorContext) and by the world-model + memory
 *   modules carrying state across the goal's lifetime.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { makeLogger } = require('../util/logger');

const log = makeLogger('mind-coordinator');

class Coordinator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {object} opts.worldModel - WorldModel instance
   * @param {object} opts.reasoner - Reasoner instance
   * @param {object} opts.runner - OneShotAgentRunner (REQUIRED): every
   *   task is dispatched as an isolated runner.run() call. The runner
   *   owns the spawn/timeout/teardown lifecycle; the coordinator only
   *   composes prompts and consumes results.
   * @param {object} [opts.memory] - Memory instance for long-term goal history
   * @param {object} [opts.goalStore] - GoalStore for in-flight goal persistence
   * @param {string} opts.mindInstanceId - The mind's own instance ID for reporting
   * @param {object} [opts.policy] - Policy object (for taskTimeoutMs etc.)
   */
  constructor(opts) {
    super();
    if (!opts || !opts.runner) {
      throw new Error('Coordinator requires a OneShotAgentRunner via opts.runner');
    }
    this.instanceManager = opts.instanceManager;
    this.worldModel = opts.worldModel;
    this.reasoner = opts.reasoner;
    this.runner = opts.runner;
    this.memory = opts.memory || null;
    this.goalStore = opts.goalStore || null;
    this.mindInstanceId = opts.mindInstanceId;
    this.policy = opts.policy || null;

    this._goals = new Map();         // goalId -> Goal
    this._taskToAgent = new Map();   // agentId -> taskId (live runs only)
  }

  /**
   * Emit a structured event for this goal so external subscribers
   * (gateway SSE, dashboard add-ons) can observe progress without
   * scraping the mind's conversation. Every transition that we already
   * report via `_report(...)` also gets an emit so the dashboard text
   * and the structured stream stay in lock-step.
   */
  _emitGoalEvent(goalId, type, data) {
    if (!goalId || !type) return;
    var payload = { goalId: goalId, type: type, timestamp: Date.now() };
    if (data && typeof data === 'object') {
      for (var k in data) payload[k] = data[k];
    }
    this.emit('goal:event', payload);
  }

  /**
   * Submit a new goal for planning and execution.
   * @param {string} prompt - The user's goal
   * @returns {Promise<{ goalId: string }>}
   */
  async submitGoal(prompt) {
    var goalId = 'goal-' + uuidv4().slice(0, 8);
    var goal = {
      id: goalId,
      prompt: prompt,
      status: 'planning',
      plan: null,
      result: null,
      createdAt: Date.now(),
    };
    this._goals.set(goalId, goal);
    this._persistGoalState(goal);

    // Don't echo the entire prompt — the user just typed it, it's
    // already in their bubble above, and dumping it back as the mind's
    // "first reply" clutters the chat for long goals. The structured
    // goal:event below still carries the full prompt for any SSE
    // consumer that needs it.
    this._report('Planning your goal…');
    this._emitGoalEvent(goalId, 'planning', { prompt: prompt });

    try {
      var worldSummary = this.worldModel.getSummary();
      // Inject relevant memories from past goals into the context
      if (this.memory) {
        var results = this.memory.search(prompt, 5);
        if (results.length > 0) {
          var memoryBlock = this.memory.formatForContext(results);
          worldSummary = worldSummary + '\n\n' + memoryBlock;
        }
      }
      var plan = await this.reasoner.plan(worldSummary, prompt);
      goal.plan = this._buildTaskPlan(goalId, plan);
      goal.status = 'running';
      this._persistGoalState(goal);

      this._report('Plan ready (' + goal.plan.tasks.length + ' task' +
        (goal.plan.tasks.length !== 1 ? 's' : '') + '):\n' +
        goal.plan.tasks.map(function (t, i) {
          return (i + 1) + '. ' + t.description;
        }).join('\n'));
      this._emitGoalEvent(goalId, 'plan_ready', {
        tasks: goal.plan.tasks.map(function (t) {
          return {
            id: t.id,
            description: t.description,
            agentType: t.agentType,
            targetCwd: t.targetCwd,
            dependsOn: (t.dependsOn || []).slice(),
          };
        }),
      });

      this._dispatchReadyTasks(goalId);
      return { goalId: goalId };

    } catch (err) {
      goal.status = 'failed';
      goal.result = 'Planning failed: ' + err.message;
      this._persistGoalState(goal);
      this._report('Planning failed: ' + err.message);
      this._emitGoalEvent(goalId, 'error', { message: 'planning_failed', detail: err.message });
      return { goalId: goalId };
    }
  }

  /**
   * Build internal task objects from the reasoner's plan.
   */
  _buildTaskPlan(goalId, plan) {
    var tasks = (plan.tasks || []).map(function (t, idx) {
      return {
        id: 'task-' + uuidv4().slice(0, 8),
        index: idx,
        goalId: goalId,
        description: t.description,
        agentType: t.agentType || 'claude',
        targetCwd: t.targetCwd || '',
        prompt: t.prompt,
        dependsOn: (t.dependsOn || []).slice(), // indices of tasks this depends on
        status: 'pending',
        agentId: null,
        result: null,
        output: null, // Last assistant text from the arm (captured on completion)
        timeoutMs: 300000, // 5 min default
        startedAt: null,
        completedAt: null,
        replanCount: 0, // Number of times this task has been re-planned
      };
    });

    return { tasks: tasks };
  }

  /**
   * Maximum re-plans per task (to prevent infinite loops).
   */
  get MAX_REPLANS() { return 2; }

  /**
   * Build a context block from completed predecessor tasks, to prepend
   * to a dependent task's prompt. This is how arms share findings:
   * the mind brokers information between them.
   *
   * @param {object} task - the task about to be dispatched
   * @param {Array} allTasks - all tasks in the plan
   * @returns {string} context block (may be empty)
   */
  _buildPredecessorContext(task, allTasks) {
    if (!task.dependsOn || task.dependsOn.length === 0) return '';

    var blocks = [];
    for (var i = 0; i < task.dependsOn.length; i++) {
      var depIdx = task.dependsOn[i];
      if (depIdx < 0 || depIdx >= allTasks.length) continue;
      var dep = allTasks[depIdx];
      if (dep.status !== 'completed' || !dep.output) continue;

      // Truncate each predecessor's output to keep the combined prompt
      // within reasonable token bounds (~8k chars total for all deps).
      var maxPerDep = Math.floor(8000 / task.dependsOn.length);
      var output = dep.output.length > maxPerDep
        ? dep.output.slice(0, maxPerDep) + '\n... (output truncated)'
        : dep.output;

      blocks.push(
        '<task index="' + depIdx + '" description="' + this._escapeAttr(dep.description) + '">\n' +
        output + '\n' +
        '</task>'
      );
    }

    if (blocks.length === 0) return '';

    return '<previous_task_results>\n' +
      'The following tasks completed before yours. Their outputs are provided as context.\n' +
      'Use them to inform your work on the current task.\n\n' +
      blocks.join('\n\n') + '\n' +
      '</previous_task_results>\n\n';
  }

  /**
   * Escape a string for use inside an XML attribute.
   */
  _escapeAttr(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Extract the final assistant text output from an agent's conversation.
   * This captures what the arm actually produced, used as context for
   * dependent tasks.
   */
  _extractAgentOutput(agentId) {
    var conversation = this.worldModel.getAgentConversation(agentId, 20);
    if (!conversation || conversation.length === 0) return '';

    // Walk backwards and collect consecutive assistant text messages
    // until we hit a non-assistant message. This captures the arm's
    // final response (which may span multiple text blocks).
    var assistantTexts = [];
    for (var i = conversation.length - 1; i >= 0; i--) {
      var m = conversation[i];
      if (m.role === 'assistant' && (!m.contentType || m.contentType === 'text') && m.content) {
        assistantTexts.unshift(m.content);
      } else if (assistantTexts.length > 0) {
        // Stop once we've hit a non-assistant message after finding some
        break;
      }
    }

    return assistantTexts.join('\n\n').trim();
  }

  /**
   * Dispatch tasks that have all dependencies met.
   */
  _dispatchReadyTasks(goalId) {
    var goal = this._goals.get(goalId);
    if (!goal || goal.status !== 'running') return;

    var tasks = goal.plan.tasks;
    var self = this;

    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      if (task.status !== 'pending') continue;

      // Check if all dependencies are completed
      var ready = true;
      for (var j = 0; j < task.dependsOn.length; j++) {
        var depIdx = task.dependsOn[j];
        if (depIdx >= 0 && depIdx < tasks.length) {
          if (tasks[depIdx].status !== 'completed') {
            ready = false;
            break;
          }
        }
      }

      if (ready) {
        this._assignTask(task);
      }
    }
  }

  /**
   * Dispatch a task as an isolated one-shot agent run.
   *
   * Each call spawns a fresh agent via the shared runner, sends ONE
   * composed prompt (predecessor context + task prompt), waits for the
   * agent to go idle, captures the result, and tears the agent down.
   * No pool, no reuse. The coordinator holds the only durable state.
   */
  _assignTask(task) {
    var self = this;

    // Build the final prompt: predecessor context + task prompt.
    // The mind brokers information between arms by serialising prior
    // task outputs into this block; since the agent is one-shot it has
    // no other way to know what previous arms produced.
    var goal = this._goals.get(task.goalId);
    var contextBlock = goal && goal.plan
      ? this._buildPredecessorContext(task, goal.plan.tasks)
      : '';
    var finalPrompt = contextBlock + task.prompt;

    var cwd = task.targetCwd && task.targetCwd.trim()
      ? task.targetCwd
      : process.cwd();

    var goalIdShort = (task.goalId || '').slice(-8);
    var sourceTag = 'mind:' + goalIdShort;
    var displayName = 'Mind arm: ' + task.description.slice(0, 60);

    task.status = 'running';
    task.startedAt = Date.now();

    // Fire-and-forget. The runner's onTerminal callback finalises the
    // task synchronously inside the same tick as the triggering event,
    // so getActiveGoals() reflects state correctly without a microtask
    // wait.
    this.runner.run({
      agentType: task.agentType,
      cwd: cwd,
      prompt: finalPrompt,
      name: displayName,
      source: sourceTag,
      timeoutMs: task.timeoutMs,

      onSpawn: function (agentInstanceId) {
        task.agentId = agentInstanceId;
        self._taskToAgent.set(agentInstanceId, task.id);
        // Mirror the prompt into the arm's conversation so the dashboard
        // shows what the mind asked for. The unprefixed prompt is what
        // the user sees — keeping it free of the predecessor context
        // block, which is internal plumbing.
        try {
          self.instanceManager.addMessage(agentInstanceId, {
            role: 'user',
            content: task.prompt,
            source: 'mind',
          });
        } catch {}
        var inst = self.instanceManager.get(agentInstanceId);
        var name = inst ? (inst.name || agentInstanceId) : agentInstanceId;
        self._report('Assigned to ' + name + ': ' + task.description);
        self._emitGoalEvent(task.goalId, 'task_started', {
          taskId: task.id,
          description: task.description,
          agentInstanceId: agentInstanceId,
          agentName: name,
          agentType: task.agentType,
        });
      },

      onChunk: function (text) {
        // Relay assistant text to goal:event consumers (gateway SSE,
        // dashboard add-ons). The runner already feeds chunks into the
        // agent's conversation via the instance manager, so the
        // dashboard chat view continues to work unchanged.
        self._emitGoalEvent(task.goalId, 'task_chunk', {
          taskId: task.id,
          text: text,
        });
      },

      onApproval: function (req) {
        // Surface the request so SSE consumers know the agent paused.
        // The runner itself will then fail the run with
        // status='failed', error='approval_required', which lands us
        // in _failTask via onTerminal below. The mind's policy is to
        // bypass approvals (autoApprove=true); reaching this path
        // means something escaped the bypass.
        self._emitGoalEvent(task.goalId, 'task_approval_needed', {
          taskId: task.id,
          request: req,
        });
      },

      onTerminal: function (result) {
        if (task.agentId) self._taskToAgent.delete(task.agentId);
        // Idempotent: if some other path already finalised this task
        // (cancelGoal, watcher failAgentTask invoked _failTask before
        // cancelling), don't clobber that decision. We just released
        // our id mapping above; the rest is already done.
        if (task.status !== 'running') return;
        if (result.status === 'completed') {
          self._completeTask(task, result.output || '');
        } else if (result.status === 'cancelled') {
          // Treat cancel as a normal failure path; no retry/replan,
          // the caller (cancelGoal / failAgentTask) already decided.
          self._markTaskCancelled(task, result.error || 'cancelled');
        } else {
          self._failTask(task.id, result.error || 'agent_run_failed');
        }
      },
    }).catch(function (err) {
      // Only programmer-style errors reach here (bad opts, spawn
      // failure before the lifecycle starts). Normal failures go via
      // onTerminal above.
      if (task.agentId) self._taskToAgent.delete(task.agentId);
      self._failTask(task.id, (err && err.message) || 'run_init_failed');
    });
  }

  /**
   * Mark a task as cancelled (via cancelGoal or watcher abort) without
   * triggering the replan path. Cancellation is an external decision
   * already taken by the caller; replanning would undo it.
   */
  _markTaskCancelled(task, reason) {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;
    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = { success: false, summary: 'Cancelled: ' + reason };
    this._report('Cancelled: ' + task.description + ' (' + reason + ')');
    this._emitGoalEvent(task.goalId, 'task_failed', {
      taskId: task.id, reason: reason, terminal: true, cancelled: true,
    });
    this._checkGoalCompletion(task.goalId);
  }

  /**
   * Mark a task as completed and evaluate.
   *
   * @param {object} task
   * @param {string} [output] - assistant text captured by the runner.
   *   The runner is the source of truth: by the time onTerminal fires
   *   the arm is already unregistered and the world-model has no
   *   conversation to walk, so we take the runner's snapshot as-is.
   */
  _completeTask(task, output) {
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = { success: true, summary: 'Completed' };

    // Capture the arm's output text so dependent tasks can use it as context.
    // This is the 'brokering' that lets the mind share findings between arms.
    task.output = typeof output === 'string' ? output : '';

    var duration = task.completedAt - (task.startedAt || task.completedAt);
    var durationStr = duration < 60000
      ? Math.round(duration / 1000) + 's'
      : Math.round(duration / 60000) + 'min';

    this._report('Completed (' + durationStr + '): ' + task.description);
    this._emitGoalEvent(task.goalId, 'task_done', {
      taskId: task.id,
      success: true,
      summary: (task.output || '').slice(-1000),
      durationMs: duration,
    });

    // Dispatch dependent tasks and check goal completion synchronously
    // so the coordinator state is consistent before returning
    this._checkGoalCompletion(task.goalId);
    this._dispatchReadyTasks(task.goalId);

    // Evaluate asynchronously (non-blocking, updates result after the fact)
    var self = this;
    var conversation = this.worldModel.getAgentConversation(task.agentId, 10);
    if (conversation.length > 0) {
      this.reasoner.evaluate(task.description, conversation).then(function (evaluation) {
        task.result = evaluation;
      }).catch(function () {});
    }
  }

  /**
   * Mark a task as failed.
   */
  _failTask(taskId, reason) {
    var task = this._findTask(taskId);
    if (!task || task.status !== 'running') return;

    // Capture any partial output before clearing state (used for re-planning)
    var partialOutput = task.agentId ? this._extractAgentOutput(task.agentId) : '';

    // Clean up task state — the runner already stopped the agent before
    // calling onTerminal, so we just drop our id mapping here.
    if (task.agentId) {
      this._taskToAgent.delete(task.agentId);
    }

    // Try to re-plan before giving up, up to MAX_REPLANS times
    if (task.replanCount < this.MAX_REPLANS) {
      this._attemptReplan(task, reason, partialOutput);
      return;
    }

    // Out of retries: mark task as failed
    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = { success: false, summary: reason };

    this._report('Failed (no more retries): ' + task.description + '\n  ' + reason);
    this._emitGoalEvent(task.goalId, 'task_failed', { taskId: task.id, reason: reason, terminal: true });
    this._checkGoalCompletion(task.goalId);
  }

  /**
   * Ask the reasoner how to recover from a failed task, then apply
   * the recovery strategy (retry, split into replacement tasks, or abandon).
   */
  async _attemptReplan(task, failureReason, partialOutput) {
    var self = this;
    var goal = this._goals.get(task.goalId);
    if (!goal || !goal.plan) {
      return this._markAbandoned(task, failureReason);
    }

    task.replanCount++;
    // Transitional state so goal completion check waits for the recovery decision
    task.status = 'replanning';

    this._report('Re-planning (attempt ' + task.replanCount + '/' + this.MAX_REPLANS + '): ' + task.description + '\n  Reason: ' + failureReason);
    this._emitGoalEvent(task.goalId, 'replanning', {
      taskId: task.id,
      attempt: task.replanCount,
      maxAttempts: this.MAX_REPLANS,
      reason: failureReason,
    });

    var completedTasks = goal.plan.tasks.filter(function (t) { return t.status === 'completed'; });

    try {
      var recovery = await this.reasoner.replan({
        goalPrompt: goal.prompt,
        failedTask: {
          description: task.description,
          prompt: task.prompt,
          agentType: task.agentType,
          targetCwd: task.targetCwd,
        },
        failureReason: failureReason,
        partialOutput: partialOutput,
        completedTasks: completedTasks,
      });

      if (recovery.action === 'retry' && recovery.prompt) {
        // Replace the task's prompt with the revised one, re-queue it
        task.prompt = recovery.prompt;
        task.status = 'pending';
        task.agentId = null;
        task.result = null;
        task.startedAt = null;
        task.completedAt = null;
        this._report('Retrying with revised approach: ' + task.description);
        this._dispatchReadyTasks(task.goalId);
        return;
      }

      if (recovery.action === 'split' && recovery.tasks && recovery.tasks.length > 0) {
        this._applySplit(task, recovery.tasks);
        this._report('Split into ' + recovery.tasks.length + ' subtasks:\n' +
          recovery.tasks.map(function (t, i) { return '  ' + (i + 1) + '. ' + t.description; }).join('\n'));
        this._dispatchReadyTasks(task.goalId);
        return;
      }

      // abandon
      return this._markAbandoned(task, recovery.reason || failureReason);

    } catch (err) {
      return this._markAbandoned(task, 'Re-plan failed: ' + err.message);
    }
  }

  /**
   * Replace a failed task with N replacement tasks. The replacements inherit
   * the original's dependents (tasks that depended on the original now depend
   * on the last replacement in the chain, so they run sequentially).
   */
  _applySplit(originalTask, newTaskSpecs) {
    var goal = this._goals.get(originalTask.goalId);
    if (!goal || !goal.plan) return;

    var originalIdx = originalTask.index;
    // Mark the original as completed (its replacements will carry the work forward).
    // We don't mark it 'failed' because that would cascade to its dependents.
    originalTask.status = 'completed';
    originalTask.completedAt = Date.now();
    originalTask.result = { success: false, summary: 'Replaced by ' + newTaskSpecs.length + ' recovery subtasks' };
    originalTask.output = null;

    // Create replacement tasks: first depends on originalTask's deps, subsequent
    // depend on the previous replacement. This chain runs sequentially.
    var replacements = [];
    for (var i = 0; i < newTaskSpecs.length; i++) {
      var spec = newTaskSpecs[i];
      var replIdx = goal.plan.tasks.length + i;
      var deps = i === 0
        ? originalTask.dependsOn.slice()
        : [goal.plan.tasks.length + i - 1];
      replacements.push({
        id: 'task-' + uuidv4().slice(0, 8),
        index: replIdx,
        goalId: originalTask.goalId,
        description: spec.description,
        agentType: spec.agentType || originalTask.agentType,
        targetCwd: spec.targetCwd || originalTask.targetCwd,
        prompt: spec.prompt,
        dependsOn: deps,
        status: 'pending',
        agentId: null,
        result: null,
        output: null,
        timeoutMs: originalTask.timeoutMs,
        startedAt: null,
        completedAt: null,
        replanCount: 0,
      });
    }

    // Append replacements to the plan. Any task that previously depended on
    // originalIdx now needs to wait for the LAST replacement, so retarget
    // those deps from originalIdx to (last replacement's index).
    var lastReplIdx = goal.plan.tasks.length + replacements.length - 1;
    for (var j = 0; j < goal.plan.tasks.length; j++) {
      var t = goal.plan.tasks[j];
      if (t === originalTask) continue;
      if (!t.dependsOn) continue;
      for (var k = 0; k < t.dependsOn.length; k++) {
        if (t.dependsOn[k] === originalIdx) t.dependsOn[k] = lastReplIdx;
      }
    }

    goal.plan.tasks = goal.plan.tasks.concat(replacements);
  }

  _markAbandoned(task, reason) {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = { success: false, summary: 'Abandoned: ' + reason };
    this._report('Abandoned: ' + task.description + '\n  ' + reason);
    this._emitGoalEvent(task.goalId, 'task_failed', { taskId: task.id, reason: reason, terminal: true, abandoned: true });
    this._checkGoalCompletion(task.goalId);
  }

  /**
   * Check if all tasks in a goal are done.
   */
  _checkGoalCompletion(goalId) {
    var goal = this._goals.get(goalId);
    if (!goal || goal.status !== 'running') return;

    var tasks = goal.plan.tasks;
    var allDone = true;
    var anyFailed = false;

    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].status === 'pending' || tasks[i].status === 'running' || tasks[i].status === 'assigned' || tasks[i].status === 'acquiring' || tasks[i].status === 'replanning') {
        allDone = false;
      }
      if (tasks[i].status === 'failed') {
        anyFailed = true;
      }
    }

    // Snapshot task-level progress so recovery can report partial completion
    this._persistGoalState(goal);

    if (allDone) {
      goal.status = anyFailed ? 'failed' : 'completed';
      goal.result = anyFailed
        ? 'Some tasks failed. Check individual task results.'
        : 'All tasks completed successfully.';

      this._report(goal.status === 'completed'
        ? 'Goal completed: ' + goal.prompt
        : 'Goal partially failed: ' + goal.prompt);

      // Persist to memory so future goals can benefit from past work
      this._persistGoalToMemory(goal);

      // Remove from the in-flight store (no longer pending across restart)
      this._persistGoalState(goal);

      // Granular event for /v1/goals SSE consumers. Includes the per-task
      // summaries so a caller that joined late can rebuild what happened.
      var taskSummaries = (goal.plan && goal.plan.tasks) ? goal.plan.tasks.map(function (t) {
        return {
          id: t.id,
          description: t.description,
          status: t.status,
          summary: (t.result && t.result.summary) || null,
          durationMs: (t.startedAt && t.completedAt) ? (t.completedAt - t.startedAt) : null,
        };
      }) : [];
      this._emitGoalEvent(goalId, 'done', {
        status: goal.status,
        result: goal.result,
        taskSummaries: taskSummaries,
        durationMs: Date.now() - goal.createdAt,
      });

      this.emit('goal:completed', { goalId: goalId, status: goal.status });
    }
  }

  /**
   * Write a completed goal to long-term memory.
   */
  _persistGoalToMemory(goal) {
    if (!this.memory) return;
    try {
      var summaries = [];
      if (goal.plan && Array.isArray(goal.plan.tasks)) {
        for (var i = 0; i < goal.plan.tasks.length; i++) {
          var t = goal.plan.tasks[i];
          var status = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '·';
          // Prefer the evaluation summary over the raw output (shorter, distilled)
          var detail = (t.result && t.result.summary) || '';
          var line = status + ' ' + t.description;
          if (detail) line += ' — ' + detail;
          summaries.push(line);
        }
      }

      var outcome = goal.status === 'completed' ? 'completed'
        : goal.status === 'failed' ? 'failed'
        : 'partial';

      var durationMs = 0;
      if (goal.plan && goal.plan.tasks.length > 0) {
        var starts = goal.plan.tasks.map(function (t) { return t.startedAt || 0; }).filter(function (n) { return n > 0; });
        var ends = goal.plan.tasks.map(function (t) { return t.completedAt || 0; }).filter(function (n) { return n > 0; });
        if (starts.length > 0 && ends.length > 0) {
          durationMs = Math.max.apply(null, ends) - Math.min.apply(null, starts);
        }
      }

      this.memory.save({
        type: 'goal',
        goalPrompt: goal.prompt,
        outcome: outcome,
        taskCount: goal.plan ? goal.plan.tasks.length : 0,
        taskSummaries: summaries,
        durationMs: durationMs,
      });
    } catch (err) {
      // Memory persistence is non-critical — log and continue
      log.error('Failed to persist goal to memory:', err.message);
    }
  }

  /**
   * Find a task by ID across all goals.
   */
  _findTask(taskId) {
    for (var entry of this._goals) {
      var goal = entry[1];
      if (!goal.plan) continue;
      for (var i = 0; i < goal.plan.tasks.length; i++) {
        if (goal.plan.tasks[i].id === taskId) return goal.plan.tasks[i];
      }
    }
    return null;
  }

  /**
   * Cancel a goal and abort all running tasks via the runner.
   *
   * Each running task gets cancelled through the runner, which aborts
   * the agent and synchronously fires the task's onTerminal callback
   * with status='cancelled'. That in turn marks the task failed via
   * _markTaskCancelled; we just have to handle pending tasks ourselves.
   */
  cancelGoal(goalId) {
    var goal = this._goals.get(goalId);
    if (!goal) return;

    if (goal.plan) {
      for (var i = 0; i < goal.plan.tasks.length; i++) {
        var task = goal.plan.tasks[i];
        if (task.status === 'running' && task.agentId) {
          // Runner.cancel triggers onTerminal -> _markTaskCancelled;
          // status flips to 'failed' synchronously.
          try { this.runner.cancel(task.agentId); } catch (err) {}
        } else if (task.status === 'pending') {
          // Pending tasks never reached the runner; mark them directly.
          task.status = 'failed';
          task.result = { success: false, summary: 'Cancelled' };
        }
      }
    }

    goal.status = 'failed';
    goal.result = 'Cancelled by user';
    this._persistGoalState(goal);
    this._report('Goal cancelled: ' + goal.prompt);
    this._emitGoalEvent(goalId, 'cancelled', { reason: 'cancelled_by_user' });
  }

  /**
   * Public hook for the watcher: declare that the task currently running on
   * an arm should be considered failed (e.g. because the arm is stuck).
   * Aborts the arm, then triggers the normal failure path which may re-plan.
   *
   * @param {string} agentId
   * @param {string} reason
   * @returns {boolean} true if a task was found and failed
   */
  failAgentTask(agentId, reason) {
    if (!agentId) return false;
    var taskId = this._taskToAgent.get(agentId);
    if (!taskId) return false;
    var task = this._findTask(taskId);
    if (!task || task.status !== 'running') return false;
    // Mark the task failed (entering the replan path) BEFORE cancelling
    // the agent. The runner's onTerminal callback will then see the
    // task already-non-running and bail out, which leaves the replan
    // flow intact.
    this._failTask(taskId, reason || 'Auto-cancelled by watcher');
    try { this.runner.cancel(agentId); } catch (err) {}
    return true;
  }

  /**
   * Get all active goals.
   */
  getActiveGoals() {
    var goals = [];
    for (var entry of this._goals) {
      goals.push(entry[1]);
    }
    return goals;
  }

  /**
   * Persist the goal to the in-flight store, or remove it if terminal.
   * No-op if no store was configured.
   */
  _persistGoalState(goal) {
    if (!this.goalStore || !goal) return;
    try {
      if (goal.status === 'completed' || goal.status === 'failed') {
        this.goalStore.remove(goal.id);
      } else {
        this.goalStore.upsert(goal);
      }
    } catch (err) {
      log.error('Goal store write failed:', err.message);
    }
  }

  /**
   * Recover goals that were in-flight at the time of the last shutdown.
   * Arms cannot survive a restart, so we mark each as 'interrupted',
   * write a summary to long-term memory, notify the user, and clear
   * the store. Returns the list of recovered goal IDs.
   */
  recoverInterruptedGoals() {
    if (!this.goalStore) return [];
    var stored = this.goalStore.getAll();
    if (stored.length === 0) return [];

    var self = this;
    var recovered = [];
    stored.forEach(function (snap) {
      if (!snap || !snap.prompt) return;
      // Mark a synthetic goal as failed/interrupted so memory captures it
      var ghost = {
        id: snap.id,
        prompt: snap.prompt,
        status: 'failed',
        plan: snap.plan,
        result: 'Interrupted by server restart',
        createdAt: snap.createdAt || Date.now(),
      };
      try {
        self._persistGoalToMemory(ghost);
      } catch (err) {
        log.error('Failed to log interrupted goal:', err.message);
      }
      recovered.push(snap.id);
    });

    // Build a single user-facing report rather than one per goal
    var lines = stored.map(function (snap) {
      var taskInfo = '';
      if (snap.plan && Array.isArray(snap.plan.tasks)) {
        var done = snap.plan.tasks.filter(function (t) { return t.status === 'completed'; }).length;
        taskInfo = ' (' + done + '/' + snap.plan.tasks.length + ' tasks completed)';
      }
      return '- ' + snap.prompt + taskInfo;
    });
    this._report('Recovered ' + stored.length + ' interrupted goal' +
      (stored.length !== 1 ? 's' : '') + ' from before restart:\n' + lines.join('\n') +
      '\n\nArms could not be resumed; resubmit if you want to retry.');

    this.goalStore.clear();
    return recovered;
  }

  /**
   * Send a message to the mind's conversation for the user to see.
   */
  _report(text) {
    this.instanceManager.addMessage(this.mindInstanceId, {
      role: 'assistant',
      content: text,
      source: 'mind',
    });
  }

  /**
   * Clean up event listeners and timeouts.
   */
  destroy() {
    // The runner owns instance-manager listener subscriptions and the
    // per-task timeouts; we just clear our own bookkeeping. The runner
    // itself is owned by the mind module (index.js) and is destroyed
    // by it, which aborts any in-flight runs.
    this._goals.clear();
    this._taskToAgent.clear();
    this.removeAllListeners();
  }
}

module.exports = { Coordinator };
