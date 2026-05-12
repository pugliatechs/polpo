const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoalStore } = require('../src/mind/goal-store');

function tempPath() {
  return path.join(os.tmpdir(), 'polpo-goal-store-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}

function makeGoal(id, status, taskStatuses) {
  taskStatuses = taskStatuses || [];
  return {
    id: id,
    prompt: 'Goal ' + id,
    status: status,
    createdAt: Date.now(),
    plan: {
      tasks: taskStatuses.map(function (s, i) {
        return { id: 'task-' + i, description: 'Task ' + i, status: s, result: null };
      }),
    },
  };
}

describe('GoalStore', () => {
  let filePath;
  let store;

  beforeEach(() => {
    filePath = tempPath();
    store = new GoalStore({ path: filePath });
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch {}
    try { fs.unlinkSync(filePath + '.tmp'); } catch {}
  });

  it('starts empty when file does not exist', () => {
    store.load();
    assert.equal(store.size(), 0);
    assert.deepEqual(store.getAll(), []);
  });

  it('upsert persists a goal to disk', () => {
    store.upsert(makeGoal('g1', 'running', ['completed', 'pending']));
    assert.equal(store.size(), 1);

    const store2 = new GoalStore({ path: filePath });
    store2.load();
    assert.equal(store2.size(), 1);
    const all = store2.getAll();
    assert.equal(all[0].id, 'g1');
    assert.equal(all[0].status, 'running');
    assert.equal(all[0].plan.tasks.length, 2);
    assert.equal(all[0].plan.tasks[0].status, 'completed');
  });

  it('upsert updates an existing goal in place', () => {
    store.upsert(makeGoal('g1', 'planning', []));
    store.upsert(makeGoal('g1', 'running', ['completed']));
    assert.equal(store.size(), 1);
    assert.equal(store.getAll()[0].status, 'running');
  });

  it('remove deletes a goal from disk', () => {
    store.upsert(makeGoal('g1', 'running', []));
    store.upsert(makeGoal('g2', 'running', []));
    store.remove('g1');
    assert.equal(store.size(), 1);

    const store2 = new GoalStore({ path: filePath });
    store2.load();
    assert.equal(store2.size(), 1);
    assert.equal(store2.getAll()[0].id, 'g2');
  });

  it('clear empties the store', () => {
    store.upsert(makeGoal('g1', 'running', []));
    store.upsert(makeGoal('g2', 'running', []));
    store.clear();
    assert.equal(store.size(), 0);

    const store2 = new GoalStore({ path: filePath });
    store2.load();
    assert.equal(store2.size(), 0);
  });

  it('rejects entries without an id', () => {
    store.upsert(null);
    store.upsert({ prompt: 'no id' });
    store.upsert(42);
    assert.equal(store.size(), 0);
  });

  it('ignores malformed file contents', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not valid json');
    store.load();
    assert.equal(store.size(), 0);
  });

  it('writes file with 0o600 permissions', () => {
    store.upsert(makeGoal('g1', 'running', []));
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    assert.ok((mode & 0o077) === 0, 'file should not be world/group readable: got ' + mode.toString(8));
  });

  it('writes atomically via tmp + rename', () => {
    store.upsert(makeGoal('g1', 'running', []));
    // After upsert, the tmp file should not exist (it was renamed)
    assert.equal(fs.existsSync(filePath + '.tmp'), false);
    assert.equal(fs.existsSync(filePath), true);
  });

  it('serializes only durable fields', () => {
    const goal = makeGoal('g1', 'running', ['completed']);
    goal.plan.tasks[0].agentId = 'agent-abc';
    goal.plan.tasks[0].startedAt = 100;
    goal.plan.tasks[0].completedAt = 200;
    goal.plan.tasks[0].nonSerializable = function () { return 'should not appear'; };
    store.upsert(goal);

    const store2 = new GoalStore({ path: filePath });
    store2.load();
    const t = store2.getAll()[0].plan.tasks[0];
    assert.equal(t.agentId, 'agent-abc');
    assert.equal(t.startedAt, 100);
    assert.equal(t.completedAt, 200);
    assert.equal(t.nonSerializable, undefined);
  });
});
