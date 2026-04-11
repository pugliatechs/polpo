/**
 * Alien Mind — meta-agent coordination module.
 *
 * The mind registers itself as a regular instance in InstanceManager
 * (agentType: 'mind') and appears in the dashboard. Users send goals
 * to it by selecting it and typing prompts. The mind observes all
 * other agents via WorldModel and coordinates their work.
 *
 * Opt-in: only loads when POLPO_MIND=1 is set.
 */

const { WorldModel } = require('./world-model');

/**
 * Create the Alien Mind module.
 * @param {object} instanceManager - Polpo InstanceManager
 * @param {object} [options]
 * @param {boolean} [options.verbose] - Enable verbose logging
 * @param {number} [options.serverPort] - Hub port for agent connections
 * @param {string} [options.authToken] - Auth token for agent registration
 * @returns {{ worldModel: WorldModel, instanceId: string, destroy: () => void }}
 */
function createMind(instanceManager, options) {
  if (!options) options = {};

  // Register the mind as a regular instance
  var instance = instanceManager.register({
    name: 'Alien Mind',
    type: 'terminal',
    project: 'polpo-mind',
    cwd: process.cwd(),
    agentType: 'mind',
    canReceivePrompts: true,
  });

  var mindId = instance.id;
  instanceManager.updateStatus(mindId, 'idle');

  // Create world model (observes all other agents)
  var worldModel = new WorldModel(instanceManager, mindId);

  // Log agent events in verbose mode
  if (options.verbose) {
    worldModel.on('agent:added', function (data) {
      console.log('[mind] Agent added: ' + data.name + ' (' + data.agentType + ')');
    });
    worldModel.on('agent:removed', function (data) {
      console.log('[mind] Agent removed: ' + data.id);
    });
    worldModel.on('agent:idle', function (data) {
      console.log('[mind] Agent idle: ' + data.name);
    });
    worldModel.on('agent:busy', function (data) {
      console.log('[mind] Agent busy: ' + data.name);
    });
    worldModel.on('all:idle', function () {
      console.log('[mind] All agents idle');
    });
  }

  // Listen for user prompts sent to the mind's instance
  var messageHandler = function (data) {
    if (data.id !== mindId) return;
    var msg = data.message;
    if (!msg || msg.role !== 'user' || msg.source === 'mind') return;

    // For Phase 1: respond with a world state summary
    var summary = worldModel.getSummary();
    var response = 'I can see the following agents:\n\n' + summary +
      '\n\nCoordination capabilities are being built. ' +
      'For now, I observe all agent activity in real-time.';

    instanceManager.addMessage(mindId, {
      role: 'assistant',
      content: response,
      source: 'mind',
    });
  };

  instanceManager.on('instance:message', messageHandler);

  console.log('[mind] Alien Mind active (instance: ' + mindId + ')');

  return {
    worldModel: worldModel,
    instanceId: mindId,

    destroy: function () {
      instanceManager.removeListener('instance:message', messageHandler);
      worldModel.destroy();
      instanceManager.unregister(mindId);
    },
  };
}

module.exports = { createMind };
