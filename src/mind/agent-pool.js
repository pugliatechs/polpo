/**
 * AgentPool — manages agent lifecycle for the Alien Mind.
 *
 * Reuses idle agents when possible, spawns new ones when needed.
 * Tracks which agents were spawned by the mind (vs user-started)
 * for cleanup purposes.
 */

const { createAgent } = require('../agent/agent-factory');

class AgentPool {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {object} opts.worldModel - WorldModel instance
   * @param {number} [opts.serverPort] - Hub port for agent WebSocket connection
   * @param {string} [opts.authToken] - Auth token for agent registration
   * @param {number} [opts.maxSpawned=4] - Maximum agents the mind can spawn
   * @param {boolean} [opts.autoApprove=true] - Auto-approve tool calls for spawned agents
   */
  constructor(opts) {
    this.instanceManager = opts.instanceManager;
    this.worldModel = opts.worldModel;
    this.serverPort = opts.serverPort || 7890;
    this.authToken = opts.authToken || null;
    this.maxSpawned = opts.maxSpawned || 4;
    this.autoApprove = opts.autoApprove !== false;

    this._spawned = new Map(); // agentId -> agent instance
    this._assigned = new Map(); // agentId -> taskId
  }

  /**
   * Acquire an agent for a task. Tries to reuse an idle agent,
   * spawns a new one if none available.
   *
   * @param {object} task - { agentType, targetCwd, id }
   * @returns {Promise<string|null>} agentId, or null if none available
   */
  async acquire(task) {
    // Only reuse mind-spawned arms that are idle and unassigned.
    // User-started sessions are not hijacked -- the user expects to control
    // their own agents. If we need capacity, we spawn new arms.
    var self = this;
    var reusable = null;
    for (var entry of this._spawned) {
      var armId = entry[0];
      if (self._assigned.has(armId)) continue;
      var inst = self.instanceManager.get(armId);
      if (!inst || inst.status !== 'idle') continue;
      // Prefer match by target cwd
      var targetLower = (task.targetCwd || '').toLowerCase();
      if (targetLower && (inst.cwd || '').toLowerCase().includes(targetLower)) {
        reusable = armId;
        break;
      }
      if (!reusable) reusable = armId;
    }

    if (reusable) {
      this._assigned.set(reusable, task.id);
      return reusable;
    }

    // Spawn a new arm if under limit
    if (this._spawned.size >= this.maxSpawned) {
      this._lastSpawnError = 'Max spawned agents reached (' + this.maxSpawned + ')';
      return null;
    }

    try {
      var agentId = await this._spawnAgent(task);
      this._assigned.set(agentId, task.id);
      return agentId;
    } catch (err) {
      console.error('[mind-pool] Failed to spawn agent:', err.message, err.stack);
      this._lastSpawnError = err.message;
      return null;
    }
  }

  /**
   * Get the last spawn error message, if any.
   */
  getLastSpawnError() {
    return this._lastSpawnError || null;
  }

  /**
   * Release an agent back to the pool.
   * @param {string} agentId
   */
  release(agentId) {
    this._assigned.delete(agentId);
  }

  /**
   * Get the task ID assigned to an agent.
   * @param {string} agentId
   * @returns {string|null}
   */
  getAssignment(agentId) {
    return this._assigned.get(agentId) || null;
  }

  /**
   * Check if an agent is currently assigned to a task.
   * @param {string} agentId
   * @returns {boolean}
   */
  isAssigned(agentId) {
    return this._assigned.has(agentId);
  }

  /**
   * Spawn a new agent for a task.
   * @param {object} task
   * @returns {Promise<string>} agentId
   */
  async _spawnAgent(task) {
    var agentType = task.agentType || 'claude';
    var cwd = task.targetCwd || process.cwd();

    var agent = createAgent(agentType, {
      name: 'Arm: ' + (task.description || agentType).slice(0, 50),
      cwd: cwd,
      serverUrl: 'ws://127.0.0.1:' + this.serverPort,
      token: this.authToken,
      type: 'terminal',
      project: require('path').basename(cwd),
      // Respect autoApprove policy: bypass only when enabled
      permissionMode: this.autoApprove ? 'bypass' : 'default',
    });

    await agent.start();
    this._spawned.set(agent.instanceId, agent);

    if (this.autoApprove) {
      this.instanceManager.setAutoApprove(agent.instanceId, true);
    }

    // Wait for the agent's WebSocket to be connected to the hub before
    // returning. start() resolves after register+connectToHub, but the
    // WebSocket 'open' event is async. Poll up to 5s for agentSocket to
    // be OPEN in InstanceManager.
    var self = this;
    await new Promise(function (resolve, reject) {
      var deadline = Date.now() + 5000;
      var check = function () {
        var inst = self.instanceManager.get(agent.instanceId);
        if (inst && inst.agentSocket && inst.agentSocket.readyState === 1) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('Agent WebSocket did not connect within 5s'));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    return agent.instanceId;
  }

  /**
   * Stop all mind-spawned agents and clean up.
   */
  destroy() {
    for (var entry of this._spawned) {
      var agent = entry[1];
      try { agent.stop(); } catch {}
      try { this.instanceManager.unregister(entry[0]); } catch {}
    }
    this._spawned.clear();
    this._assigned.clear();
  }

  /**
   * Get count of spawned agents.
   * @returns {number}
   */
  get spawnedCount() {
    return this._spawned.size;
  }

  /**
   * Get count of assigned agents.
   * @returns {number}
   */
  get assignedCount() {
    return this._assigned.size;
  }
}

module.exports = { AgentPool };
