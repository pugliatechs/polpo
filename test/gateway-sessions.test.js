const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const express = require('express');
const { createGatewayRouter } = require('../src/server/gateway');

// --- Mocks ---

function createMockIM(conversations) {
  const em = new EventEmitter();
  // conversations: { [instanceId]: { instance, messages } }
  em.getAll = function () {
    return Object.values(conversations).map(e => e.instance);
  };
  em.getConversation = function (id, limit) {
    const entry = conversations[id];
    if (!entry) return [];
    return entry.messages.slice(-(limit || 50));
  };
  em.get = function (id) {
    const e = conversations[id];
    return e ? e.instance : null;
  };
  em.sendToAgent = function () { return true; };
  return em;
}

// Stub task manager so the gateway router can construct.
function createStubTaskManager() {
  return {
    _activeTaskCount() { return 0; },
    createTask: async () => { throw new Error('not used'); },
    getTask: () => null,
    cancelTask: () => false,
    subscribe: () => function unsub() {},
    listArtifacts: () => [],
    openArtifact: () => { throw new Error('not used'); },
  };
}

function startServer(routerOpts) {
  const app = express();
  app.use('/v1', createGatewayRouter(routerOpts));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: 'http://127.0.0.1:' + port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const VALID_KEY = 'test-sessions-key';
const AUTH = { Authorization: 'Bearer ' + VALID_KEY };

// --- Suites ---

describe('Gateway /v1/search', () => {
  let im, harness;

  beforeEach(async () => {
    im = createMockIM({
      'inst-alpha': {
        instance: {
          id: 'inst-alpha',
          sessionId: 'sess-alpha',
          project: 'authproject',
          cwd: '/tmp/authproject',
          agentType: 'claude',
          firstPrompt: 'Refactor the auth module',
          lastActivity: Date.now(),
        },
        messages: [
          { role: 'user', content: 'Refactor the auth flow', timestamp: Date.now() - 1000 },
          { role: 'assistant', content: 'Sure, looking at the bearer token middleware', timestamp: Date.now() },
        ],
      },
    });
    harness = await startServer({
      taskManager: createStubTaskManager(),
      getKey: () => VALID_KEY,
      instanceManager: im,
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('401 without bearer token', async () => {
    const r = await fetch(harness.url + '/v1/search?q=auth');
    assert.equal(r.status, 401);
  });

  it('400 on missing query', async () => {
    const r = await fetch(harness.url + '/v1/search', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_query');
  });

  it('400 on too-short query', async () => {
    const r = await fetch(harness.url + '/v1/search?q=a', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_query');
  });

  it('400 on overlong query', async () => {
    const r = await fetch(harness.url + '/v1/search?q=' + 'a'.repeat(201), { headers: AUTH });
    assert.equal(r.status, 400);
  });

  it('400 on invalid include filter', async () => {
    const r = await fetch(harness.url + '/v1/search?q=auth&include=garbage', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_include');
  });

  it('returns in-memory hits when include=memory and disk is unavailable', async () => {
    const r = await fetch(harness.url + '/v1/search?q=auth&include=memory', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.results));
    const memHits = body.results.filter(h => h.source === 'memory');
    assert.ok(memHits.length >= 1);
    assert.equal(memHits[0].sessionId, 'sess-alpha');
    assert.equal(memHits[0].instanceId, 'inst-alpha');
  });

  it('returns merged disk + memory hits sorted by timestamp desc', async () => {
    const r = await fetch(harness.url + '/v1/search?q=auth', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    // In-memory hits should be present (disk is empty in CI for the test account)
    const sources = new Set(body.results.map(h => h.source));
    assert.ok(sources.has('memory'));
    // Newest first
    for (let i = 1; i < body.results.length; i++) {
      const a = body.results[i - 1].timestamp || 0;
      const b = body.results[i].timestamp || 0;
      const ta = typeof a === 'number' ? a : Date.parse(a) || 0;
      const tb = typeof b === 'number' ? b : Date.parse(b) || 0;
      assert.ok(ta >= tb, 'timestamps should be newest-first');
    }
  });
});

describe('Gateway /v1/sessions/search', () => {
  let im, harness;
  const now = Date.now();

  beforeEach(async () => {
    im = createMockIM({
      'inst-fresh': {
        instance: {
          id: 'inst-fresh', sessionId: 'sess-fresh',
          project: 'fresh', cwd: '/tmp/fresh', agentType: 'claude',
          firstPrompt: 'Fresh project on auth', lastActivity: now,
        },
        messages: [
          { role: 'user', content: 'auth flow today', timestamp: now },
          { role: 'user', content: 'still auth', timestamp: now - 1000 },
        ],
      },
      'inst-quiet': {
        instance: {
          id: 'inst-quiet', sessionId: 'sess-quiet',
          project: 'quiet', cwd: '/tmp/quiet', agentType: 'claude',
          firstPrompt: 'Quiet auth project', lastActivity: now - 86400000,
        },
        messages: [
          { role: 'user', content: 'auth once long ago', timestamp: now - 86400000 },
        ],
      },
    });
    harness = await startServer({
      taskManager: createStubTaskManager(), getKey: () => VALID_KEY, instanceManager: im,
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('401 without bearer', async () => {
    const r = await fetch(harness.url + '/v1/sessions/search?q=auth');
    assert.equal(r.status, 401);
  });

  it('400 on bad query', async () => {
    const r = await fetch(harness.url + '/v1/sessions/search?q=a', { headers: AUTH });
    assert.equal(r.status, 400);
  });

  it('returns sessions grouped, ranked by score', async () => {
    const r = await fetch(harness.url + '/v1/sessions/search?q=auth', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.sessions));
    const ids = body.sessions.map(s => s.sessionId);
    assert.ok(ids.indexOf('sess-fresh') !== -1);
    assert.ok(ids.indexOf('sess-quiet') !== -1);
    // Fresh session: 2 hits with recency boost (today). Quiet: 1 hit 1d ago.
    // Fresh score should be higher.
    const fresh = body.sessions.find(s => s.sessionId === 'sess-fresh');
    const quiet = body.sessions.find(s => s.sessionId === 'sess-quiet');
    assert.ok(fresh.score > quiet.score, 'fresh.score=' + fresh.score + ' should beat quiet.score=' + quiet.score);
    assert.equal(fresh.matchCount, 2);
    assert.equal(quiet.matchCount, 1);
    // Enrichment from live instance
    assert.equal(fresh.project, 'fresh');
    assert.equal(fresh.cwd, '/tmp/fresh');
    assert.equal(fresh.instanceId, 'inst-fresh');
  });

  it('respects snippets cap', async () => {
    const r = await fetch(harness.url + '/v1/sessions/search?q=auth&snippets=1', { headers: AUTH });
    const body = await r.json();
    for (const s of body.sessions) {
      assert.ok(s.topSnippets.length <= 1);
    }
  });
});

describe('Gateway /v1/sessions catalogue', () => {
  let im, harness;
  const now = Date.now();

  beforeEach(async () => {
    im = createMockIM({
      'inst-user': {
        instance: {
          id: 'inst-user', sessionId: 'sess-user',
          project: 'userwork', cwd: '/u/work', agentType: 'claude',
          firstPrompt: 'manual session', lastActivity: now, source: null,
        },
        messages: [],
      },
      'inst-gw': {
        instance: {
          id: 'inst-gw', sessionId: 'sess-gw',
          project: 'gwwork', cwd: '/g/work', agentType: 'claude',
          firstPrompt: 'gateway task', lastActivity: now - 5000,
          source: 'gateway:openclaw',
        },
        messages: [],
      },
    });
    harness = await startServer({
      taskManager: createStubTaskManager(), getKey: () => VALID_KEY, instanceManager: im,
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('401 without bearer', async () => {
    const r = await fetch(harness.url + '/v1/sessions');
    assert.equal(r.status, 401);
  });

  it('400 on invalid source', async () => {
    const r = await fetch(harness.url + '/v1/sessions?source=bogus', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_source');
  });

  it('returns live instances with isLive: true', async () => {
    const r = await fetch(harness.url + '/v1/sessions', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.sessions));
    const liveIds = body.sessions.filter(s => s.isLive).map(s => s.sessionId);
    assert.ok(liveIds.includes('sess-user'));
    assert.ok(liveIds.includes('sess-gw'));
  });

  it('source=gateway filters to only gateway-spawned instances', async () => {
    const r = await fetch(harness.url + '/v1/sessions?source=gateway', { headers: AUTH });
    const body = await r.json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].sessionId, 'sess-gw');
    assert.equal(body.sessions[0].source, 'gateway:openclaw');
  });

  it('never leaks the agentSocket field', async () => {
    const r = await fetch(harness.url + '/v1/sessions', { headers: AUTH });
    const body = await r.json();
    for (const s of body.sessions) {
      assert.equal(s.agentSocket, undefined);
    }
  });
});

describe('Gateway /v1/sessions/:id', () => {
  let im, harness;
  const now = Date.now();

  beforeEach(async () => {
    im = createMockIM({
      'inst-foo': {
        instance: {
          id: 'inst-foo', sessionId: 'sess-foo',
          project: 'foo', cwd: '/tmp/foo', agentType: 'claude',
          firstPrompt: 'hi', lastActivity: now,
        },
        messages: [
          { role: 'user', content: 'first', timestamp: now - 3000 },
          { role: 'assistant', content: 'second', timestamp: now - 2000 },
          { role: 'user', content: 'third', timestamp: now - 1000 },
        ],
      },
    });
    harness = await startServer({
      taskManager: createStubTaskManager(), getKey: () => VALID_KEY, instanceManager: im,
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('401 without bearer', async () => {
    const r = await fetch(harness.url + '/v1/sessions/sess-foo');
    assert.equal(r.status, 401);
  });

  it('400 on path traversal', async () => {
    const r = await fetch(harness.url + '/v1/sessions/..%2Fetc%2Fpasswd', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_session_id');
  });

  it('400 on NUL / unsafe chars', async () => {
    const r = await fetch(harness.url + '/v1/sessions/' + encodeURIComponent('bad\0id'), { headers: AUTH });
    assert.equal(r.status, 400);
  });

  it('returns live session messages with isLive: true', async () => {
    const r = await fetch(harness.url + '/v1/sessions/sess-foo?tail=10', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.isLive, true);
    assert.equal(body.instanceId, 'inst-foo');
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].content, 'first');
    assert.equal(body.messages[2].content, 'third');
  });

  it('respects tail param', async () => {
    const r = await fetch(harness.url + '/v1/sessions/sess-foo?tail=2', { headers: AUTH });
    const body = await r.json();
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].content, 'second');
    assert.equal(body.messages[1].content, 'third');
  });

  it('supports offset+limit pagination', async () => {
    const r = await fetch(harness.url + '/v1/sessions/sess-foo?offset=1&limit=1', { headers: AUTH });
    const body = await r.json();
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'second');
    assert.equal(body.hasMore, true);
  });

  it('strips internal fields from messages', async () => {
    const r = await fetch(harness.url + '/v1/sessions/sess-foo', { headers: AUTH });
    const body = await r.json();
    for (const m of body.messages) {
      assert.ok(Object.keys(m).every(k =>
        ['role', 'content', 'timestamp', 'type', 'contentType', 'toolUseId'].includes(k)),
        'unexpected message key: ' + Object.keys(m).join(','));
    }
  });

  it('404 for unknown id when no live + no disk match', async () => {
    const r = await fetch(harness.url + '/v1/sessions/nonexistent-session', { headers: AUTH });
    assert.equal(r.status, 404);
  });
});

describe('Gateway search rate limiting', () => {
  let im, harness;

  beforeEach(async () => {
    im = createMockIM({});
    harness = await startServer({
      taskManager: createStubTaskManager(), getKey: () => VALID_KEY, instanceManager: im,
    });
  });
  afterEach(async () => { await closeServer(harness.server); });

  it('returns 429 after the per-token cap is exceeded', async () => {
    // Search limiter is 30/min. Fire 32 requests sequentially. We use
    // include=memory to skip the on-disk scan so all 32 finish well
    // inside the 60s window — otherwise the bucket resets midway.
    let last;
    for (let i = 0; i < 32; i++) {
      last = await fetch(harness.url + '/v1/search?q=needle&include=memory', { headers: AUTH });
    }
    assert.equal(last.status, 429);
    assert.equal((await last.json()).error, 'rate_limited');
  });
});
