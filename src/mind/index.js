/**
 * Alien Mind — meta-agent coordination module.
 *
 * The mind registers itself as a regular instance in InstanceManager
 * (agentType: 'mind') and appears in the dashboard. Users send goals
 * to it by selecting it and typing prompts. The mind observes all
 * other agents via WorldModel, plans via Reasoner, and coordinates
 * work via Coordinator.
 *
 * Opt-in: only loads when POLPO_MIND=1 is set.
 */

const { WorldModel } = require('./world-model');
const { Reasoner } = require('./reasoner');
const { Coordinator } = require('./coordinator');
const { Watcher } = require('./watcher');
const { AgentPool } = require('./agent-pool');
const { Memory } = require('./memory');
const { GoalStore } = require('./goal-store');
const { loadPolicy } = require('./policies');

/**
 * Create the Alien Mind module.
 * @param {object} instanceManager - Polpo InstanceManager
 * @param {object} [options]
 * @param {boolean} [options.verbose] - Enable verbose logging
 * @param {number} [options.serverPort] - Hub port for agent connections
 * @param {string} [options.authToken] - Auth token for agent registration
 * @returns {{ worldModel: WorldModel, coordinator: Coordinator, instanceId: string, destroy: () => void }}
 */
function createMind(instanceManager, options) {
  if (!options) options = {};

  // Register the mind as a regular instance.
  // Project is 'polpo' because the mind IS polpo's distributed brain,
  // not a separate project.
  var instance = instanceManager.register({
    name: 'Alien Mind',
    type: 'terminal',
    project: 'polpo',
    cwd: process.cwd(),
    agentType: 'mind',
    canReceivePrompts: true,
  });

  var mindId = instance.id;
  instanceManager.updateStatus(mindId, 'idle');

  // Create world model (observes all other agents)
  var worldModel = new WorldModel(instanceManager, mindId);

  // Create reasoner (LLM-backed planning)
  var reasoner = new Reasoner({
    model: process.env.POLPO_MIND_MODEL || null,
  });

  // Load policy early for agent pool config
  var policy = loadPolicy();

  // Create agent pool (handles idle match, type match, spawn new)
  var agentPool = new AgentPool({
    instanceManager: instanceManager,
    worldModel: worldModel,
    serverPort: options.serverPort || 7890,
    authToken: options.authToken || null,
    maxSpawned: policy.maxSpawnedAgents,
    autoApprove: policy.autoApproveSpawned,
  });

  // Long-term memory (JSONL at ~/.config/polpo/mind-memory.jsonl)
  var memory = new Memory();
  try {
    memory.load();
    if (options.verbose) {
      console.log('[mind] Memory loaded (' + memory.size() + ' past goals)');
    }
  } catch (err) {
    console.error('[mind] Memory load failed:', err.message);
  }

  // Durable goal store for in-flight recovery across server restarts.
  // Arms can't survive a restart, so recovery reports interrupted goals
  // and writes them to long-term memory (it does not resume them).
  var goalStore = new GoalStore();
  goalStore.load();
  if (options.verbose && goalStore.size() > 0) {
    console.log('[mind] Goal store has ' + goalStore.size() + ' in-flight goal(s) to recover');
  }

  // Create coordinator (goal/task lifecycle)
  var coordinator = new Coordinator({
    instanceManager: instanceManager,
    worldModel: worldModel,
    reasoner: reasoner,
    agentPool: agentPool,
    memory: memory,
    goalStore: goalStore,
    mindInstanceId: mindId,
  });

  // Recover any goals that were in-flight at the time of the last shutdown.
  // Must run after the mind is registered so the report appears in its chat.
  try {
    coordinator.recoverInterruptedGoals();
  } catch (err) {
    console.error('[mind] Goal recovery failed:', err.message);
  }

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

    var text = (msg.content || '').trim();
    if (!text) return;

    // Special commands
    if (text === '/status' || text === '/agents') {
      instanceManager.addMessage(mindId, {
        role: 'assistant',
        content: worldModel.getSummary(),
        source: 'mind',
      });
      return;
    }

    if (text === '/goals') {
      var goals = coordinator.getActiveGoals();
      if (goals.length === 0) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'No active goals.',
          source: 'mind',
        });
      } else {
        var lines = goals.map(function (g) {
          var taskSummary = g.plan
            ? g.plan.tasks.map(function (t) { return '  - ' + t.description + ' [' + t.status + ']'; }).join('\n')
            : '  (no plan)';
          return '**' + g.status + '**: ' + g.prompt + '\n' + taskSummary;
        });
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: lines.join('\n\n'),
          source: 'mind',
        });
      }
      return;
    }

    if (text.startsWith('/cancel')) {
      var goals = coordinator.getActiveGoals().filter(function (g) {
        return g.status === 'running' || g.status === 'planning';
      });
      if (goals.length === 0) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'No active goals to cancel.',
          source: 'mind',
        });
      } else {
        goals.forEach(function (g) { coordinator.cancelGoal(g.id); });
      }
      return;
    }

    // Everything else is a goal
    instanceManager.updateStatus(mindId, 'busy');
    coordinator.submitGoal(text).then(function () {
      instanceManager.updateStatus(mindId, 'idle');
    }).catch(function (err) {
      instanceManager.addMessage(mindId, {
        role: 'assistant',
        content: 'Error: ' + err.message,
        source: 'mind',
      });
      instanceManager.updateStatus(mindId, 'idle');
    });
  };

  instanceManager.on('instance:message', messageHandler);

  // Start watcher (policy already loaded above for agent pool)
  var watcher = new Watcher({
    worldModel: worldModel,
    instanceManager: instanceManager,
    mindInstanceId: mindId,
    policy: policy,
    coordinator: coordinator,
  });
  watcher.start();

  console.log('[mind] Alien Mind active (policy: ' + policy.name + ', instance: ' + mindId + ')');

  return {
    worldModel: worldModel,
    coordinator: coordinator,
    instanceId: mindId,

    destroy: function () {
      watcher.destroy();
      instanceManager.removeListener('instance:message', messageHandler);
      coordinator.destroy();
      agentPool.destroy();
      reasoner.destroy();
      worldModel.destroy();
      instanceManager.unregister(mindId);
    },
  };
}

module.exports = { createMind };
