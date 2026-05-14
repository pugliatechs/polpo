/**
 * Gateway auth — API key management for programmatic callers.
 *
 * Distinct from the dashboard auth (auth.js):
 *   - Dashboard auth is for humans: token + optional PIN/TOTP, session cookies,
 *     burned-after-first-use tokens.
 *   - Gateway auth is for machines: a single long-lived API key, presented as
 *     a Bearer token on every request. No sessions, no MFA.
 *
 * The key is stored at ~/.config/polpo/gateway.json (mode 0o600), generated
 * on first start if missing. Callers can override by setting POLPO_GATEWAY_KEY
 * in the environment.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'polpo', 'gateway.json');

function generateKey() {
  // 256 bits, base64url so it's URL/header-safe without padding
  return crypto.randomBytes(32).toString('base64url');
}

function loadKeyFromFile(configPath) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data && typeof data.key === 'string' ? data.key : null;
  } catch {
    return null;
  }
}

function saveKeyToFile(configPath, key) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ key }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
}

/**
 * Resolve the gateway key with this precedence:
 *   1. options.key (caller override)
 *   2. POLPO_GATEWAY_KEY env var
 *   3. Existing key in configPath
 *   4. Generate, persist, and return a fresh key
 *
 * @param {object} [options]
 * @param {string} [options.key] - explicit override
 * @param {string} [options.configPath] - alternative config path (for tests)
 * @returns {{ key: string, isNew: boolean, source: 'override'|'env'|'file'|'generated' }}
 */
function loadOrCreateGatewayKey(options) {
  options = options || {};
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  if (options.key) {
    return { key: options.key, isNew: false, source: 'override' };
  }
  if (process.env.POLPO_GATEWAY_KEY) {
    return { key: process.env.POLPO_GATEWAY_KEY, isNew: false, source: 'env' };
  }
  const existing = loadKeyFromFile(configPath);
  if (existing) {
    return { key: existing, isNew: false, source: 'file' };
  }
  const key = generateKey();
  saveKeyToFile(configPath, key);
  return { key, isNew: true, source: 'generated' };
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Stable fingerprint of a bearer token for rate-limit bucketing and
 * upload ownership scoping. SHA-256 hex, full 64 chars.
 *
 * Why hash: storing tokens raw on the server (in a Map keyed by token)
 * would mean every rate-limit lookup compares secrets. Hashing
 * narrows the blast radius if the in-memory map is ever observed and
 * forward-compatible with persisting bucket state.
 */
function tokenFingerprint(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a per-token rate limiter middleware. Buckets are keyed by
 * sha256(bearer-token). Returns 429 with Retry-After when the cap is
 * exceeded. Independent of IP, which is useless behind a shared
 * gateway key.
 *
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max - requests allowed per window per token
 * @param {() => number} [opts.now] - injectable clock for tests
 */
function createPerTokenRateLimit(opts) {
  const windowMs = opts && opts.windowMs;
  const max = opts && opts.max;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createPerTokenRateLimit: windowMs must be > 0');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createPerTokenRateLimit: max must be > 0');
  }
  const now = (opts && opts.now) || Date.now;
  const buckets = new Map(); // fp -> { count, resetAt }

  // Periodic cleanup so buckets don't grow unbounded.
  const cleanup = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) {
      if (t > b.resetAt) buckets.delete(k);
    }
  }, Math.max(windowMs, 60_000));
  if (typeof cleanup.unref === 'function') cleanup.unref();

  const middleware = (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      // The auth middleware will reject this; pass through so the 401
      // is consistent. Don't bucket-charge an unauth'd call.
      return next();
    }
    const fp = tokenFingerprint(token);
    const t = now();
    let b = buckets.get(fp);
    if (!b || t > b.resetAt) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(fp, b);
    }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'rate_limited', retryAfterMs: b.resetAt - t });
    }
    next();
  };
  middleware._buckets = buckets;     // test introspection
  middleware._cleanup = cleanup;     // test cleanup
  return middleware;
}

function extractBearerToken(req) {
  const header = req.headers && req.headers['authorization'];
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

/**
 * Express middleware that requires Bearer <gatewayKey> on every request.
 * @param {() => string} getKey - returns the current expected key
 * @returns {(req, res, next) => void}
 */
function createGatewayAuthMiddleware(getKey) {
  return (req, res, next) => {
    const expected = typeof getKey === 'function' ? getKey() : getKey;
    if (!expected) {
      return res.status(503).json({ error: 'gateway_not_configured' });
    }
    const provided = extractBearerToken(req);
    if (!provided || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  generateKey,
  loadKeyFromFile,
  saveKeyToFile,
  loadOrCreateGatewayKey,
  extractBearerToken,
  createGatewayAuthMiddleware,
  timingSafeEqual,
  tokenFingerprint,
  createPerTokenRateLimit,
};
