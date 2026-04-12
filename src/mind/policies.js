/**
 * Policies — configurable autonomy levels for the Alien Mind.
 *
 * Controls how aggressively the mind acts on its own:
 *   CONSERVATIVE: observe only, suggest to user, no auto-actions
 *   BALANCED: auto-approve spawned agents, suggest goals, moderate parallelism
 *   AUTONOMOUS: auto-approve all, auto-initiate goals, high parallelism
 */

var POLICIES = {
  conservative: {
    name: 'conservative',
    autoApproveSpawned: false,
    autoInitiateGoals: false,
    maxConcurrentTasks: 2,
    maxSpawnedAgents: 2,
    taskTimeoutMs: 300000, // 5 min
    stuckThresholdMs: 10 * 60 * 1000, // 10 min
    watcherIntervalMs: 30000, // 30s
  },
  balanced: {
    name: 'balanced',
    autoApproveSpawned: true,
    autoInitiateGoals: false,
    maxConcurrentTasks: 4,
    maxSpawnedAgents: 4,
    taskTimeoutMs: 600000, // 10 min
    stuckThresholdMs: 15 * 60 * 1000, // 15 min
    watcherIntervalMs: 30000,
  },
  autonomous: {
    name: 'autonomous',
    autoApproveSpawned: true,
    autoInitiateGoals: true,
    maxConcurrentTasks: 8,
    maxSpawnedAgents: 6,
    taskTimeoutMs: 900000, // 15 min
    stuckThresholdMs: 20 * 60 * 1000, // 20 min
    watcherIntervalMs: 30000,
  },
};

/**
 * Load the active policy from env or default.
 * @returns {object} Policy object
 */
function loadPolicy() {
  var name = (process.env.POLPO_MIND_POLICY || 'balanced').toLowerCase();
  return POLICIES[name] || POLICIES.balanced;
}

module.exports = { POLICIES, loadPolicy };
