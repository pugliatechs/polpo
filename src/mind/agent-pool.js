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
    // 1. Try idle agents matching target cwd
    var idle = this.worldModel.getIdleAgents();
    var targetLower = (task.targetCwd || '').toLowerCase();

    if (targetLower) {
      for (var i = 0; i < idle.length; i++) {
        if (!this._assigned.has(idle[i].id) &&
            ((idle[i].cwd || '').toLowerCase().includes(targetLower) ||
             (idle[i].project || '').toLowerCase().includes(targetLower))) {
          this._assigned.set(idle[i].id, task.id);
          return idle[i].id;
        }
      }
    }

    // 2. Try idle agents of matching type
    for (var j = 0; j < idle.length; j++) {
      if (!this._assigned.has(idle[j].id) &&
          idle[j].agentType === (task.agentType || 'claude')) {
        this._assigned.set(idle[j].id, task.id);
        return idle[j].id;
      }
    }

    // 3. Try any idle agent
    for (var k = 0; k < idle.length; k++) {
      if (!this._assigned.has(idle[k].id)) {
        this._assigned.set(idle[k].id, task.id);
        return idle[k].id;
      }
    }

    // 4. Spawn a new agent if under limit
    if (this._spawned.size >= this.maxSpawned) {
      return null; // At capacity
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
