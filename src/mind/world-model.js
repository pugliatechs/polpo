/**
 * WorldModel — real-time mirror of all agent states via InstanceManager events.
 *
 * The WorldModel subscribes to all InstanceManager events and maintains a
 * live snapshot of every agent: status, project, cwd, conversation tail.
 * It provides query methods for the coordinator and reasoner to understand
 * the current state of the "arms."
 *
 * Emits:
 *   - agent:idle    { id, name, project } — when any agent goes idle
 *   - agent:busy    { id, name, project } — when any agent goes busy
 *   - all:idle      — when no agents are busy (all arms resting)
 *   - agent:added   { id, name, agentType } — new agent registered
 *   - agent:removed { id } — agent disconnected/unregistered
 */

const EventEmitter = require('events');

class WorldModel extends EventEmitter {
  /**
   * @param {object} instanceManager - Polpo InstanceManager
   * @param {string} mindInstanceId - The mind's own instance ID (excluded from queries)
   */
  constructor(instanceManager, mindInstanceId) {
    super();
    this.instanceManager = instanceManager;
    this.mindInstanceId = mindInstanceId;
    this._handlers = {};

    this._subscribe();
  }

  _subscribe() {
    var self = this;

    this._handlers.registered = function (inst) {
      if (inst.id === self.mindInstanceId) return;
      self.emit('agent:added', { id: inst.id, name: inst.name, agentType: inst.agentType });
    };

    this._handlers.disconnected = function (inst) {
      if (inst.id === self.mindInstanceId) return;
      self.emit('agent:removed', { id: inst.id });
    };

    this._handlers.status = function (data) {
      if (data.id === self.mindInstanceId) return;
      var inst = self.instanceManager.get(data.id);
      var name = inst ? (inst.name || inst.project || data.id) : data.id;
      var project = inst ? (inst.project || '') : '';

      if (data.status === 'idle') {
        self.emit('agent:idle', { id: data.id, name: name, project: project });
        // Check if ALL agents are now idle
        if (self._allIdle()) {
          self.emit('all:idle');
        }
      } else if (data.status === 'busy') {
        self.emit('agent:busy', { id: data.id, name: name, project: project });
      }
    };

    this._handlers.message = function (data) {
      // Track for conversation awareness (no re-emit needed)
    };

    this._handlers.approval = function (data) {
      if (data.id === self.mindInstanceId) return;
      // Mind can observe approval requests from other agents
    };

    this.instanceManager.on('instance:registered', this._handlers.registered);
    this.instanceManager.on('instance:disconnected', this._handlers.disconnected);
    this.instanceManager.on('instance:status', this._handlers.status);
    this.instanceManager.on('instance:message', this._handlers.message);
    this.instanceManager.on('instance:approval', this._handlers.approval);
  }

  /**
   * Check if all non-mind agents are idle or disconnected.
   */
  _allIdle() {
    var all = this.instanceManager.getAll();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === this.mindInstanceId) continue;
      if (all[i].status === 'busy' || all[i].status === 'waiting') return false;
    }
    return true;
  }

  /**
   * Get a snapshot of all agents (excluding the mind itself).
   * @returns {{ agents: Array, timestamp: number }}
   */
  getSnapshot() {
    var self = this;
    var all = this.instanceManager.getAll();
    var agents = all
      .filter(function (inst) { return inst.id !== self.mindInstanceId; })
      .map(function (inst) {
        return {
          id: inst.id,
          name: inst.name || inst.project || inst.id,
          status: inst.status,
          project: inst.project || '',
          cwd: inst.cwd || '',
          agentType: inst.agentType || 'claude',
          canReceivePrompts: inst.canReceivePrompts !== false,
          sessionId: inst.sessionId || null,
          pendingApproval: inst.pendingApproval ? true : false,
          conversationLength: inst.conversationLength || 0,
        };
      });

    return { agents: agents, timestamp: Date.now() };
  }

  /**
   * Get agents that are idle and can receive prompts.
   * @returns {Array}
   */
  getIdleAgents() {
    return this.getSnapshot().agents.filter(function (a) {
      return a.status === 'idle' && a.canReceivePrompts;
    });
  }

  /**
   * Get agents working in a specific project.
   * @param {string} project
   * @returns {Array}
   */
  getAgentsByProject(project) {
    var lower = (project || '').toLowerCase();
    return this.getSnapshot().agents.filter(function (a) {
      return (a.project || '').toLowerCase() === lower ||
             (a.cwd || '').toLowerCase().includes(lower);
    });
  }

  /**
   * Get a human-readable summary of all agents for LLM context injection.
   * @returns {string}
   */
  getSummary() {
    var snapshot = this.getSnapshot();
    if (snapshot.agents.length === 0) {
      return 'No active agents.';
    }

    var lines = snapshot.agents.map(function (a) {
      var status = a.status;
      if (a.pendingApproval) status += ' (waiting for approval)';
      return '- ' + a.name + ' [' + a.agentType + '] ' + status +
        ' | project: ' + (a.project || 'none') +
        ' | cwd: ' + (a.cwd || 'unknown') +
        (a.canReceivePrompts ? '' : ' (read-only)');
    });

    return 'Active agents (' + snapshot.agents.length + '):\n' + lines.join('\n');
  }

  /**
   * Get the last N messages from a specific agent's conversation.
   * @param {string} agentId
   * @param {number} [limit=10]
   * @returns {Array}
   */
  getAgentConversation(agentId, limit) {
    return this.instanceManager.getConversation(agentId, limit || 10);
  }

  /**
   * Remove all event listeners and clean up.
   */
  destroy() {
    if (this._handlers.registered) {
      this.instanceManager.removeListener('instance:registered', this._handlers.registered);
    }
    if (this._handlers.disconnected) {
      this.instanceManager.removeListener('instance:disconnected', this._handlers.disconnected);
    }
    if (this._handlers.status) {
      this.instanceManager.removeListener('instance:status', this._handlers.status);
    }
    if (this._handlers.message) {
      this.instanceManager.removeListener('instance:message', this._handlers.message);
    }
    if (this._handlers.approval) {
      this.instanceManager.removeListener('instance:approval', this._handlers.approval);
    }
    this._handlers = {};
    this.removeAllListeners();
  }
}

module.exports = { WorldModel };
