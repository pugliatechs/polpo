const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const Module = require('module');

// Stub the heavy scanSessions to return a deterministic list, so this
// test focuses on the pagination + cache logic in the route handler.
const originalResolve = Module._resolveFilename;
const stubbed = new Map();
function stubModule(spec, fakeExports) {
  stubbed.set(require.resolve(spec), fakeExports);
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try {
    const full = Module._resolveFilename(request, parent, isMain);
    if (stubbed.has(full)) return stubbed.get(full);
  } catch {}
  return origLoad.call(this, request, parent, isMain);
};

// Stub createAgent so the api router can require it without a real factory.
stubModule('../src/agent/agent-factory', { createAgent: () => null });

// Provide a 250-entry deterministic catalogue. Each call records its
// args so tests can confirm the cache prevents re-walks.
let scanCalls = 0;
stubModule('../src/server/sessions', {
  scanSessions: async (opts) => {
    scanCalls++;
    const list = [];
    for (let i = 0; i < 250; i++) {
      list.push({
        sessionId: 's-' + i,
        agentType: 'claude',
        project: 'p',
        cwd: '/tmp',
        firstPrompt: 'prompt ' + i,
        lastActivity: Date.now() - i * 1000,
      });
    }
    return list.slice(0, opts.limit || list.length);
  },
  loadHistory: async () => ({ messages: [], total: 0 }),
});

// Now require the router (it will see our stubs).
const { createApiRouter } = require('../src/server/api');

function noopInstanceManager() {
  return {
    on: () => {}, register: () => ({}), unregister: () => {},
    get: () => null, getAll: () => [], updateStatus: () => {},
    addMessage: () => {}, sendToAgent: () => false, getConversation: () => [],
  };
}

function mount() {
  const app = express();
  app.use('/api', createApiRouter(
    noopInstanceManager(),
    () => ({ token: 't', trustLocalhost: false, mfaEnabled: false }),
    null,
    null,
    () => null,
  ));
  return app;
}

function listenOn(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function fetchJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

describe('GET /api/sessions: pagination + cache', () => {
  it('returns the first 30 sessions by default with X-Total-Count + X-Has-More', async () => {
    scanCalls = 0;
    const app = mount();
    const { srv, port } = await listenOn(app);
    try {
      const { status, headers, body } = await fetchJson(port, '/api/sessions');
      assert.equal(status, 200);
      assert.equal(body.length, 50, 'default limit is 50');
      assert.equal(headers['x-total-count'], '250');
      assert.equal(headers['x-has-more'], '1');
      assert.equal(headers['x-offset'], '0');
    } finally { srv.close(); }
  });

  it('respects ?offset=N&limit=M', async () => {
    scanCalls = 0;
    const app = mount();
    const { srv, port } = await listenOn(app);
    try {
      const page1 = await fetchJson(port, '/api/sessions?offset=0&limit=10');
      const page2 = await fetchJson(port, '/api/sessions?offset=10&limit=10');
      assert.equal(page1.body.length, 10);
      assert.equal(page2.body.length, 10);
      assert.notDeepEqual(page1.body[0], page2.body[0], 'pages are distinct');
      assert.equal(page1.body[0].sessionId, 's-0');
      assert.equal(page2.body[0].sessionId, 's-10');
    } finally { srv.close(); }
  });

  it('caches the scan so multiple page fetches do NOT re-walk', async () => {
    scanCalls = 0;
    const app = mount();
    const { srv, port } = await listenOn(app);
    try {
      await fetchJson(port, '/api/sessions?offset=0&limit=10');
      await fetchJson(port, '/api/sessions?offset=10&limit=10');
      await fetchJson(port, '/api/sessions?offset=20&limit=10');
      assert.equal(scanCalls, 1, 'one scan covers all three page fetches');
    } finally { srv.close(); }
  });

  it('X-Has-More is 0 when the offset reaches the end of the list', async () => {
    const app = mount();
    const { srv, port } = await listenOn(app);
    try {
      const { headers } = await fetchJson(port, '/api/sessions?offset=240&limit=30');
      assert.equal(headers['x-has-more'], '0');
    } finally { srv.close(); }
  });

  it('different (days,source) tuples have separate cache entries', async () => {
    scanCalls = 0;
    const app = mount();
    const { srv, port } = await listenOn(app);
    try {
      await fetchJson(port, '/api/sessions?days=7&source=all');
      await fetchJson(port, '/api/sessions?days=30&source=all');
      assert.equal(scanCalls, 2, 'days=7 and days=30 are cached separately');
    } finally { srv.close(); }
  });
});
