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
   * @param {object} [opts]
   * @param {boolean} [opts.autoDispatch=false] - When true, the mind
   *   dispatches the plan as soon as the reasoner produces it (legacy
   *   fire-and-forget behaviour). When false (default for dashboard
   *   submissions), the mind posts the plan to chat and awaits an
   *   `/approve`, `/tweak <feedback>`, or `/abandon` reply from the user
   *   before dispatching. Gateway-originated goals MUST set
   *   autoDispatch:true because there is no human in the loop on that
   *   API surface.
   * @returns {Promise<{ goalId: string }>}
   */
  async submitGoal(prompt, opts) {
    var autoDispatch = !!(opts && opts.autoDispatch);
    var goalId = 'goal-' + uuidv4().slice(0, 8);
    var goal = {
      id: goalId,
      prompt: prompt,
      status: 'planning',
      plan: null,
      result: null,
      createdAt: Date.now(),
      autoDispatch: autoDispatch,
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
      var plan = await this._planFor(goal);
      goal.plan = this._buildTaskPlan(goalId, plan);

      if (autoDispatch) {
        goal.status = 'running';
        this._persistGoalState(goal);
        this._reportPlanReady(goal);
        this._emitPlanReady(goal);
        this._dispatchReadyTasks(goalId);
      } else {
        // Interactive mode: hold dispatch, post plan preview to chat
        // and remember this goal as the active pending question. The
        // next /approve, /tweak, or /abandon from the user lands here
        // via approvePlan/tweakPlan/abandonAwaitingPlan.
        goal.status = 'awaiting_approval';
        this._persistGoalState(goal);
        this._emitPlanReady(goal);
        this._pendingApprovalGoalId = goalId;
        this._reportPlanPreview(goal);
        this._emitGoalEvent(goalId, 'awaiting_approval', {
          tasks: goal.plan.tasks.map(this._serialiseTaskForEvent),
        });
      }
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
   * Generate (or regenerate) a plan for a goal, injecting any tweak
   * feedback the user supplied during the awaiting_approval round-trip
   * so the reasoner can revise the plan instead of starting from scratch.
   *
   * @param {object} goal
   * @param {string} [tweakFeedback]
   * @returns {Promise<{tasks: Array}>}  raw reasoner output, not internal task records
   */
  async _planFor(goal, tweakFeedback) {
    var worldSummary = this.worldModel.getSummary();
    if (this.memory) {
      var memHits = this.memory.search(goal.prompt, 5);
      if (memHits.length > 0) {
        worldSummary = worldSummary + '\n\n' + this.memory.formatForContext(memHits);
      }
    }
    var prompt = goal.prompt;
    if (tweakFeedback) {
      // Append the user's feedback to the prompt as guidance. We do this
      // rather than calling a separate replan() method so reasoners that
      // only implement plan() still work; replan() is reserved for
      // failure recovery on a specific task.
      prompt = goal.prompt +
        '\n\nFEEDBACK ON THE PREVIOUS PLAN (revise accordingly):\n' +
        tweakFeedback;
    }
    return this.reasoner.plan(worldSummary, prompt);
  }

  /**
   * User-facing chat: render the plan with explicit reply instructions.
   * Only used in interactive mode (awaiting_approval).
   */
  _reportPlanPreview(goal) {
    var lines = [
      'Plan ready (' + goal.plan.tasks.length + ' task' +
        (goal.plan.tasks.length !== 1 ? 's' : '') + '):',
      '',
    ];
    goal.plan.tasks.forEach(function (t, i) {
      lines.push('  ' + (i + 1) + '. ' + t.description);
    });
    lines.push('');
    lines.push('Reply:');
    lines.push('  /approve            — dispatch the plan as-is');
    lines.push('  /tweak <feedback>   — revise the plan with your feedback');
    lines.push('  /abandon            — cancel this goal');
    this._report(lines.join('\n'), [
      { label: 'Approve',  command: '/approve', kind: 'send',  style: 'primary' },
      { label: 'Tweak…',   command: '/tweak',   kind: 'input',
        inputPrompt: 'Tell the mind what to change about the plan…', style: 'secondary' },
      { label: 'Abandon',  command: '/abandon', kind: 'send',  style: 'danger' },
    ]);
  }

  /**
   * Render the plan-ready message used in auto-dispatch mode (no
   * approval gate). Backwards-compatible with v1.2.1 behaviour.
   */
  _reportPlanReady(goal) {
    this._report('Plan ready (' + goal.plan.tasks.length + ' task' +
      (goal.plan.tasks.length !== 1 ? 's' : '') + '):\n' +
      goal.plan.tasks.map(function (t, i) {
        return (i + 1) + '. ' + t.description;
      }).join('\n'));
  }

  _emitPlanReady(goal) {
    this._emitGoalEvent(goal.id, 'plan_ready', {
      tasks: goal.plan.tasks.map(this._serialiseTaskForEvent),
    });
  }

  _serialiseTaskForEvent(t) {
    return {
      id: t.id,
      description: t.description,
      agentType: t.agentType,
      targetCwd: t.targetCwd,
      dependsOn: (t.dependsOn || []).slice(),
    };
  }

  // ---- Interactive-mode action handlers ----
  //
  // The chat layer (src/mind/index.js) parses slash commands and calls
  // these. They are no-ops on goals whose status doesn't match the
  // expected state, so a stray /approve after a goal already dispatched
  // is silently ignored.

  /**
   * Accept the proposed plan and start dispatching arms.
   * @returns {boolean} true if a plan was approved
   */
  approvePlan(goalId) {
    var resolvedId = this._resolveGoalForApproval(goalId);
    if (!resolvedId) return false;
    var goal = this._goals.get(resolvedId);
    if (!goal || goal.status !== 'awaiting_approval') return false;
    goal.status = 'running';
    this._persistGoalState(goal);
    if (this._pendingApprovalGoalId === resolvedId) {
      this._pendingApprovalGoalId = null;
    }
    this._report('Plan approved. Dispatching ' + goal.plan.tasks.length + ' arm' +
      (goal.plan.tasks.length !== 1 ? 's' : '') + '…');
    this._emitGoalEvent(resolvedId, 'plan_approved', {});
    this._dispatchReadyTasks(resolvedId);
    return true;
  }

  /**
   * Re-run the planner with the user's feedback layered on top of the
   * original goal prompt. Stays in awaiting_approval state.
   */
  async tweakPlan(goalId, feedback) {
    var resolvedId = this._resolveGoalForApproval(goalId);
    if (!resolvedId) return false;
    var goal = this._goals.get(resolvedId);
    if (!goal || goal.status !== 'awaiting_approval') return false;
    if (typeof feedback !== 'string' || !feedback.trim()) {
      this._report('Provide feedback after /tweak, e.g. `/tweak focus only on auth tests`.');
      return false;
    }
    this._report('Revising plan with your feedback…');
    this._emitGoalEvent(resolvedId, 'plan_tweak', { feedback: feedback });
    try {
      var revised = await this._planFor(goal, feedback);
      goal.plan = this._buildTaskPlan(resolvedId, revised);
      this._persistGoalState(goal);
      this._emitPlanReady(goal);
      this._reportPlanPreview(goal);
      return true;
    } catch (err) {
      this._report('Re-planning failed: ' + err.message + ' (the previous plan still stands; reply /approve or /abandon)');
      return false;
    }
  }

  /**
   * Cancel a goal that's still awaiting approval (never dispatched).
   * For an already-running goal use cancelGoal().
   */
  abandonAwaitingPlan(goalId) {
    var resolvedId = this._resolveGoalForApproval(goalId);
    if (!resolvedId) return false;
    var goal = this._goals.get(resolvedId);
    if (!goal || goal.status !== 'awaiting_approval') return false;
    goal.status = 'failed';
    goal.result = 'Abandoned before dispatch';
    this._persistGoalState(goal);
    if (this._pendingApprovalGoalId === resolvedId) {
      this._pendingApprovalGoalId = null;
    }
    this._report('Goal abandoned: ' + goal.prompt);
    this._emitGoalEvent(resolvedId, 'cancelled', { reason: 'abandoned_at_approval' });
    return true;
  }

  /**
   * If the user types /approve without an explicit goalId, resolve to
   * the most recently-staged awaiting_approval goal. Returns null if
   * nothing is waiting.
   */
  _resolveGoalForApproval(goalId) {
    // Strict-on-explicit-id: if the user typed `/approve goal-abc1234`
    // and that id doesn't exist, return null instead of silently
    // falling back to the pending one. The fallback is only for the
    // bare `/approve` case where the user didn't specify an id.
    if (goalId) {
      return this._goals.has(goalId) ? goalId : null;
    }
    if (this._pendingApprovalGoalId && this._goals.has(this._pendingApprovalGoalId)) {
      return this._pendingApprovalGoalId;
    }
    return null;
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

    // Evaluate asynchronously. Until v1.2.2 the evaluation result was
    // recorded on the task but never acted on, which meant an arm that
    // went idle with a refusal ("I can't do this because X") was
    // treated as a successful completion and its dependents proceeded
    // with the refusal text inlined as their predecessor context.
    //
    // Now: if the evaluation comes back failed AND no dependent has
    // started yet, route through the normal failure path so the
    // reasoner gets a chance to replan or — in interactive mode — the
    // user gets a chance to retry/skip/abandon.
    //
    // The "no dependent has started yet" guard is intentional. If a
    // dependent is already running (it consumed the refusal text and
    // chose to push forward), retroactively failing this task would
    // require cancelling the dependent and unwinding state, which is
    // bigger surgery than v1.2.2 is willing to do. v1.3 may move
    // evaluate to the synchronous critical path and gate dependents
    // on it.
    var self = this;
    var conversation = this.worldModel.getAgentConversation(task.agentId, 10);
    if (conversation.length > 0) {
      this.reasoner.evaluate(task.description, conversation).then(function (evaluation) {
        task.result = evaluation;
        if (evaluation && evaluation.success === false && self._noDependentsStarted(task)) {
          self._report('Evaluation failed for ' + task.description + ': ' + (evaluation.summary || 'no summary'));
          // Re-fail through the normal path. _failTask sees status not
          // === 'running' (it's 'completed' now) so we explicitly
          // re-set it to running so the failure handler accepts.
          task.status = 'running';
          self._failTask(task.id, 'evaluation: ' + (evaluation.summary || 'task did not produce a usable result'));
        }
      }).catch(function () {});
    }
  }

  /**
   * Returns true when no task that depends on `task` has yet started
   * running. Used by the evaluate-failure path to decide whether
   * re-failing the task is safe.
   */
  _noDependentsStarted(task) {
    var goal = this._goals.get(task.goalId);
    if (!goal || !goal.plan) return true;
    var tasks = goal.plan.tasks;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.dependsOn && t.dependsOn.indexOf(task.index) !== -1) {
        if (t.status !== 'pending') return false;
      }
    }
    return true;
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

    // Out of retries. In auto-dispatch mode (gateway, autonomous CI
    // workers) we still terminate the task here so the goal can
    // finish without a human in the loop. In interactive mode
    // (dashboard chat), we escalate to the user instead — they can
    // /retry <hint>, /skip, or /abandon the task.
    var goal = this._goals.get(task.goalId);
    if (goal && goal.autoDispatch) {
      task.status = 'failed';
      task.completedAt = Date.now();
      task.result = { success: false, summary: reason };
      this._report('Failed (no more retries): ' + task.description + '\n  ' + reason);
      this._emitGoalEvent(task.goalId, 'task_failed', { taskId: task.id, reason: reason, terminal: true });
      this._checkGoalCompletion(task.goalId);
      return;
    }

    this._escalateToUser(task, reason, partialOutput);
  }

  /**
   * Pause a task that the mind couldn't recover from and ask the user
   * what to do. Posts a chat message with /retry, /skip, /abandon
   * instructions and records this task as the active pending question
   * so a bare `/retry hint` (no taskId) lands on it.
   *
   * The task stays in 'awaiting_user_input' status and the goal does
   * NOT terminate. _checkGoalCompletion treats awaiting_user_input as
   * non-terminal so the goal sits in 'running' until the user resolves.
   */
  _escalateToUser(task, reason, partialOutput) {
    task.status = 'awaiting_user_input';
    task.completedAt = null;
    task.result = { success: false, summary: reason };
    task.escalationReason = reason;
    task.escalationPartialOutput = (partialOutput || '').slice(-2000);
    this._pendingEscalatedTaskId = task.id;

    var lines = [
      '🛑 Arm stuck on: ' + task.description,
      '',
      'Reason: ' + reason,
    ];
    if (task.escalationPartialOutput) {
      lines.push('');
      lines.push('Last output (truncated):');
      lines.push('  ' + task.escalationPartialOutput.split('\n').slice(-6).join('\n  '));
    }
    lines.push('');
    lines.push('Reply:');
    lines.push('  /retry <hint>   — re-run this arm with your guidance');
    lines.push('  /skip           — abandon this arm and cascade-fail its dependents');
    lines.push('  /abandon        — cancel the whole goal');
    this._report(lines.join('\n'), [
      { label: 'Retry…',  command: '/retry',   kind: 'input',
        inputPrompt: 'Give the arm guidance for this retry…', style: 'primary' },
      { label: 'Skip',    command: '/skip',    kind: 'send',  style: 'secondary' },
      { label: 'Abandon', command: '/abandon', kind: 'send',  style: 'danger' },
    ]);

    this._emitGoalEvent(task.goalId, 'task_escalated', {
      taskId: task.id,
      reason: reason,
      replanCount: task.replanCount,
    });
  }

  // ---- Interactive task-escalation handlers ----

  /**
   * User said /retry with optional hint. Resets the task and re-runs
   * it through the replan flow, feeding the hint to the reasoner as
   * additional context. Resets replanCount so the user's guidance
   * doesn't get penalised by the old failure budget.
   */
  async userRetryEscalatedTask(taskId, hint) {
    var resolvedId = this._resolveEscalatedTaskId(taskId);
    if (!resolvedId) return false;
    var task = this._findTask(resolvedId);
    if (!task || task.status !== 'awaiting_user_input') return false;
    var reason = task.escalationReason || 'previous attempt did not produce a usable result';
    var partialOutput = task.escalationPartialOutput || '';

    // Reset budget for the user-guided round so we don't immediately
    // fall back into escalation if the reasoner produces another
    // imperfect plan.
    task.replanCount = 0;
    task.status = 'running';        // _attemptReplan asserts non-terminal
    task.escalationReason = null;
    task.escalationPartialOutput = null;
    if (this._pendingEscalatedTaskId === resolvedId) {
      this._pendingEscalatedTaskId = null;
    }
    this._report('Retrying with your guidance: ' + task.description);
    this._emitGoalEvent(task.goalId, 'task_retry_requested', {
      taskId: task.id,
      hint: hint || null,
    });
    // Bake the hint into the failure-reason payload so the reasoner
    // sees it during replan.
    var augmentedReason = hint
      ? reason + '\n\nUSER GUIDANCE: ' + hint
      : reason;
    this._attemptReplan(task, augmentedReason, partialOutput);
    return true;
  }

  /**
   * User said /skip. Mark the task failed and cascade-fail its
   * transitive dependents so the goal can converge.
   */
  userSkipEscalatedTask(taskId) {
    var resolvedId = this._resolveEscalatedTaskId(taskId);
    if (!resolvedId) return false;
    var task = this._findTask(resolvedId);
    if (!task || task.status !== 'awaiting_user_input') return false;
    if (this._pendingEscalatedTaskId === resolvedId) {
      this._pendingEscalatedTaskId = null;
    }
    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = { success: false, summary: 'Skipped by user' };
    this._report('Skipped: ' + task.description);
    this._emitGoalEvent(task.goalId, 'task_failed', {
      taskId: task.id, reason: 'skipped_by_user', terminal: true, skipped: true,
    });
    this._cascadeFailDependents(task);
    this._checkGoalCompletion(task.goalId);
    return true;
  }

  /**
   * User said /abandon. Cancel the entire goal — same path as the
   * existing cancelGoal() (which handles running arms via runner.cancel)
   * but with a different audit message.
   */
  userAbandonEscalatedGoal(taskId) {
    var resolvedId = this._resolveEscalatedTaskId(taskId);
    if (!resolvedId) return false;
    var task = this._findTask(resolvedId);
    if (!task) return false;
    if (this._pendingEscalatedTaskId === resolvedId) {
      this._pendingEscalatedTaskId = null;
    }
    this.cancelGoal(task.goalId);
    return true;
  }

  /**
   * Walk the dependency graph and mark every task that transitively
   * depends on the skipped task as failed. Without this, dependents
   * would sit in 'pending' forever (waiting for a task that will
   * never complete) and _checkGoalCompletion would never converge.
   */
  _cascadeFailDependents(skippedTask) {
    var goal = this._goals.get(skippedTask.goalId);
    if (!goal || !goal.plan) return;
    var tasks = goal.plan.tasks;
    var blockedIndices = new Set();
    blockedIndices.add(skippedTask.index);

    // Iterate to fixed point — a dependent of a dependent is also
    // blocked. Plans are small enough (<50 tasks typically) for this
    // to be cheap.
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (blockedIndices.has(t.index)) continue;
        for (var d = 0; d < t.dependsOn.length; d++) {
          if (blockedIndices.has(t.dependsOn[d])) {
            blockedIndices.add(t.index);
            if (t.status === 'pending' || t.status === 'running') {
              t.status = 'failed';
              t.completedAt = Date.now();
              t.result = { success: false, summary: 'Cascade-failed: depends on a skipped task' };
              this._emitGoalEvent(t.goalId, 'task_failed', {
                taskId: t.id, reason: 'cascade_skipped', terminal: true,
              });
            }
            changed = true;
            break;
          }
        }
      }
    }
  }

  _resolveEscalatedTaskId(taskId) {
    if (taskId && this._findTask(taskId)) return taskId;
    if (this._pendingEscalatedTaskId && this._findTask(this._pendingEscalatedTaskId)) {
      return this._pendingEscalatedTaskId;
    }
    return null;
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
      if (tasks[i].status === 'pending' || tasks[i].status === 'running' || tasks[i].status === 'assigned' || tasks[i].status === 'acquiring' || tasks[i].status === 'replanning' || tasks[i].status === 'awaiting_user_input') {
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
  /**
   * Post an assistant message to the mind's conversation.
   *
   * `actions`, when present, is an array of structured button
   * descriptors the dashboard renders inline below the message body
   * instead of asking the user to type a slash command. Each entry is
   *   { label, command, kind?, inputPrompt? }
   * where `kind` is one of:
   *   - 'send'  (default): clicking dispatches `command` as a
   *     send_prompt. Use for /approve, /abandon, /skip — single-tap
   *     commands with no extra input.
   *   - 'input': clicking opens an inline text field. On submit, the
   *     dashboard concatenates `command` + a space + the user's text
   *     and dispatches that as a send_prompt. Use for /tweak,
   *     /retry — commands that need free-form follow-up.
   *
   * Older dashboards that don't know about `actions` ignore the field
   * silently and the user falls back to typing the command (the body
   * of the message still spells out the syntax).
   */
  _report(text, actions) {
    var msg = {
      role: 'assistant',
      content: text,
      source: 'mind',
    };
    if (Array.isArray(actions) && actions.length > 0) {
      msg.actions = actions;
    }
    this.instanceManager.addMessage(this.mindInstanceId, msg);
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
