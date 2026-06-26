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
 *
 * Scope: this only alerts on MIND-OWNED arms (instances whose source
 * tag starts with `mind:`). User-started sessions and gateway-spawned
 * tasks have their own UX paths (per-instance approval modals in the
 * dashboard for users, fail-closed semantics in the gateway) and
 * shouldn't pollute the mind's chat with notifications the user
 * doesn't expect.
 */

function isMindOwned(agent) {
  return !!(agent && typeof agent.source === 'string' && agent.source.indexOf('mind:') === 0);
}

const { makeLogger } = require('../util/logger');

const log = makeLogger('mind-watcher');

class Watcher {
  /**
   * @param {object} opts
   * @param {object} opts.worldModel - WorldModel instance
   * @param {object} opts.instanceManager
   * @param {string} opts.mindInstanceId - Mind's instance ID for reporting
   * @param {object} opts.policy - Policy object with thresholds
   * @param {object} [opts.coordinator] - Coordinator (enables autonomous task cancellation)
   */
  constructor(opts) {
    this.worldModel = opts.worldModel;
    this.instanceManager = opts.instanceManager;
    this.mindInstanceId = opts.mindInstanceId;
    this.policy = opts.policy;
    this.coordinator = opts.coordinator || null;

    this._timer = null;
    this._alerted = new Set(); // agentIds we already alerted about (avoid spam)
    this._acted = new Set(); // agentIds we already auto-cancelled (one action per stuck episode)
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
        log.error('Check error:', err.message);
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
   * Two stages, gated by policy:
   *   1. Alert: warn the user once the stuckThreshold is crossed.
   *   2. Act:   if autoActOnStuck is true and the agent is running a
   *             coordinator-owned task, cancel that task once busy time
   *             exceeds stuckThreshold * stuckActionMultiplier. The
   *             coordinator's normal failure path will then re-plan or
   *             abandon based on the reasoner's judgment.
   */
  _checkStuckAgents() {
    var snapshot = this.worldModel.getSnapshot();
    var now = Date.now();
    var threshold = this.policy.stuckThresholdMs || 15 * 60 * 1000;
    var autoAct = !!this.policy.autoActOnStuck && this.coordinator !== null;
    var multiplier = this.policy.stuckActionMultiplier > 0 ? this.policy.stuckActionMultiplier : 1;
    var actionThreshold = threshold * multiplier;

    for (var i = 0; i < snapshot.agents.length; i++) {
      var agent = snapshot.agents[i];
      if (agent.status !== 'busy') continue;
      // Only nag the user about arms the mind itself spawned.
      // User-started sessions are the user's own concern.
      if (!isMindOwned(agent)) continue;

      var inst = this.instanceManager.get(agent.id);
      if (!inst || !inst.lastActivity) continue;

      var busyDuration = now - inst.lastActivity;

      // Stage 1: alert
      if (busyDuration > threshold && !this._alerted.has('stuck:' + agent.id)) {
        var minutes = Math.round(busyDuration / 60000);
        this._suggest(
          '⚠️ **' + agent.name + '** has been busy for ' + minutes +
          ' minutes without status change. It may be stuck.\n' +
          'Consider aborting it or checking its output in the dashboard.'
        );
        this._alerted.add('stuck:' + agent.id);
      }

      // Stage 2: act (only once per stuck episode)
      if (autoAct && busyDuration > actionThreshold && !this._acted.has(agent.id)) {
        var failed = this.coordinator.failAgentTask(
          agent.id,
          'Auto-cancelled by watcher after ' + Math.round(busyDuration / 60000) + ' minutes of no activity'
        );
        if (failed) {
          this._acted.add(agent.id);
          this._suggest(
            '🛑 Auto-cancelled the task on **' + agent.name + '** (stuck for ' +
            Math.round(busyDuration / 60000) + ' min). The mind will retry, split, or abandon based on context.'
          );
        }
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
      // Only alert on mind-owned arms. The dashboard already shows
      // the user a per-instance approval modal for their own sessions
      // and the gateway fails closed for its own tasks, so the mind's
      // chat alerting on them is noise (and confusing — the user
      // sees notifications about agents they never asked the mind to
      // touch).
      if (!isMindOwned(agent)) continue;
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
          // Also clear the acted flag so a future stuck episode can re-trigger
          this._acted.delete(agentId);
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
    this._acted.clear();
  }
}

module.exports = { Watcher };
