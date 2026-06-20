/**
 * GoalStore — durable storage for in-flight goals.
 *
 * Persists active goals to disk so a server restart can report what
 * was interrupted instead of silently losing them. Arms themselves are
 * spawned subprocesses and cannot survive a restart, so we don't try
 * to resume mid-task — recovery marks active goals as 'interrupted'
 * and writes a summary to long-term memory.
 *
 * Storage: ~/.config/polpo/mind-active-goals.json (mode 0o600)
 * Format: JSON array of goal snapshots, rewritten atomically on each change.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeLogger } = require('../util/logger');

const log = makeLogger('mind-goal-store');

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'polpo', 'mind-active-goals.json');

class GoalStore {
  constructor(opts) {
    opts = opts || {};
    this.path = opts.path || DEFAULT_PATH;
    this._goals = new Map();
  }

  load() {
    try {
      var raw = fs.readFileSync(this.path, 'utf8');
      var data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (var i = 0; i < data.length; i++) {
          var g = data[i];
          if (g && typeof g === 'object' && typeof g.id === 'string') {
            this._goals.set(g.id, g);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.error('Load failed:', err.message);
      }
    }
  }

  getAll() {
    return Array.from(this._goals.values());
  }

  size() {
    return this._goals.size;
  }

  upsert(goal) {
    if (!goal || typeof goal !== 'object' || !goal.id) return;
    this._goals.set(goal.id, serialize(goal));
    this._flush();
  }

  remove(goalId) {
    if (!goalId) return;
    if (this._goals.delete(goalId)) {
      this._flush();
    }
  }

  clear() {
    if (this._goals.size === 0) return;
    this._goals.clear();
    this._flush();
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      var tmp = this.path + '.tmp';
      var data = JSON.stringify(Array.from(this._goals.values()), null, 2);
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, this.path);
    } catch (err) {
      log.error('Flush failed:', err.message);
    }
  }
}

// Snapshot only durable fields. Agent IDs survive serialization for diagnostics
// but are not actionable after restart (the agent process is gone).
function serialize(goal) {
  var snap = {
    id: goal.id,
    prompt: goal.prompt,
    status: goal.status,
    createdAt: goal.createdAt || Date.now(),
  };
  if (goal.plan && Array.isArray(goal.plan.tasks)) {
    snap.plan = {
      tasks: goal.plan.tasks.map(function (t) {
        return {
          id: t.id,
          description: t.description,
          status: t.status,
          result: t.result || null,
          agentId: t.agentId || null,
          startedAt: t.startedAt || null,
          completedAt: t.completedAt || null,
        };
      }),
    };
  } else {
    snap.plan = null;
  }
  if (goal.result !== undefined) snap.result = goal.result;
  return snap;
}

module.exports = { GoalStore };
