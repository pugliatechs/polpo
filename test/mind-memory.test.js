const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Memory, tokenize, jaccard } = require('../src/mind/memory');

// Use a temp file for each test so real memory isn't touched
function tempPath() {
  return path.join(os.tmpdir(), 'polpo-mind-memory-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
}

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    const tokens = tokenize('Refactor the Auth Module!');
    assert.ok(tokens.has('refactor'));
    assert.ok(tokens.has('auth'));
    assert.ok(tokens.has('module'));
  });

  it('filters stopwords', () => {
    const tokens = tokenize('the quick brown fox');
    assert.ok(!tokens.has('the'));
    assert.ok(tokens.has('quick'));
    assert.ok(tokens.has('brown'));
    assert.ok(tokens.has('fox'));
  });

  it('filters single-char tokens', () => {
    const tokens = tokenize('a b cd');
    assert.ok(!tokens.has('a'));
    assert.ok(!tokens.has('b'));
    assert.ok(tokens.has('cd'));
  });

  it('returns empty set for non-strings', () => {
    assert.equal(tokenize(null).size, 0);
    assert.equal(tokenize(undefined).size, 0);
    assert.equal(tokenize(123).size, 0);
  });

  it('returns empty set for empty string', () => {
    assert.equal(tokenize('').size, 0);
  });

  it('keeps numeric tokens', () => {
    const tokens = tokenize('build plugin 2026');
    assert.ok(tokens.has('2026'));
  });
});

describe('jaccard', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['x', 'y', 'z']);
    assert.equal(jaccard(a, b), 1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['x', 'y']);
    const b = new Set(['p', 'q']);
    assert.equal(jaccard(a, b), 0);
  });

  it('returns 0 for empty sets', () => {
    assert.equal(jaccard(new Set(), new Set(['x'])), 0);
    assert.equal(jaccard(new Set(['x']), new Set()), 0);
  });

  it('computes partial overlap', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['y', 'z', 'w']);
    // intersection = 2, union = 4
    assert.equal(jaccard(a, b), 0.5);
  });
});

describe('Memory', () => {
  let filePath;
  let memory;

  beforeEach(() => {
    filePath = tempPath();
    memory = new Memory({ path: filePath });
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch {}
  });

  it('starts empty if file does not exist', () => {
    memory.load();
    assert.equal(memory.size(), 0);
  });

  it('save persists an entry and it reappears after reload', () => {
    memory.save({ type: 'goal', goalPrompt: 'Refactor auth', outcome: 'completed', taskCount: 2, taskSummaries: ['a', 'b'] });
    assert.equal(memory.size(), 1);

    // New instance loads from disk
    const m2 = new Memory({ path: filePath });
    m2.load();
    assert.equal(m2.size(), 1);
    const entry = m2.getRecent(1)[0];
    assert.equal(entry.goalPrompt, 'Refactor auth');
    assert.equal(entry.outcome, 'completed');
  });

  it('save fills id and createdAt when missing', () => {
    const e = memory.save({ type: 'goal', goalPrompt: 'Test' });
    assert.ok(e.id && e.id.startsWith('mem-'));
    assert.ok(typeof e.createdAt === 'number');
    assert.ok(e.createdAt > 0);
  });

  it('save rejects non-object entries', () => {
    assert.throws(() => memory.save(null));
    assert.throws(() => memory.save('string'));
    assert.throws(() => memory.save(42));
  });

  it('truncates long goalPrompt', () => {
    const longStr = 'x'.repeat(1000);
    const e = memory.save({ type: 'goal', goalPrompt: longStr });
    assert.ok(e.goalPrompt.length <= 510); // 500 + '...'
    assert.ok(e.goalPrompt.endsWith('...'));
  });

  it('truncates long taskSummaries entries', () => {
    const longStr = 'y'.repeat(1000);
    const e = memory.save({ type: 'goal', goalPrompt: 'g', taskSummaries: [longStr, 'short'] });
    assert.ok(e.taskSummaries[0].endsWith('...'));
    assert.equal(e.taskSummaries[1], 'short');
  });

  it('ignores malformed lines when loading', () => {
    // Manually write a mix of valid and invalid lines
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath,
      JSON.stringify({ id: 'mem-1', createdAt: 1, type: 'goal', goalPrompt: 'good' }) + '\n' +
      'NOT JSON\n' +
      JSON.stringify({ id: 'mem-2', createdAt: 2, type: 'goal', goalPrompt: 'also good' }) + '\n' +
      JSON.stringify({ missing: 'fields' }) + '\n'
    );

    memory.load();
    assert.equal(memory.size(), 2);
  });

  it('search returns results ranked by overlap', () => {
    memory.save({ type: 'goal', goalPrompt: 'Refactor the authentication module', outcome: 'completed', taskSummaries: [] });
    memory.save({ type: 'goal', goalPrompt: 'Build a weather widget', outcome: 'completed', taskSummaries: [] });
    memory.save({ type: 'goal', goalPrompt: 'Fix auth bug with JWT tokens', outcome: 'completed', taskSummaries: [] });

    const results = memory.search('authentication bug', 5);
    assert.ok(results.length >= 1);
    // Top result should be auth-related
    assert.ok(results[0].entry.goalPrompt.toLowerCase().includes('auth'));
    // Weather should not be in top results (no overlap)
    const weatherHit = results.find(function (r) { return r.entry.goalPrompt.includes('weather'); });
    assert.equal(weatherHit, undefined);
  });

  it('search returns empty for empty query', () => {
    memory.save({ type: 'goal', goalPrompt: 'Something', outcome: 'completed', taskSummaries: [] });
    assert.deepEqual(memory.search('', 5), []);
    assert.deepEqual(memory.search(null, 5), []);
  });

  it('search respects k limit', () => {
    for (let i = 0; i < 10; i++) {
      memory.save({ type: 'goal', goalPrompt: 'goal about testing ' + i, outcome: 'completed', taskSummaries: [] });
    }
    const results = memory.search('testing', 3);
    assert.equal(results.length, 3);
  });

  it('getRecent returns newest first', () => {
    memory.save({ type: 'goal', goalPrompt: 'first', outcome: 'completed', taskSummaries: [] });
    memory.save({ type: 'goal', goalPrompt: 'second', outcome: 'completed', taskSummaries: [] });
    memory.save({ type: 'goal', goalPrompt: 'third', outcome: 'completed', taskSummaries: [] });

    const recent = memory.getRecent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].goalPrompt, 'third');
    assert.equal(recent[1].goalPrompt, 'second');
  });

  it('formatForContext renders human-readable block', () => {
    const entry = {
      type: 'goal',
      goalPrompt: 'Build a weather widget',
      outcome: 'completed',
      createdAt: new Date('2026-04-01T00:00:00Z').getTime(),
      taskSummaries: ['✓ Research APIs', '✓ Implement widget'],
    };
    const block = memory.formatForContext([{ entry: entry, score: 0.5 }]);
    assert.ok(block.includes('Relevant past work'));
    assert.ok(block.includes('Build a weather widget'));
    assert.ok(block.includes('Research APIs'));
    assert.ok(block.includes('2026-04-01'));
  });

  it('formatForContext returns empty for no results', () => {
    assert.equal(memory.formatForContext([]), '');
    assert.equal(memory.formatForContext(null), '');
  });

  it('writes file with 0o600 permissions', () => {
    memory.save({ type: 'goal', goalPrompt: 'permission test', outcome: 'completed', taskSummaries: [] });
    const stat = fs.statSync(filePath);
    // Check owner read+write bits and no world read
    const mode = stat.mode & 0o777;
    // 0o600 or at least no world/group permissions
    assert.ok((mode & 0o077) === 0, 'file should not be world/group readable: got ' + mode.toString(8));
  });
});
