const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  generateKey,
  loadKeyFromFile,
  saveKeyToFile,
  loadOrCreateGatewayKey,
  extractBearerToken,
  createGatewayAuthMiddleware,
  timingSafeEqual,
  tokenFingerprint,
  createPerTokenRateLimit,
} = require('../src/server/gateway-auth');

function tempConfigPath() {
  return path.join(os.tmpdir(), 'polpo-gw-auth-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}

describe('gateway-auth: key primitives', () => {
  it('generateKey returns a 43-char base64url string (256 bits)', () => {
    const k = generateKey();
    assert.equal(typeof k, 'string');
    // 32 bytes base64url-encoded with no padding = 43 chars
    assert.equal(k.length, 43);
    // base64url charset
    assert.match(k, /^[A-Za-z0-9_-]+$/);
  });

  it('generateKey produces distinct values', () => {
    const a = generateKey();
    const b = generateKey();
    assert.notEqual(a, b);
  });

  it('timingSafeEqual handles equal/unequal/wrong-type/wrong-length', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
    assert.equal(timingSafeEqual(null, 'abc'), false);
    assert.equal(timingSafeEqual('abc', undefined), false);
    assert.equal(timingSafeEqual(42, 42), false);
  });
});

describe('gateway-auth: file I/O', () => {
  let configPath;

  beforeEach(() => { configPath = tempConfigPath(); });
  afterEach(() => {
    try { fs.unlinkSync(configPath); } catch {}
    try { fs.unlinkSync(configPath + '.tmp'); } catch {}
  });

  it('loadKeyFromFile returns null when file does not exist', () => {
    assert.equal(loadKeyFromFile(configPath), null);
  });

  it('saveKeyToFile + loadKeyFromFile roundtrip', () => {
    const key = generateKey();
    saveKeyToFile(configPath, key);
    assert.equal(loadKeyFromFile(configPath), key);
  });

  it('saveKeyToFile writes with 0o600 permissions', () => {
    saveKeyToFile(configPath, generateKey());
    const mode = fs.statSync(configPath).mode & 0o777;
    assert.ok((mode & 0o077) === 0, 'file must not be group/world readable: ' + mode.toString(8));
  });

  it('saveKeyToFile is atomic (no .tmp left behind)', () => {
    saveKeyToFile(configPath, generateKey());
    assert.equal(fs.existsSync(configPath + '.tmp'), false);
  });

  it('loadKeyFromFile returns null on malformed JSON', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'not json');
    assert.equal(loadKeyFromFile(configPath), null);
  });

  it('loadKeyFromFile returns null on JSON missing the key field', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ other: 'value' }));
    assert.equal(loadKeyFromFile(configPath), null);
  });
});

describe('gateway-auth: loadOrCreateGatewayKey precedence', () => {
  let configPath;
  let savedEnv;

  beforeEach(() => {
    configPath = tempConfigPath();
    savedEnv = process.env.POLPO_GATEWAY_KEY;
    delete process.env.POLPO_GATEWAY_KEY;
  });

  afterEach(() => {
    try { fs.unlinkSync(configPath); } catch {}
    if (savedEnv !== undefined) process.env.POLPO_GATEWAY_KEY = savedEnv;
    else delete process.env.POLPO_GATEWAY_KEY;
  });

  it('explicit override wins over everything', () => {
    process.env.POLPO_GATEWAY_KEY = 'from-env';
    saveKeyToFile(configPath, 'from-file');
    const r = loadOrCreateGatewayKey({ key: 'from-override', configPath });
    assert.equal(r.key, 'from-override');
    assert.equal(r.source, 'override');
    assert.equal(r.isNew, false);
  });

  it('env wins over file and generation', () => {
    process.env.POLPO_GATEWAY_KEY = 'from-env';
    saveKeyToFile(configPath, 'from-file');
    const r = loadOrCreateGatewayKey({ configPath });
    assert.equal(r.key, 'from-env');
    assert.equal(r.source, 'env');
  });

  it('file wins over generation when no env override', () => {
    saveKeyToFile(configPath, 'from-file');
    const r = loadOrCreateGatewayKey({ configPath });
    assert.equal(r.key, 'from-file');
    assert.equal(r.source, 'file');
    assert.equal(r.isNew, false);
  });

  it('generates and persists when nothing exists', () => {
    const r = loadOrCreateGatewayKey({ configPath });
    assert.equal(r.source, 'generated');
    assert.equal(r.isNew, true);
    assert.equal(r.key.length, 43);
    // Persisted to disk
    assert.equal(loadKeyFromFile(configPath), r.key);
  });

  it('a second call after generation reuses the same key', () => {
    const r1 = loadOrCreateGatewayKey({ configPath });
    const r2 = loadOrCreateGatewayKey({ configPath });
    assert.equal(r1.key, r2.key);
    assert.equal(r2.source, 'file');
  });
});

describe('gateway-auth: extractBearerToken', () => {
  it('extracts a valid Bearer token', () => {
    const req = { headers: { authorization: 'Bearer abc123' } };
    assert.equal(extractBearerToken(req), 'abc123');
  });

  it('trims whitespace', () => {
    const req = { headers: { authorization: 'Bearer   abc123  ' } };
    assert.equal(extractBearerToken(req), 'abc123');
  });

  it('returns null for missing header', () => {
    assert.equal(extractBearerToken({ headers: {} }), null);
    assert.equal(extractBearerToken({}), null);
  });

  it('returns null for non-Bearer schemes', () => {
    assert.equal(extractBearerToken({ headers: { authorization: 'Basic abc' } }), null);
    assert.equal(extractBearerToken({ headers: { authorization: 'Token abc' } }), null);
  });
});

describe('gateway-auth: createGatewayAuthMiddleware', () => {
  function makeRes() {
    return {
      statusCode: 200,
      jsonBody: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.jsonBody = body; return this; },
    };
  }

  it('rejects when no key is configured', () => {
    const mw = createGatewayAuthMiddleware(() => null);
    const res = makeRes();
    let called = false;
    mw({ headers: { authorization: 'Bearer anything' } }, res, () => { called = true; });
    assert.equal(res.statusCode, 503);
    assert.equal(res.jsonBody.error, 'gateway_not_configured');
    assert.equal(called, false);
  });

  it('rejects when bearer is missing', () => {
    const mw = createGatewayAuthMiddleware(() => 'expected-key');
    const res = makeRes();
    let called = false;
    mw({ headers: {} }, res, () => { called = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody.error, 'unauthorized');
    assert.equal(called, false);
  });

  it('rejects when bearer does not match', () => {
    const mw = createGatewayAuthMiddleware(() => 'expected-key');
    const res = makeRes();
    let called = false;
    mw({ headers: { authorization: 'Bearer wrong-key' } }, res, () => { called = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(called, false);
  });

  it('allows when bearer matches', () => {
    const mw = createGatewayAuthMiddleware(() => 'expected-key');
    const res = makeRes();
    let called = false;
    mw({ headers: { authorization: 'Bearer expected-key' } }, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
  });

  it('uses the current key value at request time (rotation)', () => {
    let current = 'old-key';
    const mw = createGatewayAuthMiddleware(() => current);
    let called = false;
    mw({ headers: { authorization: 'Bearer old-key' } }, makeRes(), () => { called = true; });
    assert.equal(called, true);

    current = 'new-key';
    called = false;
    const res2 = makeRes();
    mw({ headers: { authorization: 'Bearer old-key' } }, res2, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res2.statusCode, 401);
  });
});

describe('gateway-auth: tokenFingerprint', () => {
  it('returns 64-char hex sha256', () => {
    const fp = tokenFingerprint('the-key');
    assert.equal(typeof fp, 'string');
    assert.equal(fp.length, 64);
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    assert.equal(tokenFingerprint('abc'), tokenFingerprint('abc'));
  });

  it('differs between tokens', () => {
    assert.notEqual(tokenFingerprint('a'), tokenFingerprint('b'));
  });

  it('returns null for invalid inputs', () => {
    assert.equal(tokenFingerprint(''), null);
    assert.equal(tokenFingerprint(undefined), null);
    assert.equal(tokenFingerprint(42), null);
  });
});

describe('gateway-auth: createPerTokenRateLimit', () => {
  function makeRes() {
    return {
      statusCode: 200, headers: {}, body: null,
      status(code) { this.statusCode = code; return this; },
      json(b) { this.body = b; return this; },
      set(name, value) { this.headers[name] = value; return this; },
    };
  }

  it('rejects bad options', () => {
    assert.throws(() => createPerTokenRateLimit({ windowMs: 0, max: 1 }));
    assert.throws(() => createPerTokenRateLimit({ windowMs: 100, max: 0 }));
    assert.throws(() => createPerTokenRateLimit({}));
  });

  it('passes through requests with no bearer token (auth handles 401)', () => {
    const mw = createPerTokenRateLimit({ windowMs: 1000, max: 1, now: () => 0 });
    const res = makeRes();
    let called = false;
    mw({ headers: {} }, res, () => { called = true; });
    assert.equal(called, true);
    clearInterval(mw._cleanup);
  });

  it('allows requests up to max within the window', () => {
    let now = 0;
    const mw = createPerTokenRateLimit({ windowMs: 1000, max: 3, now: () => now });
    const req = { headers: { authorization: 'Bearer my-key' } };
    let callCount = 0;
    const next = () => { callCount++; };
    for (let i = 0; i < 3; i++) mw(req, makeRes(), next);
    assert.equal(callCount, 3);
    clearInterval(mw._cleanup);
  });

  it('returns 429 when max is exceeded, with Retry-After header', () => {
    let now = 0;
    const mw = createPerTokenRateLimit({ windowMs: 5000, max: 2, now: () => now });
    const req = { headers: { authorization: 'Bearer my-key' } };
    mw(req, makeRes(), () => {});
    mw(req, makeRes(), () => {});
    const res = makeRes();
    mw(req, res, () => { assert.fail('should not pass'); });
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, 'rate_limited');
    assert.ok(res.headers['Retry-After']);
    clearInterval(mw._cleanup);
  });

  it('buckets per token, not globally', () => {
    let now = 0;
    const mw = createPerTokenRateLimit({ windowMs: 1000, max: 1, now: () => now });
    const reqA = { headers: { authorization: 'Bearer key-A' } };
    const reqB = { headers: { authorization: 'Bearer key-B' } };
    let okCount = 0;
    mw(reqA, makeRes(), () => okCount++);
    mw(reqB, makeRes(), () => okCount++);
    assert.equal(okCount, 2, 'each token gets its own bucket');
    clearInterval(mw._cleanup);
  });

  it('refills after the window expires', () => {
    let now = 0;
    const mw = createPerTokenRateLimit({ windowMs: 100, max: 1, now: () => now });
    const req = { headers: { authorization: 'Bearer my-key' } };
    mw(req, makeRes(), () => {});
    const res2 = makeRes();
    mw(req, res2, () => { assert.fail('should be limited'); });
    assert.equal(res2.statusCode, 429);

    now = 200; // past the window
    let called = false;
    mw(req, makeRes(), () => { called = true; });
    assert.equal(called, true);
    clearInterval(mw._cleanup);
  });
});
