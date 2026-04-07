const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryManager } = require('../src/pa/memory/index');
const { buildFtsQuery, bm25RankToScore, mergeHybridResults } = require('../src/pa/memory/hybrid');
const { cosineSimilarity } = require('../src/pa/memory/embeddings');

// --- MemoryManager ---

describe('MemoryManager', () => {
  let mm;

  beforeEach(() => {
    mm = new MemoryManager({ dbPath: ':memory:' });
    mm.init();
  });

  afterEach(() => {
    if (mm) mm.close();
  });

  // -- Conversations --

  it('saves and retrieves messages', () => {
    mm.saveMessage('chat1', 'user', 'hello');
    mm.saveMessage('chat1', 'assistant', 'hi there');
    const history = mm.getHistory('chat1');
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, 'hello');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].content, 'hi there');
  });

  it('respects limit on getHistory', () => {
    for (let i = 0; i < 10; i++) {
      mm.saveMessage('chat1', 'user', 'msg ' + i);
    }
    const history = mm.getHistory('chat1', 3);
    assert.equal(history.length, 3);
    // Should be the 3 most recent, in chronological order
    assert.equal(history[0].content, 'msg 7');
    assert.equal(history[2].content, 'msg 9');
  });

  it('isolates chats', () => {
    mm.saveMessage('chat1', 'user', 'msg a');
    mm.saveMessage('chat2', 'user', 'msg b');
    assert.equal(mm.getHistory('chat1').length, 1);
    assert.equal(mm.getHistory('chat2').length, 1);
  });

  it('counts messages', () => {
    mm.saveMessage('chat1', 'user', 'a');
    mm.saveMessage('chat1', 'user', 'b');
    assert.equal(mm.getMessageCount('chat1'), 2);
    assert.equal(mm.getMessageCount('chat2'), 0);
  });

  it('prunes old messages', () => {
    for (let i = 0; i < 10; i++) {
      mm.saveMessage('chat1', 'user', 'msg ' + i);
    }
    mm.pruneHistory('chat1', 3);
    assert.equal(mm.getMessageCount('chat1'), 3);
    const remaining = mm.getHistory('chat1');
    assert.equal(remaining[0].content, 'msg 7');
  });

  // -- Memories --

  it('adds and retrieves a memory', async () => {
    await mm.addMemory('fav_color', 'My favorite color is blue');
    const mem = mm.getMemory('fav_color');
    assert.ok(mem);
    assert.equal(mem.key, 'fav_color');
    assert.equal(mem.content, 'My favorite color is blue');
  });

  it('updates an existing memory', async () => {
    await mm.addMemory('name', 'Alice');
    await mm.addMemory('name', 'Bob');
    const mem = mm.getMemory('name');
    assert.equal(mem.content, 'Bob');
  });

  it('removes a memory', async () => {
    await mm.addMemory('temp', 'temporary');
    assert.equal(mm.removeMemory('temp'), true);
    assert.equal(mm.getMemory('temp'), null);
  });

  it('removeMemory returns false for nonexistent', () => {
    assert.equal(mm.removeMemory('nope'), false);
  });

  it('lists memories', async () => {
    await mm.addMemory('a', 'first');
    await mm.addMemory('b', 'second');
    const list = mm.listMemories();
    assert.equal(list.length, 2);
  });

  it('lists memories with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await mm.addMemory('m' + i, 'content ' + i);
    }
    const list = mm.listMemories(2);
    assert.equal(list.length, 2);
  });

  // -- Search --

  it('searches memories by keyword', async () => {
    await mm.addMemory('hobby', 'I enjoy playing chess and reading books');
    await mm.addMemory('work', 'I work as a software engineer');
    await mm.addMemory('food', 'I love sushi and ramen');

    const results = await mm.search('chess');
    assert.ok(results.length > 0);
    assert.equal(results[0].key, 'hobby');
  });

  it('search returns empty when no memories exist', async () => {
    const results = await mm.search('anything');
    assert.equal(results.length, 0);
  });

  it('getRelevantContext formats results', async () => {
    await mm.addMemory('pet', 'I have a cat named Luna');
    const context = await mm.getRelevantContext('cat');
    assert.ok(context.includes('pet'));
    assert.ok(context.includes('Luna'));
  });

  it('getRelevantContext returns empty when no matches', async () => {
    const context = await mm.getRelevantContext('nothing');
    assert.equal(context, '');
  });
});

// --- Hybrid search helpers ---

describe('buildFtsQuery', () => {
  it('wraps words in quotes', () => {
    assert.equal(buildFtsQuery('hello world'), '"hello" OR "world"');
  });

  it('strips punctuation', () => {
    const q = buildFtsQuery('hello, world!');
    assert.ok(q.includes('"hello"'));
    assert.ok(q.includes('"world"'));
  });

  it('filters single-char words', () => {
    assert.equal(buildFtsQuery('a b cd'), '"cd"');
  });

  it('returns empty for empty input', () => {
    assert.equal(buildFtsQuery(''), '');
    assert.equal(buildFtsQuery(null), '');
  });
});

describe('bm25RankToScore', () => {
  it('converts strong match to high score', () => {
    assert.ok(bm25RankToScore(-20) >= 0.9);
  });

  it('converts weak match to low score', () => {
    assert.ok(bm25RankToScore(-1) < 0.2);
  });

  it('clamps to [0, 1]', () => {
    assert.equal(bm25RankToScore(0), 0);
    assert.ok(bm25RankToScore(-100) <= 1);
  });
});

describe('mergeHybridResults', () => {
  it('merges vector and keyword results', () => {
    const merged = mergeHybridResults({
      vector: [{ id: 1, score: 0.9 }, { id: 2, score: 0.3 }],
      keyword: [{ id: 2, rank: -15 }, { id: 3, rank: -5 }],
    });
    assert.ok(merged.length >= 2);
    // id 1 should have high score (vector only), id 2 has both
  });

  it('handles empty inputs', () => {
    const merged = mergeHybridResults({ vector: [], keyword: [] });
    assert.equal(merged.length, 0);
  });

  it('sorts by score descending', () => {
    const merged = mergeHybridResults({
      vector: [{ id: 1, score: 0.2 }, { id: 2, score: 0.8 }],
      keyword: [],
    });
    assert.equal(merged[0].id, 2);
  });
});

// --- Cosine similarity ---

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 0.001);
  });

  it('returns 0 for orthogonal vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 0.001);
  });

  it('returns 0 for mismatched lengths', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it('returns 0 for null/undefined', () => {
    assert.equal(cosineSimilarity(null, [1]), 0);
    assert.equal(cosineSimilarity([1], null), 0);
  });
});
