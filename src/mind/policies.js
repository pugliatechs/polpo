/**
 * Policies — configurable autonomy levels for the Alien Mind.
 *
 * Controls how aggressively the mind acts on its own:
 *   CONSERVATIVE: observe only, suggest to user, no auto-actions
 *   BALANCED: auto-approve spawned agents, suggest goals, moderate parallelism
 *   AUTONOMOUS: auto-approve all, auto-initiate goals, high parallelism
 */

// maxArmTurns bounds how many turns ONE arm may take inside a single
// task. 1 is the classic one shot: the arm answers once and is gone.
// Above 1, the mind may answer a question the arm asks and let it
// continue with its context, instead of killing it and dispatching a
// fresh arm that has to redo the work. Each extra turn costs a
// reasoner call, so conservative keeps the old behaviour.
//
// Autonomous-action knobs (used by Watcher):
//   autoActOnStuck       — if true, watcher cancels a stuck task instead of
//                          only alerting. The coordinator's normal failure path
//                          then decides whether to retry/split/abandon.
//   stuckActionMultiplier — only act after busy time exceeds
//                          stuckThresholdMs * multiplier. Gives the user time
//                          to intervene first.
var POLICIES = {
  conservative: {
    name: 'conservative',
    autoApproveSpawned: false,
    autoInitiateGoals: false,
    autoActOnStuck: false,
    stuckActionMultiplier: 0,
    maxArmTurns: 1,
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
    autoActOnStuck: true,
    stuckActionMultiplier: 2, // wait 2x stuckThreshold before acting
    maxArmTurns: 2,
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
    autoActOnStuck: true,
    stuckActionMultiplier: 1, // act as soon as the stuck threshold trips
    maxArmTurns: 3,
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
