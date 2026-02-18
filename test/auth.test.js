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
