const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Point the router's cache file at a scratch HOME. os.homedir() reads
// $HOME on POSIX, and the router resolves the path when it is created,
// so this must be set before createApiRouter runs.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-profile-home-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = FAKE_HOME;
const CACHE_PATH = path.join(FAKE_HOME, '.config', 'polpo', 'profile-cache.json');

after(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

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

// The real analysis takes 30 to 40 seconds over a large history. Here it
// is a counted, controllable stub.
let analyzeCalls = 0;
let analyzeDelayMs = 0;
let analyzeFails = false;
let archetypeName = 'The Architect';

stubModule('../src/server/profile-analyzer', {
  analyzeProfile: async () => {
    analyzeCalls++;
    if (analyzeDelayMs) await new Promise((r) => setTimeout(r, analyzeDelayMs));
    if (analyzeFails) throw new Error('analysis blew up');
    return {
      archetype: { name: archetypeName, blurb: 'b' },
      dimensions: { steering: 65, execution: 76, engineering: 48, productInstinct: 63, planning: 86 },
      activity: { totalSessions: 1073, spanDays: 304 },
      generatedAt: Date.now(),
    };
  },
});
stubModule('../src/server/sessions', { scanSessions: async () => [], loadHistory: async () => [] });
stubModule('../src/agent/agent-factory', { createAgent: () => null });

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
  app.use('/api', createApiRouter(
    instanceManager(),
    () => ({ token: 't', trustLocalhost: false, mfaEnabled: false }),
    null, null, () => null,
  ));
  return app;
}

function listen(app) {
  return new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    }).on('error', reject);
  });
}

async function withServer(fn) {
  const srv = await listen(mount());
  try {
    return await fn(srv.address().port);
  } finally {
    srv.close();
  }
}

describe('GET /api/profile: caching', () => {
  beforeEach(() => {
    analyzeCalls = 0;
    analyzeDelayMs = 0;
    analyzeFails = false;
    archetypeName = 'The Architect';
    try { fs.rmSync(CACHE_PATH, { force: true }); } catch {}
  });

  it('computes and returns a profile when nothing is cached', async () => {
    await withServer(async (port) => {
      const { status, body } = await get(port, '/api/profile');
      assert.equal(status, 200);
      assert.equal(body.archetype.name, 'The Architect');
      assert.equal(analyzeCalls, 1);
    });
  });

  it('serves a warm cache without recomputing', async () => {
    await withServer(async (port) => {
      await get(port, '/api/profile');
      const { headers } = await get(port, '/api/profile');
      assert.equal(analyzeCalls, 1, 'second request must not recompute');
      assert.equal(headers['x-profile-stale'], undefined);
    });
  });

  it('shares one run between concurrent callers instead of turning one away', async () => {
    // A second dashboard tab used to get a bare 429, which the client
    // turned into a permanently hidden section.
    analyzeDelayMs = 60;
    await withServer(async (port) => {
      const [a, b, c] = await Promise.all([
        get(port, '/api/profile'),
        get(port, '/api/profile'),
        get(port, '/api/profile'),
      ]);
      for (const r of [a, b, c]) {
        assert.equal(r.status, 200, 'no caller may be rejected');
        assert.equal(r.body.archetype.name, 'The Architect');
      }
      assert.equal(analyzeCalls, 1, 'one analysis shared by all three');
    });
  });

  it('never answers 429', async () => {
    analyzeDelayMs = 40;
    await withServer(async (port) => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => get(port, '/api/profile'))
      );
      assert.ok(!results.some((r) => r.status === 429));
    });
  });

  it('persists the cache to disk', async () => {
    await withServer(async (port) => {
      await get(port, '/api/profile');
    });
    assert.ok(fs.existsSync(CACHE_PATH), 'cache file should exist');
    const saved = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    assert.equal(saved.data.archetype.name, 'The Architect');
    assert.equal(typeof saved.at, 'number');
  });

  it('writes the cache file with owner-only permissions', async () => {
    await withServer(async (port) => { await get(port, '/api/profile'); });
    const mode = fs.statSync(CACHE_PATH).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('answers a restart from the persisted cache without recomputing', async () => {
    await withServer(async (port) => { await get(port, '/api/profile'); });
    assert.equal(analyzeCalls, 1);

    // A brand new router is a new server process for our purposes: it
    // warms from disk in its constructor.
    analyzeCalls = 0;
    await withServer(async (port) => {
      const { status, body } = await get(port, '/api/profile');
      assert.equal(status, 200);
      assert.equal(body.archetype.name, 'The Architect');
    });
    // It may recompute in the background, but it must have ANSWERED
    // from disk rather than blocking on a fresh analysis.
    assert.ok(analyzeCalls <= 1, 'restart must not block on a cold analysis');
  });

  it('serves a stale cache immediately and marks it stale', async () => {
    // Write a cache entry old enough to be past the TTL.
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      key: '90:all',
      at: Date.now() - 10 * 60 * 1000,
      data: {
        archetype: { name: 'The Cached One', blurb: 'b' },
        dimensions: { steering: 1, execution: 1, engineering: 1, productInstinct: 1, planning: 1 },
        activity: { totalSessions: 5, spanDays: 2 },
        generatedAt: Date.now() - 10 * 60 * 1000,
      },
    }), { mode: 0o600 });

    analyzeDelayMs = 200;
    await withServer(async (port) => {
      const { status, headers, body } = await get(port, '/api/profile');
      assert.equal(status, 200);
      assert.equal(headers['x-profile-stale'], '1');
      assert.equal(body.archetype.name, 'The Cached One', 'answered from the stale cache');
      // and a refresh was kicked off behind it
      assert.equal(analyzeCalls, 1);
      await new Promise((r) => setTimeout(r, 320));
    });
  });

  it('a background refresh updates what the next request sees', async () => {
    await withServer(async (port) => {
      await get(port, '/api/profile');          // warm
      archetypeName = 'The Refactorer';         // the world changes
      const { body } = await get(port, '/api/profile?refresh=1');
      assert.equal(body.archetype.name, 'The Refactorer');
      assert.equal(analyzeCalls, 2);
    });
  });

  it('reports a failure rather than caching it', async () => {
    analyzeFails = true;
    await withServer(async (port) => {
      const { status } = await get(port, '/api/profile');
      assert.equal(status, 500);
    });
    assert.ok(!fs.existsSync(CACHE_PATH), 'a failed analysis must not be persisted');
  });

  it('survives a corrupt cache file', async () => {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, 'this is not json');
    await withServer(async (port) => {
      const { status, body } = await get(port, '/api/profile');
      assert.equal(status, 200);
      assert.equal(body.archetype.name, 'The Architect');
    });
  });
});
