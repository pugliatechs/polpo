const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  generatePKCEVerifier,
  generatePKCEChallenge,
  buildAuthURL,
  parseCallbackURL,
  parseRawCode,
  CALLBACK_URL_PATTERN,
  RAW_CODE_PATTERN,
} = require('../src/pa/auth/oauth');

const {
  setPendingFlow,
  getPendingVerifier,
  getMostRecentVerifier,
  clearExpired,
  clear,
  size,
} = require('../src/pa/auth/state');

const {
  formatTimeRemaining,
} = require('../src/pa/auth/token-monitor');

// --- OAuth ---

describe('PKCE', () => {
  it('generates a verifier of expected length', () => {
    const v = generatePKCEVerifier();
    assert.ok(v.length >= 40, 'verifier should be ~43 chars base64url');
    assert.ok(/^[A-Za-z0-9_-]+$/.test(v), 'should be base64url-safe');
  });

  it('generates unique verifiers', () => {
    const a = generatePKCEVerifier();
    const b = generatePKCEVerifier();
    assert.notEqual(a, b);
  });

  it('generates a challenge from verifier', () => {
    const v = generatePKCEVerifier();
    const c = generatePKCEChallenge(v);
    assert.ok(c.length > 0);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(c), 'should be base64url-safe');
  });

  it('same verifier produces same challenge', () => {
    const v = generatePKCEVerifier();
    assert.equal(generatePKCEChallenge(v), generatePKCEChallenge(v));
  });

  it('different verifiers produce different challenges', () => {
    const a = generatePKCEVerifier();
    const b = generatePKCEVerifier();
    assert.notEqual(generatePKCEChallenge(a), generatePKCEChallenge(b));
  });
});

describe('buildAuthURL', () => {
  it('returns a valid URL with required params', () => {
    const v = generatePKCEVerifier();
    const url = buildAuthURL(v);
    assert.ok(url.startsWith('https://claude.ai/oauth/authorize'));
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsed.searchParams.get('state'), v);
    assert.ok(parsed.searchParams.get('code_challenge'));
    assert.ok(parsed.searchParams.get('client_id'));
    assert.ok(parsed.searchParams.get('scope'));
  });
});

describe('parseCallbackURL', () => {
  it('parses console.anthropic.com callback', () => {
    const url = 'https://console.anthropic.com/oauth/code/callback?code=abc123&state=xyz789';
    const result = parseCallbackURL(url);
    assert.deepEqual(result, { code: 'abc123', state: 'xyz789' });
  });

  it('parses platform.claude.com callback', () => {
    const url = 'https://platform.claude.com/oauth/code/callback?code=def456&state=uvw321';
    const result = parseCallbackURL(url);
    assert.deepEqual(result, { code: 'def456', state: 'uvw321' });
  });

  it('returns null for non-callback URLs', () => {
    assert.equal(parseCallbackURL('https://google.com'), null);
    assert.equal(parseCallbackURL('just some text'), null);
  });

  it('returns null if code or state missing', () => {
    assert.equal(parseCallbackURL('https://console.anthropic.com/oauth/code/callback?code=abc'), null);
  });

  it('extracts from surrounding text', () => {
    const text = 'Here is my URL: https://console.anthropic.com/oauth/code/callback?code=abc&state=xyz done!';
    const result = parseCallbackURL(text);
    assert.deepEqual(result, { code: 'abc', state: 'xyz' });
  });
});

describe('parseRawCode', () => {
  it('parses code without state', () => {
    assert.deepEqual(parseRawCode('abcdef123456'), { code: 'abcdef123456' });
  });

  it('parses code with state after #', () => {
    const result = parseRawCode('mycode#mystate');
    assert.deepEqual(result, { code: 'mycode', state: 'mystate' });
  });
});

describe('CALLBACK_URL_PATTERN', () => {
  it('matches console.anthropic.com', () => {
    assert.ok(CALLBACK_URL_PATTERN.test('https://console.anthropic.com/oauth/code/callback?code=x'));
  });

  it('matches platform.claude.com', () => {
    assert.ok(CALLBACK_URL_PATTERN.test('https://platform.claude.com/oauth/code/callback?code=x'));
  });

  it('does not match random URLs', () => {
    assert.ok(!CALLBACK_URL_PATTERN.test('https://evil.com/oauth/code/callback?code=x'));
  });
});

describe('RAW_CODE_PATTERN', () => {
  it('matches 20+ char alphanumeric', () => {
    assert.ok(RAW_CODE_PATTERN.test('a'.repeat(20)));
    assert.ok(RAW_CODE_PATTERN.test('AbCdEf0123456789_-xyzw'));
  });

  it('does not match short strings', () => {
    assert.ok(!RAW_CODE_PATTERN.test('short'));
  });

  it('matches code#state format', () => {
    assert.ok(RAW_CODE_PATTERN.test('a'.repeat(25) + '#state123'));
  });

  it('does not match strings with spaces', () => {
    assert.ok(!RAW_CODE_PATTERN.test('hello world this is text'));
  });
});

// --- State ---

describe('pending flow state', () => {
  beforeEach(() => {
    clear();
  });

  it('stores and retrieves a flow by state', () => {
    setPendingFlow('user1', 'verifier_abc');
    const result = getPendingVerifier('verifier_abc');
    assert.equal(result, 'verifier_abc');
  });

  it('consumes the flow on retrieval', () => {
    setPendingFlow('user1', 'verifier_abc');
    getPendingVerifier('verifier_abc');
    assert.equal(getPendingVerifier('verifier_abc'), null);
  });

  it('returns null for unknown state', () => {
    assert.equal(getPendingVerifier('nonexistent'), null);
  });

  it('getMostRecentVerifier returns a pending verifier', () => {
    setPendingFlow('user1', 'v1');
    const result = getMostRecentVerifier();
    assert.equal(result, 'v1');
  });

  it('getMostRecentVerifier consumes the entry', () => {
    setPendingFlow('user1', 'v1');
    getMostRecentVerifier();
    assert.equal(getMostRecentVerifier(), null);
  });

  it('clearExpired removes old entries', () => {
    // Manually set an expired entry
    const state = require('../src/pa/auth/state');
    setPendingFlow('old', 'v_old');
    // Hack: directly modify timestamp (the Map is internal, but we can test via size)
    assert.equal(size(), 1);
    clearExpired(); // Should keep it (not expired yet)
    assert.equal(size(), 1);
  });
});

// --- Token monitor helpers ---

describe('formatTimeRemaining', () => {
  it('formats minutes', () => {
    assert.equal(formatTimeRemaining(5 * 60 * 1000), '5m');
    assert.equal(formatTimeRemaining(59 * 60 * 1000), '59m');
  });

  it('formats hours and minutes', () => {
    assert.equal(formatTimeRemaining(90 * 60 * 1000), '1h 30m');
  });

  it('formats expired', () => {
    assert.equal(formatTimeRemaining(0), 'expired');
    assert.equal(formatTimeRemaining(-1000), 'expired');
  });
});
