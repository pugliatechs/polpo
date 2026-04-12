/**
 * Watcher — passive monitoring for the Alien Mind.
 *
 * Periodically checks agent states and detects:
 *   - Stuck agents (busy for too long without progress)
 *   - Repeated failures in the same project
 *   - Idle agents that could be utilized
 *   - Approval requests waiting too long
 *
 * Reports findings to the mind's conversation for the user to see.
 */

class Watcher {
  /**
   * @param {object} opts
   * @param {object} opts.worldModel - WorldModel instance
   * @param {object} opts.instanceManager
   * @param {string} opts.mindInstanceId - Mind's instance ID for reporting
   * @param {object} opts.policy - Policy object with thresholds
   */
  constructor(opts) {
    this.worldModel = opts.worldModel;
    this.instanceManager = opts.instanceManager;
    this.mindInstanceId = opts.mindInstanceId;
    this.policy = opts.policy;

    this._timer = null;
    this._alerted = new Set(); // agentIds we already alerted about (avoid spam)
    this._lastCheck = Date.now();
  }

  /**
   * Start the monitoring loop.
   */
  start() {
    if (this._timer) return;
    var self = this;
    var intervalMs = this.policy.watcherIntervalMs || 30000;

    this._timer = setInterval(function () {
      try { self._check(); } catch (err) {
        console.error('[mind-watcher] Check error:', err.message);
      }
    }, intervalMs);
  }

  /**
   * Stop the monitoring loop.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run all checks.
   */
  _check() {
    this._lastCheck = Date.now();
    this._checkStuckAgents();
    this._checkStaleApprovals();
    this._cleanupAlerts();
  }

  /**
   * Detect agents that have been busy for longer than the threshold.
   */
  _checkStuckAgents() {
    var snapshot = this.worldModel.getSnapshot();
    var now = Date.now();
    var threshold = this.policy.stuckThresholdMs || 15 * 60 * 1000;

    for (var i = 0; i < snapshot.agents.length; i++) {
      var agent = snapshot.agents[i];
      if (agent.status !== 'busy') continue;

      var inst = this.instanceManager.get(agent.id);
      if (!inst || !inst.lastActivity) continue;

      var busyDuration = now - inst.lastActivity;
      if (busyDuration > threshold && !this._alerted.has('stuck:' + agent.id)) {
        var minutes = Math.round(busyDuration / 60000);
        this._suggest(
          '⚠️ **' + agent.name + '** has been busy for ' + minutes +
          ' minutes without status change. It may be stuck.\n' +
          'Consider aborting it or checking its output in the dashboard.'
        );
        this._alerted.add('stuck:' + agent.id);
      }
    }
  }

  /**
   * Detect approval requests that have been waiting too long.
   */
  _checkStaleApprovals() {
    var snapshot = this.worldModel.getSnapshot();

    for (var i = 0; i < snapshot.agents.length; i++) {
      var agent = snapshot.agents[i];
      if (agent.status !== 'waiting' || !agent.pendingApproval) continue;
      if (this._alerted.has('approval:' + agent.id)) continue;

      this._suggest(
        '⏳ **' + agent.name + '** is waiting for approval. ' +
        'Check the dashboard to approve or reject the pending action.'
      );
      this._alerted.add('approval:' + agent.id);
    }
  }

  /**
   * Clean up alerts for agents that are no longer in the alerted state.
   */
  _cleanupAlerts() {
    var snapshot = this.worldModel.getSnapshot();
    var activeIds = new Set(snapshot.agents.map(function (a) { return a.id; }));

    for (var alertKey of this._alerted) {
      var agentId = alertKey.split(':')[1];
      if (!activeIds.has(agentId)) {
        this._alerted.delete(alertKey);
        continue;
      }
      // Clear stuck alert if agent is no longer busy
      if (alertKey.startsWith('stuck:')) {
        var inst = this.instanceManager.get(agentId);
        if (inst && inst.status !== 'busy') {
          this._alerted.delete(alertKey);
        }
      }
      // Clear approval alert if no longer waiting
      if (alertKey.startsWith('approval:')) {
        var inst2 = this.instanceManager.get(agentId);
        if (inst2 && inst2.status !== 'waiting') {
          this._alerted.delete(alertKey);
        }
      }
    }
  }

  /**
   * Add a suggestion to the mind's conversation.
   */
  _suggest(text) {
    this.instanceManager.addMessage(this.mindInstanceId, {
      role: 'assistant',
      content: text,
      source: 'mind-watcher',
    });
  }

  /**
   * Clean up.
   */
  destroy() {
    this.stop();
    this._alerted.clear();
  }
}

module.exports = { Watcher };
