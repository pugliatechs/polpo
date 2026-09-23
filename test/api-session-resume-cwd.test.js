const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Same module-stubbing harness the other api tests use, so the router
// can be exercised without a real agent factory or session store.
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

// Two real directories, so the router's isDirectory() checks pass.
const REAL_RECORDED = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-recorded-'));
const REAL_CLIENT = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-client-'));
const GONE = path.join(os.tmpdir(), 'polpo-definitely-not-here-' + process.pid);

// What resolveSessionCwd should report for the next request.
let recordedCwd = null;
let resolveThrows = false;
// What cwd createAgent was actually constructed with.
let spawnedWith = null;

stubModule('../src/server/sessions', {
  scanSessions: async () => [],
  loadHistory: async () => [],
  resolveSessionCwd: async () => {
    if (resolveThrows) throw new Error('store unreadable');
    return recordedCwd;
  },
});

stubModule('../src/agent/agent-factory', {
  createAgent: (type, opts) => {
    spawnedWith = opts.cwd;
    return {
      instanceId: 'inst-1',
      start: async () => {},
      ws: { readyState: 1, close() {}, on: () => {}, once: () => {} },
      on: () => {},
      stop: () => {},
    };
  },
});

const { createApiRouter } = require('../src/server/api');

function instanceManager() {
  return {
    on: () => {}, register: () => ({}), unregister: () => {},
    get: () => null, getAll: () => [], updateStatus: () => {},
    addMessage: () => {}, sendToAgent: () => false, getConversation: () => [],
    setSessionInfo: () => {},
  };
}

function mount() {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(
    instanceManager(),
    () => ({ token: 't', trustLocalhost: false, mfaEnabled: false }),
    null,
    null,
    () => null,
  ));
  return app;
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

async function resume(body) {
  const app = mount();
  const srv = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  try {
    await post(srv.address().port, '/api/sessions/' + SESSION_ID + '/resume', body);
  } finally {
    srv.close();
  }
  return spawnedWith;
}

describe('POST /api/sessions/:id/resume: which cwd the agent launches in', () => {
  beforeEach(() => {
    recordedCwd = null;
    resolveThrows = false;
    spawnedWith = null;
  });

  it('launches in the cwd the transcript recorded', async () => {
    // Agents find a transcript by hashing the cwd into a project slug,
    // so this is the only directory the resume can actually work from.
    recordedCwd = REAL_RECORDED;
    assert.equal(await resume({}), REAL_RECORDED);
  });

  it('prefers the recorded cwd over one the client supplied', async () => {
    recordedCwd = REAL_RECORDED;
    assert.equal(await resume({ cwd: REAL_CLIENT }), REAL_RECORDED);
  });

  it('falls back to the client cwd when the store has no answer', async () => {
    // The SQLite-backed stores (opencode, pi, goose) resolve to null.
    recordedCwd = null;
    assert.equal(await resume({ cwd: REAL_CLIENT }), REAL_CLIENT);
  });

  it('falls back to the client cwd when the project has since moved', async () => {
    recordedCwd = GONE;
    assert.equal(await resume({ cwd: REAL_CLIENT }), REAL_CLIENT);
  });

  it('falls back to the client cwd when the store read throws', async () => {
    resolveThrows = true;
    assert.equal(await resume({ cwd: REAL_CLIENT }), REAL_CLIENT);
  });

  it('ignores a relative client cwd', async () => {
    assert.equal(await resume({ cwd: './somewhere' }), process.cwd());
  });

  it('ignores a client cwd that is not a directory', async () => {
    assert.equal(await resume({ cwd: GONE }), process.cwd());
  });

  it('still answers when neither source yields a directory', async () => {
    // This is the old default, and the bug being fixed: it launched the
    // agent inside polpo's own directory, where the agent reported that
    // no conversation was found. It stays only as a last resort.
    assert.equal(await resume({}), process.cwd());
  });

  it('rejects an invalid session id before resolving anything', async () => {
    const app = mount();
    const srv = await new Promise((res) => {
      const s = app.listen(0, '127.0.0.1', () => res(s));
    });
    try {
      const { status } = await post(srv.address().port, '/api/sessions/..%2Fetc/resume', {});
      assert.ok(status === 400 || status === 404, 'got ' + status);
      assert.equal(spawnedWith, null);
    } finally { srv.close(); }
  });
});
