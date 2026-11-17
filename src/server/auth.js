const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { isLoopbackHost } = require('./host-guard');

// ---- AuthState ----

// Two secrets, kept apart on purpose:
//
//   token       the agent token. Polpo's own sessions, hooks, bridges and
//               external agents send it as `Authorization: Bearer`. It is
//               never put in a URL, and it opens the API and the WebSocket.
//   loginToken  the token in the QR code and the phone links. It can only
//               open the dashboard page, once (burnToken), and with PIN or
//               TOTP on it only leads to that second step. The API and the
//               WebSocket do not accept it.
//
// They used to be one value, so the link in the QR code (browser history,
// screenshots, the tunnel provider that terminates TLS) gave the whole API
// without PIN or TOTP, even after the page had burned it.
class AuthState {
  constructor(options = {}) {
    this.token = options.token || null;
    this.loginToken = options.loginToken || (this.token ? generateToken() : null);
    this.mode = options.mode || null; // null | 'pin' | 'paranoid'
    this.totpSecret = options.totpSecret || null;
    this.trustLocalhost = options.trustLocalhost !== undefined ? options.trustLocalhost : false;
    this.pin = null;
    this.pinAttempts = 0;
    this.maxPinAttempts = 3;
    this.tokenBurned = false;
    this.sessions = new Map(); // sessionId -> createdAt timestamp
    this.sessionMaxAge = 24 * 60 * 60 * 1000; // 24 hours
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

/** The agent token: only from `Authorization: Bearer`, never from a URL. */
function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

/** The login token from a QR or phone link (`?token=`). */
function extractLoginToken(req) {
  const parsed = url.parse(req.url || '', true);
  const value = parsed.query.token;
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---- Sessions ----

function createSession(authState) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  authState.sessions.set(sessionId, Date.now());
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
  if (!sessionId) return false;
  const lastActive = authState.sessions.get(sessionId);
  if (lastActive === undefined) return false;
  if (Date.now() - lastActive > authState.sessionMaxAge) {
    authState.sessions.delete(sessionId);
    return false;
  }
  // Sliding window: renew on activity
  authState.sessions.set(sessionId, Date.now());
  return true;
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
    // Only generate a PIN if one wasn't already set (e.g. by CLI startup)
    if (!authState.pin) {
      authState.pin = generatePin();
    }
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
  // ±2 window (150s effective) to account for clock skew and app-switching delay
  for (let i = -2; i <= 2; i++) {
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

// ---- Localhost Trust ----

/**
 * Check if a request originates from a genuine localhost client.
 * When trustLocalhost is enabled, localhost connections bypass auth
 * entirely — the user is already on the machine.
 *
 * Tunnels (cloudflared, ngrok, etc.) proxy from 127.0.0.1 but set
 * X-Forwarded-For to the real client IP. If that header is present,
 * the request came through a proxy and is NOT a direct localhost client.
 *
 * The Host header must also be a loopback name. A browser that opened
 * localhost, 127.0.0.1 or [::1] sends exactly that; a DNS rebinding page
 * reaches the same socket address under its own name, and must not count
 * as the user at the desk.
 *
 * This trusts every program and account on the machine, by design. It
 * cannot tell a raw TCP forward apart either (ssh -R): that is why
 * --trust-localhost is refused with the ssh tunnel.
 */
function isLocalhost(req) {
  // If a proxy set X-Forwarded-For, the real client is remote
  if (req.headers['x-forwarded-for']) return false;
  if (!isLoopbackHost(req.headers.host)) return false;

  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ---- Middleware ----

function createAuthMiddleware(getAuthState) {
  return (req, res, next) => {
    const state = typeof getAuthState === 'function' ? getAuthState() : getAuthState;
    if (!state || !state.enabled) return next();

    // Localhost bypass: desktop access is trusted
    if (state.trustLocalhost && isLocalhost(req)) return next();

    // Session cookie (MFA-authenticated dashboard)
    if (validateSession(state, req)) return next();

    // Agent token, as a Bearer header only. The login token in the QR
    // link is not accepted here.
    const provided = extractToken(req);
    if (provided && isAgentToken(state, provided)) return next();

    res.status(401).json({ error: 'Unauthorized' });
  };
}

function createStaticAuthMiddleware(getAuthState) {
  return (req, res, next) => {
    const state = typeof getAuthState === 'function' ? getAuthState() : getAuthState;
    if (!state || !state.enabled) return next();

    // Skip API + gateway paths — they have their own auth (Bearer token).
    // Without this, paranoid-mode dashboard auth would redirect /v1 calls
    // to /auth.html before the gateway router could validate the Bearer key.
    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next();

    // Allow auth page
    if (req.path === '/auth' || req.path === '/auth.html') return next();

    // Localhost bypass: desktop access is trusted
    if (state.trustLocalhost && isLocalhost(req)) return next();

    // Valid session
    if (validateSession(state, req)) return next();

    // Login token in the URL (first access from the QR code)
    const provided = extractLoginToken(req);
    if (provided && !state.tokenBurned && timingSafeEqual(provided, state.loginToken)) {
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

    // Token already burned — redirect to auth page for re-authentication
    if (state.tokenBurned) {
      if (state.mfaEnabled) {
        // MFA modes: user can re-enter PIN/TOTP remotely
        res.redirect(`/auth.html?mode=${state.mode}`);
      } else {
        // Token-only mode: no remote re-auth possible, show expired message
        res.redirect('/auth.html?mode=expired');
      }
      return;
    }

    res.status(401).send('Unauthorized');
  };
}

function validateWsAuth(authState, req) {
  if (!authState || !authState.enabled) return true;

  // Localhost bypass: desktop WebSocket is trusted
  if (authState.trustLocalhost && isLocalhost(req)) return true;

  // Session cookie (dashboard after MFA)
  if (validateSession(authState, req)) return true;

  // Agent token, as a Bearer header on the upgrade request. Browsers
  // cannot set one; the dashboard authenticates with its session cookie.
  const provided = extractToken(req);
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
  extractLoginToken,
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
  isLocalhost,
  timingSafeEqual,
};
