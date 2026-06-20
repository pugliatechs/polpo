const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_QUERY_LENGTH,
  MAX_QUERY_LENGTH,
  prepareQuery,
  clampLimit,
  isValidSessionId,
  buildSnippet,
  rankScore,
  extractLiveContent,
  extractClaudeContent,
  extractCodexContent,
  extractPiContent,
  extractGeminiText,
  searchInMemory,
  groupBySession,
} = require('../src/server/conversation-search');

// ---- prepareQuery / clampLimit / isValidSessionId ----

describe('prepareQuery (bounds + normalisation)', () => {
  it('lowercases the trimmed query', () => {
    assert.equal(prepareQuery('  Hello WORLD  '), 'hello world');
  });

  it('rejects queries below the minimum length', () => {
    assert.equal(MIN_QUERY_LENGTH, 2);
    assert.equal(prepareQuery('a'), null);
    assert.equal(prepareQuery(''), null);
    assert.equal(prepareQuery('   '), null);
  });

  it('rejects queries above the maximum length', () => {
    const long = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    assert.equal(prepareQuery(long), null);
  });

  it('rejects non-string input', () => {
    assert.equal(prepareQuery(null), null);
    assert.equal(prepareQuery(undefined), null);
    assert.equal(prepareQuery(42), null);
    assert.equal(prepareQuery({}), null);
  });
});

describe('clampLimit', () => {
  it('returns the default when input is missing or invalid', () => {
    assert.equal(clampLimit(undefined, 100), 20);
    assert.equal(clampLimit('not a number', 100), 20);
    assert.equal(clampLimit(0, 100), 20);
    assert.equal(clampLimit(-5, 100), 20);
  });

  it('clamps to the provided max', () => {
    assert.equal(clampLimit(1000, 50), 50);
    assert.equal(clampLimit(25, 50), 25);
  });

  it('parses string numbers', () => {
    assert.equal(clampLimit('30', 100), 30);
  });
});

describe('isValidSessionId', () => {
  it('accepts the documented charset', () => {
    assert.equal(isValidSessionId('abc-DEF_123.txt'), true);
    assert.equal(isValidSessionId('5e3a4f10-1234-5678-9abc-def012345678'), true);
  });

  it('rejects traversal vectors', () => {
    assert.equal(isValidSessionId('../etc/passwd'), false);
    assert.equal(isValidSessionId('a/b'), false);
    assert.equal(isValidSessionId('a\\b'), false);
    assert.equal(isValidSessionId('a\x00b'), false);
    assert.equal(isValidSessionId('a\nb'), false);
  });

  it('rejects empty and overlong input', () => {
    assert.equal(isValidSessionId(''), false);
    assert.equal(isValidSessionId(null), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId('a'.repeat(201)), false);
  });
});

// ---- buildSnippet ----

describe('buildSnippet (windowing)', () => {
  it('adds ellipses on both sides when the match is in the middle', () => {
    const content = 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200);
    const { snippet, matchIndex, matchLength } = buildSnippet(content, 200, 'NEEDLE'.length);
    assert.ok(snippet.startsWith('...'));
    assert.ok(snippet.endsWith('...'));
    // matchIndex is relative to the snippet, accounting for the leading ellipsis
    assert.equal(snippet.slice(matchIndex, matchIndex + matchLength), 'NEEDLE');
  });

  it('omits the leading ellipsis when the match is near the start', () => {
    const { snippet } = buildSnippet('NEEDLE in a haystack', 0, 6);
    assert.ok(!snippet.startsWith('...'));
  });

  it('omits the trailing ellipsis when the match reaches the end', () => {
    const content = 'a haystack ending with NEEDLE';
    const { snippet } = buildSnippet(content, content.indexOf('NEEDLE'), 6);
    assert.ok(!snippet.endsWith('...'));
  });
});

// ---- rankScore ----

describe('rankScore (matchCount + recency boost)', () => {
  const NOW = Date.parse('2026-05-31T12:00:00Z');
  const dayAgo = NOW - 24 * 60 * 60 * 1000;
  const oneMonthAgo = NOW - 30 * 24 * 60 * 60 * 1000;
  const oneYearAgo = NOW - 365 * 24 * 60 * 60 * 1000;

  it('a single match today (~5) outranks four matches a year ago (~4)', () => {
    const today = rankScore(1, NOW, NOW);
    const ancient = rankScore(4, oneYearAgo, NOW);
    assert.ok(today > ancient, today + ' should be > ' + ancient);
  });

  it('ten matches today outranks both', () => {
    const ten = rankScore(10, NOW, NOW);
    const today = rankScore(1, NOW, NOW);
    const ancient = rankScore(4, oneYearAgo, NOW);
    assert.ok(ten > today && ten > ancient);
  });

  it('recency boost reaches 0 at 30 days old', () => {
    assert.equal(rankScore(1, oneMonthAgo, NOW), 1);
  });

  it('matchCount of 0 gives a score of 0', () => {
    assert.equal(rankScore(0, NOW, NOW), 0);
  });

  it('missing timestamp scores by matchCount alone (no recency boost)', () => {
    assert.equal(rankScore(5, null, NOW), 5);
    assert.equal(rankScore(5, undefined, NOW), 5);
  });

  it('day-old match gets a near-max boost', () => {
    // matchCount=1 + boost ≈ 4.833 → score ≈ 5.833 (between 5.8 and 5.85)
    const score = rankScore(1, dayAgo, NOW);
    assert.ok(score > 5.8 && score < 5.85, 'expected ~5.833, got ' + score);
  });
});

// ---- groupBySession ----

describe('groupBySession (aggregation + ranking)', () => {
  const NOW = Date.parse('2026-05-31T12:00:00Z');

  function hit(sessionId, daysAgo, role) {
    return {
      sessionId,
      snippet: 's',
      role: role || 'user',
      matchIndex: 0,
      matchLength: 5,
      timestamp: NOW - daysAgo * 24 * 60 * 60 * 1000,
      source: 'disk',
    };
  }

  it('aggregates matchCount per sessionId', () => {
    const sessions = groupBySession([hit('A', 0), hit('A', 1), hit('B', 0)], { now: NOW });
    const a = sessions.find(s => s.sessionId === 'A');
    const b = sessions.find(s => s.sessionId === 'B');
    assert.equal(a.matchCount, 2);
    assert.equal(b.matchCount, 1);
  });

  it('ranks today-with-N-matches above year-old-with-the-same-N', () => {
    // With matchCount equal on both sides, recency boost (~5) decides
    const fresh = [hit('FRESH', 0), hit('FRESH', 0), hit('FRESH', 1)];
    const ancient = [hit('ANCIENT', 365), hit('ANCIENT', 365), hit('ANCIENT', 365)];
    const sessions = groupBySession(fresh.concat(ancient), { now: NOW });
    assert.equal(sessions[0].sessionId, 'FRESH');
  });

  it('the documented examples hold: 1 today (~5.8) > 4 year-ago (4.0); 10 today (~14.8) > both', () => {
    const oneToday = rankScore(1, NOW, NOW);              // ≈ 5.83
    const fourAncient = rankScore(4, NOW - 365 * 86400000, NOW); // 4.00
    const tenToday = rankScore(10, NOW, NOW);             // ≈ 14.83
    assert.ok(oneToday > fourAncient);
    assert.ok(tenToday > oneToday && tenToday > fourAncient);
  });

  it('caps topSnippets to the requested count', () => {
    const many = Array.from({ length: 10 }, (_, i) => hit('A', i));
    const sessions = groupBySession(many, { snippets: 2, now: NOW });
    assert.equal(sessions[0].topSnippets.length, 2);
  });

  it('topSnippets are sorted newest-first', () => {
    const out = groupBySession([hit('A', 5), hit('A', 0), hit('A', 2)], { snippets: 3, now: NOW });
    const tss = out[0].topSnippets.map(s => s.timestamp);
    assert.deepEqual(tss, [NOW, NOW - 2 * 86400000, NOW - 5 * 86400000]);
  });

  it('snippets cap above maximum is clamped to MAX_TOP_SNIPPETS', () => {
    const many = Array.from({ length: 10 }, (_, i) => hit('A', i));
    const sessions = groupBySession(many, { snippets: 100, now: NOW });
    assert.equal(sessions[0].topSnippets.length, 5); // MAX_TOP_SNIPPETS
  });

  it('preserves instanceId from hits that have one', () => {
    const inMem = { ...hit('A', 0), instanceId: 'inst-1' };
    const onDisk = hit('A', 1);
    const sessions = groupBySession([inMem, onDisk], { now: NOW });
    assert.equal(sessions[0].instanceId, 'inst-1');
  });
});

// ---- extractLiveContent ----

describe('extractLiveContent (InstanceManager envelope)', () => {
  it('handles plain string content', () => {
    assert.deepEqual(extractLiveContent({ role: 'user', content: 'hi' }),
      { content: 'hi', role: 'user' });
  });

  it('handles content blocks (text + output_text)', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'one' }, { type: 'output_text', text: 'two' }, { type: 'image' }],
    };
    assert.deepEqual(extractLiveContent(msg), { content: 'one two', role: 'assistant' });
  });

  it('returns null when content is missing or empty', () => {
    assert.equal(extractLiveContent({ role: 'user' }), null);
    assert.equal(extractLiveContent({ role: 'user', content: [] }), null);
    assert.equal(extractLiveContent(null), null);
  });
});

// ---- searchInMemory ----

describe('searchInMemory (live conversations)', () => {
  function makeMockIM(setup) {
    const instances = setup; // { id: { instance, conversation } }
    return {
      getAll() {
        return Object.values(instances).map(e => e.instance);
      },
      getConversation(id, limit) {
        const entry = instances[id];
        if (!entry) return [];
        return entry.conversation.slice(-(limit || 50));
      },
    };
  }

  it('returns hits with source: memory and instanceId set', () => {
    const im = makeMockIM({
      'inst-1': {
        instance: { id: 'inst-1', sessionId: 'sess-1' },
        conversation: [
          { role: 'user', content: 'tell me about the auth flow', timestamp: 1000 },
          { role: 'assistant', content: 'the auth flow uses bearer tokens', timestamp: 2000 },
        ],
      },
    });
    const { results } = searchInMemory('auth', im);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.source, 'memory');
      assert.equal(r.instanceId, 'inst-1');
      assert.equal(r.sessionId, 'sess-1');
    }
    // Sorted newest-first
    assert.equal(results[0].timestamp, 2000);
    assert.equal(results[1].timestamp, 1000);
  });

  it('falls back to instance.id when no sessionId is set', () => {
    const im = makeMockIM({
      'inst-2': {
        instance: { id: 'inst-2' },
        conversation: [{ role: 'user', content: 'foo bar baz', timestamp: 1 }],
      },
    });
    const { results } = searchInMemory('foo', im);
    assert.equal(results[0].sessionId, 'inst-2');
  });

  it('skips instances with unsafe ids', () => {
    const im = makeMockIM({
      '../escape': {
        instance: { id: '../escape', sessionId: '../escape' },
        conversation: [{ role: 'user', content: 'foo', timestamp: 1 }],
      },
    });
    const { results } = searchInMemory('foo', im);
    assert.equal(results.length, 0);
  });

  it('returns empty for an invalid query', () => {
    const im = makeMockIM({});
    assert.deepEqual(searchInMemory('a', im).results, []);
    assert.deepEqual(searchInMemory('   ', im).results, []);
  });

  it('respects the candidate-pool limit', () => {
    const conv = Array.from({ length: 100 }, (_, i) => ({
      role: 'user',
      content: 'match number ' + i,
      timestamp: i,
    }));
    const im = makeMockIM({
      'i1': { instance: { id: 'i1', sessionId: 'i1' }, conversation: conv },
    });
    const { results } = searchInMemory('match', im, { limit: 10 });
    assert.equal(results.length, 10);
  });

  it('returns empty when instanceManager is missing', () => {
    assert.deepEqual(searchInMemory('foo', null).results, []);
    assert.deepEqual(searchInMemory('foo', undefined).results, []);
  });
});

// ---- Extractor sanity (lifted-as-is from api.js, smoke check) ----

describe('extractors (smoke checks)', () => {
  it('extractClaudeContent string vs array', () => {
    assert.deepEqual(
      extractClaudeContent({ type: 'user', message: { content: 'hi' } }),
      { content: 'hi', role: 'user' }
    );
    assert.deepEqual(
      extractClaudeContent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      { content: 'hi', role: 'assistant' }
    );
    assert.equal(extractClaudeContent({ message: null }), null);
    assert.equal(extractClaudeContent({}), null);
  });

  it('extractCodexContent user vs assistant', () => {
    assert.deepEqual(
      extractCodexContent({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
      { content: 'hi', role: 'user' }
    );
    assert.deepEqual(
      extractCodexContent({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      }),
      { content: 'ok', role: 'assistant' }
    );
    assert.equal(extractCodexContent({}), null);
  });

  it('extractPiContent string vs blocks', () => {
    assert.deepEqual(
      extractPiContent({ type: 'message', role: 'user', content: 'hi' }),
      { content: 'hi', role: 'user' }
    );
    assert.deepEqual(
      extractPiContent({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }),
      { content: 'hi', role: 'assistant' }
    );
    assert.equal(extractPiContent({ type: 'tool_use', content: 'x' }), null);
  });

  it('extractGeminiText string vs blocks', () => {
    assert.equal(extractGeminiText('hello'), 'hello');
    assert.equal(extractGeminiText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b');
    assert.equal(extractGeminiText([{ type: 'image' }]), null);
    assert.equal(extractGeminiText(null), null);
  });
});
