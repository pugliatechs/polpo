const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ---- AuthState ----

class AuthState {
  constructor(options = {}) {
    this.token = options.token || null;
    this.mode = options.mode || null; // null | 'pin' | 'paranoid'
    this.totpSecret = options.totpSecret || null;
    this.pin = null;
    this.pinAttempts = 0;
    this.maxPinAttempts = 3;
    this.tokenBurned = false;
    this.sessions = new Set();
    this.onPinRegenerated = null; // callback(newPin) for terminal display
  }

  get enabled() {
    return this.token !== null;
  }

  get mfaEnabled() {
    return this.mode === 'pin' || this.mode === 'paranoid';
  }
}

// ---- Token ----

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // 2. ?token=<token> query param
  const parsed = url.parse(req.url, true);
  if (parsed.query.token) {
    return parsed.query.token;
  }
  // 3. Cookie: polpo_token=<token>
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)polpo_token=([^;]+)/);
  if (match) {
    return match[1];
  }
  return null;
}

// ---- Sessions ----

function createSession(authState) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  authState.sessions.add(sessionId);
  return sessionId;
}

function extractSessionId(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)polpo_session=([^;]+)/);
  return match ? match[1] : null;
}

function validateSession(authState, req) {
  if (!authState.enabled) return true;
  const sessionId = extractSessionId(req);
  return sessionId !== null && authState.sessions.has(sessionId);
}

function setSessionCookie(res, sessionId, secure) {
  res.setHeader('Set-Cookie',
    `polpo_session=${sessionId}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

// ---- Single-use token ----

function burnToken(authState) {
  authState.tokenBurned = true;
  if (authState.mode === 'pin') {
    authState.pin = generatePin();
    authState.pinAttempts = 0;
  }
  return authState.pin;
}

// ---- PIN ----

function generatePin() {
  return crypto.randomInt(1000, 10000).toString();
}

function verifyPin(authState, pin) {
  if (!authState.pin) return { valid: false, locked: false };
  if (authState.pinAttempts >= authState.maxPinAttempts) {
    return { valid: false, locked: true };
  }

  const valid = timingSafeEqual(pin, authState.pin);
  if (valid) {
    authState.pin = null;
    authState.pinAttempts = 0;
    return { valid: true, locked: false };
  }

  authState.pinAttempts++;
  if (authState.pinAttempts >= authState.maxPinAttempts) {
    // Regenerate PIN after max failures
    authState.pin = generatePin();
    authState.pinAttempts = 0;
    if (authState.onPinRegenerated) {
      authState.onPinRegenerated(authState.pin);
    }
    return { valid: false, locked: true, regenerated: true };
  }
  return { valid: false, locked: false };
}

// ---- TOTP (RFC 6238) ----

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let result = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return result;
}

function base32Decode(str) {
  str = str.replace(/[=\s]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output = [];
  for (let i = 0; i < str.length; i++) {
    const idx = BASE32_CHARS.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function computeTotp(secret, timeStep) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
  buf.writeUInt32BE(timeStep >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, '0');
}

function verifyTotp(secret, code) {
  const now = Math.floor(Date.now() / 30000);
  for (let i = -1; i <= 1; i++) {
    if (timingSafeEqual(code, computeTotp(secret, now + i))) {
      return true;
    }
  }
  return false;
}

function buildTotpUri(secret, label) {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=Polpo&algorithm=SHA1&digits=6&period=30`;
}

function loadTotpSecret(configPath) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data.secret || null;
  } catch {
    return null;
  }
}

function saveTotpSecret(configPath, secret) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ secret }, null, 2) + '\n', { mode: 0o600 });
}

// ---- Middleware ----

function createAuthMiddleware(getAuthState) {
  return (req, res, next) => {
    const state = typeof getAuthState === 'function' ? getAuthState() : getAuthState;
    if (!state || !state.enabled) return next();

    // Session cookie (MFA-authenticated dashboard)
    if (validateSession(state, req)) return next();

    // Bearer token (agents/scripts — not burned for agent use)
    const provided = extractToken(req);
    if (provided && isAgentToken(state, provided)) return next();

    res.status(401).json({ error: 'Unauthorized' });
  };
}

function createStaticAuthMiddleware(getAuthState) {
  return (req, res, next) => {
    const state = typeof getAuthState === 'function' ? getAuthState() : getAuthState;
    if (!state || !state.enabled) return next();

    // Allow auth page
    if (req.path === '/auth' || req.path === '/auth.html') return next();

    // Valid session
    if (validateSession(state, req)) return next();

    // Token in URL (first access from QR code)
    const provided = extractToken(req);
    if (provided && !state.tokenBurned && timingSafeEqual(provided, state.token)) {
      const pin = burnToken(state);

      if (state.mfaEnabled) {
        res.redirect(`/auth.html?mode=${state.mode}`);
        return;
      }

      // No MFA — create session directly
      const sessionId = createSession(state);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      setSessionCookie(res, sessionId, secure);
      return next();
    }

    // Token already burned, MFA in progress
    if (state.mfaEnabled && state.tokenBurned) {
      res.redirect(`/auth.html?mode=${state.mode}`);
      return;
    }

    res.status(401).send('Unauthorized');
  };
}

function validateWsAuth(authState, req) {
  if (!authState || !authState.enabled) return true;

  // Session cookie (dashboard after MFA)
  if (validateSession(authState, req)) return true;

  // Agent token (agents use the raw token, not sessions)
  const parsed = url.parse(req.url, true);
  const provided = parsed.query.token;
  if (provided && isAgentToken(authState, provided)) return true;

  return false;
}

// Agents always use the raw token — it's not burned for them
function isAgentToken(authState, provided) {
  return provided && timingSafeEqual(provided, authState.token);
}

// ---- Helpers ----

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
  AuthState,
  generateToken,
  extractToken,
  createSession,
  extractSessionId,
  validateSession,
  setSessionCookie,
  burnToken,
  generatePin,
  verifyPin,
  generateTotpSecret,
  base32Encode,
  base32Decode,
  computeTotp,
  verifyTotp,
  buildTotpUri,
  loadTotpSecret,
  saveTotpSecret,
  createAuthMiddleware,
  createStaticAuthMiddleware,
  validateWsAuth,
  isAgentToken,
  timingSafeEqual,
};
