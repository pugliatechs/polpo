const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createGatewayRouter } = require('../src/server/gateway');

// Minimal task manager + auth stubs — the same pattern other gateway
// route tests use. /v1/profile doesn't touch the task manager but the
// router constructor still requires it.
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
      resolve({ server, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const VALID_KEY = 'profile-test-key';
const AUTH = { Authorization: 'Bearer ' + VALID_KEY };

describe('Gateway /v1/profile', () => {
  let harness;

  beforeEach(async () => {
    harness = await startServer({
      taskManager: createStubTaskManager(),
      getKey: () => VALID_KEY,
    });
  });

  afterEach(async () => { await closeServer(harness.server); });

  it('401 without bearer token', async () => {
    const r = await fetch(harness.url + '/v1/profile');
    assert.equal(r.status, 401);
  });

  it('400 on invalid agent value', async () => {
    const r = await fetch(harness.url + '/v1/profile?agent=cobol', { headers: AUTH });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_source');
  });

  it('400 also rejects ?source=... when not in the whitelist (alias param)', async () => {
    const r = await fetch(harness.url + '/v1/profile?source=bogus', { headers: AUTH });
    assert.equal(r.status, 400);
  });

  it('200 returns a profile snapshot with the expected top-level shape', async () => {
    const r = await fetch(harness.url + '/v1/profile?days=30', { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    // The analyzer returns the full Builder Profile shape — assert the
    // top-level keys callers will rely on, not the deep numbers (which
    // depend on whatever sessions happen to be on this host).
    for (const k of ['archetype', 'dimensions', 'activity', 'agents',
                     'models', 'projects', 'prompts', 'tools', 'shell',
                     'messages', 'generatedAt']) {
      assert.ok(k in body, 'missing key: ' + k);
    }
    assert.ok(body.archetype && typeof body.archetype.name === 'string');
    assert.ok(body.dimensions && typeof body.dimensions === 'object');
    // Dimensions are five 0..100 scores
    for (const dim of ['steering', 'execution', 'engineering', 'productInstinct', 'planning']) {
      assert.ok(dim in body.dimensions, 'dimension missing: ' + dim);
      const v = body.dimensions[dim];
      assert.ok(v >= 0 && v <= 100, dim + ' out of range: ' + v);
    }
  });

  it('clamps days to the [1, 365] range', async () => {
    const r1 = await fetch(harness.url + '/v1/profile?days=0', { headers: AUTH });
    const r2 = await fetch(harness.url + '/v1/profile?days=99999', { headers: AUTH });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  });

  it('caches identical (days, source) calls — second call returns instantly', async () => {
    const r1 = await fetch(harness.url + '/v1/profile?days=30', { headers: AUTH });
    const body1 = await r1.json();
    // The cache uses Date.now-stamping; we cannot directly observe it
    // from the HTTP response, but identical input under TTL must produce
    // an identical generatedAt timestamp (because it's the cached object).
    const r2 = await fetch(harness.url + '/v1/profile?days=30', { headers: AUTH });
    const body2 = await r2.json();
    assert.equal(body1.generatedAt, body2.generatedAt);
  });
});
