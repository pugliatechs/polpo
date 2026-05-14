/**
 * TaskRunner — DAG executor for the Alien Mind.
 *
 * Executes a task plan respecting dependencies: tasks with no unmet
 * dependencies run in parallel, dependent tasks wait. Uses the AgentPool
 * to acquire agents for each task.
 *
 * Emits:
 *   - task:dispatched  { taskId, agentId }
 *   - task:completed   { taskId, result }
 *   - task:failed      { taskId, reason }
 *   - plan:completed   { completed: number, failed: number }
 *   - plan:failed      { reason }
 */

const EventEmitter = require('events');

class TaskRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.agentPool - AgentPool instance
   * @param {object} opts.instanceManager
   * @param {number} [opts.taskTimeoutMs=300000] - Per-task timeout (5 min)
   */
  constructor(opts) {
    super();
    this.agentPool = opts.agentPool;
    this.instanceManager = opts.instanceManager;
    this.taskTimeoutMs = opts.taskTimeoutMs || 300000;

    this._tasks = []; // Array of task objects (the plan)
    this._timeouts = new Map(); // taskId -> timeout handle
    this._agentToTask = new Map(); // agentId -> taskId
    this._running = false;
    this._statusHandler = null;
  }

  /**
   * Execute a task plan (array of tasks with dependsOn indices).
   * @param {Array} tasks - Task objects with id, prompt, dependsOn, agentType, targetCwd, description
   * @returns {Promise<{ completed: number, failed: number }>}
   */
  execute(tasks) {
    var self = this;
    this._tasks = tasks;
    this._running = true;

    // Subscribe to agent status changes
    this._statusHandler = function (data) {
      if (data.status === 'idle') {
        self._onAgentIdle(data.id);
      }
    };
    this.instanceManager.on('instance:status', this._statusHandler);

    return new Promise(function (resolve) {
      self._resolve = resolve;
      self._dispatchReady();
    });
  }

  /**
   * Find and dispatch all tasks whose dependencies are met.
   */
  _dispatchReady() {
    if (!this._running) return;

    var dispatched = 0;
    for (var i = 0; i < this._tasks.length; i++) {
      var task = this._tasks[i];
      if (task.status !== 'pending') continue;
      if (!this._depsMetFor(task)) continue;

      this._dispatchTask(task);
      dispatched++;
    }

    // If nothing was dispatched and nothing is running, we're done
    if (dispatched === 0 && !this._hasRunning()) {
      this._finish();
    }
  }

  /**
   * Check if all dependencies for a task are completed.
   */
  _depsMetFor(task) {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    for (var i = 0; i < task.dependsOn.length; i++) {
      var depIdx = task.dependsOn[i];
      if (depIdx >= 0 && depIdx < this._tasks.length) {
        if (this._tasks[depIdx].status !== 'completed') return false;
      }
    }
    return true;
  }

  /**
   * Check if any task is still running or acquiring an agent.
   */
  _hasRunning() {
    for (var i = 0; i < this._tasks.length; i++) {
      if (this._tasks[i].status === 'running' || this._tasks[i].status === 'acquiring') return true;
    }
    return false;
  }

  /**
   * Check if any task is running or acquiring.
   */
  _hasRunningOrAcquiring() {
    return this._hasRunning();
  }

  /**
   * Dispatch a single task to an agent.
   */
  _dispatchTask(task) {
    task.status = 'acquiring'; // Transitional state while waiting for agent
    task.startedAt = Date.now();

    var self = this;
    this.agentPool.acquire(task).then(function (agentId) {
      if (!self._running) return; // Aborted while acquiring
      self._onAgentAcquired(task, agentId);
    }).catch(function () {
      if (!self._running) return;
      task.status = 'failed';
      task.result = { success: false, summary: 'Agent acquisition error' };
      self.emit('task:failed', { taskId: task.id, reason: 'Agent acquisition error' });
      self._checkDependentFailures(task);
      self._dispatchReady();
    });
  }

  /**
   * Handle agent acquired for a task.
   */
  _onAgentAcquired(task, agentId) {
    if (!agentId) {
      task.status = 'failed';
      task.result = { success: false, summary: 'No agent available' };
      this.emit('task:failed', { taskId: task.id, reason: 'No agent available' });
      this._checkDependentFailures(task);
      if (!this._hasRunningOrAcquiring()) this._finish();
      return;
    }

    task.status = 'running';
    task.agentId = agentId;
    this._agentToTask.set(agentId, task.id);

    // Set timeout
    var self = this;
    var timeout = setTimeout(function () {
      self._failTask(task.id, 'Timed out');
    }, this.taskTimeoutMs);
    this._timeouts.set(task.id, timeout);

    // Send prompt
    var sent = this.instanceManager.sendToAgent(agentId, {
      type: 'prompt',
      text: task.prompt,
    });

    if (!sent) {
      clearTimeout(timeout);
      this._timeouts.delete(task.id);
      this._agentToTask.delete(agentId);
      this.agentPool.release(agentId);
      task.status = 'failed';
      task.result = { success: false, summary: 'Agent unreachable' };
      this.emit('task:failed', { taskId: task.id, reason: 'Agent unreachable' });
      this._checkDependentFailures(task);
      this._dispatchReady();
      return;
    }

    this.emit('task:dispatched', { taskId: task.id, agentId: agentId });
  }

  /**
   * Handle an agent going idle (task completion).
   */
  _onAgentIdle(agentId) {
    var taskId = this._agentToTask.get(agentId);
    if (!taskId) return;

    var task = this._findTask(taskId);
    if (!task || task.status !== 'running') return;

    // Clean up
    var timeout = this._timeouts.get(taskId);
    if (timeout) { clearTimeout(timeout); this._timeouts.delete(taskId); }
    this._agentToTask.delete(agentId);
    this.agentPool.release(agentId);

    // Mark complete
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = { success: true, summary: 'Completed' };

    this.emit('task:completed', { taskId: task.id, result: task.result });

    // Dispatch newly ready tasks
    this._dispatchReady();
  }

  /**
   * Fail a task and cascade to dependents.
   */
  _failTask(taskId, reason) {
    var task = this._findTask(taskId);
    if (!task || task.status !== 'running') return;

    var timeout = this._timeouts.get(taskId);
    if (timeout) { clearTimeout(timeout); this._timeouts.delete(taskId); }

    if (task.agentId) {
      this._agentToTask.delete(task.agentId);
      this.agentPool.release(task.agentId);
      // Abort the agent
      this.instanceManager.sendToAgent(task.agentId, { type: 'abort' });
    }

    task.status = 'failed';
    task.completedAt = Date.now();
    task.result = { success: false, summary: reason };

    this.emit('task:failed', { taskId: task.id, reason: reason });

    this._checkDependentFailures(task);
    this._dispatchReady();
  }

  /**
   * Cascade failure to tasks that depend on a failed task.
   */
  _checkDependentFailures(failedTask) {
    var failedIdx = this._tasks.indexOf(failedTask);
    if (failedIdx === -1) return;

    for (var i = 0; i < this._tasks.length; i++) {
      var task = this._tasks[i];
      if (task.status !== 'pending') continue;
      if (task.dependsOn && task.dependsOn.indexOf(failedIdx) !== -1) {
        task.status = 'failed';
        task.result = { success: false, summary: 'Dependency failed: ' + failedTask.description };
        this.emit('task:failed', { taskId: task.id, reason: 'Dependency failed' });
        // Cascade further
        this._checkDependentFailures(task);
      }
    }
  }

  /**
   * Find a task by ID.
   */
  _findTask(taskId) {
    for (var i = 0; i < this._tasks.length; i++) {
      if (this._tasks[i].id === taskId) return this._tasks[i];
    }
    return null;
  }

  /**
   * Finish execution and resolve the promise.
   */
  _finish() {
    if (!this._running) return;
    this._running = false;

    if (this._statusHandler) {
      this.instanceManager.removeListener('instance:status', this._statusHandler);
      this._statusHandler = null;
    }

    var completed = 0;
    var failed = 0;
    for (var i = 0; i < this._tasks.length; i++) {
      if (this._tasks[i].status === 'completed') completed++;
      if (this._tasks[i].status === 'failed') failed++;
    }

    var result = { completed: completed, failed: failed };

    if (failed > 0) {
      this.emit('plan:failed', result);
    } else {
      this.emit('plan:completed', result);
    }

    if (this._resolve) {
      this._resolve(result);
      this._resolve = null;
    }
  }

  /**
   * Abort all running tasks.
   */
  abortAll() {
    for (var i = 0; i < this._tasks.length; i++) {
      var task = this._tasks[i];
      if (task.status === 'running') {
        this._failTask(task.id, 'Aborted');
      } else if (task.status === 'pending' || task.status === 'acquiring') {
        task.status = 'failed';
        task.result = { success: false, summary: 'Aborted' };
      }
    }
    this._finish();
  }

  /**
   * Clean up timeouts and listeners.
   */
  destroy() {
    this._running = false;
    if (this._statusHandler) {
      this.instanceManager.removeListener('instance:status', this._statusHandler);
      this._statusHandler = null;
    }
    for (var entry of this._timeouts) {
      clearTimeout(entry[1]);
    }
    this._timeouts.clear();
    this._agentToTask.clear();
    this.removeAllListeners();
  }
}

module.exports = { TaskRunner };
