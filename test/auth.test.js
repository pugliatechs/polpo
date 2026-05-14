const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  AuthState,
  generateToken,
  extractToken,
  createSession,
  extractSessionId,
  validateSession,
  burnToken,
  generatePin,
  verifyPin,
  generateTotpSecret,
  base32Encode,
  base32Decode,
  computeTotp,
  verifyTotp,
  buildTotpUri,
  createAuthMiddleware,
  createStaticAuthMiddleware,
  validateWsAuth,
  isAgentToken,
  isLocalhost,
  timingSafeEqual,
} = require('../src/server/auth');

// --- Helper: mock req/res ---

function mockReq(overrides = {}) {
  return {
    headers: overrides.headers || {},
    url: overrides.url || '/',
    path: overrides.path || '/',
    secure: overrides.secure || false,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirectUrl: null,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; },
    send(str) { res.body = str; },
    setHeader(k, v) { res.headers[k] = v; },
    redirect(url) { res.redirectUrl = url; },
  };
  return res;
}

// --- AuthState ---

describe('AuthState', () => {
  it('defaults to disabled', () => {
    const state = new AuthState();
    assert.equal(state.enabled, false);
    assert.equal(state.mfaEnabled, false);
    assert.equal(state.token, null);
    assert.equal(state.mode, null);
  });

  it('is enabled when token is set', () => {
    const state = new AuthState({ token: 'abc' });
    assert.equal(state.enabled, true);
  });

  it('detects MFA modes', () => {
    const pin = new AuthState({ token: 'x', mode: 'pin' });
    assert.equal(pin.mfaEnabled, true);
    const paranoid = new AuthState({ token: 'x', mode: 'paranoid' });
    assert.equal(paranoid.mfaEnabled, true);
    const basic = new AuthState({ token: 'x' });
    assert.equal(basic.mfaEnabled, false);
  });
});

// --- Token ---

describe('generateToken', () => {
  it('returns a base64url string', () => {
    const token = generateToken();
    assert.ok(token.length > 20);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(token));
  });

  it('generates unique tokens', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
  });
});

describe('extractToken', () => {
  it('extracts from Authorization header', () => {
    const req = mockReq({ headers: { authorization: 'Bearer mytoken123' } });
    assert.equal(extractToken(req), 'mytoken123');
  });

  it('extracts from query param', () => {
    const req = mockReq({ url: '/page?token=qparam&other=1' });
    assert.equal(extractToken(req), 'qparam');
  });

  it('extracts from cookie', () => {
    const req = mockReq({ headers: { cookie: 'other=1; polpo_token=cookieval; more=2' } });
    assert.equal(extractToken(req), 'cookieval');
  });

  it('prioritizes header over query over cookie', () => {
    const req = mockReq({
      headers: { authorization: 'Bearer header', cookie: 'polpo_token=cookie' },
      url: '/?token=query',
    });
    assert.equal(extractToken(req), 'header');
  });

  it('returns null when nothing found', () => {
    const req = mockReq();
    assert.equal(extractToken(req), null);
  });
});

// --- Sessions ---

describe('sessions', () => {
  it('createSession adds to state', () => {
    const state = new AuthState({ token: 'x' });
    const id = createSession(state);
    assert.ok(id.length > 20);
    assert.equal(state.sessions.has(id), true);
  });

  it('extractSessionId reads cookie', () => {
    const req = mockReq({ headers: { cookie: 'polpo_session=sess123' } });
    assert.equal(extractSessionId(req), 'sess123');
  });

  it('extractSessionId returns null on missing', () => {
    assert.equal(extractSessionId(mockReq()), null);
  });

  it('validateSession passes with valid session', () => {
    const state = new AuthState({ token: 'x' });
    const id = createSession(state);
    const req = mockReq({ headers: { cookie: `polpo_session=${id}` } });
    assert.equal(validateSession(state, req), true);
  });

  it('validateSession fails with bad session', () => {
    const state = new AuthState({ token: 'x' });
    const req = mockReq({ headers: { cookie: 'polpo_session=bogus' } });
    assert.equal(validateSession(state, req), false);
  });

  it('validateSession passes when auth is disabled', () => {
    const state = new AuthState();
    assert.equal(validateSession(state, mockReq()), true);
  });
});

// --- burnToken ---

describe('burnToken', () => {
  it('marks token as burned', () => {
    const state = new AuthState({ token: 'tok', mode: null });
    burnToken(state);
    assert.equal(state.tokenBurned, true);
  });

  it('generates PIN when mode is pin', () => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    const pin = burnToken(state);
    assert.ok(pin);
    assert.ok(/^\d{4}$/.test(pin));
    assert.equal(state.pin, pin);
  });

  it('preserves existing PIN when mode is pin', () => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    state.pin = '4829';
    const pin = burnToken(state);
    assert.equal(pin, '4829');
    assert.equal(state.pin, '4829');
    assert.equal(state.tokenBurned, true);
  });
});

// --- PIN ---

describe('PIN', () => {
  it('generatePin returns 4-digit string', () => {
    for (let i = 0; i < 10; i++) {
      const pin = generatePin();
      assert.ok(/^\d{4}$/.test(pin), `bad pin: ${pin}`);
    }
  });

  it('verifyPin succeeds with correct pin', () => {
    const state = new AuthState({ token: 'x', mode: 'pin' });
    state.pin = '1234';
    const result = verifyPin(state, '1234');
    assert.equal(result.valid, true);
    assert.equal(state.pin, null); // consumed
  });

  it('verifyPin fails with wrong pin', () => {
    const state = new AuthState({ token: 'x', mode: 'pin' });
    state.pin = '1234';
    const result = verifyPin(state, '5678');
    assert.equal(result.valid, false);
    assert.equal(state.pinAttempts, 1);
  });

  it('verifyPin regenerates after max attempts', () => {
    const state = new AuthState({ token: 'x', mode: 'pin' });
    state.pin = '1234';
    let regeneratedPin = null;
    state.onPinRegenerated = (p) => { regeneratedPin = p; };

    verifyPin(state, '0000');
    verifyPin(state, '0000');
    const result = verifyPin(state, '0000'); // 3rd attempt
    assert.equal(result.regenerated, true);
    assert.ok(regeneratedPin);
    assert.ok(/^\d{4}$/.test(regeneratedPin));
    assert.equal(state.pinAttempts, 0); // reset
  });
});

// --- TOTP ---

describe('TOTP', () => {
  it('base32 round-trip', () => {
    const buf = Buffer.from('Hello, World!');
    const encoded = base32Encode(buf);
    const decoded = base32Decode(encoded);
    assert.deepEqual(decoded, buf);
  });

  it('generateTotpSecret returns a base32 string', () => {
    const secret = generateTotpSecret();
    assert.ok(secret.length >= 20);
    assert.ok(/^[A-Z2-7]+$/.test(secret));
  });

  it('computeTotp returns 6-digit code', () => {
    const secret = generateTotpSecret();
    const step = Math.floor(Date.now() / 30000);
    const code = computeTotp(secret, step);
    assert.ok(/^\d{6}$/.test(code));
  });

  it('verifyTotp accepts current code', () => {
    const secret = generateTotpSecret();
    const step = Math.floor(Date.now() / 30000);
    const code = computeTotp(secret, step);
    assert.equal(verifyTotp(secret, code), true);
  });

  it('verifyTotp rejects wrong code', () => {
    const secret = generateTotpSecret();
    assert.equal(verifyTotp(secret, '000000'), false);
  });

  it('buildTotpUri contains required params', () => {
    const uri = buildTotpUri('JBSWY3DPEHPK3PXP', 'Polpo');
    assert.ok(uri.startsWith('otpauth://totp/'));
    assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
    assert.ok(uri.includes('issuer=Polpo'));
  });
});

// --- Middleware ---

describe('createAuthMiddleware', () => {
  it('passes through when auth disabled', (_, done) => {
    const mw = createAuthMiddleware(() => new AuthState());
    const req = mockReq();
    const res = mockRes();
    mw(req, res, () => { done(); });
  });

  it('passes with valid session cookie', (_, done) => {
    const state = new AuthState({ token: 'tok' });
    const sessionId = createSession(state);
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ headers: { cookie: `polpo_session=${sessionId}` } });
    const res = mockRes();
    mw(req, res, () => { done(); });
  });

  it('passes with valid bearer token (agent)', (_, done) => {
    const state = new AuthState({ token: 'tok' });
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ headers: { authorization: 'Bearer tok' } });
    const res = mockRes();
    mw(req, res, () => { done(); });
  });

  it('rejects with no credentials', () => {
    const state = new AuthState({ token: 'tok' });
    const mw = createAuthMiddleware(() => state);
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects with wrong token', () => {
    const state = new AuthState({ token: 'tok' });
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ headers: { authorization: 'Bearer wrong' } });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

describe('createStaticAuthMiddleware', () => {
  it('passes through when auth disabled', (_, done) => {
    const mw = createStaticAuthMiddleware(() => new AuthState());
    mw(mockReq(), mockRes(), () => { done(); });
  });

  it('allows auth page path', (_, done) => {
    const state = new AuthState({ token: 'tok' });
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ path: '/auth.html' });
    mw(req, mockRes(), () => { done(); });
  });

  it('burns token and creates session (no MFA)', (_, done) => {
    const state = new AuthState({ token: 'tok' });
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ url: '/?token=tok', path: '/' });
    const res = mockRes();
    mw(req, res, () => {
      assert.equal(state.tokenBurned, true);
      assert.ok(res.headers['Set-Cookie']);
      done();
    });
  });

  it('skips API paths (handled by API auth middleware)', (_, done) => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    state.tokenBurned = true; // token already used
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ path: '/api/instances/123/conversation' });
    mw(req, mockRes(), () => { done(); }); // should call next(), not redirect
  });

  it('skips all /api sub-paths regardless of auth state', (_, done) => {
    const state = new AuthState({ token: 'tok', mode: 'paranoid' });
    state.tokenBurned = true;
    const mw = createStaticAuthMiddleware(() => state);
    // No session cookie, no token — should still call next() for API paths
    const req = mockReq({ path: '/api/sessions/abc/resume' });
    mw(req, mockRes(), () => { done(); });
  });

  it('skips /v1 (gateway) paths regardless of auth state', (_, done) => {
    // Regression: paranoid-mode dashboard auth must not redirect /v1 calls.
    // The gateway has its own Bearer middleware; the static middleware
    // should not preempt it with an auth.html redirect.
    const state = new AuthState({ token: 'tok', mode: 'paranoid' });
    state.tokenBurned = true;
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ path: '/v1/tasks' });
    mw(req, mockRes(), () => { done(); });
  });

  it('skips /v1 sub-paths too', (_, done) => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    state.tokenBurned = true;
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ path: '/v1/tasks/gtask-abc/stream' });
    mw(req, mockRes(), () => { done(); });
  });

  it('redirects to auth page for MFA after burn', () => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ url: '/?token=tok', path: '/' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.ok(res.redirectUrl);
    assert.ok(res.redirectUrl.includes('auth.html'));
  });

  it('redirects to expired auth page for unauthenticated non-API non-MFA request', () => {
    const state = new AuthState({ token: 'tok' }); // no MFA mode
    state.tokenBurned = true;
    const mw = createStaticAuthMiddleware(() => state);
    const req = mockReq({ path: '/' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.ok(res.redirectUrl);
    assert.ok(res.redirectUrl.includes('mode=expired'));
  });

  it('redirects on burned token second use and un-burns for re-scan', () => {
    const state = new AuthState({ token: 'tok' });
    const mw = createStaticAuthMiddleware(() => state);
    // First use: burns token, creates session
    const req1 = mockReq({ url: '/?token=tok', path: '/' });
    const res1 = mockRes();
    let firstNext = false;
    mw(req1, res1, () => { firstNext = true; });
    assert.equal(firstNext, true); // no MFA, creates session
    assert.equal(state.tokenBurned, true);

    // Second use: token is burned, redirects to expired page
    const req2 = mockReq({ url: '/?token=tok', path: '/' });
    const res2 = mockRes();
    let secondNext = false;
    mw(req2, res2, () => { secondNext = true; });
    assert.equal(secondNext, false);
    assert.ok(res2.redirectUrl);
    assert.ok(res2.redirectUrl.includes('mode=expired'));
  });

  it('allows access with session cookie after token burn', (_, done) => {
    const state = new AuthState({ token: 'tok' });
    const mw = createStaticAuthMiddleware(() => state);
    // Burn the token first
    const req1 = mockReq({ url: '/?token=tok', path: '/' });
    const res1 = mockRes();
    mw(req1, res1, () => {});
    // Extract session cookie from response
    const cookie = res1.headers['Set-Cookie'];
    const sessionId = cookie.match(/polpo_session=([^;]+)/)[1];

    // Now access with session cookie
    const req2 = mockReq({ path: '/', headers: { cookie: `polpo_session=${sessionId}` } });
    mw(req2, mockRes(), () => { done(); });
  });
});

// --- Auth middleware: Bearer token after burn ---

describe('createAuthMiddleware — post-burn', () => {
  it('accepts Bearer token even after token is burned', (_, done) => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    burnToken(state); // burn the single-use token
    const mw = createAuthMiddleware(() => state);
    // Agent uses raw Bearer token — should still work
    const req = mockReq({ headers: { authorization: 'Bearer tok' } });
    mw(req, mockRes(), () => { done(); });
  });

  it('rejects wrong Bearer token after burn', () => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    burnToken(state);
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ headers: { authorization: 'Bearer wrong' } });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

// --- WS Auth ---

describe('validateWsAuth', () => {
  it('passes when auth disabled', () => {
    assert.equal(validateWsAuth(null, mockReq()), true);
    assert.equal(validateWsAuth(new AuthState(), mockReq()), true);
  });

  it('passes with valid session cookie', () => {
    const state = new AuthState({ token: 'tok' });
    const id = createSession(state);
    const req = mockReq({ headers: { cookie: `polpo_session=${id}` } });
    assert.equal(validateWsAuth(state, req), true);
  });

  it('passes with valid agent token in query', () => {
    const state = new AuthState({ token: 'tok' });
    const req = mockReq({ url: '/?role=agent&token=tok' });
    assert.equal(validateWsAuth(state, req), true);
  });

  it('rejects with no credentials', () => {
    const state = new AuthState({ token: 'tok' });
    assert.equal(validateWsAuth(state, mockReq()), false);
  });

  it('rejects with wrong token', () => {
    const state = new AuthState({ token: 'tok' });
    const req = mockReq({ url: '/?token=wrong' });
    assert.equal(validateWsAuth(state, req), false);
  });
});

// --- Full auth flow ---

describe('full auth flow: token → burn → PIN → session', () => {
  it('complete PIN flow produces valid session', () => {
    const state = new AuthState({ token: 'tok', mode: 'pin' });
    state.pin = '9876';

    // Step 1: static middleware burns token, redirects to PIN page
    const staticMw = createStaticAuthMiddleware(() => state);
    const req1 = mockReq({ url: '/?token=tok', path: '/' });
    const res1 = mockRes();
    let next1 = false;
    staticMw(req1, res1, () => { next1 = true; });
    assert.equal(next1, false);
    assert.ok(res1.redirectUrl.includes('mode=pin'));
    assert.equal(state.tokenBurned, true);
    assert.equal(state.pin, '9876'); // preserved

    // Step 2: verify PIN, get session
    const pinResult = verifyPin(state, '9876');
    assert.equal(pinResult.valid, true);
    const sessionId = createSession(state);

    // Step 3: session cookie grants access
    const req2 = mockReq({ path: '/', headers: { cookie: `polpo_session=${sessionId}` } });
    let next2 = false;
    staticMw(req2, mockRes(), () => { next2 = true; });
    assert.equal(next2, true);

    // Step 4: API auth also passes with the session
    const apiMw = createAuthMiddleware(() => state);
    let next3 = false;
    apiMw(req2, mockRes(), () => { next3 = true; });
    assert.equal(next3, true);
  });

  it('complete TOTP flow produces valid session', () => {
    const secret = generateTotpSecret();
    const state = new AuthState({ token: 'tok', mode: 'paranoid', totpSecret: secret });

    // Step 1: burn token
    const staticMw = createStaticAuthMiddleware(() => state);
    const req1 = mockReq({ url: '/?token=tok', path: '/' });
    const res1 = mockRes();
    staticMw(req1, res1, () => {});
    assert.ok(res1.redirectUrl.includes('mode=paranoid'));

    // Step 2: verify TOTP
    const step = Math.floor(Date.now() / 30000);
    const code = computeTotp(secret, step);
    assert.equal(verifyTotp(secret, code), true);
    const sessionId = createSession(state);

    // Step 3: session + API access work
    const req2 = mockReq({ path: '/dashboard', headers: { cookie: `polpo_session=${sessionId}` } });
    let staticOk = false;
    staticMw(req2, mockRes(), () => { staticOk = true; });
    assert.equal(staticOk, true);

    const apiMw = createAuthMiddleware(() => state);
    let apiOk = false;
    apiMw(req2, mockRes(), () => { apiOk = true; });
    assert.equal(apiOk, true);
  });

  it('agent token works alongside MFA sessions', (_, done) => {
    const state = new AuthState({ token: 'tok', mode: 'paranoid' });
    burnToken(state);

    // Dashboard user gets a session
    const sessionId = createSession(state);

    // Agent uses Bearer token — both should pass API auth
    const apiMw = createAuthMiddleware(() => state);

    const dashReq = mockReq({ headers: { cookie: `polpo_session=${sessionId}` } });
    let dashOk = false;
    apiMw(dashReq, mockRes(), () => { dashOk = true; });
    assert.equal(dashOk, true);

    const agentReq = mockReq({ headers: { authorization: 'Bearer tok' } });
    apiMw(agentReq, mockRes(), () => { done(); });
  });
});

// --- TOTP edge cases ---

describe('TOTP window', () => {
  it('accepts code from ±2 time steps (150s window)', () => {
    const secret = generateTotpSecret();
    const now = Math.floor(Date.now() / 30000);
    // Code from 2 steps ago should still be valid
    const oldCode = computeTotp(secret, now - 2);
    assert.equal(verifyTotp(secret, oldCode), true);
    // Code from 2 steps ahead should still be valid
    const futureCode = computeTotp(secret, now + 2);
    assert.equal(verifyTotp(secret, futureCode), true);
  });

  it('rejects code from 3+ time steps away', () => {
    const secret = generateTotpSecret();
    const now = Math.floor(Date.now() / 30000);
    const tooOld = computeTotp(secret, now - 3);
    assert.equal(verifyTotp(secret, tooOld), false);
    const tooNew = computeTotp(secret, now + 3);
    assert.equal(verifyTotp(secret, tooNew), false);
  });
});

// --- PIN edge cases ---

describe('PIN edge cases', () => {
  it('rejects PIN when none is set', () => {
    const state = new AuthState({ token: 'x', mode: 'pin' });
    // pin is null by default
    const result = verifyPin(state, '1234');
    assert.equal(result.valid, false);
  });

  it('timing-safe comparison for PIN', () => {
    const state = new AuthState({ token: 'x', mode: 'pin' });
    state.pin = '1234';
    // Same length but different value
    const result = verifyPin(state, '1235');
    assert.equal(result.valid, false);
    assert.equal(state.pinAttempts, 1);
  });

  it('resets attempts after successful verification', () => {
    const state = new AuthState({ token: 'x', mode: 'pin' });
    state.pin = '1234';
    verifyPin(state, '0000'); // fail 1
    verifyPin(state, '0000'); // fail 2
    const result = verifyPin(state, '1234'); // success before lockout
    assert.equal(result.valid, true);
    assert.equal(state.pinAttempts, 0);
  });
});

// --- Session isolation ---

describe('session isolation', () => {
  it('different AuthState instances have independent sessions', () => {
    const state1 = new AuthState({ token: 'tok1' });
    const state2 = new AuthState({ token: 'tok2' });
    const session1 = createSession(state1);
    const req = mockReq({ headers: { cookie: `polpo_session=${session1}` } });
    // Session from state1 should not work on state2
    assert.equal(validateSession(state1, req), true);
    assert.equal(validateSession(state2, req), false);
  });
});

// --- isAgentToken ---

describe('isAgentToken', () => {
  it('returns true for matching token', () => {
    const state = new AuthState({ token: 'secret' });
    assert.equal(isAgentToken(state, 'secret'), true);
  });

  it('returns false for wrong token', () => {
    const state = new AuthState({ token: 'secret' });
    assert.equal(isAgentToken(state, 'wrong'), false);
  });
});

// --- timingSafeEqual ---

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
  });

  it('returns false for different strings', () => {
    assert.equal(timingSafeEqual('abc', 'def'), false);
  });

  it('returns false for different lengths', () => {
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
  });

  it('returns false for non-string inputs', () => {
    assert.equal(timingSafeEqual(null, 'abc'), false);
    assert.equal(timingSafeEqual('abc', undefined), false);
  });
});

// --- isLocalhost ---

describe('isLocalhost', () => {
  it('returns true for 127.0.0.1', () => {
    assert.equal(isLocalhost({ ip: '127.0.0.1', headers: {}, socket: {} }), true);
  });

  it('returns true for ::1', () => {
    assert.equal(isLocalhost({ ip: '::1', headers: {}, socket: {} }), true);
  });

  it('returns true for ::ffff:127.0.0.1', () => {
    assert.equal(isLocalhost({ ip: '::ffff:127.0.0.1', headers: {}, socket: {} }), true);
  });

  it('returns false for external IPs', () => {
    assert.equal(isLocalhost({ ip: '192.168.1.5', headers: {}, socket: {} }), false);
    assert.equal(isLocalhost({ ip: '10.0.0.1', headers: {}, socket: {} }), false);
  });

  it('falls back to socket.remoteAddress', () => {
    assert.equal(isLocalhost({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.equal(isLocalhost({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), false);
  });

  it('returns false when X-Forwarded-For is set (tunnel/proxy)', () => {
    assert.equal(isLocalhost({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.50' }, socket: {} }), false);
    assert.equal(isLocalhost({ ip: '::1', headers: { 'x-forwarded-for': '10.0.0.1' }, socket: {} }), false);
  });
});

// --- trustLocalhost ---

describe('trustLocalhost', () => {
  it('auth middleware allows localhost when trustLocalhost is true', () => {
    const state = new AuthState({ token: generateToken(), trustLocalhost: true });
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ ip: '127.0.0.1' });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  it('auth middleware blocks localhost when trustLocalhost is false', () => {
    const state = new AuthState({ token: generateToken(), trustLocalhost: false });
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ ip: '127.0.0.1' });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });

  it('auth middleware blocks remote IPs even when trustLocalhost is true', () => {
    const state = new AuthState({ token: generateToken(), trustLocalhost: true });
    const mw = createAuthMiddleware(() => state);
    const req = mockReq({ ip: '192.168.1.5' });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });

  it('validateWsAuth allows localhost WebSocket when trustLocalhost is true', () => {
    const state = new AuthState({ token: generateToken(), trustLocalhost: true });
    const req = mockReq({ ip: '::1' });
    assert.equal(validateWsAuth(state, req), true);
  });

  it('validateWsAuth blocks localhost WebSocket when trustLocalhost is false', () => {
    const state = new AuthState({ token: generateToken(), trustLocalhost: false });
    const req = mockReq({ ip: '::1' });
    assert.equal(validateWsAuth(state, req), false);
  });
});
