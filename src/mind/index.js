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
const { OneShotAgentRunner } = require('../agent/one-shot-runner');
const { Memory } = require('./memory');
const { GoalStore } = require('./goal-store');
const { loadPolicy } = require('./policies');
const { makeLogger } = require('../util/logger');

const log = makeLogger('mind');

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

  // Load policy early for agent runner config
  var policy = loadPolicy();

  // Shared one-shot agent runner — same lifecycle the HTTP gateway
  // uses. Mind dispatches each task as an isolated runner.run() call;
  // there is no pool/reuse. Agents are stateless function calls; the
  // coordinator holds all the durable state (world-model, dependency
  // graph, memory, goal store).
  var runner = new OneShotAgentRunner({
    instanceManager: instanceManager,
    hubPort: options.serverPort || 7890,
    hubToken: options.authToken || null,
    autoApprove: policy.autoApproveSpawned,
  });

  // Long-term memory (JSONL at ~/.config/polpo/mind-memory.jsonl)
  var memory = new Memory();
  try {
    memory.load();
    if (options.verbose) {
      log.info('Memory loaded (' + memory.size() + ' past goals)');
    }
  } catch (err) {
    log.error('Memory load failed:', err.message);
  }

  // Durable goal store for in-flight recovery across server restarts.
  // Arms can't survive a restart, so recovery reports interrupted goals
  // and writes them to long-term memory (it does not resume them).
  var goalStore = new GoalStore();
  goalStore.load();
  if (options.verbose && goalStore.size() > 0) {
    log.info('Goal store has ' + goalStore.size() + ' in-flight goal(s) to recover');
  }

  // Create coordinator (goal/task lifecycle)
  var coordinator = new Coordinator({
    instanceManager: instanceManager,
    worldModel: worldModel,
    reasoner: reasoner,
    runner: runner,
    memory: memory,
    goalStore: goalStore,
    mindInstanceId: mindId,
    policy: policy,
  });

  // Recover any goals that were in-flight at the time of the last shutdown.
  // Must run after the mind is registered so the report appears in its chat.
  try {
    coordinator.recoverInterruptedGoals();
  } catch (err) {
    log.error('Goal recovery failed:', err.message);
  }

  // Log agent events in verbose mode
  if (options.verbose) {
    worldModel.on('agent:added', function (data) {
      log.info('Agent added: ' + data.name + ' (' + data.agentType + ')');
    });
    worldModel.on('agent:removed', function (data) {
      log.info('Agent removed: ' + data.id);
    });
    worldModel.on('agent:idle', function (data) {
      log.info('Agent idle: ' + data.name);
    });
    worldModel.on('agent:busy', function (data) {
      log.info('Agent busy: ' + data.name);
    });
    worldModel.on('all:idle', function () {
      log.info('All agents idle');
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
        return g.status === 'running' || g.status === 'planning' || g.status === 'awaiting_approval';
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

    // ---- Interactive-mode slash commands ----
    //
    // These resolve to the most-recent awaiting_approval goal OR
    // awaiting_user_input task automatically, so the user rarely
    // needs to type an explicit id. If the chat layout grows multiple
    // pending questions at once they can use the explicit form, e.g.
    //   /approve goal-abc1234
    //   /retry task-def5678 here's the missing context...

    if (text === '/approve' || text.startsWith('/approve ')) {
      var explicitGoalId = text.slice('/approve'.length).trim() || null;
      var approved = coordinator.approvePlan(explicitGoalId);
      if (!approved) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'No plan is awaiting approval right now.',
          source: 'mind',
        });
      }
      return;
    }

    if (text.startsWith('/tweak')) {
      var feedback = text.slice('/tweak'.length).trim();
      coordinator.tweakPlan(null, feedback).catch(function (err) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'Tweak failed: ' + err.message,
          source: 'mind',
        });
      });
      return;
    }

    if (text === '/abandon' || text.startsWith('/abandon ')) {
      // /abandon resolves to whichever pending question the user has —
      // if a plan is awaiting approval, cancel it; if a task is
      // escalated, cancel its goal. Either way the goal terminates.
      var abandonGoalId = text.slice('/abandon'.length).trim() || null;
      var abandoned = coordinator.abandonAwaitingPlan(abandonGoalId);
      if (!abandoned) {
        abandoned = coordinator.userAbandonEscalatedGoal(null);
      }
      if (!abandoned) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'Nothing to abandon — no plan awaiting approval and no escalated arm.',
          source: 'mind',
        });
      }
      return;
    }

    if (text === '/retry' || text.startsWith('/retry ')) {
      var hint = text.slice('/retry'.length).trim();
      coordinator.userRetryEscalatedTask(null, hint).then(function (ok) {
        if (!ok) {
          instanceManager.addMessage(mindId, {
            role: 'assistant',
            content: 'No escalated arm waiting for a /retry.',
            source: 'mind',
          });
        }
      }).catch(function (err) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'Retry failed: ' + err.message,
          source: 'mind',
        });
      });
      return;
    }

    if (text === '/skip' || text.startsWith('/skip ')) {
      var skipped = coordinator.userSkipEscalatedTask(null);
      if (!skipped) {
        instanceManager.addMessage(mindId, {
          role: 'assistant',
          content: 'No escalated arm to skip.',
          source: 'mind',
        });
      }
      return;
    }

    // Everything else is a goal. By default goals submitted via chat
    // are *interactive*: the mind plans, posts the plan preview, and
    // waits for /approve before dispatching. Operators who want the
    // old fire-and-forget behaviour can set POLPO_MIND_AUTO_DISPATCH=1
    // OR prefix the goal with "/auto " for a single-shot bypass.
    var autoDispatch = process.env.POLPO_MIND_AUTO_DISPATCH === '1';
    var goalPrompt = text;
    if (text.startsWith('/auto ')) {
      autoDispatch = true;
      goalPrompt = text.slice('/auto '.length).trim();
    }
    if (!goalPrompt) {
      instanceManager.addMessage(mindId, {
        role: 'assistant',
        content: 'Empty goal. Type something for the mind to plan, e.g. "Refactor the auth module".',
        source: 'mind',
      });
      return;
    }
    instanceManager.updateStatus(mindId, 'busy');
    coordinator.submitGoal(goalPrompt, { autoDispatch: autoDispatch }).then(function () {
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

  log.info('Alien Mind active (policy: ' + policy.name + ', instance: ' + mindId + ')');

  return {
    worldModel: worldModel,
    coordinator: coordinator,
    instanceId: mindId,

    destroy: function () {
      watcher.destroy();
      instanceManager.removeListener('instance:message', messageHandler);
      coordinator.destroy();
      runner.destroy();
      reasoner.destroy();
      worldModel.destroy();
      instanceManager.unregister(mindId);
    },
  };
}

module.exports = { createMind };
