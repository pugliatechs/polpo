/**
 * Coordinator — goal/task lifecycle management for the Alien Mind.
 *
 * Receives goals from the user, asks the Reasoner to plan, assigns
 * tasks to idle agents, monitors completion, and reports results.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class Coordinator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {object} opts.worldModel - WorldModel instance
   * @param {object} opts.reasoner - Reasoner instance
   * @param {object} [opts.agentPool] - AgentPool for spawning agents when no idle ones
   * @param {string} opts.mindInstanceId - The mind's own instance ID for reporting
   */
  constructor(opts) {
    super();
    this.instanceManager = opts.instanceManager;
    this.worldModel = opts.worldModel;
    this.reasoner = opts.reasoner;
    this.agentPool = opts.agentPool || null;
    this.mindInstanceId = opts.mindInstanceId;

    this._goals = new Map(); // goalId -> Goal
    this._taskToAgent = new Map(); // agentId -> taskId (which agent is working on which task)
    this._timeouts = new Map(); // taskId -> timeout handle

    // Subscribe to agent status changes for completion detection
    var self = this;
    this._statusHandler = function (data) {
      if (data.id === self.mindInstanceId) return;
      if (data.status === 'idle') {
        self._onAgentIdle(data.id);
      }
    };
    this.instanceManager.on('instance:status', this._statusHandler);
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

    this._report('Planning: ' + prompt);

    try {
      var worldSummary = this.worldModel.getSummary();
      var plan = await this.reasoner.plan(worldSummary, prompt);
      goal.plan = this._buildTaskPlan(goalId, plan);
      goal.status = 'running';

      this._report('Plan ready (' + goal.plan.tasks.length + ' task' +
        (goal.plan.tasks.length !== 1 ? 's' : '') + '):\n' +
        goal.plan.tasks.map(function (t, i) {
          return (i + 1) + '. ' + t.description;
        }).join('\n'));

      this._dispatchReadyTasks(goalId);
      return { goalId: goalId };

    } catch (err) {
      goal.status = 'failed';
      goal.result = 'Planning failed: ' + err.message;
      this._report('Planning failed: ' + err.message);
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
      };
    });

    return { tasks: tasks };
  }

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
   * Assign a task to an agent (via AgentPool if available, else legacy match).
   */
  _assignTask(task) {
    var self = this;

    if (this.agentPool) {
      // Use AgentPool: handles idle match, type match, spawn new
      task.status = 'acquiring';
      this.agentPool.acquire(task).then(function (agentId) {
        self._onAgentAcquired(task, agentId);
      }).catch(function (err) {
        task.status = 'failed';
        task.result = { success: false, summary: 'Agent acquisition failed: ' + err.message };
        self._report('Task failed (agent acquisition): ' + task.description);
        self._checkGoalCompletion(task.goalId);
      });
      return;
    }

    // Legacy path: find idle agent directly from WorldModel (test/no-pool path).
    // Exclude agents already assigned to another running task to avoid
    // sending two prompts to the same agent in parallel.
    var self2 = this;
    var idleAgents = this.worldModel.getIdleAgents().filter(function (a) {
      return !self2._taskToAgent.has(a.id);
    });
    var bestAgent = null;
    if (task.targetCwd) {
      var targetLower = task.targetCwd.toLowerCase();
      for (var i = 0; i < idleAgents.length; i++) {
        if ((idleAgents[i].cwd || '').toLowerCase().includes(targetLower) ||
            (idleAgents[i].project || '').toLowerCase().includes(targetLower)) {
          bestAgent = idleAgents[i];
          break;
        }
      }
    }
    if (!bestAgent) {
      for (var j = 0; j < idleAgents.length; j++) {
        if (idleAgents[j].agentType === task.agentType) {
          bestAgent = idleAgents[j];
          break;
        }
      }
    }
    if (!bestAgent && idleAgents.length > 0) {
      bestAgent = idleAgents[0];
    }

    if (!bestAgent) {
      task.status = 'failed';
      task.result = { success: false, summary: 'No idle agent available' };
      this._report('Task failed (no idle agent): ' + task.description);
      this._checkGoalCompletion(task.goalId);
      return;
    }

    this._onAgentAcquired(task, bestAgent.id);
  }

  /**
   * Handle an agent being assigned to a task (from pool or legacy match).
   */
  _onAgentAcquired(task, agentId) {
    if (!agentId) {
      var reason = 'No agent available';
      if (this.agentPool && this.agentPool.getLastSpawnError) {
        var spawnErr = this.agentPool.getLastSpawnError();
        if (spawnErr) reason = 'Failed to spawn agent: ' + spawnErr;
      }
      task.status = 'failed';
      task.result = { success: false, summary: reason };
      this._report('Task failed: ' + task.description + '\n' + reason);
      this._checkGoalCompletion(task.goalId);
      return;
    }

    task.status = 'running';
    task.agentId = agentId;
    task.startedAt = Date.now();
    this._taskToAgent.set(agentId, task.id);

    // Build the final prompt: predecessor context + task prompt.
    // This is how the mind brokers information between arms.
    var goal = this._goals.get(task.goalId);
    var contextBlock = goal && goal.plan
      ? this._buildPredecessorContext(task, goal.plan.tasks)
      : '';
    var finalPrompt = contextBlock + task.prompt;

    // Set timeout
    var self = this;
    var timeout = setTimeout(function () {
      self._failTask(task.id, 'Timed out after ' + Math.round(task.timeoutMs / 60000) + ' minutes');
    }, task.timeoutMs);
    this._timeouts.set(task.id, timeout);

    // Send prompt to the agent
    var sent = this.instanceManager.sendToAgent(agentId, {
      type: 'prompt',
      text: finalPrompt,
    });

    if (!sent) {
      task.status = 'failed';
      task.result = { success: false, summary: 'Failed to send prompt to agent' };
      this._taskToAgent.delete(agentId);
      clearTimeout(timeout);
      this._timeouts.delete(task.id);
      if (this.agentPool) this.agentPool.release(agentId);
      this._report('Task failed (agent unreachable): ' + task.description);
      this._checkGoalCompletion(task.goalId);
      return;
    }

    // Record the prompt as a user message (the original prompt, not the
    // full context-injected one — that would make the convo noisy)
    this.instanceManager.addMessage(agentId, {
      role: 'user',
      content: task.prompt,
      source: 'mind',
    });

    var inst = this.instanceManager.get(agentId);
    var name = inst ? (inst.name || agentId) : agentId;
    this._report('Assigned to ' + name + ': ' + task.description);
  }

  /**
   * Handle an agent going idle (potential task completion).
   */
  _onAgentIdle(agentId) {
    var taskId = this._taskToAgent.get(agentId);
    if (!taskId) return;

    var task = this._findTask(taskId);
    if (!task || task.status !== 'running') return;

    // Clear timeout
    var timeout = this._timeouts.get(taskId);
    if (timeout) {
      clearTimeout(timeout);
      this._timeouts.delete(taskId);
    }

    this._taskToAgent.delete(agentId);
    this._completeTask(task);
  }

  /**
   * Mark a task as completed and evaluate.
   */
  _completeTask(task) {
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = { success: true, summary: 'Completed' };

    // Capture the arm's output text so dependent tasks can use it as context.
    // This is the 'brokering' that lets the mind share findings between arms.
    task.output = this._extractAgentOutput(task.agentId);

    var duration = task.completedAt - (task.startedAt || task.completedAt);
    var durationStr = duration < 60000
      ? Math.round(duration / 1000) + 's'
      : Math.round(duration / 60000) + 'min';

    this._report('Completed (' + durationStr + '): ' + task.description);

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

    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = { success: false, summary: reason };

    // Clean up
    if (task.agentId) {
      this._taskToAgent.delete(task.agentId);
    }
    var timeout = this._timeouts.get(taskId);
    if (timeout) {
      clearTimeout(timeout);
      this._timeouts.delete(taskId);
    }

    this._report('Failed: ' + task.description + '\n  ' + reason);
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
      if (tasks[i].status === 'pending' || tasks[i].status === 'running' || tasks[i].status === 'assigned') {
        allDone = false;
      }
      if (tasks[i].status === 'failed') {
        anyFailed = true;
      }
    }

    if (allDone) {
      goal.status = anyFailed ? 'failed' : 'completed';
      goal.result = anyFailed
        ? 'Some tasks failed. Check individual task results.'
        : 'All tasks completed successfully.';

      this._report(goal.status === 'completed'
        ? 'Goal completed: ' + goal.prompt
        : 'Goal partially failed: ' + goal.prompt);

      this.emit('goal:completed', { goalId: goalId, status: goal.status });
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
   * Cancel a goal and abort all running tasks.
   */
  cancelGoal(goalId) {
    var goal = this._goals.get(goalId);
    if (!goal) return;

    if (goal.plan) {
      for (var i = 0; i < goal.plan.tasks.length; i++) {
        var task = goal.plan.tasks[i];
        if (task.status === 'running' && task.agentId) {
          this.instanceManager.sendToAgent(task.agentId, { type: 'abort' });
          this._taskToAgent.delete(task.agentId);
        }
        if (task.status === 'pending' || task.status === 'running') {
          task.status = 'failed';
          task.result = { success: false, summary: 'Cancelled' };
        }
        var timeout = this._timeouts.get(task.id);
        if (timeout) {
          clearTimeout(timeout);
          this._timeouts.delete(task.id);
        }
      }
    }

    goal.status = 'failed';
    goal.result = 'Cancelled by user';
    this._report('Goal cancelled: ' + goal.prompt);
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
    this.instanceManager.removeListener('instance:status', this._statusHandler);
    for (var entry of this._timeouts) {
      clearTimeout(entry[1]);
    }
    this._timeouts.clear();
    this._goals.clear();
    this._taskToAgent.clear();
    this.removeAllListeners();
  }
}

module.exports = { Coordinator };
